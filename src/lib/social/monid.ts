/**
 * monid.ai transport – many data providers (context.dev web search / scrape, TikHub, Apify…) behind one
 * `POST {base}/run` endpoint. Ported from content-ai (`src/lib/providers/live/monid-run.ts`).
 *
 * Contract (verified live 2026-08/09):
 *   POST /run  { provider, endpoint, input: { body?, queryParams?, pathParams? } }
 *     → { runId, status: "COMPLETED" | "RUNNING" | "FAILED" | "BLOCKED" | "STOPPED" | "TIME_OUT", output, billing }
 *   GET  /runs/{runId}   – poll while RUNNING (submit is singular /run, poll is plural /runs)
 *   billing.reportedCost = { value, unit: "MICRO_DOLLAR" }
 */
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("monid");

export type MonidInput = { body?: Record<string, unknown>; queryParams?: Record<string, unknown>; pathParams?: Record<string, unknown> };
export type MonidResult = { output: Record<string, unknown>; costUsd: number; latencyMs: number; runId?: string };

type Envelope = {
  runId?: string;
  status: string;
  output?: Record<string, unknown> | null;
  billing?: { reportedCost?: { value: number; currency: string; unit?: string } };
  price?: { amount?: { value: number } };
  controls?: unknown;
  error?: unknown;
};

const TERMINAL_BAD = new Set(["FAILED", "BLOCKED", "STOPPED", "TIME_OUT"]);

export function monidEnabled() {
  return Boolean(env().MONID_API_KEY);
}

function costOf(e: Envelope): number {
  const rc = e.billing?.reportedCost;
  if (rc) return rc.unit === "MICRO_DOLLAR" ? rc.value / 1e6 : rc.value;
  return e.price?.amount?.value ?? 0;
}

async function monidFetch(path: string, init: RequestInit): Promise<Envelope> {
  const e = env();
  if (!e.MONID_API_KEY) throw AppError.notConfigured("monid.ai", ["MONID_API_KEY"]);
  let res: Response;
  try {
    res = await fetch(`${e.MONID_BASE_URL.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${e.MONID_API_KEY}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    log.error({ err: errInfo(err), path, hint: "Network error reaching api.monid.ai – check outbound connectivity / DNS." }, "monid request failed");
    throw new AppError(502, "monid_network_error", `Could not reach monid: ${errInfo(err).message}`, { hint: "Check outbound network access from the server.", cause: err });
  }
  const raw = await res.text();
  if (!res.ok) {
    const hint = res.status === 401 ? "MONID_API_KEY is invalid or revoked." : res.status === 402 ? "monid balance exhausted – top up at monid.ai." : res.status === 429 ? "Rate limited by monid – retry later." : "Inspect `data` for the raw monid error.";
    log.error({ status: res.status, path, body: raw.slice(0, 600), hint }, "monid returned an error");
    throw new AppError(502, "monid_upstream_error", `monid ${path} responded ${res.status}`, { hint, data: raw.slice(0, 600) });
  }
  try {
    return JSON.parse(raw) as Envelope;
  } catch {
    throw new AppError(502, "monid_bad_response", "monid returned non-JSON", { hint: "Transient gateway issue; retry.", data: raw.slice(0, 300) });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run one provider endpoint through monid and wait for its terminal state. */
export async function monidRun(provider: string, endpoint: string, input: MonidInput, opts: { pollMs?: number; timeoutMs?: number; reqId?: string } = {}): Promise<MonidResult> {
  const t0 = Date.now();
  let e = await monidFetch("/run", { method: "POST", body: JSON.stringify({ provider, endpoint, input }) });
  const timeoutMs = opts.timeoutMs ?? 90_000;
  while (e.status !== "COMPLETED") {
    if (TERMINAL_BAD.has(e.status)) {
      throw new AppError(502, "monid_run_failed", `monid run ${e.runId ?? "?"} ended ${e.status}`, { hint: e.status === "BLOCKED" ? "The site/provider blocked the request; try another query or provider." : "Provider-side failure; retry later.", data: e.controls ?? e.error });
    }
    if (Date.now() - t0 > timeoutMs) throw new AppError(504, "monid_timeout", `monid run ${e.runId ?? "?"} still ${e.status} after ${timeoutMs} ms`, { hint: "Slow provider; retry or lower the result count." });
    await sleep(opts.pollMs ?? 2500);
    e = await monidFetch(`/runs/${e.runId}`, { method: "GET" });
  }
  const r = { output: e.output ?? {}, costUsd: costOf(e), latencyMs: Date.now() - t0, runId: e.runId };
  log.info({ provider, endpoint, costUsd: r.costUsd, ms: r.latencyMs, runId: e.runId, reqId: opts.reqId }, "← monid ok");
  return r;
}
