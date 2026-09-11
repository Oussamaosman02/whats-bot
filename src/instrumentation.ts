/**
 * Runs once when the Next.js server boots (Node runtime only).
 * Registers the bot handler and, unless WHATSAPP_AUTOSTART=false, opens the WhatsApp connection.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getLogger, errInfo } = await import("./lib/logger");
  const log = getLogger("boot");
  try {
    const { env, features } = await import("./lib/env");
    const e = env();
    log.info({ nodeEnv: e.NODE_ENV, model: e.GEMINI_MODEL, features: features(), autostart: e.WHATSAPP_AUTOSTART, apiAuth: Boolean(e.API_KEY) }, "whats-bot starting");
    if (!e.API_KEY) log.warn({ hint: "Set API_KEY in the environment to protect the API. Fine for local dev, not for Railway." }, "API_KEY is empty → all /api routes are open");

    const { registerBot } = await import("./lib/bot/handler");
    registerBot();
    const { startRetentionScheduler } = await import("./lib/maintenance");
    startRetentionScheduler();
    const { startDigestScheduler } = await import("./lib/bot/digest");
    startDigestScheduler();
    const { startJobScheduler } = await import("./lib/bot/jobs");
    startJobScheduler();

    if (e.WHATSAPP_AUTOSTART) {
      const { whatsapp } = await import("./lib/whatsapp/client");
      whatsapp.start().catch((err) => log.error({ err: errInfo(err), hint: "WhatsApp failed to start. Check DATABASE_URL (auth state lives in Postgres) and the stack above." }, "whatsapp autostart failed"));
    } else {
      log.info("WHATSAPP_AUTOSTART=false → call POST /api/whatsapp/connect to start");
    }
  } catch (err) {
    log.fatal({ err: errInfo(err), hint: "Boot failed – most likely an invalid .env. Compare with .env.example." }, "boot error");
  }
}
