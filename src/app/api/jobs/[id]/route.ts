import { route, ok, z } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { cancelJob, deliverJob, getJob } from "@/lib/bot/jobs";

type P = { id: string };
const parseId = (raw: string) => {
  const id = z.coerce.number().int().positive().safeParse(raw);
  if (!id.success) throw AppError.badRequest(`"${raw}" is not a job id.`);
  return id.data;
};

export const GET = route<P>(async ({ params }) => {
  const job = await getJob(parseId(params.id));
  if (!job) throw AppError.notFound(`Job ${params.id} not found.`);
  return ok(job);
});

/** DELETE /api/jobs/:id → cancel a pending job. */
export const DELETE = route<P>(async ({ params }) => {
  const id = parseId(params.id);
  const job = await cancelJob(id);
  if (!job) {
    const existing = await getJob(id);
    if (!existing) throw AppError.notFound(`Job ${id} not found.`);
    throw AppError.badRequest(`Job ${id} is ${existing.status}, only pending jobs can be cancelled.`);
  }
  return ok(job);
});

/** POST /api/jobs/:id → deliver it right now (schedule untouched). */
export const POST = route<P>(async ({ params, reqId }) => {
  const job = await getJob(parseId(params.id));
  if (!job) throw AppError.notFound(`Job ${params.id} not found.`);
  await deliverJob(job, reqId);
  return ok({ id: job.id, delivered: true });
});
