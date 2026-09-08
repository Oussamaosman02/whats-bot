import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";

export const GET = route(async ({ query }) => {
  const q = query(z.object({ search: z.string().optional(), platform: z.string().default("whatsapp"), limit: z.coerce.number().max(200).default(50), skip: z.coerce.number().default(0) }));
  return ok(await zernio.contacts(q));
});
