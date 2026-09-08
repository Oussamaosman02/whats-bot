import { route, ok, z } from "@/lib/api";
import { runSummary } from "@/lib/bot/service";
import { whatsapp } from "@/lib/whatsapp/client";
import { zernio } from "@/lib/zernio/client";
import { env } from "@/lib/env";
import { phoneFromJid, toJid } from "@/lib/whatsapp/jid";

const Body = z.object({
  since: z.string().optional().describe("last | mymessage | hoy | ayer 15:00 | lunes | 08/09 10:30 | 2026-09-08 10:30 | 3h | 2d | 50 | todo"),
  until: z.string().optional(),
  style: z.enum(["brief", "bullets", "detailed", "spoken", "spoken_detailed"]).optional(),
  focus: z.string().optional(),
  language: z.string().optional(),
  model: z.string().optional(),
  requester: z.string().optional().describe("user jid/phone whose read-mark should be used and advanced"),
  deliver: z.enum(["none", "group", "dm"]).default("none"),
  to: z.string().optional().describe("phone/jid for deliver=dm (defaults to requester)"),
});

/** POST /api/groups/:jid/summarize → generate a summary; optionally post it to the group or DM someone. */
export const POST = route<{ jid: string }>(async ({ params, body, reqId, log }) => {
  const jid = decodeURIComponent(params.jid);
  const b = await body(Body);
  const requesterJid = b.requester ? toJid(b.requester) : undefined;
  const res = await runSummary({ chatJid: jid, since: b.since, until: b.until ? new Date(b.until) : undefined, style: b.style, focus: b.focus, language: b.language, model: b.model, requesterJid, requesterPhone: requesterJid ? phoneFromJid(requesterJid) : undefined, trigger: "api", reqId });
  const text = `📝 *Resumen${res.chatName ? ` de ${res.chatName}` : ""}* – ${res.label}\n_${res.messageCount} mensajes_\n\n${res.text}`;
  let delivered: { to: string; id: string | null } | undefined;
  if (b.deliver === "group") delivered = await whatsapp.sendText(jid, text);
  if (b.deliver === "dm") {
    const target = b.to ?? requesterJid;
    if (!target) throw new Error("deliver=dm needs `to` or `requester`");
    const phone = phoneFromJid(toJid(target));
    if (env().DM_TRANSPORT === "zernio" && phone) {
      const r = await zernio.sendToPhone({ phone, text, reqId });
      delivered = { to: phone, id: r.messageId };
    } else delivered = await whatsapp.sendText(target, text);
  }
  log.info({ summaryId: res.id, delivered }, "summary done");
  return ok({ ...res, delivered });
});
