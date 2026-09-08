import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";

export const GET = route(async ({ query }) => {
  const q = query(z.object({ accountId: z.string().optional(), status: z.string().optional(), language: z.string().optional(), name: z.string().optional() }));
  const accountId = q.accountId ?? (await zernio.whatsappAccountId());
  return ok(await zernio.templates(accountId, q));
});
