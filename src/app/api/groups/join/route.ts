import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

/** POST {code} or {link} → join a group via invite */
export const POST = route(async ({ body }) => {
  const { code, link } = await body(z.object({ code: z.string().optional(), link: z.string().optional() }).refine((v) => v.code || v.link, "Provide code or link"));
  return ok(await whatsapp.groupJoin((code ?? link)!));
});
