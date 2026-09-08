import { route, ok } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

export const POST = route(async () => {
  await whatsapp.start();
  return ok(whatsapp.getStatus());
});
