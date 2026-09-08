/**
 * Shared authentication used by the proxy (edge) and by route handlers.
 * Two credentials, both optional:
 *   API_KEY            – Bearer / x-api-key / ?key=      (machines)
 *   DASHBOARD_PASSWORD – HTTP Basic, any username        (humans in a browser), falls back to API_KEY
 * When neither is set the app is open (local dev only – boot logs warn about it).
 *
 * Kept free of Node-only imports so it can run in the proxy.
 */
export type AuthResult = { ok: true; via: "open" | "apiKey" | "basic" } | { ok: false; reason: string };

/** Paths that must stay reachable without credentials (third-party callbacks + platform health probe). */
export const PUBLIC_PATHS = ["/api/webhooks/zernio", "/api/cloud/webhook", "/api/health"];

export function isPublicPath(pathname: string) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function authenticate(req: Request, env: { apiKey?: string; dashboardPassword?: string }): AuthResult {
  const apiKey = env.apiKey;
  const password = env.dashboardPassword ?? env.apiKey;
  if (!apiKey && !password) return { ok: true, via: "open" };

  const url = new URL(req.url);
  const header = req.headers.get("authorization") ?? "";

  if (apiKey) {
    const token = header.startsWith("Bearer ") ? header.slice(7) : (req.headers.get("x-api-key") ?? url.searchParams.get("key") ?? "");
    if (token && safeEqual(token, apiKey)) return { ok: true, via: "apiKey" };
  }
  if (password && header.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice(6));
      const pass = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(pass, password)) return { ok: true, via: "basic" };
    } catch {
      /* malformed header */
    }
  }
  return { ok: false, reason: header ? "invalid credentials" : "no credentials" };
}

export function basicChallenge(realm = "whats-bot") {
  return { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` };
}
