import { route, ok, z } from "@/lib/api";
import { runActionItems } from "@/lib/bot/service";
import { whatsapp } from "@/lib/whatsapp/client";
import { toJid, phoneFromJid } from "@/lib/whatsapp/jid";

/**
 * POST /api/groups/:jid/actions {since?: "7d", for?: {name?, phone?}, deliver?: "group"|"none"}
 * → open tasks, promises, unanswered questions and debts (the /pendientes command).
 */
export const POST = route<{ jid: string }>(async ({ params, body, reqId }) => {
  const jid = decodeURIComponent(params.jid);
  const b = await body(z.object({ since: z.string().optional(), for: z.object({ name: z.string().optional(), phone: z.string().optional(), jid: z.string().optional() }).optional(), language: z.string().optional(), model: z.string().optional(), deliver: z.enum(["group", "none"]).optional() }).default({}));
  const forJid = b.for?.jid ? toJid(b.for.jid) : b.for?.phone ? toJid(b.for.phone) : undefined;
  const res = await runActionItems({ chatJid: jid, since: b.since, forJid, forName: b.for?.name ?? (forJid ? phoneFromJid(forJid) : undefined), forPhone: b.for?.phone ?? (forJid ? phoneFromJid(forJid) : undefined), language: b.language, model: b.model, reqId });
  let delivered: { to: string; id: string | null } | undefined;
  if ((b.deliver ?? "none") === "group") delivered = await whatsapp.sendText(jid, `📋 *Pendientes* – ${res.label}\n\n${res.text}`);
  return ok({ ...res, delivered });
});
