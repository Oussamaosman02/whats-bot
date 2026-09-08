/**
 * Zernio REST client (official WhatsApp Cloud API wrapper) – 1:1 messages, templates, webhooks.
 * Base: https://zernio.com/api/v1, auth: Bearer ZERNIO_API_KEY.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("zernio");
const BASE = "https://zernio.com/api/v1";

export type ZernioAccount = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean; profileId?: string; [k: string]: unknown };
export type ZernioConversation = { id: string; accountId: string; platform: string; participantId: string; participantName?: string; participantUsername?: string; lastMessage?: string; updatedTime?: string; status: string; unreadCount?: number };

async function request<T>(method: string, path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown; reqId?: string } = {}): Promise<T> {
  const key = env().ZERNIO_API_KEY;
  if (!key) throw AppError.notConfigured("Zernio", ["ZERNIO_API_KEY"]);
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const t0 = Date.now();
  log.debug({ method, path: url.pathname + url.search, reqId: opts.reqId }, "→ zernio");
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    log.error({ err: errInfo(e), hint: "Network error reaching zernio.com." }, "zernio request failed");
    throw new AppError(502, "zernio_network_error", `Could not reach Zernio: ${errInfo(e).message}`, { cause: e });
  }
  const raw = await res.text();
  let json: unknown = raw;
  try {
    json = JSON.parse(raw);
  } catch {
    /* keep raw */
  }
  if (!res.ok) {
    const hint =
      res.status === 401
        ? "ZERNIO_API_KEY is invalid."
        : res.status === 404
          ? "Resource not found – check the accountId / conversationId (GET /api/zernio/accounts, /api/zernio/conversations)."
          : res.status === 403
            ? `Zernio refused: ${(json as { error?: string })?.error ?? "insufficient permissions"}. A profile-scoped key cannot manage webhooks – create the webhook in the Zernio dashboard (Settings › Webhooks) or use a workspace-level API key.`
            : res.status === 402
              ? "Plan limit reached on the Zernio account – check the Zernio dashboard › Billing."
              : "See `data` for Zernio's raw response.";
    log.error({ status: res.status, method, path, body: raw.slice(0, 800), hint, ms: Date.now() - t0 }, "zernio error");
    throw AppError.upstream("Zernio", res.status, json, hint);
  }
  log.debug({ status: res.status, ms: Date.now() - t0, reqId: opts.reqId }, "← zernio");
  return json as T;
}

export const zernio = {
  accounts: (query: { platform?: string; status?: "connected" | "disconnected" } = {}) =>
    request<{ accounts: ZernioAccount[] }>("GET", "/accounts", { query }),

  /** Resolve the WhatsApp account id: env override or the first connected WhatsApp account. */
  async whatsappAccountId(): Promise<string> {
    const pinned = env().ZERNIO_WHATSAPP_ACCOUNT_ID;
    if (pinned) return pinned;
    const { accounts } = await zernio.accounts({ platform: "whatsapp" });
    const acc = accounts.find((a) => a.platform === "whatsapp");
    if (!acc) throw new AppError(503, "zernio_no_whatsapp_account", "No WhatsApp account connected in Zernio.", { hint: "Connect a WhatsApp number in the Zernio dashboard or set ZERNIO_WHATSAPP_ACCOUNT_ID." });
    return acc._id;
  },

  conversations: (query: { accountId?: string; platform?: string; status?: string; limit?: number; cursor?: string } = {}) =>
    request<{ data: ZernioConversation[]; pagination: { hasMore: boolean; nextCursor?: string } }>("GET", "/inbox/conversations", { query }),

  messages: (conversationId: string, query: { accountId: string; limit?: number; cursor?: string; sortOrder?: "asc" | "desc" }) =>
    request<{ messages: Record<string, unknown>[]; pagination: { hasMore: boolean; nextCursor?: string } }>("GET", `/inbox/conversations/${conversationId}/messages`, { query }),

  sendToConversation: (conversationId: string, body: { accountId: string; message?: string; attachmentUrl?: string; attachmentType?: string; replyTo?: string; [k: string]: unknown }) =>
    request<{ success: boolean; data: { messageId: string; conversationId: string } }>("POST", `/inbox/conversations/${conversationId}/messages`, { body }),

  /** Start (or reuse) a conversation with a phone number. Use templateName for out-of-window sends. */
  startConversation: (body: { accountId: string; participantId: string; message?: string; templateName?: string; templateLanguage?: string; templateParams?: unknown[]; skipDmCheck?: boolean; [k: string]: unknown }) =>
    request<{ success: boolean; data: { messageId: string; conversationId: string; participantId: string } }>("POST", "/inbox/conversations", { body }),

  typing: (conversationId: string, accountId: string) => request("POST", `/inbox/conversations/${conversationId}/typing`, { body: { accountId } }),
  markRead: (conversationId: string, accountId: string) => request("POST", `/inbox/conversations/${conversationId}/read`, { body: { accountId } }),

  templates: (accountId: string, query: { status?: string; language?: string; name?: string } = {}) =>
    request<{ success: boolean; templates: Record<string, unknown>[] }>("GET", "/whatsapp/templates", { query: { accountId, ...query } }),

  webhooks: () => request<{ webhooks: Record<string, unknown>[] }>("GET", "/webhooks/settings"),
  createWebhook: (body: { name: string; url: string; secret?: string; events: string[]; isActive?: boolean }) => request("POST", "/webhooks/settings", { body }),
  deleteWebhook: (id: string) => request("DELETE", "/webhooks/settings", { query: { id } }),
  testWebhook: (id: string) => request("POST", "/webhooks/test", { body: { webhookId: id } }),
  webhookLogs: (query: { limit?: number } = {}) => request<{ logs: unknown[] }>("GET", "/webhooks/logs", { query }),

  contacts: (query: { search?: string; platform?: string; limit?: number; skip?: number } = {}) => request<{ contacts: unknown[]; pagination: unknown }>("GET", "/contacts", { query }),

  /** Find the WhatsApp conversation with a phone number, if Zernio already has one. */
  async findConversation(accountId: string, phone: string): Promise<ZernioConversation | undefined> {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await zernio.conversations({ accountId, platform: "whatsapp", limit: 100, cursor });
      const hit = res.data.find((c) => c.participantId?.replace(/[^\d]/g, "") === phone || c.participantUsername?.replace(/[^\d]/g, "") === phone);
      if (hit) return hit;
      if (!res.pagination?.hasMore || !res.pagination.nextCursor) break;
      cursor = res.pagination.nextCursor;
    }
    return undefined;
  },

  /**
   * Send a free-form or template message to a phone number in one call.
   * Free text: reuses the existing conversation (works inside Meta's 24h window); if none exists, tries a
   * Direct Send utility message; otherwise explains that a template is required.
   */
  async sendToPhone(opts: { phone: string; text?: string; templateName?: string; templateLanguage?: string; templateParams?: unknown[]; reqId?: string }) {
    const accountId = await zernio.whatsappAccountId();
    const participantId = opts.phone.replace(/[^\d]/g, "");
    if (!opts.templateName && opts.text) {
      const conv = await zernio.findConversation(accountId, participantId);
      if (conv) {
        const r = await zernio.sendToConversation(conv.id, { accountId, message: opts.text });
        log.info({ to: participantId, conversationId: conv.id, messageId: r.data?.messageId, reqId: opts.reqId }, "zernio message sent (existing conversation)");
        return { messageId: r.data?.messageId, conversationId: conv.id, participantId };
      }
      try {
        const r = await zernio.startConversation({ accountId, participantId, message: opts.text, category: "utility", skipDmCheck: true });
        log.info({ to: participantId, conversationId: r.data?.conversationId, reqId: opts.reqId }, "zernio message sent (direct send utility)");
        return r.data;
      } catch (e) {
        throw new AppError(409, "zernio_template_required", `No open conversation with ${participantId} and the account is not eligible for Direct Send.`, {
          hint: "Outside the 24h window WhatsApp only allows approved templates: pass templateName (GET /api/zernio/templates) or have the contact message the business number first.",
          cause: e,
        });
      }
    }
    const res = await zernio.startConversation({
      accountId,
      participantId,
      message: opts.text,
      templateName: opts.templateName,
      templateLanguage: opts.templateLanguage,
      templateParams: opts.templateParams,
      skipDmCheck: true,
    });
    log.info({ to: participantId, conversationId: res.data?.conversationId, messageId: res.data?.messageId, template: opts.templateName, reqId: opts.reqId }, "zernio message sent");
    return res.data;
  },

  /** Verify X-Zernio-Signature (HMAC-SHA256 hex of the raw body). Returns true when no secret is configured. */
  verifySignature(rawBody: string, header: string | null): { ok: boolean; reason?: string } {
    const secret = env().ZERNIO_WEBHOOK_SECRET;
    if (!secret) return { ok: true, reason: "no ZERNIO_WEBHOOK_SECRET configured – signature not enforced" };
    if (!header) return { ok: false, reason: "missing X-Zernio-Signature header" };
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const given = header.replace(/^sha256=/, "").trim();
    if (given.length !== expected.length) return { ok: false, reason: "signature length mismatch" };
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected)) ? { ok: true } : { ok: false, reason: "signature mismatch" };
  },

  /** Download a media attachment from a Zernio media URL (or any zernio.com URL) with the API key. */
  async downloadMedia(url: string): Promise<{ buffer: Buffer; mimetype: string }> {
    const key = env().ZERNIO_API_KEY;
    if (!key) throw AppError.notConfigured("Zernio", ["ZERNIO_API_KEY"]);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) throw AppError.upstream("Zernio media", res.status, await res.text().catch(() => ""), "The media may have expired on Meta's side (Cloud API media lives ~30 days).");
    return { buffer: Buffer.from(await res.arrayBuffer()), mimetype: res.headers.get("content-type") ?? "application/octet-stream" };
  },

  async ping(): Promise<{ ok: true; whatsappAccountId?: string } | { ok: false; error: string; hint: string }> {
    try {
      if (!env().ZERNIO_API_KEY) return { ok: false, error: "ZERNIO_API_KEY not set", hint: "Optional: set it to enable official 1:1 / template sends." };
      const id = await zernio.whatsappAccountId();
      return { ok: true, whatsappAccountId: id };
    } catch (e) {
      const info = errInfo(e);
      return { ok: false, error: info.message, hint: (e as AppError).hint ?? "Check ZERNIO_API_KEY." };
    }
  },
};
