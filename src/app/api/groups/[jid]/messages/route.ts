import { route, ok, z } from "@/lib/api";
import { listMessages } from "@/lib/store";

const Q = z.object({ since: z.string().optional(), until: z.string().optional(), limit: z.coerce.number().min(1).max(1000).default(100), order: z.enum(["asc", "desc"]).default("desc") });

export const GET = route<{ jid: string }>(async ({ params, query }) => {
  const q = query(Q);
  const rows = await listMessages({ chatJid: decodeURIComponent(params.jid), since: q.since ? new Date(q.since) : undefined, until: q.until ? new Date(q.until) : undefined, limit: q.limit, newestFirst: q.order === "desc" });
  return ok(rows);
});
