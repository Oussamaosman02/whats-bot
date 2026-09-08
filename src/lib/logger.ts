/**
 * Developer-friendly structured logging built on pino.
 *
 * - `LOG_FORMAT=pretty` (default outside production): one readable coloured line per event
 *      12:01:03.412 INFO  [api] ← 200 POST /api/messages (41ms) reqId=k3f9…
 * - `LOG_FORMAT=json`: raw pino JSON, ideal for Vercel / log drains.
 *
 * Conventions used across the codebase:
 *   log.child({ mod: "zernio" })          → tag the subsystem
 *   log.info({ reqId, ... }, "message")   → context first, message second
 *   log.error({ err, hint }, "what failed") → ALWAYS include `err` and a `hint` telling the
 *                                             reader what to check / how to fix it.
 */
import pino, { type Logger } from "pino";

const LEVEL_COLOURS: Record<string, string> = {
  TRACE: "\x1b[90m",
  DEBUG: "\x1b[36m",
  INFO: "\x1b[32m",
  WARN: "\x1b[33m",
  ERROR: "\x1b[31m",
  FATAL: "\x1b[35m",
};
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string") return /[\s=]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 400 ? s.slice(0, 400) + "…" : s;
  } catch {
    return String(v);
  }
}

/** Formats one pino JSON line into a human-readable, coloured line. */
function prettyLine(json: string): string {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json);
  } catch {
    return json;
  }
  const { level, time, msg, mod, err, hint, ...rest } = o as Record<string, unknown> & {
    level?: number;
    time?: number;
    msg?: string;
    mod?: string;
    err?: { message?: string; stack?: string; type?: string; code?: string };
    hint?: string;
  };
  const label = pino.levels.labels[level ?? 30]?.toUpperCase() ?? "INFO";
  const colour = LEVEL_COLOURS[label] ?? "";
  const ts = new Date(time ?? Date.now()).toISOString().slice(11, 23);
  const parts = [`${DIM}${ts}${RESET}`, `${colour}${label.padEnd(5)}${RESET}`];
  if (mod) parts.push(`${DIM}[${mod}]${RESET}`);
  parts.push(String(msg ?? ""));
  delete rest.pid;
  delete rest.hostname;
  for (const [k, v] of Object.entries(rest)) parts.push(`${DIM}${k}=${RESET}${fmtValue(v)}`);
  let line = parts.join(" ");
  if (err) {
    const stack = err.stack ?? err.message ?? String(err);
    line += `\n    ${colour}↳ ${err.type ? err.type + ": " : ""}${stack.split("\n").join("\n      ")}${RESET}`;
    let cause = (err as { cause?: { message?: string; type?: string; code?: string; cause?: unknown } }).cause;
    let n = 0;
    while (cause && n++ < 3) {
      line += `\n    ${colour}  caused by ${cause.type ?? "Error"}${cause.code ? `[${cause.code}]` : ""}: ${cause.message}${RESET}`;
      cause = cause.cause as typeof cause;
    }
  }
  if (hint) line += `\n    ${LEVEL_COLOURS.WARN}💡 ${hint}${RESET}`;
  return line;
}

function createRoot(): Logger {
  const level = process.env.LOG_LEVEL ?? "debug";
  const format = process.env.LOG_FORMAT ?? (process.env.NODE_ENV === "production" ? "json" : "pretty");
  const base = { pid: undefined, hostname: undefined };
  if (format === "json") {
    return pino({ level, base });
  }
  return pino(
    { level, base },
    {
      write(line: string) {
        process.stdout.write(prettyLine(line) + "\n");
      },
    },
  );
}

// Survive Next.js hot reloads / multiple bundles by pinning the root logger on globalThis.
const g = globalThis as unknown as { __whatsbotLogger?: Logger };
export const rootLogger: Logger = g.__whatsbotLogger ?? (g.__whatsbotLogger = createRoot());

/** Get a logger tagged with a module name: `const log = getLogger("zernio")`. */
export function getLogger(mod: string): Logger {
  return rootLogger.child({ mod });
}

/** Short random id for correlating log lines of one request. */
export function newReqId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Serialise unknown thrown values so they log well. */
export function errInfo(e: unknown, depth = 0): { message: string; stack?: string; type?: string; code?: string; data?: unknown; cause?: unknown } {
  if (e instanceof Error) {
    const anyE = e as Error & { code?: string; data?: unknown; status?: number; cause?: unknown };
    const cause = anyE.cause !== undefined && depth < 3 ? errInfo(anyE.cause, depth + 1) : undefined;
    return { message: e.message, stack: e.stack, type: e.name, code: anyE.code, data: anyE.data, cause };
  }
  return { message: typeof e === "string" ? e : JSON.stringify(e) };
}
