import { route, ok } from "@/lib/api";
import { metaCloud } from "@/lib/meta/cloud";

type P = { id: string };
export const GET = route<P>(async ({ params }) => ok(await metaCloud.inviteLink(params.id)));
export const POST = route<P>(async ({ params }) => ok(await metaCloud.resetInviteLink(params.id)));
