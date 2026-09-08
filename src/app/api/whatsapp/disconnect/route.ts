import { route, ok } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

export const POST = route(async () => {
  await whatsapp.stop();
  return ok(whatsapp.getStatus());
});
