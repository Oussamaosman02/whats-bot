/**
 * Scheduled digests ("boletín" / breaking news): at fixed local hours the bot posts, in the group, a summary of
 * everything said since the previous slot – as a voice note by default.
 *
 * State lives in the `digests` table (one row per group) so it survives restarts:
 *   • the scheduler ticks every minute and picks rows with next_run_at <= now
 *   • a row is *claimed* with `UPDATE … WHERE next_run_at = <seen value>` – the first process to win the update owns
 *     that slot, so even two accidental replicas never post twice
 *   • a slot found more than DIGEST_MAX_LATE_MINUTES late (server down) is skipped; its messages roll into the next one
 *   • nothing is posted when there are fewer than `minMessages` new messages ("bots that talk unprompted" rule)
 */
import { and, eq, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { AppError, isAppError } from "../errors";
import { errInfo, getLogger } from "../logger";
import { synthesize, ttsEnabled } from "../ai/tts";
import { whatsapp } from "../whatsapp/client";
import { getChat, groupsForUser, listMessages } from "../store";
import { phoneFromJid } from "../whatsapp/jid";
import { sendDm } from "./deliver";
import { fmtZoned } from "./since";
import { nextSlot, normalizeHours, prevSlot } from "./schedule";
import { runSummary } from "./service";
import type { Digest, DigestStyle } from "../db/schema";

const log = getLogger("digest");
const TICK_MS = 60_000;
const MAX_WINDOW_MS = 24 * 3_600_000;

export { hoursEvery, nextSlot, normalizeHours, parseHour, prevSlot } from "./schedule";

// ───────────────────────── persistence ─────────────────────────

export type DigestInput = {
  chatJid: string;
  hours?: string[];
  audio?: boolean;
  style?: DigestStyle;
  enabled?: boolean;
  minMessages?: number;
  createdBy?: string | null;
  createdByName?: string | null;
};

export async function getDigest(chatJid: string): Promise<Digest | undefined> {
  const rows = await db.select().from(schema.digests).where(eq(schema.digests.chatJid, chatJid)).limit(1);
  return rows[0];
}

export async function listDigests(): Promise<Digest[]> {
  return db.select().from(schema.digests).orderBy(schema.digests.nextRunAt);
}

/** Create or update a group's digest. `hours` is required the first time; the next slot is recomputed on every change. */
export async function upsertDigest(input: DigestInput): Promise<Digest> {
  const existing = await getDigest(input.chatJid);
  const hours = input.hours ? normalizeHours(input.hours) : existing?.hours;
  if (!hours) throw AppError.badRequest("This group has no digest yet – tell me the hours.", "Example: /boletin 06:00 14:00 22:00 audio");
  const now = new Date();
  const values = {
    chatJid: input.chatJid,
    hours,
    audio: input.audio ?? existing?.audio ?? true,
    style: input.style ?? existing?.style ?? "bullets",
    enabled: input.enabled ?? existing?.enabled ?? true,
    minMessages: input.minMessages ?? existing?.minMessages ?? env().DIGEST_MIN_MESSAGES,
    createdBy: existing?.createdBy ?? input.createdBy ?? null,
    createdByName: existing?.createdByName ?? input.createdByName ?? null,
    nextRunAt: nextSlot(hours, now),
    lastError: null,
    updatedAt: now,
  };
  const rows = await db
    .insert(schema.digests)
    .values(values)
    .onConflictDoUpdate({ target: schema.digests.chatJid, set: values })
    .returning();
  log.info({ chat: input.chatJid, hours, audio: values.audio, style: values.style, enabled: values.enabled, next: rows[0].nextRunAt.toISOString(), by: input.createdByName ?? input.createdBy }, "digest configured");
  return rows[0];
}

export async function deleteDigest(chatJid: string): Promise<boolean> {
  const rows = await db.delete(schema.digests).where(eq(schema.digests.chatJid, chatJid)).returning({ id: schema.digests.id });
  if (rows.length) log.info({ chat: chatJid }, "digest removed");
  return rows.length > 0;
}

/**
 * Atomically take ownership of a due slot: advance next_run_at only if nobody else did it first.
 * Returns the updated row, or undefined when another process won.
 */
async function claim(d: Digest, opts: { markRun: boolean }): Promise<Digest | undefined> {
  const now = new Date();
  const rows = await db
    .update(schema.digests)
    .set({ nextRunAt: nextSlot(d.hours, now), ...(opts.markRun ? { lastRunAt: now } : {}), updatedAt: now })
    .where(and(eq(schema.digests.id, d.id), eq(schema.digests.nextRunAt, d.nextRunAt)))
    .returning();
  return rows[0];
}

// ───────────────────────── running one digest ─────────────────────────

export type DigestRunResult =
  | { posted: true; messages: number; audio: boolean; summaryId: number; from: Date; to: Date; ms: number }
  | { posted: false; reason: "too_few_messages" | "no_messages" | "not_connected"; messages: number; from: Date; to: Date };

/**
 * Summarise `since → now` and post it in the group (voice note when `audio` and TTS is configured; text otherwise).
 * `since` defaults to the digest's last run (capped at 24 h) or, on a first run, the previous slot.
 */
export async function runDigest(d: Digest, opts: { since?: Date; force?: boolean; reqId?: string; audio?: boolean } = {}): Promise<DigestRunResult> {
  const e = env();
  const tz = e.BOT_TIMEZONE;
  const reqId = opts.reqId ?? `dig-${d.id}-${Date.now().toString(36)}`;
  const dlog = log.child({ reqId, chat: d.chatJid });
  const now = new Date();
  const floor = new Date(now.getTime() - MAX_WINDOW_MS);
  const since = opts.since ?? (d.lastRunAt && d.lastRunAt > floor ? d.lastRunAt : prevSlot(d.hours, now) > floor ? prevSlot(d.hours, now) : floor);
  const t0 = Date.now();
  const chat = await getChat(d.chatJid);

  if (whatsapp.getStatus().status !== "open") {
    dlog.warn({ hint: "WhatsApp is not connected; the slot is left due and retried next minute (GET /api/whatsapp/status)." }, "digest skipped – not connected");
    return { posted: false, reason: "not_connected", messages: 0, from: since, to: now };
  }

  const min = opts.force ? 1 : Math.max(1, d.minMessages);
  if (chat?.kind === "dm") return runPrivateBrief(d, { since, now, min, reqId, audio: opts.audio, t0 });
  const sample = await listMessages({ chatJid: d.chatJid, since, until: now, limit: min, excludeCommands: true });
  if (sample.length < min) {
    dlog.info({ messages: sample.length, min, since: fmtZoned(since, tz) }, sample.length ? "digest skipped – too few new messages" : "digest skipped – nothing new");
    return { posted: false, reason: sample.length ? "too_few_messages" : "no_messages", messages: sample.length, from: since, to: now };
  }

  const audio = (opts.audio ?? d.audio) && ttsEnabled();
  if ((opts.audio ?? d.audio) && !audio) dlog.warn({ hint: "Set ELEVENLABS_API_KEY + ELEVENLABS_DEFAULT_VOICE_ID for voice digests; sending text." }, "digest audio requested but TTS is not configured");
  const style = audio ? (d.style === "detailed" ? "spoken_detailed" : "spoken") : d.style;

  const res = await whatsapp.withPresence(d.chatJid, audio ? "recording" : "composing", () =>
    runSummary({ chatJid: d.chatJid, since: { kind: "time", since, until: now, label: `desde las ${fmtZoned(since, tz, false)}` }, until: now, style, tone: "news", trigger: "digest", reqId }),
  );

  const header = `📰 *Boletín de ${chat?.name ?? "el grupo"}* – ${fmtZoned(res.from, tz, false)} → ${fmtZoned(res.to, tz, false)}\n_${res.messageCount} mensajes_\n\n`;
  let sentAudio = false;
  if (audio) {
    try {
      const a = await synthesize(res.text, { reqId });
      await whatsapp.sendVoice(d.chatJid, a.buffer, { mimetype: a.mimetype });
      sentAudio = true;
    } catch (err) {
      dlog.warn({ err: errInfo(err), hint: isAppError(err) ? err.hint : "TTS or send failed; posting the digest as text instead." }, "digest voice note failed – sending text");
    }
  }
  if (!sentAudio) await whatsapp.sendText(d.chatJid, header + res.text);

  await db.update(schema.digests).set({ lastSentAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(schema.digests.id, d.id));
  dlog.info({ messages: res.messageCount, audio: sentAudio, summaryId: res.id, window: `${fmtZoned(res.from, tz)} → ${fmtZoned(res.to, tz)}`, ms: Date.now() - t0 }, `📰 digest posted${sentAudio ? " (voice)" : ""}`);
  return { posted: true, messages: res.messageCount, audio: sentAudio, summaryId: res.id, from: res.from, to: res.to, ms: Date.now() - t0 };
}

/**
 * Private brief: the digest row belongs to a user (DM jid) → one DM with a short digest of EVERY group they share
 * with the bot (groups with fewer than `min` new messages are left out). Text by default; one voice note when
 * `audio`. Read marks are not advanced.
 */
async function runPrivateBrief(d: Digest, ctx: { since: Date; now: Date; min: number; reqId: string; audio?: boolean; t0: number }): Promise<DigestRunResult> {
  const e = env();
  const tz = e.BOT_TIMEZONE;
  const dlog = log.child({ reqId: ctx.reqId, user: d.chatJid, mode: "private" });
  const groups = await groupsForUser(d.chatJid, phoneFromJid(d.chatJid));
  const audio = (ctx.audio ?? d.audio) && ttsEnabled();
  const parts: { name: string; count: number; text: string }[] = [];
  let total = 0;
  for (const g of groups) {
    const sample = await listMessages({ chatJid: g.jid, since: ctx.since, until: ctx.now, limit: ctx.min, excludeCommands: true });
    if (sample.length < ctx.min) continue;
    try {
      const res = await runSummary({ chatJid: g.jid, since: { kind: "time", since: ctx.since, until: ctx.now, label: `desde las ${fmtZoned(ctx.since, tz, false)}` }, until: ctx.now, style: audio ? "spoken" : d.style === "detailed" ? "bullets" : "brief", trigger: "digest", requesterJid: d.chatJid, advanceMark: false, reqId: ctx.reqId });
      parts.push({ name: g.name ?? g.jid, count: res.messageCount, text: res.text });
      total += res.messageCount;
    } catch (err) {
      if (isAppError(err) && err.code === "no_messages") continue;
      dlog.warn({ err: errInfo(err), chat: g.jid, hint: isAppError(err) ? err.hint : undefined }, "private brief: one group failed – skipped");
    }
  }
  if (!parts.length) {
    dlog.info({ groups: groups.length, since: fmtZoned(ctx.since, tz) }, "private brief skipped – nothing new in any group");
    return { posted: false, reason: "no_messages", messages: 0, from: ctx.since, to: ctx.now };
  }
  const header = `🌅 *Tu boletín* – ${fmtZoned(ctx.since, tz, false)} → ${fmtZoned(ctx.now, tz, false)} · ${parts.length} grupo${parts.length > 1 ? "s" : ""}, ${total} mensajes\n\n`;
  const text = header + parts.map((p) => `*${p.name}* _(${p.count} mensajes)_\n${p.text}`).join("\n\n");
  let sentAudio = false;
  if (audio) {
    try {
      const spoken = parts.map((p) => `Sobre ${p.name}. ${p.text}`).join("\n\n");
      const a = await synthesize(spoken, { reqId: ctx.reqId });
      await whatsapp.sendVoice(d.chatJid, a.buffer, { mimetype: a.mimetype });
      sentAudio = true;
    } catch (err) {
      dlog.warn({ err: errInfo(err), hint: isAppError(err) ? err.hint : "TTS failed; sending the brief as text." }, "private brief voice note failed – sending text");
    }
  }
  if (!sentAudio) await sendDm(d.chatJid, text, ctx.reqId);
  await db.update(schema.digests).set({ lastSentAt: new Date(), lastError: null, updatedAt: new Date() }).where(eq(schema.digests.id, d.id));
  dlog.info({ groups: parts.length, messages: total, audio: sentAudio, ms: Date.now() - ctx.t0 }, `🌅 private brief sent${sentAudio ? " (voice)" : ""}`);
  return { posted: true, messages: total, audio: sentAudio, summaryId: 0, from: ctx.since, to: ctx.now, ms: Date.now() - ctx.t0 };
}

// ───────────────────────── scheduler ─────────────────────────

let timer: NodeJS.Timeout | undefined;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const due = await db
      .select()
      .from(schema.digests)
      .where(and(eq(schema.digests.enabled, true), lte(schema.digests.nextRunAt, now)))
      .orderBy(schema.digests.nextRunAt);
    if (!due.length) return;
    if (whatsapp.getStatus().status !== "open") {
      log.warn({ due: due.length, hint: "Digests are due but WhatsApp is not connected; retrying every minute (GET /api/whatsapp/status)." }, "digest tick – not connected");
      return;
    }
    const maxLateMs = env().DIGEST_MAX_LATE_MINUTES * 60_000;
    for (const d of due) {
      const lateMs = now.getTime() - d.nextRunAt.getTime();
      if (lateMs > maxLateMs) {
        // Server was down for this slot: skip it (window is kept, so the next digest covers these messages too)
        const c = await claim(d, { markRun: false });
        if (c) log.warn({ chat: d.chatJid, slot: d.nextRunAt.toISOString(), lateMinutes: Math.round(lateMs / 60_000), next: c.nextRunAt.toISOString(), hint: "Slot skipped because the server was down; raise DIGEST_MAX_LATE_MINUTES to post late anyway." }, "digest slot skipped (too late)");
        continue;
      }
      const owned = await claim(d, { markRun: true });
      if (!owned) continue; // another process took it
      try {
        // window: from what the row said *before* the claim
        await runDigest({ ...owned, lastRunAt: d.lastRunAt }, { reqId: `dig-${d.id}-${d.nextRunAt.getTime().toString(36)}` });
      } catch (err) {
        const info = errInfo(err);
        log.error({ err: info, chat: d.chatJid, hint: isAppError(err) ? err.hint : "Digest failed; next slot will cover this window too (window start is only advanced on a claim). Check OPENROUTER_API_KEY / ElevenLabs quota." }, "digest failed");
        await db.update(schema.digests).set({ lastError: info.message.slice(0, 500), updatedAt: new Date() }).where(eq(schema.digests.id, d.id)).catch(() => {});
      }
      // human-like pacing when several groups share a slot
      if (due.length > 1) await new Promise((r) => setTimeout(r, 4_000 + Math.random() * 6_000));
    }
  } catch (err) {
    log.error({ err: errInfo(err), hint: "Digest scheduler tick failed; retried next minute. Check DATABASE_URL / Neon and that `npm run db:push` created the digests table." }, "digest tick failed");
  } finally {
    ticking = false;
  }
}

/** Start the one-minute digest loop (idempotent). Rows are only ever claimed, never run from memory, so restarts are safe. */
export function startDigestScheduler() {
  if (timer) return;
  if (!env().DIGEST_ENABLED) {
    log.info("digest scheduler disabled (DIGEST_ENABLED=false)");
    return;
  }
  setTimeout(() => void tick(), 20_000);
  timer = setInterval(() => void tick(), TICK_MS);
  void db
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.digests)
    .where(eq(schema.digests.enabled, true))
    .then(([r]) => log.info({ active: r?.n ?? 0, maxLateMinutes: env().DIGEST_MAX_LATE_MINUTES }, "digest scheduler started (every minute)"))
    .catch((err) => log.warn({ err: errInfo(err), hint: "Run `npm run db:push` to create the digests table." }, "digest scheduler could not read the digests table"));
}

/** Human-readable description of a digest config for chat replies. */
export function describeDigest(d: Digest, chatName?: string | null, isPrivate = false) {
  const tz = env().BOT_TIMEZONE;
  const lines = [
    `${isPrivate ? "🌅 *Boletín privado* (todos tus grupos, por aquí)" : `📰 *Boletín${chatName ? ` de ${chatName}` : ""}*`}: ${d.enabled ? "activo ✅" : "pausado ⏸️"}`,
    `- Horas: ${d.hours.join(", ")} (${tz})`,
    `- Formato: ${d.audio ? "nota de voz 🔊" : "texto 📝"}${d.style !== "bullets" ? ` · ${d.style === "brief" ? "breve" : "detallado"}` : ""}`,
    `- Mínimo de mensajes nuevos: ${d.minMessages}`,
    `- Próximo: ${fmtZoned(d.nextRunAt, tz)}${d.lastSentAt ? ` · último enviado: ${fmtZoned(d.lastSentAt, tz)}` : ""}`,
  ];
  if (d.lastError) lines.push(`- ⚠️ Último error: ${d.lastError.slice(0, 120)}`);
  return lines.join("\n");
}
