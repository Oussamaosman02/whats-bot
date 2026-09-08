import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";

/** POST /api/zernio/send {phone, text? | templateName, templateLanguage?, templateParams?} */
export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ phone: z.string().min(5), text: z.string().optional(), templateName: z.string().optional(), templateLanguage: z.string().optional(), templateParams: z.array(z.unknown()).optional() }).refine((v) => v.text || v.templateName, "Provide text or templateName"));
  return ok(await zernio.sendToPhone({ ...b, reqId }));
});
