/**
 * Drizzle schema (Postgres / Neon).
 *
 * Tables:
 *   chats            – every group / DM the bot has seen
 *   participants     – group membership snapshot
 *   messages         – every message (from Baileys, Zernio or Meta Cloud), deduped
 *   summaries        – generated summaries (audit + "resume from where I left")
 *   read_marks       – per (chat, user) pointer of the last summary delivered
 *   webhook_events   – inbound webhook ids for idempotency
 *   settings         – key/value runtime settings (bot config, worker status…)
 *   stickers         – sticker library (file in R2 + AI caption)
 *   social_lookups   – every X/YouTube/TikTok/web lookup the assistant made (audit, cost, short-lived cache)
 *   digests          – scheduled group bulletins ("breaking news"): fixed local hours, text or voice note
 *   jobs             – one-off / recurring scheduled messages and reminders (claimed atomically by the scheduler)
 *   baileys_auth     – Baileys credentials/keys so the worker is stateless
 */
import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  serial,
  doublePrecision,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** Per-group bot settings (set with /bienvenida, /config or PATCH /api/groups/:jid {settings}). */
export type GroupSettings = {
  /** DM newcomers a summary of the last `welcomeDays` days (default off) */
  welcomeBrief?: boolean;
  welcomeDays?: number;
};

export const chats = pgTable("chats", {
  jid: text("jid").primaryKey(),
  kind: text("kind").$type<"group" | "dm">().notNull(),
  name: text("name"),
  botIsMember: boolean("bot_is_member").notNull().default(true),
  participantCount: integer("participant_count"),
  description: text("description"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  /** bot settings for this chat – separate from `metadata` (which WhatsApp group syncs overwrite) */
  settings: jsonb("settings").$type<GroupSettings>(),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const participants = pgTable(
  "participants",
  {
    chatJid: text("chat_jid").notNull(),
    userJid: text("user_jid").notNull(),
    phone: text("phone"),
    name: text("name"),
    isAdmin: boolean("is_admin").notNull().default(false),
    leftAt: timestamp("left_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatJid, t.userJid] }), index("participants_user_idx").on(t.userJid)],
);

export type MessageSource = "baileys" | "zernio" | "cloud" | "import";

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    waId: text("wa_id").notNull(),
    chatJid: text("chat_jid").notNull(),
    senderJid: text("sender_jid"),
    senderPhone: text("sender_phone"),
    senderName: text("sender_name"),
    fromMe: boolean("from_me").notNull().default(false),
    type: text("type").notNull().default("text"),
    text: text("text"),
    media: jsonb("media").$type<Record<string, unknown>>(),
    quotedId: text("quoted_id"),
    mentions: jsonb("mentions").$type<string[]>(),
    source: text("source").$type<MessageSource>().notNull(),
    isCommand: boolean("is_command").notNull().default(false),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("messages_chat_wa_idx").on(t.chatJid, t.waId),
    index("messages_chat_ts_idx").on(t.chatJid, t.timestamp),
    index("messages_sender_idx").on(t.senderJid),
  ],
);

export const summaries = pgTable(
  "summaries",
  {
    id: serial("id").primaryKey(),
    chatJid: text("chat_jid").notNull(),
    requestedBy: text("requested_by"),
    trigger: text("trigger").notNull().default("api"), // api | command
    fromTs: timestamp("from_ts", { withTimezone: true }).notNull(),
    toTs: timestamp("to_ts", { withTimezone: true }).notNull(),
    messageCount: integer("message_count").notNull(),
    text: text("text").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    deliveredTo: text("delivered_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("summaries_chat_idx").on(t.chatJid, t.createdAt)],
);

export const readMarks = pgTable(
  "read_marks",
  {
    chatJid: text("chat_jid").notNull(),
    userJid: text("user_jid").notNull(),
    lastSummaryAt: timestamp("last_summary_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chatJid, t.userJid] })],
);

export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  event: text("event").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Sticker library: every sticker seen, with its file and an AI caption (humour/intent aware). */
export const stickers = pgTable(
  "stickers",
  {
    sha256: text("sha256").primaryKey(),
    /** WebP bytes, base64 – only when R2 is not configured (legacy); otherwise null and `storageKey` is set */
    data: text("data"),
    /** R2 object key, e.g. stickers/<sha256hex>.webp */
    storageKey: text("storage_key"),
    mimetype: text("mimetype").notNull().default("image/webp"),
    bytes: integer("bytes").notNull(),
    isAnimated: boolean("is_animated").notNull().default(false),
    caption: text("caption"),
    /** short tags for search, e.g. ["risa","gato","sarcasmo"] */
    tags: jsonb("tags").$type<string[]>(),
    model: text("model"),
    firstChatJid: text("first_chat_jid"),
    firstSenderJid: text("first_sender_jid"),
    firstSenderName: text("first_sender_name"),
    timesSeen: integer("times_seen").notNull().default(1),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("stickers_last_seen_idx").on(t.lastSeenAt)],
);

/** Cache of Gemini descriptions of photos / video thumbnails keyed by file hash. */
export const mediaDescriptions = pgTable("media_descriptions", {
  sha256: text("sha256").primaryKey(),
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-user daily counters (e.g. assistant audios). `day` is the local date in BOT_TIMEZONE (YYYY-MM-DD). */
export const usageCounters = pgTable(
  "usage_counters",
  {
    userJid: text("user_jid").notNull(),
    kind: text("kind").notNull(),
    day: text("day").notNull(),
    count: integer("count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userJid, t.kind, t.day] })],
);

export type SocialKind = "tweets" | "user_tweets" | "youtube" | "youtube_transcript" | "web" | "url" | "tiktok";

/** One provider-agnostic hit (tweet, video, page, search result…) as stored and as handed to Gemini. */
export type SocialItem = {
  id?: string;
  title?: string;
  text?: string;
  url?: string;
  author?: string;
  /** ISO date or the provider's human label ("2 days ago") */
  date?: string;
  metrics?: Record<string, number>;
};

/**
 * Social / web lookups made through the assistant or POST /api/social (like `stickers`, but for the outside world):
 * what was asked, by whom, which provider answered, what it cost, and the folded results so an identical query
 * within SOCIAL_CACHE_MINUTES is served from here instead of paying the provider again.
 */
export const socialLookups = pgTable(
  "social_lookups",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").$type<SocialKind>().notNull(),
    query: text("query").notNull(),
    /** normalised `${kind}:${query}` used for cache hits */
    queryKey: text("query_key").notNull(),
    chatJid: text("chat_jid"),
    requestedBy: text("requested_by"),
    requestedByName: text("requested_by_name"),
    /** twitterapi | transcriptapi | monid | treg | fetch | cache */
    provider: text("provider"),
    endpoint: text("endpoint"),
    ok: boolean("ok").notNull().default(true),
    error: text("error"),
    resultCount: integer("result_count").notNull().default(0),
    results: jsonb("results").$type<SocialItem[]>(),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms"),
    /** true when served from an earlier row instead of the provider */
    cached: boolean("cached").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("social_lookups_key_idx").on(t.queryKey, t.createdAt), index("social_lookups_chat_idx").on(t.chatJid, t.createdAt)],
);

export type DigestStyle = "brief" | "bullets" | "detailed";

/**
 * Scheduled digest per group: at each hour in `hours` (HH:MM, BOT_TIMEZONE) the bot posts a summary of what was said
 * since the previous run – as a voice note when `audio` is set. One row per group; the in-process scheduler
 * (src/lib/bot/digest.ts) claims a row by advancing `nextRunAt` atomically, so a restart never double-posts.
 */
export const digests = pgTable(
  "digests",
  {
    id: serial("id").primaryKey(),
    chatJid: text("chat_jid").notNull().unique(),
    /** local wall-clock times, sorted, e.g. ["06:00","14:00","22:00"] */
    hours: jsonb("hours").$type<string[]>().notNull(),
    audio: boolean("audio").notNull().default(true),
    style: text("style").$type<DigestStyle>().notNull().default("bullets"),
    enabled: boolean("enabled").notNull().default(true),
    /** fewer stored messages than this since the last run → the slot is skipped silently */
    minMessages: integer("min_messages").notNull().default(5),
    createdBy: text("created_by"),
    createdByName: text("created_by_name"),
    /** start of the window of the next digest (set when a slot is claimed) */
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    /** last time a digest was actually posted */
    lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
    lastError: text("last_error"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("digests_next_run_idx").on(t.enabled, t.nextRunAt)],
);

export type JobKind = "message" | "reminder";
export type JobStatus = "pending" | "running" | "done" | "cancelled" | "failed" | "missed";
export type Recurrence = { kind: "daily" } | { kind: "weekdays" } | { kind: "weekly"; weekday: number } | { kind: "interval"; ms: number };

/**
 * Scheduled messages (`/programar`, posted as the bot) and reminders (`/recordar`, mention the author).
 * `dueAt` is the next fire time; recurring jobs go back to `pending` with a new `dueAt` after each run.
 * Claimed with `UPDATE … WHERE status = 'pending'` so two processes never send the same job.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").$type<JobKind>().notNull(),
    /** where it is delivered: a group jid or a user jid (DM) */
    chatJid: text("chat_jid").notNull(),
    /** where the command was typed (DM vs group) – for listing */
    originJid: text("origin_jid"),
    text: text("text").notNull(),
    mentions: jsonb("mentions").$type<string[]>(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    recurrence: jsonb("recurrence").$type<Recurrence>(),
    status: text("status").$type<JobStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runs: integer("runs").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_due_idx").on(t.status, t.dueAt), index("jobs_chat_idx").on(t.chatJid, t.status), index("jobs_creator_idx").on(t.createdBy, t.status)],
);

export const baileysAuth = pgTable("baileys_auth", {
  id: text("id").primaryKey(),
  data: text("data").notNull(), // BufferJSON-encoded
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Chat = typeof chats.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Summary = typeof summaries.$inferSelect;
export type SocialLookup = typeof socialLookups.$inferSelect;
export type Digest = typeof digests.$inferSelect;
export type Job = typeof jobs.$inferSelect;
