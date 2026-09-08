import { route, ok, z } from "@/lib/api";
import { draftReply } from "@/lib/ai/summarize";
import { getChat, lastMessages } from "@/lib/store";
import { whatsapp } from "@/lib/whatsapp/client";
import { toJid } from "@/lib/whatsapp/jid";
import { AppError } from "@/lib/errors";

/** POST /api/ai/reply {chatJid, instruction?, send?} → Gemini drafts the next message; send=true posts it. */
export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ chatJid: z.string(), instruction: z.string().optional(), context: z.coerce.number().min(1).max(200).default(40), language: z.string().optional(), model: z.string().optional(), send: z.boolean().default(false) }));
  const jid = toJid(b.chatJid);
  const chat = await getChat(jid);
  if (!chat) throw AppError.notFound(`Chat ${jid} unknown.`);
  const msgs = await lastMessages(jid, b.context);
  const draft = await draftReply(msgs, { chatName: chat.name ?? undefined, instruction: b.instruction, language: b.language, model: b.model, reqId });
  const sent = b.send ? await whatsapp.sendText(jid, draft.text) : undefined;
  return ok({ text: draft.text, model: draft.model, sent });
});
