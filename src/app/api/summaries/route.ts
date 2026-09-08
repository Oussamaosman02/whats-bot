import { route, ok, z } from "@/lib/api";
import { listSummaries } from "@/lib/store";

export const GET = route(async ({ query }) => {
  const { chat, limit } = query(z.object({ chat: z.string().optional(), limit: z.coerce.number().min(1).max(200).default(50) }));
  return ok(await listSummaries(chat, limit));
});
