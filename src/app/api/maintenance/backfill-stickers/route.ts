import { route, ok, z } from "@/lib/api";
import { backfillStickers } from "@/lib/import/backfill-stickers";

/** POST /api/maintenance/backfill-stickers {dryRun?, limit?} → recover stickers seen only via the Zernio webhook. */
export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ dryRun: z.boolean().default(false), limit: z.number().min(1).max(2000).optional() }));
  return ok(await backfillStickers({ ...b, reqId }));
});
