import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

export const GET = route(async ({ query }) => {
  const { code } = query(z.object({ code: z.string().min(4) }));
  const meta = await whatsapp.groupInviteInfo(code);
  return ok({ jid: meta.id, name: meta.subject, description: meta.desc, size: meta.size ?? meta.participants?.length, owner: meta.owner });
});
