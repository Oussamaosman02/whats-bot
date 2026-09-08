import { route, ok, z } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";
import { env } from "@/lib/env";

export const GET = route(async () => ok(await zernio.webhooks()));

/** POST /api/zernio/webhooks {url?, secret?, events?} → registers THIS app as a Zernio webhook. */
export const POST = route(async ({ body, log }) => {
  const b = await body(z.object({ url: z.string().url().optional(), secret: z.string().optional(), events: z.array(z.string()).optional(), name: z.string().max(50).optional() }));
  const url = b.url ?? `${env().APP_URL.replace(/\/$/, "")}/api/webhooks/zernio`;
  const secret = b.secret ?? env().ZERNIO_WEBHOOK_SECRET;
  const events = b.events ?? ["message.received", "message.sent", "conversation.started", "account.connected", "account.disconnected"];
  const res = await zernio.createWebhook({ name: b.name ?? `${env().BOT_NAME} inbox`, url, secret, events, isActive: true });
  log.info({ url, events, signed: Boolean(secret) }, "zernio webhook registered");
  if (!secret) log.warn({ hint: "Set ZERNIO_WEBHOOK_SECRET and re-register so inbound webhooks are signature-verified." }, "webhook registered WITHOUT a secret");
  return ok(res, { status: 201 });
});

export const DELETE = route(async ({ query }) => {
  const { id } = query(z.object({ id: z.string() }));
  return ok(await zernio.deleteWebhook(id));
});
