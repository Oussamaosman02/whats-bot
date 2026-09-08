import { route, ok, z } from "@/lib/api";
import { listStickers } from "@/lib/store";

/** GET /api/stickers?search=risa&limit=50&chat= → sticker library (captions, tags, usage counts). */
export const GET = route(async ({ query }) => {
  const q = query(z.object({ search: z.string().optional(), limit: z.coerce.number().min(1).max(500).default(50), chat: z.string().optional() }));
  const rows = await listStickers({ search: q.search, limit: q.limit, chatJid: q.chat });
  return ok(rows.map((r) => ({ ...r, url: `/api/stickers/${encodeURIComponent(r.sha256)}` })));
});
