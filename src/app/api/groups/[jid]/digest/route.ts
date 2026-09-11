import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getChat } from "@/lib/store";
import { deleteDigest, getDigest, runDigest, upsertDigest } from "@/lib/bot/digest";

type P = { jid: string };

const HOUR = z.string().regex(/^\d{1,2}(:\d{2})?h?$/, "HH:MM expected");

/** GET /api/groups/:jid/digest → the group's scheduled bulletin (404 when none). */
export const GET = route<P>(async ({ params }) => {
  const jid = decodeURIComponent(params.jid);
  const d = await getDigest(jid);
  if (!d) throw AppError.notFound(`Group ${jid} has no scheduled digest.`, "PUT /api/groups/:jid/digest {hours: ['06:00','14:00','22:00'], audio: true} to create one.");
  return ok(d);
});

/** PUT /api/groups/:jid/digest → create or update. `hours` is required the first time. */
export const PUT = route<P>(async ({ params, body, log }) => {
  const jid = decodeURIComponent(params.jid);
  const chat = await getChat(jid);
  if (!chat || chat.kind !== "group") throw AppError.notFound(`Group ${jid} not found in the store.`, "GET /api/groups?live=1 to sync groups first.");
  const input = await body(
    z.object({
      hours: z.array(HOUR).min(1).max(12).optional(),
      audio: z.boolean().optional(),
      style: z.enum(["brief", "bullets", "detailed"]).optional(),
      enabled: z.boolean().optional(),
      minMessages: z.number().int().min(1).max(500).optional(),
      createdBy: z.string().optional(),
    }),
  );
  const d = await upsertDigest({ chatJid: jid, ...input, createdByName: input.createdBy ? "api" : undefined });
  log.info({ chat: jid, hours: d.hours, audio: d.audio, next: d.nextRunAt }, "digest saved via API");
  return ok(d);
});

/** DELETE /api/groups/:jid/digest → remove the schedule. */
export const DELETE = route<P>(async ({ params }) => {
  const jid = decodeURIComponent(params.jid);
  const removed = await deleteDigest(jid);
  if (!removed) throw AppError.notFound(`Group ${jid} has no scheduled digest.`);
  return ok({ jid, removed: true });
});

/**
 * POST /api/groups/:jid/digest → post one bulletin right now (the schedule is untouched).
 * Without a saved digest, a transient one is used (voice, last 8 h). `force` ignores the minimum-messages rule.
 */
export const POST = route<P>(async ({ params, body }) => {
  const jid = decodeURIComponent(params.jid);
  const chat = await getChat(jid);
  if (!chat || chat.kind !== "group") throw AppError.notFound(`Group ${jid} not found in the store.`, "GET /api/groups?live=1 to sync groups first.");
  const input = await body(z.object({ since: z.string().datetime({ offset: true }).optional(), audio: z.boolean().optional(), force: z.boolean().optional(), style: z.enum(["brief", "bullets", "detailed"]).optional() }).default({}));
  const now = new Date();
  const saved = await getDigest(jid);
  const d = saved ?? { id: 0, chatJid: jid, hours: ["06:00", "14:00", "22:00"], audio: input.audio ?? true, style: input.style ?? "bullets", enabled: false, minMessages: 1, createdBy: null, createdByName: null, lastRunAt: new Date(now.getTime() - 8 * 3_600_000), lastSentAt: null, lastError: null, nextRunAt: now, createdAt: now, updatedAt: now };
  const r = await runDigest({ ...d, style: input.style ?? d.style }, { since: input.since ? new Date(input.since) : undefined, audio: input.audio, force: input.force ?? !saved });
  return ok({ jid, saved: Boolean(saved), ...r });
});
