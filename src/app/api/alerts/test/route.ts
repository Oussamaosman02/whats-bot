import { route, ok, z } from "@/lib/api";
import { sendAlert } from "@/lib/alerts";
import { whatsapp } from "@/lib/whatsapp/client";

/** POST /api/alerts/test {message?} → sends a test alert to ALERT_PHONE via Zernio (template, then free-text fallback). */
export const POST = route(async ({ body }) => {
  const { message } = await body(z.object({ message: z.string().max(500).optional() }).default({}));
  const res = await sendAlert("test", message ?? "Prueba de alerta desde la API.", whatsapp.getStatus().status, { force: true });
  return ok(res, { status: res.sent ? 200 : 502 });
});
