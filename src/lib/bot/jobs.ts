/**
 * Scheduled messages (`/programar`) and reminders (`/recordar`), one-off or recurring.
 *
 * Rows live in `jobs`; the scheduler ticks every 30 s, claims each due row with
 * `UPDATE … SET status='running' WHERE id=? AND status='pending'` (so two processes never send the same job),
 * delivers it, then marks it done or – for recurring jobs – pending again at the next occurrence.
 * A job found more than JOBS_MAX_LATE_MINUTES late (server was down) is marked `missed` (recurring: skipped
 * to its next occurrence) instead of being sent at an odd time.
 */
import { and, asc, desc, eq, inArray, lte, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { AppError, isAppError } from "../errors";
import { errInfo, getLogger } from "../logger";
import { whatsapp } from "../whatsapp/client";
import { isGroupJid } from "../whatsapp/jid";
import { sendDm } from "./deliver";
import { fmtZoned } from "./since";
import { describeRecurrence, nextOccurrence } from "./when";
import type { Job, JobKind, JobStatus, Recurrence } from "../db/schema";

const log = getLogger("jobs");
const TICK_MS = 30_000;
const MAX_ATTEMPTS = 3;

export type NewJob = {
  kind: JobKind;
  chatJid: string;
  originJid?: string;
  text: string;
  mentions?: string[];
  dueAt: Date;
  recurrence?: Recurrence;
  createdBy?: string;
  createdByName?: string;
};

export async function createJob(input: NewJob): Promise<Job> {
  if (!input.text.trim()) throw AppError.badRequest("Job text is empty.", "Say what to send or remind.");
  if (input.dueAt.getTime() <= Date.now()) throw AppError.badRequest("dueAt is in the past.", "Give a future time.");
  const rows = await db
    .insert(schema.jobs)
    .values({ kind: input.kind, chatJid: input.chatJid, originJid: input.originJid ?? null, text: input.text.trim(), mentions: input.mentions?.length ? input.mentions : null, dueAt: input.dueAt, recurrence: input.recurrence ?? null, createdBy: input.createdBy ?? null, createdByName: input.createdByName ?? null })
    .returning();
  const job = rows[0];
  log.info({ id: job.id, kind: job.kind, chat: job.chatJid, due: job.dueAt.toISOString(), recurrence: job.recurrence?.kind, by: job.createdByName ?? job.createdBy }, "job created");
  return job;
}

export async function getJob(id: number): Promise<Job | undefined> {
  const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
  return rows[0];
}

export async function listJobs(opts: { chatJid?: string; createdBy?: string; status?: JobStatus[]; limit?: number } = {}): Promise<Job[]> {
  const conds = [];
  if (opts.chatJid) conds.push(eq(schema.jobs.chatJid, opts.chatJid));
  if (opts.createdBy) conds.push(eq(schema.jobs.createdBy, opts.createdBy));
  if (opts.status?.length) conds.push(inArray(schema.jobs.status, opts.status));
  const pendingOnly = opts.status?.length === 1 && opts.status[0] === "pending";
  return db
    .select()
    .from(schema.jobs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(pendingOnly ? asc(schema.jobs.dueAt) : desc(schema.jobs.dueAt))
    .limit(opts.limit ?? 50);
}

export async function countPendingByUser(createdBy: string): Promise<number> {
  const [r] = await db.select({ n: dsql<number>`count(*)::int` }).from(schema.jobs).where(and(eq(schema.jobs.createdBy, createdBy), eq(schema.jobs.status, "pending")));
  return r?.n ?? 0;
}

/** Cancel a pending job; returns the row or undefined when it was not pending. */
export async function cancelJob(id: number): Promise<Job | undefined> {
  const rows = await db.update(schema.jobs).set({ status: "cancelled", updatedAt: new Date() }).where(and(eq(schema.jobs.id, id), eq(schema.jobs.status, "pending"))).returning();
  if (rows[0]) log.info({ id }, "job cancelled");
  return rows[0];
}

const userPart = (jid: string) => jid.split("@")[0].split(":")[0];

/** Text + mentions as they go out. Reminders in a group mention their author so the phone buzzes. */
export function renderJob(job: Job): { text: string; mentions: string[] } {
  const group = isGroupJid(job.chatJid);
  const mentions = new Set(job.mentions ?? []);
  if (job.kind === "message") return { text: job.text, mentions: [...mentions] };
  if (group && job.createdBy) {
    mentions.add(job.createdBy);
    return { text: `⏰ @${userPart(job.createdBy)} ${job.text}`, mentions: [...mentions] };
  }
  return { text: `⏰ *Recordatorio:* ${job.text}`, mentions: [...mentions] };
}

/** Deliver one job now (used by the scheduler and by POST /api/jobs/:id/run). */
export async function deliverJob(job: Job, reqId: string): Promise<void> {
  const { text, mentions } = renderJob(job);
  if (isGroupJid(job.chatJid) || mentions.length) await whatsapp.sendText(job.chatJid, text, { mentions });
  else await sendDm(job.chatJid, text, reqId);
}

function nextDue(job: Job, now: Date): Date | undefined {
  if (!job.recurrence) return undefined;
  const tz = env().BOT_TIMEZONE;
  let next = nextOccurrence(job.recurrence, job.dueAt, tz);
  for (let k = 0; next <= now && k < 1000; k++) next = nextOccurrence(job.recurrence, next, tz);
  return next;
}

async function runOne(job: Job, now: Date) {
  const reqId = `job-${job.id}-${now.getTime().toString(36)}`;
  const jlog = log.child({ reqId, id: job.id, kind: job.kind, chat: job.chatJid });
  const lateMs = now.getTime() - job.dueAt.getTime();
  if (lateMs > env().JOBS_MAX_LATE_MINUTES * 60_000) {
    const next = nextDue(job, now);
    await db.update(schema.jobs).set(next ? { dueAt: next, lastError: `slot ${job.dueAt.toISOString()} missed (server down)`, updatedAt: now } : { status: "missed", lastError: "missed: the server was down at the time", updatedAt: now }).where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "pending")));
    jlog.warn({ lateMinutes: Math.round(lateMs / 60_000), next: next?.toISOString(), hint: "Raise JOBS_MAX_LATE_MINUTES to deliver late jobs anyway." }, next ? "job slot skipped (too late) – rescheduled" : "job missed (too late)");
    return;
  }
  const claimed = await db.update(schema.jobs).set({ status: "running", updatedAt: now }).where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "pending"))).returning();
  if (!claimed.length) return; // another process took it
  try {
    await deliverJob(job, reqId);
    const next = nextDue(job, now);
    await db
      .update(schema.jobs)
      .set(next ? { status: "pending", dueAt: next, sentAt: now, runs: job.runs + 1, attempts: 0, lastError: null, updatedAt: now } : { status: "done", sentAt: now, runs: job.runs + 1, attempts: 0, lastError: null, updatedAt: now })
      .where(eq(schema.jobs.id, job.id));
    jlog.info({ text: job.text.slice(0, 80), next: next?.toISOString(), lateSeconds: Math.round(lateMs / 1000) }, next ? "🗓️ job delivered – rescheduled" : "🗓️ job delivered");
  } catch (err) {
    const attempts = job.attempts + 1;
    const giveUp = attempts >= MAX_ATTEMPTS;
    await db
      .update(schema.jobs)
      .set(giveUp ? { status: "failed", attempts, lastError: errInfo(err).message.slice(0, 500), updatedAt: now } : { status: "pending", attempts, dueAt: new Date(now.getTime() + attempts * 2 * 60_000), lastError: errInfo(err).message.slice(0, 500), updatedAt: now })
      .where(eq(schema.jobs.id, job.id));
    jlog.error({ err: errInfo(err), attempts, hint: isAppError(err) ? err.hint : giveUp ? "Gave up after 3 attempts." : "Retried in a couple of minutes." }, giveUp ? "job failed" : "job delivery failed – will retry");
  }
}

let timer: NodeJS.Timeout | undefined;
let ticking = false;

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = new Date();
    const due = await db.select().from(schema.jobs).where(and(eq(schema.jobs.status, "pending"), lte(schema.jobs.dueAt, now))).orderBy(asc(schema.jobs.dueAt)).limit(50);
    if (!due.length) return;
    if (whatsapp.getStatus().status !== "open") {
      log.warn({ due: due.length, hint: "Jobs are due but WhatsApp is not connected; retrying every 30 s (GET /api/whatsapp/status)." }, "job tick – not connected");
      return;
    }
    for (const [i, job] of due.entries()) {
      await runOne(job, now);
      if (i < due.length - 1) await new Promise((r) => setTimeout(r, 2_000 + Math.random() * 3_000)); // human-like pacing
    }
  } catch (err) {
    log.error({ err: errInfo(err), hint: "Job scheduler tick failed; retried in 30 s. Check DATABASE_URL and that `npm run db:push` created the jobs table." }, "job tick failed");
  } finally {
    ticking = false;
  }
}

/** Start the job loop (idempotent). */
export function startJobScheduler() {
  if (timer) return;
  setTimeout(() => void tick(), 25_000);
  timer = setInterval(() => void tick(), TICK_MS);
  void db
    .select({ n: dsql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(eq(schema.jobs.status, "pending"))
    .then(([r]) => log.info({ pending: r?.n ?? 0, maxLateMinutes: env().JOBS_MAX_LATE_MINUTES }, "job scheduler started (every 30 s)"))
    .catch((err) => log.warn({ err: errInfo(err), hint: "Run `npm run db:push` to create the jobs table." }, "job scheduler could not read the jobs table"));
}

/** One line for /programados: "#12 · mañana 09:00 · ⏰ llevar el pastel (cada día)". */
export function describeJob(job: Job, opts: { chatName?: string | null } = {}) {
  const tz = env().BOT_TIMEZONE;
  const rec = describeRecurrence(job.recurrence, job.dueAt, tz);
  const icon = job.kind === "reminder" ? "⏰" : "🗓️";
  return `*#${job.id}* · ${fmtZoned(job.dueAt, tz)}${rec ? ` (${rec})` : ""} · ${icon} ${job.text.length > 80 ? job.text.slice(0, 77) + "…" : job.text}${opts.chatName ? ` _→ ${opts.chatName}_` : ""}`;
}
