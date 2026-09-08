/**
 * Gemini access through OpenRouter (OpenAI-compatible chat completions).
 * Model is always a google/gemini-* id (GEMINI_MODEL). Nothing else is ever used.
 */
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("ai");
const BASE = "https://openrouter.ai/api/v1";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: string } }
  | { type: "image_url"; image_url: { url: string } };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | ContentPart[] | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolDef = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };

function contentChars(c: ChatMessage["content"]) {
  if (!c) return 0;
  return typeof c === "string" ? c.length : c.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);
}
function contentKinds(messages: ChatMessage[]) {
  const kinds = new Set<string>();
  for (const m of messages) if (m.content && typeof m.content !== "string") for (const p of m.content) kinds.add(p.type);
  return [...kinds];
}

export type Completion = {
  text: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  /** "stop" | "length" (hit max_tokens) | "tool_calls" | other provider values */
  finishReason?: string;
  toolCalls?: ToolCall[];
  ms: number;
};

function headers() {
  const key = env().OPENROUTER_API_KEY;
  if (!key) throw AppError.notConfigured("AI (OpenRouter/Gemini)", ["OPENROUTER_API_KEY"]);
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "HTTP-Referer": env().APP_URL,
    "X-Title": env().BOT_NAME,
  };
}

export function resolveModel(override?: string): string {
  const model = override ?? env().GEMINI_MODEL;
  if (!model.startsWith("google/gemini")) {
    throw AppError.badRequest(`Model "${model}" is not a Gemini model.`, "Only google/gemini-* models are allowed (GEMINI_MODEL or the `model` field). See GET /api/ai/models.");
  }
  return model;
}

export async function chatComplete(
  messages: ChatMessage[],
  opts: { model?: string; temperature?: number; maxTokens?: number; reqId?: string; tools?: ToolDef[]; toolChoice?: "auto" | "none" | "required" } = {},
): Promise<Completion> {
  const model = resolveModel(opts.model);
  const t0 = Date.now();
  const body: Record<string, unknown> = { model, messages, temperature: opts.temperature ?? 0.3, max_tokens: opts.maxTokens ?? 2048 };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  log.debug({ model, messages: messages.length, chars: messages.reduce((n, m) => n + contentChars(m.content), 0), parts: contentKinds(messages), reqId: opts.reqId }, "→ openrouter chat/completions");

  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  } catch (e) {
    log.error({ err: errInfo(e), hint: "Network error reaching openrouter.ai – check outbound connectivity / DNS." }, "openrouter request failed");
    throw new AppError(502, "ai_network_error", `Could not reach OpenRouter: ${errInfo(e).message}`, { hint: "Check outbound network access from the server.", cause: e });
  }

  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw);
  } catch {
    /* non-JSON error page */
  }

  if (!res.ok) {
    const hint =
      res.status === 401
        ? "OPENROUTER_API_KEY is invalid or revoked."
        : res.status === 402
          ? "OpenRouter account has no credits – top up at openrouter.ai/credits."
          : res.status === 404
            ? `Model "${model}" does not exist on OpenRouter. GET /api/ai/models lists valid Gemini ids.`
            : res.status === 429
              ? "Rate limited by OpenRouter/Gemini – retry with backoff or pick a different Gemini model."
              : "Inspect `data` for the raw OpenRouter error.";
    log.error({ status: res.status, model, body: raw.slice(0, 800), hint }, "openrouter returned an error");
    throw new AppError(502, "ai_upstream_error", `OpenRouter responded ${res.status} for model ${model}`, { hint, data: json.error ?? raw.slice(0, 800) });
  }

  const choice = (json.choices as { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[] | undefined)?.[0];
  const text = choice?.message?.content?.trim() ?? "";
  const toolCalls = choice?.message?.tool_calls;
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const ms = Date.now() - t0;
  log.info({ model, ms, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, finish: choice?.finish_reason, tools: toolCalls?.map((t) => t.function.name), reqId: opts.reqId }, "← openrouter ok");
  if (!text && !toolCalls?.length) {
    throw new AppError(502, "ai_empty_response", "Gemini returned an empty response.", { hint: "Usually a safety filter or max_tokens=0; check `data`.", data: json });
  }
  if (choice?.finish_reason === "length") log.warn({ model, maxTokens: body.max_tokens, hint: "Output was cut by max_tokens; the caller trims the partial last line." }, "completion truncated");
  return { text, model: (json.model as string) ?? model, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, finishReason: choice?.finish_reason, toolCalls, ms };
}

/** List Gemini models available on OpenRouter for this key. */
export async function listGeminiModels() {
  const res = await fetch(`${BASE}/models`, { headers: headers() });
  if (!res.ok) throw AppError.upstream("OpenRouter", res.status, await res.text());
  const json = (await res.json()) as { data: { id: string; name: string; context_length: number; pricing: { prompt: string; completion: string } }[] };
  return json.data
    .filter((m) => m.id.startsWith("google/gemini"))
    .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length, pricePerMTokens: { prompt: Number(m.pricing.prompt) * 1e6, completion: Number(m.pricing.completion) * 1e6 } }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Quick probe for /api/health. */
export async function pingAi(): Promise<{ ok: true; model: string } | { ok: false; error: string; hint: string }> {
  try {
    const key = env().OPENROUTER_API_KEY;
    if (!key) return { ok: false, error: "OPENROUTER_API_KEY not set", hint: "Set OPENROUTER_API_KEY to enable summaries." };
    const res = await fetch(`${BASE}/auth/key`, { headers: headers() });
    if (!res.ok) return { ok: false, error: `OpenRouter /auth/key → ${res.status}`, hint: "The key is invalid or revoked." };
    return { ok: true, model: resolveModel() };
  } catch (e) {
    return { ok: false, error: errInfo(e).message, hint: "Check network access to openrouter.ai and GEMINI_MODEL (must be google/gemini-*)." };
  }
}
