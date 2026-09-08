import { route, ok, z } from "@/lib/api";
import { runSummary } from "@/lib/bot/service";
import { phoneFromJid, toJid } from "@/lib/whatsapp/jid";

export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ chatJid: z.string(), since: z.string().optional(), until: z.string().optional(), style: z.enum(["brief", "bullets", "detailed", "spoken", "spoken_detailed"]).optional(), focus: z.string().optional(), language: z.string().optional(), model: z.string().optional(), requester: z.string().optional() }));
  return ok(await runSummary({ chatJid: toJid(b.chatJid), since: b.since, until: b.until ? new Date(b.until) : undefined, style: b.style, focus: b.focus, language: b.language, model: b.model, requesterJid: b.requester ? toJid(b.requester) : undefined, requesterPhone: b.requester ? phoneFromJid(toJid(b.requester)) : undefined, reqId }));
});
