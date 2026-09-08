/**
 * Voice-note / audio transcription with Gemini (audio understanding via OpenRouter `input_audio`).
 */
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger } from "../logger";
import { chatComplete, type Completion } from "./gemini";

const log = getLogger("ai:transcribe");

const LANG_NAMES: Record<string, string> = { es: "Spanish", en: "English", pt: "Portuguese", fr: "French", de: "German", it: "Italian", ca: "Catalan" };

/** Map a mimetype (e.g. "audio/ogg; codecs=opus") to OpenRouter's audio `format`. */
export function audioFormat(mimetype?: string): string {
  const mt = (mimetype ?? "").toLowerCase();
  if (mt.includes("ogg") || mt.includes("opus")) return "ogg";
  if (mt.includes("mpeg") || mt.includes("mp3")) return "mp3";
  if (mt.includes("mp4") || mt.includes("m4a") || mt.includes("x-m4a")) return "m4a";
  if (mt.includes("aac")) return "aac";
  if (mt.includes("wav")) return "wav";
  if (mt.includes("flac")) return "flac";
  if (mt.includes("aiff")) return "aiff";
  if (mt.includes("webm")) return "webm";
  return "ogg"; // WhatsApp voice notes are ogg/opus
}

export async function transcribeAudio(
  buffer: Buffer,
  opts: { mimetype?: string; seconds?: number; language?: string; model?: string; reqId?: string; context?: string } = {},
): Promise<Completion & { transcript: string }> {
  if (!buffer.length) throw AppError.badRequest("Empty audio buffer.");
  const format = audioFormat(opts.mimetype);
  const lang = LANG_NAMES[opts.language ?? env().BOT_LANGUAGE] ?? opts.language ?? "Spanish";
  const model = opts.model ?? env().TRANSCRIBE_MODEL ?? env().GEMINI_MODEL;
  log.debug({ bytes: buffer.length, format, seconds: opts.seconds, model, reqId: opts.reqId }, "transcribing audio");
  const res = await chatComplete(
    [
      {
        role: "system",
        content: `You transcribe WhatsApp voice notes. Output ONLY the verbatim transcript in the language spoken (most likely ${lang}), with punctuation, no preamble, no quotes, no timestamps. If there is no intelligible speech, output exactly: [inaudible]`,
      },
      {
        role: "user",
        content: [
          { type: "text", text: opts.context ? `Context: ${opts.context}\nTranscribe this audio.` : "Transcribe this audio." },
          { type: "input_audio", input_audio: { data: buffer.toString("base64"), format } },
        ],
      },
    ],
    { model, temperature: 0, maxTokens: 4000, reqId: opts.reqId },
  );
  const transcript = res.text.replace(/^["“”']+|["“”']+$/g, "").trim();
  log.info({ chars: transcript.length, ms: res.ms, seconds: opts.seconds, reqId: opts.reqId }, "audio transcribed");
  return { ...res, transcript };
}
