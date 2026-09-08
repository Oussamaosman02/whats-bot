import { route, ok, z } from "@/lib/api";
import { runQuestion } from "@/lib/bot/service";

export const POST = route<{ jid: string }>(async ({ params, body, reqId }) => {
  const b = await body(z.object({ question: z.string().min(2), since: z.string().optional(), language: z.string().optional(), model: z.string().optional(), spoken: z.boolean().optional() }));
  return ok(await runQuestion({ chatJid: decodeURIComponent(params.jid), ...b, reqId }));
});
