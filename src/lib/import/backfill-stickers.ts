/**
 * Recover stickers that only arrived via the Zernio webhook (no file on our side) by downloading them
 * from Zernio's media proxy, then storing + captioning them like live ones. Idempotent.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { and, desc, eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { getLogger, errInfo } from "../logger";
import { zernio } from "../zernio/client";
import { captionSticker } from "../ai/vision";
import { baileysIdFromWamid, getSticker, setMediaDescription, setStickerCaption, upsertSticker } from "../store";

const log = getLogger("backfill");

type Ev = { id: string; payload: Record<string, unknown> | null; receivedAt: Date };

export async function backfillStickers(opts: { limit?: number; dryRun?: boolean; reqId?: string } = {}) {
  const t0 = Date.now();
  const events = (await db
    .select({ id: schema.webhookEvents.id, payload: schema.webhookEvents.payload, receivedAt: schema.webhookEvents.receivedAt })
    .from(schema.webhookEvents)
    .where(and(eq(schema.webhookEvents.provider, "zernio"), eq(schema.webhookEvents.event, "message.received"), dsql`${schema.webhookEvents.payload}->'message'->'attachments'->0->>'type' = 'sticker'`))
    .orderBy(desc(schema.webhookEvents.receivedAt))
    .limit(opts.limit ?? 500)) as Ev[];

  const seen = new Set<string>();
  const report = { events: events.length, candidates: 0, downloaded: 0, newStickers: 0, captioned: 0, alreadyDone: 0, failed: 0, ms: 0 };
  for (const ev of events) {
    const msg = (ev.payload?.message ?? {}) as { platformMessageId?: string; direction?: string; attachments?: { url?: string; payload?: { mimeType?: string } }[]; sender?: { name?: string; phoneNumber?: string; id?: string } };
    const conv = (ev.payload?.conversation ?? {}) as { participantId?: string };
    if (msg.direction !== "incoming" || !msg.platformMessageId) continue;
    const waId = baileysIdFromWamid(msg.platformMessageId) ?? msg.platformMessageId;
    if (seen.has(waId)) continue;
    seen.add(waId);
    const phone = (msg.sender?.phoneNumber ?? msg.sender?.id ?? conv.participantId ?? "").replace(/[^\d]/g, "");
    const chatJid = `${phone}@s.whatsapp.net`;
    const url = msg.attachments?.[0]?.url;
    if (!url) continue;
    report.candidates++;
    const row = (await db.select({ id: schema.messages.id, media: schema.messages.media }).from(schema.messages).where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId))).limit(1))[0];
    if (row?.media && (row.media as { description?: string }).description) {
      report.alreadyDone++;
      continue;
    }
    if (opts.dryRun) continue;
    try {
      const { buffer, mimetype } = await zernio.downloadMedia(url);
      report.downloaded++;
      const sha256 = createHash("sha256").update(buffer).digest("base64");
      const pages = (await sharp(buffer, { animated: true }).metadata().catch(() => ({ pages: 1 }))).pages ?? 1;
      const isAnimated = pages > 1;
      const { row: st, isNew } = await upsertSticker({ sha256, data: buffer, mimetype: mimetype.split(";")[0] || "image/webp", isAnimated, chatJid, senderJid: chatJid, senderName: msg.sender?.name });
      if (isNew) report.newStickers++;
      let caption = st?.caption ?? (await getSticker(sha256))?.caption ?? undefined;
      if (!caption) {
        const c = await captionSticker(buffer, { animated: isAnimated, reqId: opts.reqId });
        caption = c.caption;
        await setStickerCaption(sha256, c.caption, c.tags, c.model);
        report.captioned++;
      }
      if (row) await setMediaDescription(chatJid, waId, `(sticker: ${caption})`);
      else {
        // no message row at all (e.g. deleted by retention) – still keep the sticker in the library
        log.debug({ waId, chatJid }, "sticker backfilled into library without a message row");
      }
      await db.update(schema.messages).set({ media: dsql`coalesce(${schema.messages.media}, '{}'::jsonb) || ${JSON.stringify({ mimetype: mimetype.split(";")[0], fileLength: buffer.length, sha256, isAnimated, backfilledFrom: "zernio" })}::jsonb` as unknown as Record<string, unknown> }).where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId)));
      log.info({ waId: waId.slice(-8), sha256: sha256.slice(0, 12), isNew, isAnimated, bytes: buffer.length, caption }, "🧩 sticker backfilled");
    } catch (e) {
      report.failed++;
      log.warn({ err: errInfo(e), waId, url, hint: "Zernio could not serve this media (expired or not a sticker). Skipped." }, "backfill failed for one sticker");
    }
  }
  report.ms = Date.now() - t0;
  log.info(report, "sticker backfill finished");
  return report;
}
