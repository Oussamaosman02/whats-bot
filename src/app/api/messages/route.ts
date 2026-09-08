import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { whatsapp } from "@/lib/whatsapp/client";
import { zernio } from "@/lib/zernio/client";
import { metaCloud } from "@/lib/meta/cloud";
import { isGroupJid, phoneFromJid, toJid } from "@/lib/whatsapp/jid";
import { listMessages } from "@/lib/store";

const Send = z.object({
  to: z.string().min(3).describe("group jid (…@g.us), phone (34600111222) or user jid"),
  text: z.string().max(65_000).optional(),
  media: z.object({ url: z.string().url(), type: z.enum(["image", "video", "audio", "document"]), caption: z.string().optional(), fileName: z.string().optional(), mimetype: z.string().optional() }).optional(),
  quotedId: z.string().optional(),
  mentions: z.array(z.string()).optional(),
  via: z.enum(["auto", "baileys", "zernio", "cloud"]).default("auto"),
  template: z.object({ name: z.string(), language: z.string().default("es"), params: z.array(z.unknown()).optional() }).optional(),
}).refine((v) => v.text || v.media || v.template, "Provide text, media or template");

/**
 * POST /api/messages — the router from the brief:
 *   groups (@g.us)      → Baileys (linked device)
 *   DMs                 → DM_TRANSPORT (baileys | zernio); via=cloud forces Meta Cloud API
 */
export const POST = route(async ({ body, reqId, log }) => {
  const b = await body(Send);
  const jid = toJid(b.to);
  const group = isGroupJid(jid);
  let via = b.via;
  if (via === "auto") via = group ? "baileys" : env().DM_TRANSPORT;
  if (b.template && via === "baileys") via = env().ZERNIO_API_KEY ? "zernio" : "cloud";
  log.debug({ to: jid, group, via }, "routing outbound message");

  if (via === "baileys") {
    if (b.media) return ok(await whatsapp.sendMedia(jid, b.media));
    return ok(await whatsapp.sendText(jid, b.text!, { quotedId: b.quotedId, mentions: b.mentions }));
  }
  if (group) throw AppError.badRequest(`Groups can only be reached via Baileys (via=baileys); ${via} does not support this group.`, "Use via=baileys or via=auto for @g.us targets. Cloud groups use /api/cloud/messages.");
  const phone = phoneFromJid(jid);
  if (!phone) throw AppError.badRequest(`Cannot derive a phone number from ${jid}.`, "Send a phone number (with country code) as `to` for Zernio/Cloud sends.");
  if (via === "zernio") {
    const r = await zernio.sendToPhone({ phone, text: b.text, templateName: b.template?.name, templateLanguage: b.template?.language, templateParams: b.template?.params, reqId });
    return ok({ id: r.messageId, conversationId: r.conversationId, to: phone, via });
  }
  const r = b.template ? await metaCloud.sendTemplate(phone, { name: b.template.name, language: b.template.language, components: b.template.params as unknown[] }) : await metaCloud.sendText(phone, b.text!);
  return ok({ id: r.messages?.[0]?.id, to: phone, via });
});

export const GET = route(async ({ query }) => {
  const q = query(z.object({ chat: z.string(), since: z.string().optional(), until: z.string().optional(), limit: z.coerce.number().min(1).max(1000).default(100) }));
  return ok(await listMessages({ chatJid: toJid(q.chat), since: q.since ? new Date(q.since) : undefined, until: q.until ? new Date(q.until) : undefined, limit: q.limit }));
});
