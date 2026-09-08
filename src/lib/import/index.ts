/**
 * Import a WhatsApp chat export (zip or txt) into a chat's history so summaries have context
 * from before the bot joined. Only the *.txt inside the zip is read; media entries are skipped
 * without being loaded, so a multi-GB export costs nothing beyond the download.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import yauzl from "yauzl";
import { and, eq, ne, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger } from "../logger";
import { getChat, listParticipants, upsertChat } from "../store";
import { parseWhatsAppExport, type ParsedMessage } from "./whatsapp-export";

const log = getLogger("import");

export type ImportReport = {
  chatJid: string;
  parsed: number;
  inserted: number;
  duplicates: number;
  skippedAfterLive: number;
  skippedLines: number;
  dateFormat: "dmy" | "mdy";
  from?: string;
  to?: string;
  sendersMapped: number;
  ms: number;
};

/** Extract the chat text from a .zip (first *.txt entry, streamed) or return a .txt file's content. */
export async function readExportFile(path: string, fileName?: string): Promise<{ text: string; entry: string }> {
  const size = (await stat(path)).size;
  const isZip = (fileName ?? path).toLowerCase().endsWith(".zip") || (await isZipMagic(path));
  if (!isZip) return { text: await readFile(path, "utf8"), entry: fileName ?? path };
  log.debug({ path, sizeMb: (size / 1e6).toFixed(1) }, "opening zip export");
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(new AppError(400, "bad_zip", `Cannot open zip: ${err?.message ?? "unknown"}`, { hint: "Is this a WhatsApp 'Export chat' zip? Try exporting again without media." }));
      let found = false;
      zip.readEntry();
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (!found && /\.txt$/i.test(name) && !/\/\./.test(name) && !name.startsWith("__MACOSX")) {
          found = true;
          zip.openReadStream(entry, (e2, stream) => {
            if (e2 || !stream) return reject(e2);
            const chunks: Buffer[] = [];
            stream.on("data", (c: Buffer) => chunks.push(c));
            stream.on("end", () => {
              zip.close();
              resolve({ text: Buffer.concat(chunks).toString("utf8"), entry: name });
            });
            stream.on("error", reject);
          });
        } else {
          zip.readEntry(); // skip media without reading it
        }
      });
      zip.on("end", () => {
        if (!found) reject(new AppError(400, "no_txt_in_zip", "The zip contains no .txt chat file.", { hint: "WhatsApp exports include '_chat.txt' (iOS) or 'WhatsApp Chat with ….txt' (Android)." }));
      });
      zip.on("error", reject);
    });
  });
}

async function isZipMagic(path: string) {
  return new Promise<boolean>((resolve) => {
    const s = createReadStream(path, { start: 0, end: 3 });
    s.once("data", (b: string | Buffer) => resolve(typeof b !== "string" && b[0] === 0x50 && b[1] === 0x4b));
    s.once("error", () => resolve(false));
    s.once("end", () => resolve(false));
  });
}

function importId(m: ParsedMessage) {
  return "import:" + createHash("sha1").update(`${m.timestamp.getTime()}|${m.sender}|${m.text ?? m.type}`).digest("hex").slice(0, 24);
}

export async function importExportText(chatJid: string, text: string, opts: { force?: boolean; reqId?: string } = {}): Promise<ImportReport> {
  const t0 = Date.now();
  const chat = await getChat(chatJid);
  if (!chat) throw AppError.notFound(`Chat ${chatJid} is unknown.`, "Sync groups first (GET /api/groups?live=1).");
  const { messages, dateFormat, skippedLines } = parseWhatsAppExport(text, { timeZone: env().BOT_TIMEZONE, dateFormat: env().IMPORT_DATE_FORMAT });
  if (!messages.length) throw AppError.badRequest("No messages could be parsed from the export.", "Check the file is a WhatsApp chat export (.txt inside the zip) and IMPORT_DATE_FORMAT.");

  // Map export display names → participant jids (exact name match only)
  const parts = await listParticipants(chatJid, true);
  const byName = new Map<string, { userJid: string; phone: string | null }>();
  for (const p of parts) if (p.name) byName.set(p.name.trim().toLowerCase(), { userJid: p.userJid, phone: p.phone });

  // Don't import anything the bot already saw live (avoid near-duplicates with different ids)
  const [live] = await db
    .select({ first: dsql<Date | null>`min(${schema.messages.timestamp})` })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatJid, chatJid), ne(schema.messages.source, "import")));
  const liveStart = opts.force ? null : live?.first ?? null;

  let inserted = 0, duplicates = 0, skippedAfterLive = 0, sendersMapped = 0;
  const batch: (typeof schema.messages.$inferInsert)[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = await db.insert(schema.messages).values(batch).onConflictDoNothing({ target: [schema.messages.chatJid, schema.messages.waId] }).returning({ id: schema.messages.id });
    inserted += rows.length;
    duplicates += batch.length - rows.length;
    batch.length = 0;
  };
  for (const m of messages) {
    if (liveStart && m.timestamp >= liveStart) {
      skippedAfterLive++;
      continue;
    }
    const mapped = byName.get(m.sender.toLowerCase());
    if (mapped) sendersMapped++;
    batch.push({
      waId: importId(m),
      chatJid,
      senderJid: mapped?.userJid ?? null,
      senderPhone: mapped?.phone ?? null,
      senderName: m.sender,
      fromMe: false,
      type: m.type,
      text: m.text,
      source: "import",
      isCommand: Boolean(m.text?.startsWith(env().BOT_COMMAND_PREFIX)),
      timestamp: m.timestamp,
      mentions: [],
    });
    if (batch.length >= 500) await flush();
  }
  await flush();
  const first = messages[0]?.timestamp, last = messages[messages.length - 1]?.timestamp;
  if (last) await upsertChat({ jid: chatJid, kind: chat.kind, lastMessageAt: last });
  const report: ImportReport = { chatJid, parsed: messages.length, inserted, duplicates, skippedAfterLive, skippedLines, dateFormat, from: first?.toISOString(), to: last?.toISOString(), sendersMapped, ms: Date.now() - t0 };
  log.info({ ...report, reqId: opts.reqId }, "chat export imported");
  return report;
}
