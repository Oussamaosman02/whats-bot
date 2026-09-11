/**
 * Persistence helpers for chats, participants, messages, summaries and read marks.
 * Every write is idempotent so the same message can arrive from Baileys AND Zernio safely.
 */
import { and, desc, eq, gt, gte, lt, lte, ne, sql as dsql, inArray } from "drizzle-orm";
import { db, schema } from "./db";
import type { NormalizedMessage } from "./whatsapp/types";
import type { Message, MessageSource, SocialItem, SocialKind } from "./db/schema";
import { getLogger } from "./logger";
import { r2, r2Enabled } from "./storage/r2";

const log = getLogger("store");

export async function upsertChat(input: {
  jid: string;
  kind: "group" | "dm";
  name?: string | null;
  botIsMember?: boolean;
  participantCount?: number | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
  lastMessageAt?: Date;
}) {
  const set: Partial<typeof schema.chats.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined && input.name !== null) set.name = input.name;
  if (input.botIsMember !== undefined) set.botIsMember = input.botIsMember;
  if (input.participantCount !== undefined && input.participantCount !== null) set.participantCount = input.participantCount;
  if (input.description !== undefined) set.description = input.description;
  if (input.metadata) set.metadata = input.metadata;
  // Pass the Date as an ISO string with an explicit cast: raw-sql params are not column-typed, so a JS Date
  // reaches Postgres as `Tue Sep 08 2026 …` and fails to parse.
  if (input.lastMessageAt) set.lastMessageAt = dsql`greatest(coalesce(${schema.chats.lastMessageAt}, 'epoch'::timestamptz), ${input.lastMessageAt.toISOString()}::timestamptz)` as unknown as Date;
  await db
    .insert(schema.chats)
    .values({
      jid: input.jid,
      kind: input.kind,
      name: input.name ?? null,
      botIsMember: input.botIsMember ?? true,
      participantCount: input.participantCount ?? null,
      description: input.description ?? null,
      metadata: input.metadata,
      lastMessageAt: input.lastMessageAt,
    })
    .onConflictDoUpdate({ target: schema.chats.jid, set });
}

export async function replaceParticipants(
  chatJid: string,
  list: { userJid: string; phone?: string; name?: string; isAdmin: boolean }[],
) {
  const now = new Date();
  if (list.length) {
    await db
      .insert(schema.participants)
      .values(list.map((p) => ({ chatJid, userJid: p.userJid, phone: p.phone ?? null, name: p.name ?? null, isAdmin: p.isAdmin, leftAt: null, updatedAt: now })))
      .onConflictDoUpdate({
        target: [schema.participants.chatJid, schema.participants.userJid],
        set: { phone: dsql`coalesce(excluded.phone, ${schema.participants.phone})`, name: dsql`coalesce(excluded.name, ${schema.participants.name})`, isAdmin: dsql`excluded.is_admin`, leftAt: null, updatedAt: now },
      });
  }
  const keep = list.map((p) => p.userJid);
  await db
    .update(schema.participants)
    .set({ leftAt: now, updatedAt: now })
    .where(and(eq(schema.participants.chatJid, chatJid), keep.length ? dsql`${schema.participants.userJid} not in ${keep}` : dsql`true`));
}

export async function markParticipants(chatJid: string, userJids: string[], action: "add" | "remove" | "promote" | "demote") {
  const now = new Date();
  if (!userJids.length) return;
  if (action === "add") {
    await db
      .insert(schema.participants)
      .values(userJids.map((userJid) => ({ chatJid, userJid, isAdmin: false, leftAt: null, updatedAt: now })))
      .onConflictDoUpdate({ target: [schema.participants.chatJid, schema.participants.userJid], set: { leftAt: null, updatedAt: now } });
  } else if (action === "remove") {
    await db.update(schema.participants).set({ leftAt: now, updatedAt: now }).where(and(eq(schema.participants.chatJid, chatJid), inArray(schema.participants.userJid, userJids)));
  } else {
    await db.update(schema.participants).set({ isAdmin: action === "promote", updatedAt: now }).where(and(eq(schema.participants.chatJid, chatJid), inArray(schema.participants.userJid, userJids)));
  }
}

/**
 * When the Cloud-API (Zernio) copy of a DM arrived first, the Baileys copy carries what it lacks:
 * media metadata (mimetype, size, hash, animated flag), sender push-name, quoted id, mentions.
 * Merge those into the existing row and mark it as baileys-backed so media processing can run.
 */
async function enrichFromBaileys(rowId: number, existingSource: MessageSource, m: NormalizedMessage): Promise<boolean> {
  if (m.source !== "baileys" || existingSource === "baileys") return false;
  await db
    .update(schema.messages)
    .set({
      source: "baileys",
      media: m.media ? (dsql`coalesce(${schema.messages.media}, '{}'::jsonb) || ${JSON.stringify(m.media)}::jsonb` as unknown as Record<string, unknown>) : undefined,
      senderName: m.senderName ? (dsql`coalesce(${schema.messages.senderName}, ${m.senderName})` as unknown as string) : undefined,
      senderJid: m.senderJid ?? undefined,
      senderPhone: m.senderPhone ?? undefined,
      quotedId: m.quoted?.id ?? undefined,
      mentions: m.mentions.length ? m.mentions : undefined,
      type: m.type,
      raw: dsql`coalesce(${schema.messages.raw}, '{}'::jsonb) || ${JSON.stringify({ enrichedFrom: existingSource })}::jsonb` as unknown as Record<string, unknown>,
    })
    .where(eq(schema.messages.id, rowId));
  log.debug({ rowId, existingSource, type: m.type }, "row enriched with Baileys copy");
  return true;
}

/**
 * Meta's `wamid.<base64>` embeds the WhatsApp Web message id (the one Baileys sees) as ASCII, e.g.
 * wamid.HBgL…GCBBQzQ4NUZB…  → "AC485FA05AE3F7BCC41CA82830F7303A". Returns it when found.
 */
export function baileysIdFromWamid(wamid: string): string | undefined {
  if (!wamid.startsWith("wamid.")) return undefined;
  try {
    const decoded = Buffer.from(wamid.slice(6), "base64").toString("latin1");
    const m = decoded.match(/[A-Z0-9]{16,64}/g);
    if (!m) return undefined;
    // longest run of hex-ish uppercase alphanumerics is the id
    return m.sort((a, b) => b.length - a.length)[0];
  } catch {
    return undefined;
  }
}

/**
 * Insert a message if it is not already stored.
 * Dedupe rules (in order):
 *   1. same chat + same platform id
 *   2. same chat + same text + same direction within 90 s (covers Baileys⇄Zernio id mismatch on DMs)
 * Returns { inserted, id }.
 */
export async function saveMessage(m: NormalizedMessage): Promise<{ inserted: boolean; id?: number; dedupedBy?: "id" | "wamid" | "fuzzy"; existingSource?: MessageSource; enriched?: boolean }> {
  // Normalise Cloud-API ids to the WhatsApp Web id so Baileys and Zernio copies share the unique key
  const embedded = baileysIdFromWamid(m.id);
  if (embedded) {
    m.raw = { ...(m.raw ?? {}), wamid: m.id };
    m.id = embedded;
  }
  const existing = await db
    .select({ id: schema.messages.id, source: schema.messages.source })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatJid, m.chatJid), eq(schema.messages.waId, m.id)))
    .limit(1);
  if (existing[0]) {
    const enriched = await enrichFromBaileys(existing[0].id, existing[0].source, m);
    return { inserted: false, id: existing[0].id, dedupedBy: embedded ? "wamid" : "id", existingSource: existing[0].source, enriched };
  }

  if (m.chatKind === "dm") {
    // Fallback for ids that cannot be matched: same chat + direction + (text | media type) within 90 s
    const lo = new Date(m.timestamp.getTime() - 90_000);
    const hi = new Date(m.timestamp.getTime() + 90_000);
    const fuzzy = await db
      .select({ id: schema.messages.id, source: schema.messages.source })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.chatJid, m.chatJid),
          m.text ? eq(schema.messages.text, m.text) : and(eq(schema.messages.type, m.type), dsql`${schema.messages.text} is null`),
          eq(schema.messages.fromMe, m.fromMe),
          gte(schema.messages.timestamp, lo),
          lte(schema.messages.timestamp, hi),
          m.text ? undefined : ne(schema.messages.type, "text"),
        ),
      )
      .limit(1);
    if (fuzzy[0]) {
      log.debug({ chat: m.chatJid, id: m.id, source: m.source, matched: fuzzy[0].source }, "message deduped by (chat,text,time) match");
      const enriched = await enrichFromBaileys(fuzzy[0].id, fuzzy[0].source as MessageSource, m);
      return { inserted: false, id: fuzzy[0].id, dedupedBy: "fuzzy", existingSource: fuzzy[0].source as MessageSource, enriched };
    }
  }

  const rows = await db
    .insert(schema.messages)
    .values({
      waId: m.id,
      chatJid: m.chatJid,
      senderJid: m.senderJid ?? null,
      senderPhone: m.senderPhone ?? null,
      senderName: m.senderName ?? null,
      fromMe: m.fromMe,
      type: m.type,
      text: m.text ?? null,
      media: m.media as Record<string, unknown> | undefined,
      quotedId: m.quoted?.id ?? null,
      mentions: m.mentions,
      source: m.source,
      timestamp: m.timestamp,
      raw: m.raw,
    })
    .onConflictDoNothing({ target: [schema.messages.chatJid, schema.messages.waId] })
    .returning({ id: schema.messages.id });
  if (!rows[0]) return { inserted: false, dedupedBy: "id" };
  await upsertChat({ jid: m.chatJid, kind: m.chatKind, name: m.chatName, lastMessageAt: m.timestamp });
  return { inserted: true, id: rows[0].id };
}

/** Attach a transcript to an audio message: text becomes searchable/summarisable, media.transcript keeps provenance. */
export async function setMessageTranscript(chatJid: string, waId: string, transcript: string, meta: { model?: string; ms?: number } = {}) {
  await db
    .update(schema.messages)
    .set({ text: transcript, media: dsql`coalesce(${schema.messages.media}, '{}'::jsonb) || ${JSON.stringify({ transcript, transcribedWith: meta.model, transcribeMs: meta.ms })}::jsonb` as unknown as Record<string, unknown> })
    .where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId)));
}

/**
 * Messages in a chat whose text matches ANY of the terms (case/accent-insensitive), each with `around`
 * neighbouring messages for context. Newest matches first, chronological output.
 */
export async function searchMessages(chatJid: string, terms: string[], opts: { limit?: number; around?: number } = {}) {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 2);
  if (!clean.length) return [] as Message[];
  const limit = opts.limit ?? 300;
  const around = opts.around ?? 2;
  const pattern = clean.map((t) => t.replace(/[%_\\]/g, (c) => "\\" + c)).join("|");
  const hits = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.isCommand, false), dsql`unaccent(coalesce(${schema.messages.text}, '')) ~* unaccent(${pattern})`))
    .orderBy(desc(schema.messages.timestamp))
    .limit(limit);
  if (!hits.length) return [] as Message[];
  // neighbours by id proximity (ids are insertion-ordered per import/live batch; good enough for context)
  const ids = new Set<number>();
  for (const h of hits) for (let d = -around; d <= around; d++) ids.add(h.id + d);
  const rows = await db.select().from(schema.messages).where(and(eq(schema.messages.chatJid, chatJid), inArray(schema.messages.id, [...ids]), eq(schema.messages.isCommand, false))).orderBy(schema.messages.timestamp);
  return rows;
}

/** Attach a vision/label description to a media message. Caption (if any) stays as `text`; otherwise the description becomes searchable text. */
export async function setMediaDescription(chatJid: string, waId: string, description: string, opts: { keepText?: boolean } = {}) {
  await db
    .update(schema.messages)
    .set({
      media: dsql`coalesce(${schema.messages.media}, '{}'::jsonb) || ${JSON.stringify({ description })}::jsonb` as unknown as Record<string, unknown>,
      ...(opts.keepText ? {} : { text: dsql`coalesce(nullif(${schema.messages.text}, ''), ${description})` as unknown as string }),
    })
    .where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId)));
}

export async function markMessageAsCommand(chatJid: string, waId: string) {
  await db.update(schema.messages).set({ isCommand: true }).where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId)));
}

export type MessageQuery = {
  chatJid: string;
  since?: Date;
  until?: Date;
  limit?: number;
  /** newest first when true (API listing), oldest first when false (summaries) */
  newestFirst?: boolean;
  excludeCommands?: boolean;
};

export async function listMessages(q: MessageQuery) {
  const conds = [eq(schema.messages.chatJid, q.chatJid)];
  if (q.since) conds.push(gt(schema.messages.timestamp, q.since));
  if (q.until) conds.push(lte(schema.messages.timestamp, q.until));
  if (q.excludeCommands) conds.push(eq(schema.messages.isCommand, false));
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(...conds))
    .orderBy(q.newestFirst === false ? schema.messages.timestamp : desc(schema.messages.timestamp))
    .limit(q.limit ?? 100);
  return rows;
}

/** The last N messages of a chat in chronological order. */
export async function lastMessages(chatJid: string, n: number, opts: { excludeCommands?: boolean } = {}) {
  const rows = await listMessages({ chatJid, limit: n, newestFirst: true, excludeCommands: opts.excludeCommands });
  return rows.reverse();
}

/** Last message a user sent in a chat before `before` (excluding bot commands). */
export async function lastMessageFromUser(chatJid: string, userJid: string, before?: Date, phone?: string) {
  const who = phone ? dsql`(${schema.messages.senderJid} = ${userJid} or ${schema.messages.senderPhone} = ${phone})` : eq(schema.messages.senderJid, userJid);
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.chatJid, chatJid), who, eq(schema.messages.isCommand, false), before ? lte(schema.messages.timestamp, before) : undefined))
    .orderBy(desc(schema.messages.timestamp))
    .limit(1);
  return rows[0];
}

export async function findMessageByWaId(chatJid: string, waId: string) {
  const rows = await db.select().from(schema.messages).where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId))).limit(1);
  return rows[0];
}

export async function getChat(jid: string) {
  const rows = await db.select().from(schema.chats).where(eq(schema.chats.jid, jid)).limit(1);
  return rows[0];
}

export async function listChats(kind?: "group" | "dm") {
  return db
    .select()
    .from(schema.chats)
    .where(kind ? eq(schema.chats.kind, kind) : undefined)
    .orderBy(desc(schema.chats.lastMessageAt));
}

export async function listParticipants(chatJid: string, includeLeft = false) {
  return db
    .select()
    .from(schema.participants)
    .where(and(eq(schema.participants.chatJid, chatJid), includeLeft ? undefined : dsql`${schema.participants.leftAt} is null`));
}

/** Groups that a given user (by jid or phone) shares with the bot. */
export async function groupsForUser(userJid: string, phone?: string) {
  const conds = [eq(schema.participants.userJid, userJid)];
  if (phone) conds.push(eq(schema.participants.phone, phone));
  const rows = await db
    .select({ chat: schema.chats })
    .from(schema.participants)
    .innerJoin(schema.chats, eq(schema.chats.jid, schema.participants.chatJid))
    .where(and(dsql`(${conds.map((c) => dsql`${c}`).reduce((a, b) => dsql`${a} or ${b}`)})`, dsql`${schema.participants.leftAt} is null`, eq(schema.chats.kind, "group"), eq(schema.chats.botIsMember, true)))
    .orderBy(desc(schema.chats.lastMessageAt));
  const seen = new Set<string>();
  return rows.map((r) => r.chat).filter((c) => (seen.has(c.jid) ? false : (seen.add(c.jid), true)));
}

export async function saveSummary(s: typeof schema.summaries.$inferInsert) {
  const rows = await db.insert(schema.summaries).values(s).returning();
  return rows[0];
}

export async function listSummaries(chatJid?: string, limit = 50) {
  return db
    .select()
    .from(schema.summaries)
    .where(chatJid ? eq(schema.summaries.chatJid, chatJid) : undefined)
    .orderBy(desc(schema.summaries.createdAt))
    .limit(limit);
}

/** Archive summaries (written by retention before deleting old messages). Newest first. */
export async function listArchiveSummaries(chatJid: string, limit = 5) {
  return db
    .select()
    .from(schema.summaries)
    .where(and(eq(schema.summaries.chatJid, chatJid), eq(schema.summaries.trigger, "archive")))
    .orderBy(desc(schema.summaries.toTs))
    .limit(limit);
}

export async function searchArchiveSummaries(chatJid: string, terms: string[], limit = 5) {
  const clean = terms.map((t) => t.trim()).filter((t) => t.length >= 2);
  if (!clean.length) return [];
  const pattern = clean.map((t) => t.replace(/[%_\\]/g, (c) => "\\" + c)).join("|");
  return db
    .select()
    .from(schema.summaries)
    .where(and(eq(schema.summaries.chatJid, chatJid), eq(schema.summaries.trigger, "archive"), dsql`unaccent(${schema.summaries.text}) ~* unaccent(${pattern})`))
    .orderBy(desc(schema.summaries.toTs))
    .limit(limit);
}

export async function getSummary(id: number) {
  const rows = await db.select().from(schema.summaries).where(eq(schema.summaries.id, id)).limit(1);
  return rows[0];
}

/** Number of command-triggered summaries a user requested since `since`. */
export async function countUserSummariesSince(userJid: string, since: Date) {
  const [r] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.summaries)
    .where(and(eq(schema.summaries.requestedBy, userJid), eq(schema.summaries.trigger, "command"), gte(schema.summaries.createdAt, since)));
  return r?.n ?? 0;
}

/** Assistant invocations by a user since `since` (command rows that are @mentions rather than slash commands). */
export async function countAssistantCallsSince(userJid: string, since: Date, prefix: string) {
  const [r] = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.messages)
    .where(and(eq(schema.messages.senderJid, userJid), eq(schema.messages.isCommand, true), gte(schema.messages.timestamp, since), dsql`${schema.messages.text} not like ${prefix + "%"}`));
  return r?.n ?? 0;
}

/** Local-day key (YYYY-MM-DD in BOT_TIMEZONE). */
export function localDayKey(d = new Date()) {
  const tz = process.env.BOT_TIMEZONE || "Europe/Madrid";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export async function getUsage(userJid: string, kind: string, day = localDayKey()) {
  const rows = await db.select({ count: schema.usageCounters.count }).from(schema.usageCounters).where(and(eq(schema.usageCounters.userJid, userJid), eq(schema.usageCounters.kind, kind), eq(schema.usageCounters.day, day))).limit(1);
  return rows[0]?.count ?? 0;
}

export async function bumpUsage(userJid: string, kind: string, day = localDayKey()) {
  const rows = await db
    .insert(schema.usageCounters)
    .values({ userJid, kind, day, count: 1, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.usageCounters.userJid, schema.usageCounters.kind, schema.usageCounters.day], set: { count: dsql`${schema.usageCounters.count} + 1`, updatedAt: new Date() } })
    .returning({ count: schema.usageCounters.count });
  return rows[0]?.count ?? 1;
}

export async function getReadMark(chatJid: string, userJid: string) {
  const rows = await db.select().from(schema.readMarks).where(and(eq(schema.readMarks.chatJid, chatJid), eq(schema.readMarks.userJid, userJid))).limit(1);
  return rows[0];
}

export async function setReadMark(chatJid: string, userJid: string, at: Date) {
  await db
    .insert(schema.readMarks)
    .values({ chatJid, userJid, lastSummaryAt: at, updatedAt: new Date() })
    .onConflictDoUpdate({ target: [schema.readMarks.chatJid, schema.readMarks.userJid], set: { lastSummaryAt: at, updatedAt: new Date() } });
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return rows[0] ? (rows[0].value as T) : fallback;
}

export async function setSetting(key: string, value: unknown) {
  await db
    .insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } });
}

/** Returns true if this webhook event id was NOT seen before (and records it). */
export async function recordWebhookEvent(provider: string, id: string, event: string, payload: Record<string, unknown>) {
  const rows = await db
    .insert(schema.webhookEvents)
    .values({ id: `${provider}:${id}`, provider, event, payload })
    .onConflictDoNothing()
    .returning({ id: schema.webhookEvents.id });
  return rows.length > 0;
}


export function stickerStorageKey(sha256: string) {
  return `whats-bot/stickers/${Buffer.from(sha256, "base64").toString("hex")}.webp`;
}

/** Insert a sticker (first time) or bump its counters. The file goes to R2 when configured, else base64 in the row. */
export async function upsertSticker(input: { sha256: string; data: Buffer; mimetype?: string; isAnimated?: boolean; chatJid?: string; senderJid?: string; senderName?: string }) {
  const existing = await db.select().from(schema.stickers).where(eq(schema.stickers.sha256, input.sha256)).limit(1);
  if (existing[0]) {
    await db.update(schema.stickers).set({ timesSeen: dsql`${schema.stickers.timesSeen} + 1`, lastSeenAt: new Date() }).where(eq(schema.stickers.sha256, input.sha256));
    return { row: existing[0], isNew: false };
  }
  let storageKey: string | null = null;
  let data: string | null = null;
  if (r2Enabled()) {
    storageKey = stickerStorageKey(input.sha256);
    await r2.put(storageKey, input.data, input.mimetype?.split(";")[0] || "image/webp", { sha256: input.sha256 });
  } else data = input.data.toString("base64");
  const rows = await db
    .insert(schema.stickers)
    .values({ sha256: input.sha256, data, storageKey, mimetype: input.mimetype?.split(";")[0] || "image/webp", bytes: input.data.length, isAnimated: Boolean(input.isAnimated), firstChatJid: input.chatJid ?? null, firstSenderJid: input.senderJid ?? null, firstSenderName: input.senderName ?? null })
    .onConflictDoNothing()
    .returning();
  return { row: rows[0] ?? existing[0], isNew: rows.length > 0 };
}

/** The sticker's WebP bytes, from R2 or the legacy base64 column. */
export async function getStickerBytes(sha256: string): Promise<{ buffer: Buffer; mimetype: string } | undefined> {
  const s = await getSticker(sha256);
  if (!s) return undefined;
  if (s.storageKey) {
    const { buffer } = await r2.get(s.storageKey);
    return { buffer, mimetype: s.mimetype };
  }
  if (s.data) return { buffer: Buffer.from(s.data, "base64"), mimetype: s.mimetype };
  return undefined;
}

/** Move legacy base64 stickers into R2. Returns counts. */
export async function migrateStickersToR2(limit = 500) {
  if (!r2Enabled()) throw new Error("R2 not configured");
  const rows = await db.select({ sha256: schema.stickers.sha256, data: schema.stickers.data, mimetype: schema.stickers.mimetype }).from(schema.stickers).where(and(dsql`${schema.stickers.storageKey} is null`, dsql`${schema.stickers.data} is not null`)).limit(limit);
  let moved = 0, failed = 0;
  for (const r of rows) {
    try {
      const key = stickerStorageKey(r.sha256);
      await r2.put(key, Buffer.from(r.data!, "base64"), r.mimetype, { sha256: r.sha256 });
      await db.update(schema.stickers).set({ storageKey: key, data: null }).where(eq(schema.stickers.sha256, r.sha256));
      moved++;
    } catch (e) {
      failed++;
      log.warn({ err: String(e), sha256: r.sha256.slice(0, 12) }, "sticker migration to R2 failed");
    }
  }
  log.info({ moved, failed, remaining: rows.length - moved }, "stickers migrated to R2");
  return { checked: rows.length, moved, failed };
}

/** R2 keys of archived media for messages in a chat within a time range (used by retention). */
export async function mediaKeysForRange(chatJid: string, from: Date, to: Date): Promise<string[]> {
  const rows = await db
    .select({ key: dsql<string>`${schema.messages.media}->>'storageKey'` })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatJid, chatJid), gte(schema.messages.timestamp, from), lt(schema.messages.timestamp, to), dsql`${schema.messages.media}->>'storageKey' is not null`));
  return rows.map((r) => r.key).filter(Boolean);
}

/** Record where a message's media was archived. */
export async function setMediaStorageKey(chatJid: string, waId: string, storageKey: string) {
  await db
    .update(schema.messages)
    .set({ media: dsql`coalesce(${schema.messages.media}, '{}'::jsonb) || ${JSON.stringify({ storageKey })}::jsonb` as unknown as Record<string, unknown> })
    .where(and(eq(schema.messages.chatJid, chatJid), eq(schema.messages.waId, waId)));
}

export async function setStickerCaption(sha256: string, caption: string, tags: string[], model?: string) {
  await db.update(schema.stickers).set({ caption, tags, model: model ?? null }).where(eq(schema.stickers.sha256, sha256));
}

export async function getSticker(sha256: string) {
  const rows = await db.select().from(schema.stickers).where(eq(schema.stickers.sha256, sha256)).limit(1);
  return rows[0];
}

/** List stickers (without file data); `search` matches caption/tags, accent-insensitive. */
export async function listStickers(opts: { search?: string; limit?: number; chatJid?: string } = {}) {
  const conds = [];
  if (opts.search) conds.push(dsql`unaccent(coalesce(${schema.stickers.caption}, '') || ' ' || coalesce(${schema.stickers.tags}::text, '')) ~* unaccent(${opts.search})`);
  if (opts.chatJid) conds.push(eq(schema.stickers.firstChatJid, opts.chatJid));
  return db
    .select({ sha256: schema.stickers.sha256, caption: schema.stickers.caption, tags: schema.stickers.tags, isAnimated: schema.stickers.isAnimated, bytes: schema.stickers.bytes, timesSeen: schema.stickers.timesSeen, lastSeenAt: schema.stickers.lastSeenAt, firstSenderName: schema.stickers.firstSenderName, firstChatJid: schema.stickers.firstChatJid })
    .from(schema.stickers)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.stickers.timesSeen), desc(schema.stickers.lastSeenAt))
    .limit(opts.limit ?? 50);
}

/** A random captioned sticker from the library (optionally excluding some hashes). */
export async function randomSticker(exclude: string[] = []) {
  const rows = await db
    .select()
    .from(schema.stickers)
    .where(exclude.length ? dsql`${schema.stickers.sha256} not in ${exclude}` : undefined)
    .orderBy(dsql`random()`)
    .limit(1);
  return rows[0];
}

export async function countStickers() {
  const [r] = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.stickers);
  return r?.n ?? 0;
}

// ── Social / web lookups (assistant superpowers) ─────────────────────────────

/** Most recent successful lookup for this key newer than `since` (cache hit), or undefined. */
export async function findRecentSocialLookup(queryKey: string, since: Date) {
  const rows = await db
    .select()
    .from(schema.socialLookups)
    .where(and(eq(schema.socialLookups.queryKey, queryKey), eq(schema.socialLookups.ok, true), eq(schema.socialLookups.cached, false), gte(schema.socialLookups.createdAt, since)))
    .orderBy(desc(schema.socialLookups.createdAt))
    .limit(1);
  return rows[0];
}

export async function insertSocialLookup(input: {
  kind: SocialKind;
  query: string;
  queryKey: string;
  chatJid?: string;
  requestedBy?: string;
  requestedByName?: string;
  provider?: string;
  endpoint?: string;
  ok: boolean;
  error?: string;
  results?: SocialItem[];
  costUsd?: number;
  latencyMs?: number;
  cached?: boolean;
}) {
  const rows = await db
    .insert(schema.socialLookups)
    .values({
      kind: input.kind,
      query: input.query,
      queryKey: input.queryKey,
      chatJid: input.chatJid ?? null,
      requestedBy: input.requestedBy ?? null,
      requestedByName: input.requestedByName ?? null,
      provider: input.provider ?? null,
      endpoint: input.endpoint ?? null,
      ok: input.ok,
      error: input.error ?? null,
      resultCount: input.results?.length ?? 0,
      results: input.results ?? null,
      costUsd: input.costUsd ?? 0,
      latencyMs: input.latencyMs ?? null,
      cached: input.cached ?? false,
    })
    .returning({ id: schema.socialLookups.id });
  return rows[0]?.id;
}

/** Recent lookups (newest first) for GET /api/social. */
export async function listSocialLookups(opts: { kind?: SocialKind; chatJid?: string; limit?: number; includeResults?: boolean } = {}) {
  const conds = [] as ReturnType<typeof eq>[];
  if (opts.kind) conds.push(eq(schema.socialLookups.kind, opts.kind));
  if (opts.chatJid) conds.push(eq(schema.socialLookups.chatJid, opts.chatJid));
  const rows = await db
    .select()
    .from(schema.socialLookups)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(schema.socialLookups.createdAt))
    .limit(opts.limit ?? 50);
  return opts.includeResults ? rows : rows.map(({ results, ...r }) => ({ ...r, results: undefined, sample: results?.slice(0, 3).map((x) => x.title ?? x.text?.slice(0, 80) ?? x.url) }));
}

/** Spend + counts per kind (all time) for GET /api/social?stats=1. */
export async function socialLookupStats() {
  return db
    .select({ kind: schema.socialLookups.kind, provider: schema.socialLookups.provider, lookups: dsql<number>`count(*)::int`, cached: dsql<number>`sum(case when ${schema.socialLookups.cached} then 1 else 0 end)::int`, failed: dsql<number>`sum(case when ${schema.socialLookups.ok} then 0 else 1 end)::int`, costUsd: dsql<number>`coalesce(sum(${schema.socialLookups.costUsd}), 0)::float` })
    .from(schema.socialLookups)
    .groupBy(schema.socialLookups.kind, schema.socialLookups.provider)
    .orderBy(schema.socialLookups.kind);
}
