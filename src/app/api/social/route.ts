import { route, ok, z } from "@/lib/api";
import { listSocialLookups, socialLookupStats } from "@/lib/store";
import { SOCIAL_KINDS, socialCapabilities, socialLookup } from "@/lib/social";
import type { SocialKind } from "@/lib/db/schema";

const kindSchema = z.enum(SOCIAL_KINDS as [SocialKind, ...SocialKind[]]);

/** GET /api/social?kind=&chat=&limit=&results=1 → recent lookups; ?stats=1 → spend per kind/provider. */
export const GET = route(async ({ query }) => {
  const q = query(z.object({ kind: kindSchema.optional(), chat: z.string().optional(), limit: z.coerce.number().min(1).max(500).default(50), results: z.string().optional(), stats: z.string().optional() }));
  if (q.stats === "1") return ok({ capabilities: socialCapabilities(), stats: await socialLookupStats() });
  return ok({ capabilities: socialCapabilities(), lookups: await listSocialLookups({ kind: q.kind, chatJid: q.chat, limit: q.limit, includeResults: q.results === "1" }) });
});

/** POST /api/social {kind, query, limit?, latest?, force?} → run a lookup (same path the assistant uses). */
export const POST = route(async ({ body, reqId }) => {
  const b = await body(z.object({ kind: kindSchema, query: z.string().min(1).max(500), limit: z.coerce.number().min(1).max(20).optional(), latest: z.boolean().optional(), force: z.boolean().optional() }));
  const r = await socialLookup(b.kind, b.query, { limit: b.limit, latest: b.latest, force: b.force, reqId, requestedBy: "api" });
  return ok(r);
});
