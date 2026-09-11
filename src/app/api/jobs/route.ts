import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { env } from "@/lib/env";
import { toJid } from "@/lib/whatsapp/jid";
import { createJob, listJobs } from "@/lib/bot/jobs";
import type { JobStatus } from "@/lib/db/schema";
import { parseWhen, WHEN_HELP } from "@/lib/bot/when";

/** GET /api/jobs?chat=&status=pending,done&limit= → scheduled messages and reminders. */
export const GET = route(async ({ query }) => {
  const q = query(z.object({ chat: z.string().optional(), status: z.string().optional(), createdBy: z.string().optional(), limit: z.coerce.number().min(1).max(200).optional() }));
  const status: JobStatus[] = q.status ? (q.status.split(",") as JobStatus[]) : ["pending"];
  const items = await listJobs({ chatJid: q.chat ? toJid(q.chat) : undefined, createdBy: q.createdBy, status, limit: q.limit });
  return ok({ timezone: env().BOT_TIMEZONE, count: items.length, items });
});

/**
 * POST /api/jobs {chat, text, when?: "mañana 9:00" | dueAt?: ISO, kind?: message|reminder, mentions?, recurrence?}
 * `when` uses the same natural-language grammar as /recordar; `recurrence` is ignored when `when` already says "cada …".
 */
export const POST = route(async ({ body }) => {
  const b = await body(
    z.object({
      chat: z.string().min(3),
      text: z.string().min(1).max(4000),
      when: z.string().optional(),
      dueAt: z.string().datetime({ offset: true }).optional(),
      kind: z.enum(["message", "reminder"]).default("message"),
      mentions: z.array(z.string()).optional(),
      recurrence: z.union([z.object({ kind: z.literal("daily") }), z.object({ kind: z.literal("weekdays") }), z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6) }), z.object({ kind: z.literal("interval"), ms: z.number().int().min(600_000) })]).optional(),
      createdBy: z.string().optional(),
    }),
  );
  let dueAt: Date | undefined;
  let recurrence = b.recurrence;
  if (b.when) {
    const w = parseWhen(b.when, { timeZone: env().BOT_TIMEZONE });
    if ("error" in w) throw AppError.badRequest(`Cannot parse when="${b.when}" (${w.error}).`, WHEN_HELP);
    dueAt = w.at;
    recurrence = w.recurrence ?? recurrence;
  } else if (b.dueAt) dueAt = new Date(b.dueAt);
  if (!dueAt) throw AppError.badRequest("Give `when` (natural language) or `dueAt` (ISO 8601).", WHEN_HELP);
  const job = await createJob({ kind: b.kind, chatJid: toJid(b.chat), text: b.text, mentions: b.mentions?.map(toJid), dueAt, recurrence, createdBy: b.createdBy ? toJid(b.createdBy) : "api", createdByName: "api" });
  return ok(job, { status: 201 });
});
