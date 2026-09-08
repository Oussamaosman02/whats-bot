import { route, ok } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getSummary } from "@/lib/store";

export const GET = route<{ id: string }>(async ({ params }) => {
  const s = await getSummary(Number(params.id));
  if (!s) throw AppError.notFound(`Summary ${params.id} not found.`);
  return ok(s);
});
