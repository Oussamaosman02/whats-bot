import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";

export const GET = route(async ({ query }) => {
  const q = query(z.object({ platform: z.string().default("whatsapp"), status: z.string().optional(), limit: z.coerce.number().max(100).default(50), cursor: z.string().optional(), accountId: z.string().optional() }));
  return ok(await zernio.conversations(q));
});
