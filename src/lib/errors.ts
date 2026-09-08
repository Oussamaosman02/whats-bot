/**
 * AppError: an error that knows its HTTP status, a stable machine-readable `code`,
 * and a human `hint` explaining how to fix it. Every API failure surfaces these three.
 */
export class AppError extends Error {
  status: number;
  code: string;
  hint?: string;
  data?: unknown;

  constructor(status: number, code: string, message: string, opts: { hint?: string; data?: unknown; cause?: unknown } = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.hint = opts.hint;
    this.data = opts.data;
  }

  static badRequest(message: string, hint?: string, data?: unknown) {
    return new AppError(400, "bad_request", message, { hint, data });
  }
  static unauthorized(message = "Unauthorized", hint?: string) {
    return new AppError(401, "unauthorized", message, { hint });
  }
  static notFound(message: string, hint?: string) {
    return new AppError(404, "not_found", message, { hint });
  }
  static notConfigured(feature: string, vars: string[]) {
    return new AppError(503, "not_configured", `${feature} is not configured.`, {
      hint: `Set ${vars.join(", ")} in your environment (see .env.example) and restart.`,
    });
  }
  static upstream(service: string, status: number, body: unknown, hint?: string) {
    return new AppError(502, "upstream_error", `${service} responded with HTTP ${status}`, {
      hint: hint ?? `Inspect the \`data\` field for the raw ${service} response.`,
      data: body,
    });
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError || (typeof e === "object" && e !== null && (e as AppError).name === "AppError");
}
