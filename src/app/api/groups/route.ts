import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";
import { listChats } from "@/lib/store";

/** GET /api/groups?live=1 → groups the bot is in. live=1 re-syncs from WhatsApp first. */
export const GET = route(async ({ query }) => {
  const { live } = query(z.object({ live: z.string().optional() }));
  if (live === "1" || live === "true") await whatsapp.syncGroups();
  const rows = await listChats("group");
  return ok(rows.map((c) => ({ jid: c.jid, name: c.name, participantCount: c.participantCount, botIsMember: c.botIsMember, description: c.description, lastMessageAt: c.lastMessageAt, metadata: c.metadata })));
});

/** POST /api/groups {subject, participants: ["34600111222", ...]} */
export const POST = route(async ({ body }) => {
  const { subject, participants } = await body(z.object({ subject: z.string().min(1).max(100), participants: z.array(z.string()).min(1) }));
  const meta = await whatsapp.groupCreate(subject, participants);
  return ok({ jid: meta.id, subject: meta.subject, participants: meta.participants.map((p) => ({ id: p.id, admin: p.admin ?? null })) }, { status: 201 });
});
