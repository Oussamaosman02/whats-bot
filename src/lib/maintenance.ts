/**
 * Retention: delete stored content older than RETENTION_DAYS (messages, summaries, webhook events).
 * Runs hourly from instrumentation.ts and on demand via POST /api/maintenance/retention.
 */
import { and, eq, gte, lt, ne, sql as dsql } from "drizzle-orm";
import { db, schema } from "./db";
import { env } from "./env";
import { getLogger, errInfo } from "./logger";
import { archiveSummary } from "./ai/summarize";
import { fmtZoned, zonedToUtc } from "./bot/since";
import { getChat, mediaKeysForRange, saveSummary } from "./store";
import { r2, r2Enabled } from "./storage/r2";

const log = getLogger("retention");

export type RetentionReport = {
  cutoff: string;
  days: number;
  dryRun: boolean;
  archived: { chats: number; days: number; messages: number; failed: number };
  deleted: { messages: number; summaries: number; webhookEvents: number };
  ms: number;
};

/**
 * Archive-then-delete. For each chat, every *complete* local day (BOT_TIMEZONE) whose messages are all
 * older than the cutoff gets one archive summary (trigger = "archive", kept forever); only after the
 * summary is stored are that day's messages deleted. If Gemini fails, the day is left untouched and
 * retried on the next run — nothing is deleted without its archive.
 */
async function archiveOldDays(cutoff: number, msgFilter: ReturnType<typeof and>, dryRun: boolean) {
  const tz = env().BOT_TIMEZONE;
  if (!/^[A-Za-z_+\-/]+$/.test(tz)) throw new Error(`BOT_TIMEZONE "${tz}" is not a valid IANA name`);
  const cutoffDate = new Date(cutoff);
  // Same literal expression in SELECT and GROUP BY (bound params would make Postgres see two different expressions)
  const localDay = dsql.raw(`("messages"."timestamp" at time zone '${tz}')::date`);
  const days = await db
    .select({ chatJid: schema.messages.chatJid, day: dsql<string>`${localDay}::text`, n: dsql<number>`count(*)::int` })
    .from(schema.messages)
    .where(and(msgFilter, lt(schema.messages.timestamp, cutoffDate)))
    .groupBy(schema.messages.chatJid, localDay)
    .orderBy(schema.messages.chatJid, localDay);
  const bounds = (day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    return { dayStart: zonedToUtc(y, m, d, 0, 0, tz), dayEnd: zonedToUtc(y, m, d + 1, 0, 0, tz) };
  };
  const complete = days.filter((d) => bounds(d.day).dayEnd.getTime() <= cutoff);
  const report = { chats: new Set<string>(), days: 0, messages: 0, failed: 0 };
  for (const d of complete) {
    const { dayStart, dayEnd } = bounds(d.day);
    if (dryRun) {
      report.chats.add(d.chatJid);
      report.days++;
      report.messages += d.n;
      continue;
    }
    try {
      const rows = await db
        .select()
        .from(schema.messages)
        .where(and(msgFilter, eq(schema.messages.chatJid, d.chatJid), gte(schema.messages.timestamp, dayStart), lt(schema.messages.timestamp, dayEnd), eq(schema.messages.isCommand, false)))
        .orderBy(schema.messages.timestamp);
      const chat = await getChat(d.chatJid);
      const label = `día ${d.day}`;
      const max = env().SUMMARY_MAX_MESSAGES;
      // Summarise in chunks if a single day is huge
      for (let i = 0; i < rows.length; i += max) {
        const chunk = rows.slice(i, i + max);
        if (!chunk.length) continue;
        const res = await archiveSummary(chunk, { chatName: chat?.name ?? undefined, label: rows.length > max ? `${label} (parte ${i / max + 1})` : label, reqId: `arch-${d.day}` });
        await saveSummary({
          chatJid: d.chatJid,
          requestedBy: null,
          trigger: "archive",
          fromTs: chunk[0].timestamp,
          toTs: chunk[chunk.length - 1].timestamp,
          messageCount: chunk.length,
          text: res.text,
          model: res.model,
          promptTokens: res.promptTokens ?? null,
          completionTokens: res.completionTokens ?? null,
        });
      }
      const mediaKeys = r2Enabled() ? await mediaKeysForRange(d.chatJid, dayStart, dayEnd) : [];
      const del = await db
        .delete(schema.messages)
        .where(and(msgFilter, eq(schema.messages.chatJid, d.chatJid), gte(schema.messages.timestamp, dayStart), lt(schema.messages.timestamp, dayEnd)))
        .returning({ id: schema.messages.id });
      if (mediaKeys.length) await r2.delete(mediaKeys).catch((e) => log.warn({ err: errInfo(e), keys: mediaKeys.length }, "R2 media cleanup failed (objects orphaned)"));
      report.chats.add(d.chatJid);
      report.days++;
      report.messages += del.length;
      log.info({ chat: d.chatJid, chatName: chat?.name, day: d.day, messages: del.length, summarised: rows.length, range: `${fmtZoned(dayStart, tz)} → ${fmtZoned(dayEnd, tz)}` }, "📦 day archived and deleted");
    } catch (e) {
      report.failed++;
      log.error({ err: errInfo(e), chat: d.chatJid, day: d.day, hint: "Archive summary failed → the day's messages were NOT deleted; retried next hour. Check OPENROUTER_API_KEY / GEMINI_MODEL." }, "archive failed");
    }
  }
  return { chats: report.chats.size, days: report.days, messages: report.messages, failed: report.failed };
}

export async function retentionStats() {
  const [m] = await db.select({ count: dsql<number>`count(*)::int`, oldest: dsql<Date | null>`min(${schema.messages.timestamp})` }).from(schema.messages);
  const [s] = await db.select({ count: dsql<number>`count(*)::int`, oldest: dsql<Date | null>`min(${schema.summaries.createdAt})` }).from(schema.summaries).where(ne(schema.summaries.trigger, "archive"));
  const [a] = await db.select({ count: dsql<number>`count(*)::int`, chats: dsql<number>`count(distinct ${schema.summaries.chatJid})::int` }).from(schema.summaries).where(eq(schema.summaries.trigger, "archive"));
  const [w] = await db.select({ count: dsql<number>`count(*)::int` }).from(schema.webhookEvents);
  return { retentionDays: env().RETENTION_DAYS, archiveEnabled: env().RETENTION_ARCHIVE, messages: m, summaries: s, archiveSummaries: a, webhookEvents: w };
}

export async function runRetention(opts: { dryRun?: boolean; days?: number } = {}): Promise<RetentionReport> {
  const days = opts.days ?? env().RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const t0 = Date.now();
  // Imported history is context the operator added on purpose → kept unless RETENTION_INCLUDE_IMPORTS=true
  const msgFilter = env().RETENTION_INCLUDE_IMPORTS ? dsql`true` : ne(schema.messages.source, "import");
  const msgWhere = and(msgFilter, lt(schema.messages.timestamp, cutoff));
  // Archive summaries are kept forever; on-demand ones follow the window
  const sumWhere = and(lt(schema.summaries.createdAt, cutoff), ne(schema.summaries.trigger, "archive"));

  const archived = env().RETENTION_ARCHIVE ? await archiveOldDays(cutoff.getTime(), and(msgFilter), Boolean(opts.dryRun)) : { chats: 0, days: 0, messages: 0, failed: 0 };

  if (opts.dryRun) {
    const [m] = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.messages).where(msgWhere);
    const [s] = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.summaries).where(sumWhere);
    const [w] = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.webhookEvents).where(lt(schema.webhookEvents.receivedAt, cutoff));
    return { cutoff: cutoff.toISOString(), days, dryRun: true, archived, deleted: { messages: m.n, summaries: s.n, webhookEvents: w.n }, ms: Date.now() - t0 };
  }
  // With archiving on, only messages of days that were archived (or of days not yet complete) remain older
  // than the cutoff; delete the rest only when archiving is off or a day is older than the cutoff AND
  // already archived (handled above). Days whose archive failed are kept.
  let messages = archived.messages;
  if (!env().RETENTION_ARCHIVE) {
    messages = (await db.delete(schema.messages).where(msgWhere).returning({ id: schema.messages.id })).length;
  }
  const summaries = (await db.delete(schema.summaries).where(sumWhere).returning({ id: schema.summaries.id })).length;
  const webhookEvents = (await db.delete(schema.webhookEvents).where(lt(schema.webhookEvents.receivedAt, cutoff)).returning({ id: schema.webhookEvents.id })).length;
  const report = { cutoff: cutoff.toISOString(), days, dryRun: false, archived, deleted: { messages, summaries, webhookEvents }, ms: Date.now() - t0 };
  (messages + summaries + webhookEvents > 0 ? log.info : log.debug).call(log, report, "retention run");
  return report;
}

/** Sticker messages whose library entry has a caption but the row does not (races, restarts) → copy it over. */
export async function reconcileStickerCaptions(): Promise<number> {
  const rows = await db.execute(dsql`
    update messages m
       set media = coalesce(m.media, '{}'::jsonb) || jsonb_build_object('description', '(sticker: ' || s.caption || ')'),
           text  = coalesce(nullif(m.text, ''), '(sticker: ' || s.caption || ')')
      from stickers s
     where m.type = 'sticker' and m.media->>'description' is null and s.sha256 = m.media->>'sha256' and s.caption is not null
     returning m.id`);
  const n = Array.isArray(rows) ? rows.length : (rows as { length?: number }).length ?? 0;
  if (n) log.info({ reconciled: n }, "sticker captions copied onto message rows");
  return n;
}

let timer: NodeJS.Timeout | undefined;
/** Start the hourly retention job (idempotent). */
export function startRetentionScheduler() {
  if (timer) return;
  const tick = () =>
    runRetention()
      .then(() => reconcileStickerCaptions())
      .catch((e) => log.error({ err: errInfo(e), hint: "Retention job failed; old rows will be retried next hour. Check DATABASE_URL / Neon." }, "retention failed"));
  setTimeout(tick, 30_000);
  timer = setInterval(tick, 60 * 60_000);
  log.info({ days: env().RETENTION_DAYS }, "retention scheduler started (hourly)");
}
