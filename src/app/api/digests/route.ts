import { route, ok } from "@/lib/api";
import { listDigests } from "@/lib/bot/digest";
import { env } from "@/lib/env";

/** GET /api/digests → every scheduled bulletin, soonest first. */
export const GET = route(async () => {
  const items = await listDigests();
  return ok({ enabled: env().DIGEST_ENABLED, timezone: env().BOT_TIMEZONE, maxLateMinutes: env().DIGEST_MAX_LATE_MINUTES, count: items.length, items });
});
