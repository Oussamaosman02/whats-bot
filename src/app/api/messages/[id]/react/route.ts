import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";
import { toJid } from "@/lib/whatsapp/jid";

export const POST = route<{ id: string }>(async ({ params, body }) => {
  const { chat, emoji } = await body(z.object({ chat: z.string(), emoji: z.string().max(8) }));
  await whatsapp.react(toJid(chat), params.id, emoji);
  return ok({ reacted: true });
});
