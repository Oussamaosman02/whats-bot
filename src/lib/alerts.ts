/**
 * Operational alerts to ALERT_PHONE through Zernio (official Cloud API), i.e. independent of Baileys,
 * so they still arrive when the linked device is dead.
 *
 * Delivery: approved UTILITY template ALERT_TEMPLATE_NAME with 4 positional params
 *   {{1}} bot name · {{2}} message · {{3}} status · {{4}} local time
 * Fallback: free-text message (only delivered inside Meta's 24h customer-service window).
 * One alert per `kind` per ALERT_COOLDOWN_MINUTES; recovery alerts are always sent.
 */
import { env } from "./env";
import { getLogger, errInfo } from "./logger";
import { zernio } from "./zernio/client";
import { fmtZoned } from "./bot/since";
import { isAppError } from "./errors";

const log = getLogger("alerts");
const lastSent = new Map<string, number>();

export type AlertKind = "logged_out" | "disconnected" | "recovered" | "test";

export async function sendAlert(kind: AlertKind, message: string, status: string, opts: { force?: boolean } = {}): Promise<{ sent: boolean; via?: "template" | "text"; skipped?: string; error?: string }> {
  const e = env();
  if (!e.ALERT_PHONE) return { sent: false, skipped: "ALERT_PHONE not set" };
  if (!e.ZERNIO_API_KEY) return { sent: false, skipped: "ZERNIO_API_KEY not set" };
  const cooldownMs = e.ALERT_COOLDOWN_MINUTES * 60_000;
  const last = lastSent.get(kind) ?? 0;
  if (!opts.force && kind !== "recovered" && Date.now() - last < cooldownMs) {
    log.debug({ kind, sinceLastMin: Math.round((Date.now() - last) / 60_000) }, "alert suppressed by cooldown");
    return { sent: false, skipped: "cooldown" };
  }
  const time = fmtZoned(new Date(), e.BOT_TIMEZONE);
  const params = [e.BOT_NAME, message, status, time];
  const text = `⚠️ ${e.BOT_NAME}: ${message}\nEstado: ${status}\nHora: ${time} (${e.BOT_TIMEZONE})`;

  if (e.ALERT_TEMPLATE_NAME) {
    try {
      await zernio.sendToPhone({ phone: e.ALERT_PHONE, templateName: e.ALERT_TEMPLATE_NAME, templateLanguage: e.ALERT_TEMPLATE_LANGUAGE, templateParams: params });
      lastSent.set(kind, Date.now());
      log.info({ kind, to: e.ALERT_PHONE, template: e.ALERT_TEMPLATE_NAME }, "alert sent (template)");
      return { sent: true, via: "template" };
    } catch (err) {
      log.warn({ err: errInfo(err), kind, hint: `Template "${e.ALERT_TEMPLATE_NAME}" failed (not approved yet, wrong language, or param count ≠ 4?). GET /api/zernio/templates shows its status. Falling back to free text (24h window only).` }, "template alert failed");
    }
  }
  try {
    await zernio.sendToPhone({ phone: e.ALERT_PHONE, text });
    lastSent.set(kind, Date.now());
    log.info({ kind, to: e.ALERT_PHONE }, "alert sent (free text)");
    return { sent: true, via: "text" };
  } catch (err) {
    const info = errInfo(err);
    log.error({ err: info, kind, hint: isAppError(err) ? err.hint : "Free-text alerts need an open 24h window: message the business number from ALERT_PHONE, or get the template approved." }, "alert could not be delivered");
    return { sent: false, error: info.message };
  }
}
