/**
 * `route()` wraps a Next.js route handler with:
 *   • a request id (reqId) echoed in logs and in the `x-request-id` response header
 *   • → / ← log lines with method, path, status and duration
 *   • optional auth: "apiKey" (Bearer API_KEY) or "none"
 *   • uniform error JSON:  { error: { code, message, hint, reqId, data? } }
 *
 * Usage:
 *   export const POST = route(async ({ req, log, json, params }) => { ... return ok({...}) })
 */
import { NextResponse, type NextRequest } from "next/server";
import type { Logger } from "pino";
import { AppError, isAppError } from "./errors";
import { env } from "./env";
import { getLogger, newReqId, errInfo } from "./logger";
import { authenticate } from "./auth";
import { z, type ZodType } from "zod";

export type RouteCtx<P = Record<string, string>> = {
  req: NextRequest;
  reqId: string;
  log: Logger;
  params: P;
  /** Parse and validate the JSON body. Throws a 400 AppError listing every invalid field. */
  body: <T>(schema: ZodType<T>) => Promise<T>;
  /** Read and validate query params. */
  query: <T>(schema: ZodType<T>) => T;
};

type Handler<P> = (ctx: RouteCtx<P>) => Promise<Response> | Response;

export type RouteOptions = {
  auth?: "apiKey" | "none";
};

const apiLog = getLogger("api");

export function ok(data: unknown, init: ResponseInit = {}) {
  return NextResponse.json({ ok: true, data }, init);
}

function errorResponse(e: unknown, reqId: string, log: Logger): Response {
  if (isAppError(e)) {
    const err = e as AppError;
    (err.status >= 500 ? log.error : log.warn).call(
      log,
      { status: err.status, code: err.code, err: errInfo(err), data: err.data, hint: err.hint },
      `✖ ${err.message}`,
    );
    return NextResponse.json(
      { ok: false, error: { code: err.code, message: err.message, hint: err.hint, data: err.data, reqId } },
      { status: err.status, headers: { "x-request-id": reqId } },
    );
  }
  const info = errInfo(e);
  log.error(
    { err: info, hint: "Unhandled exception. The stack above points at the failing line; search logs for this reqId." },
    `✖ unhandled: ${info.message}`,
  );
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "internal_error",
        message: info.message,
        hint: `Unexpected failure. Search the server logs for reqId=${reqId} to see the stack trace.`,
        reqId,
      },
    },
    { status: 500, headers: { "x-request-id": reqId } },
  );
}

function checkAuth(req: NextRequest, mode: RouteOptions["auth"]) {
  if (mode === "none") return;
  const e = env();
  const res = authenticate(req, { apiKey: e.API_KEY, dashboardPassword: e.DASHBOARD_PASSWORD });
  if (!res.ok) {
    throw AppError.unauthorized(`Unauthorized (${res.reason}).`, "Send `Authorization: Bearer <API_KEY>` (or ?key=<API_KEY>), or use the browser password (DASHBOARD_PASSWORD).");
  }
}

/** True when the request carries valid credentials (used by public routes that show more detail to admins). */
export function isAuthenticated(req: NextRequest) {
  const e = env();
  return authenticate(req, { apiKey: e.API_KEY, dashboardPassword: e.DASHBOARD_PASSWORD }).ok;
}

export function route<P = Record<string, string>>(handler: Handler<P>, opts: RouteOptions = {}) {
  return async (req: NextRequest, ctx?: { params?: Promise<P> | P }): Promise<Response> => {
    const reqId = req.headers.get("x-request-id") ?? newReqId();
    const url = new URL(req.url);
    const log = apiLog.child({ reqId });
    const t0 = Date.now();
    log.info(`→ ${req.method} ${url.pathname}${url.search}`);
    try {
      checkAuth(req, opts.auth);
      const params = (await ctx?.params) ?? ({} as P);
      const res = await handler({
        req,
        reqId,
        log,
        params,
        body: async (schema) => {
          let raw: unknown;
          try {
            raw = await req.json();
          } catch {
            throw AppError.badRequest("Request body is not valid JSON.", "Send a JSON body with header Content-Type: application/json.");
          }
          const parsed = schema.safeParse(raw);
          if (!parsed.success) {
            throw AppError.badRequest(
              "Invalid request body.",
              "Fix the fields listed in `data.issues`.",
              { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
            );
          }
          return parsed.data;
        },
        query: (schema) => {
          const obj = Object.fromEntries(url.searchParams.entries());
          const parsed = schema.safeParse(obj);
          if (!parsed.success) {
            throw AppError.badRequest(
              "Invalid query parameters.",
              "Fix the query params listed in `data.issues`.",
              { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
            );
          }
          return parsed.data;
        },
      });
      res.headers.set("x-request-id", reqId);
      log.info({ status: res.status, ms: Date.now() - t0 }, `← ${res.status} ${req.method} ${url.pathname}`);
      return res;
    } catch (e) {
      const res = errorResponse(e, reqId, log);
      log.info({ status: res.status, ms: Date.now() - t0 }, `← ${res.status} ${req.method} ${url.pathname}`);
      return res;
    }
  };
}

export { z };
