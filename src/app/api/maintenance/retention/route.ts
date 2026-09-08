import { route, ok, z } from "@/lib/api";
import { retentionStats, runRetention } from "@/lib/maintenance";

export const GET = route(async () => ok(await retentionStats()));
/** POST {dryRun?: boolean, days?: number} → delete (or count) rows older than the window. */
export const POST = route(async ({ body }) => {
  const b = await body(z.object({ dryRun: z.boolean().default(false), days: z.number().min(1).max(3650).optional() }));
  return ok(await runRetention(b));
});
