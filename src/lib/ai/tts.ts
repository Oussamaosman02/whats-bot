/**
 * Text-to-speech with ElevenLabs → Ogg/Opus, which WhatsApp plays natively as a voice note.
 */
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("tts");
const BASE = "https://api.elevenlabs.io/v1";

export type TtsResult = { buffer: Buffer; mimetype: string; chars: number; voiceId: string; ms: number };

/** Strip WhatsApp markdown and list markers so they are not read aloud. */
export function speakable(text: string): string {
  return text
    .replace(/[*_~]{1,2}([^*_~\n]+)[*_~]{1,2}/g, "$1")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/https?:\/\/\S+/g, "(enlace)")
    .replace(/[📝🎤📩📍⛔✅⚠️👍🏓📎📥📦]/gu, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function ttsEnabled() {
  const e = env();
  return Boolean(e.ELEVENLABS_API_KEY && e.ELEVENLABS_DEFAULT_VOICE_ID);
}

export async function synthesize(text: string, opts: { voice?: "default" | "secondary" | string; language?: string; reqId?: string } = {}): Promise<TtsResult> {
  const e = env();
  if (!e.ELEVENLABS_API_KEY || !e.ELEVENLABS_DEFAULT_VOICE_ID) throw AppError.notConfigured("Text-to-speech (ElevenLabs)", ["ELEVENLABS_API_KEY", "ELEVENLABS_DEFAULT_VOICE_ID"]);
  const voiceId = opts.voice === "secondary" ? (e.ELEVENLABS_SECONDARY_VOICE_ID ?? e.ELEVENLABS_DEFAULT_VOICE_ID) : !opts.voice || opts.voice === "default" ? e.ELEVENLABS_DEFAULT_VOICE_ID : opts.voice;
  let clean = speakable(text);
  if (clean.length > e.TTS_MAX_CHARS) {
    log.warn({ chars: clean.length, max: e.TTS_MAX_CHARS }, "text too long for one voice note – truncating");
    clean = clean.slice(0, e.TTS_MAX_CHARS).replace(/[^.!?]*$/, "") + " Fin del audio.";
  }
  const t0 = Date.now();
  const url = `${BASE}/text-to-speech/${voiceId}?output_format=opus_48000_64`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": e.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/ogg" },
      body: JSON.stringify({ text: clean, model_id: e.ELEVENLABS_MODEL_ID, language_code: opts.language ?? e.BOT_LANGUAGE, voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true } }),
    });
  } catch (err) {
    throw new AppError(502, "tts_network_error", `Could not reach ElevenLabs: ${errInfo(err).message}`, { cause: err });
  }
  if (!res.ok) {
    const body = await res.text();
    const hint =
      res.status === 401
        ? "ELEVENLABS_API_KEY is invalid."
        : res.status === 402 || body.includes("quota")
          ? "ElevenLabs character quota exhausted – check the subscription (GET /api/tts/status)."
          : res.status === 422
            ? "Invalid voice_id / model_id / language_code for this account."
            : "See `data` for the raw ElevenLabs error.";
    log.error({ status: res.status, body: body.slice(0, 500), voiceId, hint }, "elevenlabs error");
    throw AppError.upstream("ElevenLabs", res.status, body.slice(0, 500), hint);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const chars = Number(res.headers.get("x-character-count") ?? clean.length);
  log.info({ chars, bytes: buffer.length, voiceId, ms: Date.now() - t0, reqId: opts.reqId }, "🔊 speech synthesised");
  return { buffer, mimetype: "audio/ogg; codecs=opus", chars, voiceId, ms: Date.now() - t0 };
}

export async function ttsStatus() {
  const e = env();
  if (!e.ELEVENLABS_API_KEY) return { ok: false as const, error: "ELEVENLABS_API_KEY not set", hint: "Optional: set ELEVENLABS_API_KEY + ELEVENLABS_DEFAULT_VOICE_ID to send voice notes." };
  const res = await fetch(`${BASE}/user/subscription`, { headers: { "xi-api-key": e.ELEVENLABS_API_KEY } });
  if (!res.ok) return { ok: false as const, error: `ElevenLabs /user/subscription → ${res.status}`, hint: "Key invalid?" };
  const j = (await res.json()) as { tier?: string; character_count?: number; character_limit?: number; next_character_count_reset_unix?: number };
  return { ok: true as const, tier: j.tier, charactersUsed: j.character_count, characterLimit: j.character_limit, remaining: (j.character_limit ?? 0) - (j.character_count ?? 0), resetsAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString() : undefined, voice: e.ELEVENLABS_DEFAULT_VOICE_ID, model: e.ELEVENLABS_MODEL_ID };
}
