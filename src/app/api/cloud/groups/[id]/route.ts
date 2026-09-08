import { route, ok, z } from "@/lib/api";
import { metaCloud } from "@/lib/meta/cloud";

type P = { id: string };
export const GET = route<P>(async ({ params }) => ok(await metaCloud.getGroup(params.id)));
export const PATCH = route<P>(async ({ params, body }) => ok(await metaCloud.updateGroup(params.id, await body(z.object({ subject: z.string().optional(), description: z.string().optional() })))));
export const DELETE = route<P>(async ({ params }) => ok(await metaCloud.deleteGroup(params.id)));
