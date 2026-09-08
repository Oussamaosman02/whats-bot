import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";
import { listParticipants } from "@/lib/store";

type P = { jid: string };

export const GET = route<P>(async ({ params, query }) => {
  const { live, includeLeft } = query(z.object({ live: z.string().optional(), includeLeft: z.string().optional() }));
  const jid = decodeURIComponent(params.jid);
  if (live === "1") await whatsapp.groupMeta(jid, true);
  return ok(await listParticipants(jid, includeLeft === "1"));
});

/** POST {participants: [...], action: add|promote|demote} */
export const POST = route<P>(async ({ params, body }) => {
  const jid = decodeURIComponent(params.jid);
  const { participants, action } = await body(z.object({ participants: z.array(z.string()).min(1), action: z.enum(["add", "promote", "demote"]).default("add") }));
  return ok(await whatsapp.groupParticipants(jid, participants, action));
});

/** DELETE {participants: [...]} → remove from group */
export const DELETE = route<P>(async ({ params, body }) => {
  const jid = decodeURIComponent(params.jid);
  const { participants } = await body(z.object({ participants: z.array(z.string()).min(1) }));
  return ok(await whatsapp.groupParticipants(jid, participants, "remove"));
});
