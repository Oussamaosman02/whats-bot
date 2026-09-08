import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";

export const GET = route(async ({ query }) => {
  const { platform } = query(z.object({ platform: z.string().optional() }));
  const { accounts } = await zernio.accounts({ platform });
  return ok(accounts.map((a) => ({ id: a._id, platform: a.platform, displayName: a.displayName, username: (a as { username?: string }).username, isActive: a.isActive, profileId: a.profileId })));
});
