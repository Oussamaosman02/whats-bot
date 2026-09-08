import { route, ok, z } from "@/lib/api";
import { metaCloud } from "@/lib/meta/cloud";

type P = { id: string };
export const GET = route<P>(async ({ params }) => ok(await metaCloud.participants(params.id)));
export const DELETE = route<P>(async ({ params, body }) => {
  const { participants } = await body(z.object({ participants: z.array(z.string()).min(1) }));
  return ok(await metaCloud.removeParticipants(params.id, participants));
});
