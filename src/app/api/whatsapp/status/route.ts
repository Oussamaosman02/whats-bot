import { route, ok } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";

export const GET = route(async () => ok(whatsapp.getStatus()));
