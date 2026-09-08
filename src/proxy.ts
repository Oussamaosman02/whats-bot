/**
 * Next.js proxy (edge): password-protects the landing page, /api index, the QR page and every
 * other route for browsers via HTTP Basic auth, while API clients keep using the Bearer key.
 * Webhooks and /api/health stay public (health hides details unless authenticated).
 */
import { NextResponse, type NextRequest } from "next/server";
import { authenticate, basicChallenge, isPublicPath } from "./lib/auth";

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  const res = authenticate(req, { apiKey: process.env.API_KEY || undefined, dashboardPassword: process.env.DASHBOARD_PASSWORD || undefined });
  if (res.ok) return NextResponse.next();
  const wantsJson = pathname.startsWith("/api") && !(req.headers.get("accept") ?? "").includes("text/html");
  if (wantsJson) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: `Unauthorized (${res.reason}).`, hint: "Send `Authorization: Bearer <API_KEY>` (or ?key=), or open in a browser and enter DASHBOARD_PASSWORD." } },
      { status: 401, headers: basicChallenge() },
    );
  }
  return new NextResponse("Unauthorized", { status: 401, headers: basicChallenge() });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
