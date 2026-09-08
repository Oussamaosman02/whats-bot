import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";

type P = { id: string };
export const GET = route<P>(async ({ params, query }) => {
  const q = query(z.object({ accountId: z.string().optional(), limit: z.coerce.number().max(100).default(100), cursor: z.string().optional(), sortOrder: z.enum(["asc", "desc"]).default("asc") }));
  const accountId = q.accountId ?? (await zernio.whatsappAccountId());
  return ok(await zernio.messages(params.id, { ...q, accountId }));
});
export const POST = route<P>(async ({ params, body }) => {
  const b = await body(z.object({ accountId: z.string().optional(), message: z.string().optional(), attachmentUrl: z.string().url().optional(), attachmentType: z.enum(["image", "video", "audio", "file"]).optional(), replyTo: z.string().optional() }).refine((v) => v.message || v.attachmentUrl, "Provide message or attachmentUrl"));
  const accountId = b.accountId ?? (await zernio.whatsappAccountId());
  return ok(await zernio.sendToConversation(params.id, { ...b, accountId }));
});
