/**
 * Central, validated environment access.
 *
 * Every variable is read here once so that a missing/invalid value fails fast with a
 * message that says exactly WHICH variable is wrong and WHAT to do about it.
 */
import { z } from "zod";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  DATABASE_URL: z
    .string({ error: "DATABASE_URL is required (Neon Postgres connection string)." })
    .min(1)
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must start with postgres:// or postgresql://",
    }),

  OPENROUTER_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default("google/gemini-2.5-flash-lite"),

  ZERNIO_API_KEY: optionalString,
  ZERNIO_WHATSAPP_ACCOUNT_ID: optionalString,
  ZERNIO_WEBHOOK_SECRET: optionalString,

  APP_URL: z.string().default("http://localhost:3000"),
  API_KEY: optionalString,
  DASHBOARD_PASSWORD: optionalString,
  WHATSAPP_AUTOSTART: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),

  BOT_NAME: z.string().default("ResumenBot"),
  BOT_LANGUAGE: z.string().default("es"),
  BOT_COMMAND_PREFIX: z.string().default("/"),
  BOT_TIMEZONE: z.string().default("Europe/Madrid"),
  DM_TRANSPORT: z.enum(["baileys", "zernio"]).default("baileys"),
  SUMMARY_MAX_MESSAGES: z.coerce.number().default(1500),
  /** char budget of the transcript sent with a question (≈ chars/4 tokens) */
  ASK_MAX_CHARS: z.coerce.number().default(400_000),
  /** model for /preguntar: consolidating hundreds of near-duplicate hits needs the stronger 2.5-flash */
  ASK_MODEL: z.string().default("google/gemini-2.5-flash"),
  ASK_MAX_BULLETS: z.coerce.number().default(14),
  /** @mention assistant mode (groups only) */
  ASSISTANT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  ASSISTANT_MODEL: optionalString,
  ASSISTANT_DAILY_LIMIT: z.coerce.number().default(20),
  /** audios (voice notes) a user can get from the assistant per day; ADMIN_PHONES exempt */
  ASSISTANT_AUDIO_DAILY_LIMIT: z.coerce.number().default(3),
  ASSISTANT_CONTEXT_MESSAGES: z.coerce.number().default(30),
  ASK_KEYWORD_HITS: z.coerce.number().default(300),
  ASK_RECENT_MESSAGES: z.coerce.number().default(200),
  TRANSCRIBE_AUDIO: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  TRANSCRIBE_MAX_SECONDS: z.coerce.number().default(900),
  TRANSCRIBE_MODEL: optionalString,
  /** Describe stickers / photos / video thumbnails with Gemini vision so summaries know what was sent */
  DESCRIBE_MEDIA: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_DEFAULT_VOICE_ID: optionalString,
  ELEVENLABS_SECONDARY_VOICE_ID: optionalString,
  ELEVENLABS_MODEL_ID: z.string().default("eleven_multilingual_v2"),
  TTS_MAX_CHARS: z.coerce.number().default(2500),
  CLOUDFLARE_R2_BUCKET_NAME: optionalString,
  CLOUDFLARE_S3_API_ENDPOINT: optionalString,
  CLOUDFLARE_S3_API_PUBLIC_ENDPOINT: optionalString,
  CLOUDFLARE_S3_ACCESS_KEY: optionalString,
  CLOUDFLARE_S3_SECRET_KEY: optionalString,
  /** Archive received media (audio, images, video ≤ MEDIA_ARCHIVE_MAX_MB) in R2 so it survives restarts */
  MEDIA_ARCHIVE: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  MEDIA_ARCHIVE_MAX_MB: z.coerce.number().default(15),
  RETENTION_DAYS: z.coerce.number().default(15),
  RETENTION_ARCHIVE: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  DAILY_SUMMARY_LIMIT: z.coerce.number().default(3),
  ALERT_PHONE: optionalString,
  ALERT_TEMPLATE_NAME: optionalString,
  ALERT_TEMPLATE_LANGUAGE: z.string().default("es"),
  ALERT_COOLDOWN_MINUTES: z.coerce.number().default(30),
  RETENTION_INCLUDE_IMPORTS: z
    .string()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  ADMIN_PHONES: z
    .string()
    .optional()
    .transform((v) => (v ?? "").split(",").map((x) => x.replace(/[^\d]/g, "")).filter(Boolean)),
  IMPORT_MAX_MB: z.coerce.number().default(200),
  IMPORT_DATE_FORMAT: z.enum(["auto", "dmy", "mdy"]).default("auto"),

  /** Social / web lookups for the assistant ("superpowers"): X/Twitter, YouTube, TikTok, Google, read a page */
  SOCIAL_SEARCH_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false" && v !== "0"),
  /** lookups (any kind) a user can trigger through the assistant per day; ADMIN_PHONES exempt */
  SOCIAL_DAILY_LIMIT: z.coerce.number().default(15),
  /** identical (kind, query) within this window is served from social_lookups instead of the provider */
  SOCIAL_CACHE_MINUTES: z.coerce.number().default(30),
  /** ISO-3166 alpha-2 country used to localise web / YouTube / TikTok searches */
  SOCIAL_COUNTRY: z.string().default("es"),
  /** monid.ai — many data providers (context.dev web search/scrape, TikHub…) behind one /run endpoint */
  MONID_API_KEY: optionalString,
  MONID_BASE_URL: z.string().default("https://api.monid.ai/v1"),
  /** treg.to — ~2,600 catalogued endpoints (X, YouTube, Google SERP, TikHub…) behind one proxy */
  TREG_TOKEN: optionalString,
  TREG_BASE_URL: z.string().default("https://treg.to"),
  TREG_ORG: optionalString,
  /** transcriptapi.com — YouTube search (free) + transcripts (1 credit each) */
  TRANSCRIPTAPI_API_KEY: optionalString,
  TRANSCRIPTAPI_BASE_URL: z.string().default("https://transcriptapi.com/api/v2"),
  /** twitterapi.io — tweet search & user timelines (header x-api-key) */
  TWITTERAPI_IO_API_KEY: optionalString,
  TWITTERAPI_IO_BASE_URL: z.string().default("https://api.twitterapi.io"),

  META_ACCESS_TOKEN: optionalString,
  META_PHONE_NUMBER_ID: optionalString,
  META_VERIFY_TOKEN: optionalString,
  META_APP_SECRET: optionalString,
  META_GRAPH_VERSION: z.string().default("v26.0"),

  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("debug"),
  LOG_FORMAT: z.enum(["pretty", "json"]).optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parse process.env once. Throws a readable error listing every problem. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  • ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(
      `Invalid environment configuration:\n${lines.join("\n")}\n` +
        `→ Compare your .env with .env.example and fix the variables above.`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Feature flags derived from which secrets are present. Used by /api/health and route guards. */
export function features() {
  const e = env();
  return {
    ai: Boolean(e.OPENROUTER_API_KEY),
    tts: Boolean(e.ELEVENLABS_API_KEY && e.ELEVENLABS_DEFAULT_VOICE_ID),
    r2: Boolean(e.CLOUDFLARE_S3_API_ENDPOINT && e.CLOUDFLARE_S3_ACCESS_KEY && e.CLOUDFLARE_S3_SECRET_KEY && e.CLOUDFLARE_R2_BUCKET_NAME),
    zernio: Boolean(e.ZERNIO_API_KEY),
    metaCloud: Boolean(e.META_ACCESS_TOKEN && e.META_PHONE_NUMBER_ID),
    apiAuth: Boolean(e.API_KEY),
    /** assistant search "superpowers" – each capability lists which provider serves it (direct key first, treg/monid as fallback) */
    social: {
      enabled: e.SOCIAL_SEARCH_ENABLED,
      twitter: Boolean(e.TWITTERAPI_IO_API_KEY || e.TREG_TOKEN),
      youtube: Boolean(e.TRANSCRIPTAPI_API_KEY || e.TREG_TOKEN),
      web: Boolean(e.MONID_API_KEY || e.TREG_TOKEN),
      tiktok: Boolean(e.MONID_API_KEY || e.TREG_TOKEN),
      monid: Boolean(e.MONID_API_KEY),
      treg: Boolean(e.TREG_TOKEN),
    },
  };
}
