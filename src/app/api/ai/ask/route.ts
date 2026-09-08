import { route, ok, z } from "@/lib/api";
import { runQuestion } from "@/lib/bot/service";
import { toJid } from "@/lib/whatsapp/jid";

export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ chatJid: z.string(), question: z.string().min(2), since: z.string().optional(), language: z.string().optional(), model: z.string().optional(), spoken: z.boolean().optional() }));
  return ok(await runQuestion({ ...b, chatJid: toJid(b.chatJid), reqId }));
});
