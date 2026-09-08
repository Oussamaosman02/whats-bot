import { route, ok } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

type P = { jid: string };
export const GET = route<P>(async ({ params }) => ok(await whatsapp.groupInvite(decodeURIComponent(params.jid))));
/** POST → revoke and return the new invite link */
export const POST = route<P>(async ({ params }) => ok(await whatsapp.groupInvite(decodeURIComponent(params.jid), true)));
