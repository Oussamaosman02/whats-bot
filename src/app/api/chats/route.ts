import { route, ok, z } from "@/lib/api";
import { listChats } from "@/lib/store";

export const GET = route(async ({ query }) => {
  const { kind } = query(z.object({ kind: z.enum(["group", "dm"]).optional() }));
  return ok(await listChats(kind));
});
