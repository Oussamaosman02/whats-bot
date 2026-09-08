import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { whatsapp } from "@/lib/whatsapp/client";
import { findMessageByWaId, setMessageTranscript } from "@/lib/store";
import { toJid } from "@/lib/whatsapp/jid";
import { transcribeAudio } from "@/lib/ai/transcribe";

/** POST /api/messages/:id/transcribe {chat, force?} → transcript of a voice note (stored on the message). */
export const POST = route<{ id: string }>(async ({ params, body, reqId }) => {
  const { chat, force } = await body(z.object({ chat: z.string(), force: z.boolean().default(false) }));
  const chatJid = toJid(chat);
  const stored = await findMessageByWaId(chatJid, params.id);
  if (!stored) throw AppError.notFound(`Message ${params.id} not found in chat ${chatJid}.`);
  if (stored.type !== "audio") throw AppError.badRequest(`Message ${params.id} is a ${stored.type} message, not audio.`);
  const existing = stored.media?.transcript as string | undefined;
  if (existing && !force) return ok({ transcript: existing, cached: true });
  const media = await whatsapp.getMediaBuffer(chatJid, params.id);
  if (!media) throw AppError.notFound("Audio not available.", "Not in memory and not archived in R2.");
  const t = await transcribeAudio(media.buffer, { mimetype: media.mimetype ?? (stored.media?.mimetype as string | undefined), seconds: stored.media?.seconds as number | undefined, reqId });
  await setMessageTranscript(chatJid, params.id, t.transcript, { model: t.model, ms: t.ms });
  return ok({ transcript: t.transcript, cached: false });
});
