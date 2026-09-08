import { route, ok, z } from "@/lib/api";
import { metaCloud } from "@/lib/meta/cloud";

export const GET = route(async () => ok(await metaCloud.listGroups()));
export const POST = route(async ({ body }) => {
  const b = await body(z.object({ subject: z.string().min(1).max(100), description: z.string().max(2048).optional() }));
  return ok(await metaCloud.createGroup(b), { status: 201 });
});
