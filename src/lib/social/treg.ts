/**
 * treg.to transport – "OpenRouter for agent tools": ~2,600 catalogued endpoints behind ONE proxy that injects the
 * provider credential server-side. Ported from content-ai (`src/lib/providers/live/treg-run.ts`).
 *
 * Contract (verified live 2026-08/09):
 *   {METHOD} {base}/call/{endpoint-id}[?query]   header X-Treg-Token
 *   • a plain catalog id ("tikhub.tiktok.search.videos") relays the upstream body verbatim
 *   • a ROUTED id ("treg.x.search.posts", POST {q}) answers { output: {posts|videos|results: [...]}, raw, _treg: { served_by } }
 *   • cost in header X-Treg-Cost-Micro (MICRO_DOLLAR); X-Treg-Error: 1 marks treg's own refusal (e.g. 402 no balance)
 */
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("treg");

export type TregParams = { method?: "GET" | "POST"; queryParams?: Record<string, unknown>; body?: Record<string, unknown>; headers?: Record<string, string> };
export type TregResult = { output: Record<string, unknown>; costUsd: number; latencyMs: number; status: number; servedBy?: string };

export function tregEnabled() {
  return Boolean(env().TREG_TOKEN);
}

function callPath(endpointId: string, queryParams?: Record<string, unknown>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(queryParams ?? {})) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item));
    else qs.append(k, String(v));
  }
  const q = qs.toString();
  return `/call/${endpointId.replace(/^\/+/, "")}${q ? `?${q}` : ""}`;
}

/** Call a catalog endpoint through treg. `output` is the upstream JSON (routed ids: `{ output, raw, _treg }`). */
export async function tregCall(endpointId: string, params: TregParams = {}, opts: { reqId?: string } = {}): Promise<TregResult> {
  const e = env();
  if (!e.TREG_TOKEN) throw AppError.notConfigured("treg.to", ["TREG_TOKEN"]);
  const t0 = Date.now();
  const body = params.body ? JSON.stringify(params.body) : undefined;
  const method = params.method ?? (body ? "POST" : "GET");
  const headers: Record<string, string> = { "X-Treg-Token": e.TREG_TOKEN, "X-Treg-Client": "whats-bot", ...(params.headers ?? {}) };
  if (body) headers["Content-Type"] = "application/json";
  if (e.TREG_ORG) headers["X-Treg-Org"] = e.TREG_ORG;

  let res: Response;
  try {
    res = await fetch(`${e.TREG_BASE_URL.replace(/\/+$/, "")}${callPath(endpointId, params.queryParams)}`, { method, headers, body, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    log.error({ err: errInfo(err), endpointId, hint: "Network error reaching treg.to – check outbound connectivity / DNS." }, "treg request failed");
    throw new AppError(502, "treg_network_error", `Could not reach treg: ${errInfo(err).message}`, { hint: "Check outbound network access from the server.", cause: err });
  }
  const raw = await res.text();
  if (!res.ok) {
    const tregRefusal = res.headers.get("x-treg-error") === "1";
    const hint = res.status === 401 ? "TREG_TOKEN is invalid or revoked (treg login → treg org agent-new)." : res.status === 402 ? "treg balance exhausted – top up at treg.to." : tregRefusal ? "treg refused the call; check the endpoint id and params (treg catalog get <id>)." : "The upstream provider failed; inspect `data`.";
    log.error({ status: res.status, endpointId, tregRefusal, body: raw.slice(0, 600), hint }, "treg returned an error");
    throw new AppError(502, "treg_upstream_error", `treg ${endpointId} responded ${res.status}`, { hint, data: raw.slice(0, 600) });
  }
  let output: Record<string, unknown>;
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    output = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    output = { text: raw };
  }
  const micro = Number(res.headers.get("x-treg-cost-micro") ?? 0);
  const r: TregResult = { output, costUsd: Number.isFinite(micro) ? micro / 1e6 : 0, latencyMs: Date.now() - t0, status: res.status, servedBy: res.headers.get("x-treg-served-by") ?? ((output._treg as { served_by?: string } | undefined)?.served_by ?? undefined) };
  log.info({ endpointId, servedBy: r.servedBy, costUsd: r.costUsd, ms: r.latencyMs, reqId: opts.reqId }, "← treg ok");
  return r;
}
