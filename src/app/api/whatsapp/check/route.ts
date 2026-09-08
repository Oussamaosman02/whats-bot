import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

/** GET /api/whatsapp/check?phone=34600111222 → is this number on WhatsApp? */
export const GET = route(async ({ query }) => {
  const { phone } = query(z.object({ phone: z.string().min(5) }));
  return ok(await whatsapp.checkNumber(phone));
});
