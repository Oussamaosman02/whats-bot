import { route, ok } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

/** Unlink the device and wipe the stored session. Next GET /api/whatsapp/qr shows a fresh QR. */
export const POST = route(async ({ log }) => {
  await whatsapp.logout();
  log.warn("WhatsApp session wiped by API request");
  return ok(whatsapp.getStatus());
});
