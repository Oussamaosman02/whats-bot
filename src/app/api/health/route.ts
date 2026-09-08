import { route, ok, isAuthenticated } from "@/lib/api";
import { env, features } from "@/lib/env";
import { pingDb } from "@/lib/db";
import { pingAi } from "@/lib/ai/gemini";
import { zernio } from "@/lib/zernio/client";
import { whatsapp } from "@/lib/whatsapp/client";
import { metaCloud } from "@/lib/meta/cloud";
import { ttsStatus } from "@/lib/ai/tts";
import { r2 } from "@/lib/storage/r2";

/**
 * Deep health check. Each subsystem reports ok/error/hint so a failing deploy explains itself.
 * Returns 200 when DB is fine (WhatsApp may still be waiting for a QR), 503 when DB is down.
 */
export const GET = route(async ({ req, query, log }) => {
  const authed = isAuthenticated(req);
  if (!authed) {
    // Unauthenticated probes (Railway healthcheck) only learn liveness – no config details.
    const db = await pingDb();
    const wa = whatsapp.getStatus().status;
    return ok({ ok: db.ok, whatsapp: wa, hint: "Authenticate (Bearer API_KEY or browser password) for the full report." }, { status: db.ok ? 200 : 503 });
  }
  const q = query((await import("zod")).z.object({ deep: (await import("zod")).z.string().optional() }));
  const deep = q.deep !== "0";
  const [db, ai, zer] = await Promise.all([pingDb(), deep ? pingAi() : Promise.resolve({ ok: true as const, model: env().GEMINI_MODEL, skipped: true }), deep ? zernio.ping() : Promise.resolve({ ok: true as const, skipped: true })]);
  const wa = whatsapp.getStatus();
  const checks = {
    database: db,
    whatsapp: {
      ok: wa.status === "open",
      status: wa.status,
      me: wa.me,
      lastError: wa.lastError,
      hint: wa.status === "open" ? undefined : wa.lastErrorHint ?? (wa.status === "qr" ? "Scan GET /api/whatsapp/qr" : "POST /api/whatsapp/connect"),
    },
    ai,
    zernio: zer,
    r2: deep ? await r2.ping() : { ok: true, skipped: true },
    tts: deep ? await ttsStatus().catch((e) => ({ ok: false, error: String(e) })) : { ok: true, skipped: true },
    metaCloud: { ok: metaCloud.enabled(), configured: metaCloud.enabled(), hint: metaCloud.enabled() ? undefined : "Optional. Set META_ACCESS_TOKEN + META_PHONE_NUMBER_ID for the official Groups API (Path A)." },
  };
  const status = db.ok ? 200 : 503;
  if (!db.ok) log.error({ checks }, "health: database down");
  return ok({ ok: db.ok, features: features(), checks, uptimeSec: Math.round(process.uptime()), version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "local" }, { status });
}, { auth: "none" });
