import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { whatsapp } from "@/lib/whatsapp/client";
import { getChat, listParticipants } from "@/lib/store";

type P = { jid: string };

export const GET = route<P>(async ({ params, query }) => {
  const { live } = query(z.object({ live: z.string().optional() }));
  const jid = decodeURIComponent(params.jid);
  if (live === "1" || live === "true") {
    const meta = await whatsapp.groupMeta(jid, true);
    return ok({ jid: meta.id, name: meta.subject, description: meta.desc, owner: meta.owner, creation: meta.creation, announce: meta.announce, restrict: meta.restrict, participants: meta.participants.map((p) => ({ id: p.id, phone: (p as { phoneNumber?: string }).phoneNumber, admin: p.admin ?? null })) });
  }
  const chat = await getChat(jid);
  if (!chat) throw AppError.notFound(`Group ${jid} not found in the store.`, "Use ?live=1 to fetch it from WhatsApp, or GET /api/groups?live=1 to sync all groups.");
  const participants = await listParticipants(jid);
  return ok({ ...chat, participants });
});

export const PATCH = route<P>(async ({ params, body }) => {
  const jid = decodeURIComponent(params.jid);
  const patch = await body(z.object({ subject: z.string().max(100).optional(), description: z.string().max(2048).optional(), setting: z.enum(["announcement", "not_announcement", "locked", "unlocked"]).optional() }).refine((v) => Object.keys(v).length > 0, "Provide subject, description or setting"));
  const meta = await whatsapp.groupUpdate(jid, patch);
  return ok({ jid: meta.id, name: meta.subject, description: meta.desc, announce: meta.announce, restrict: meta.restrict });
});

/** DELETE /api/groups/:jid → the bot leaves the group. */
export const DELETE = route<P>(async ({ params }) => {
  const jid = decodeURIComponent(params.jid);
  await whatsapp.groupLeave(jid);
  return ok({ jid, left: true });
});
