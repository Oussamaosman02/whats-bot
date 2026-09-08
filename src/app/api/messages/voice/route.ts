import { route, ok, z } from "@/lib/api";
import { synthesize } from "@/lib/ai/tts";
import { whatsapp } from "@/lib/whatsapp/client";

/** POST /api/messages/voice {to, text, voice?: default|secondary|<voiceId>, quotedId?} → sends a WhatsApp voice note. */
export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ to: z.string().min(3), text: z.string().min(1).max(5000), voice: z.string().optional(), language: z.string().optional(), quotedId: z.string().optional() }));
  const a = await synthesize(b.text, { voice: b.voice, language: b.language, reqId });
  const sent = await whatsapp.sendVoice(b.to, a.buffer, { mimetype: a.mimetype, quotedId: b.quotedId });
  return ok({ ...sent, chars: a.chars, bytes: a.buffer.length, voiceId: a.voiceId, ms: a.ms });
});
