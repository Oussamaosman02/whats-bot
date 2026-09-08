/**
 * Meta WhatsApp Cloud API – Groups API (Path A in the project brief).
 * Only works with a Cloud-API-only, OBA number. Fully optional; gated on META_* env vars.
 *
 * Endpoints (Graph API):
 *   POST   /{PHONE_NUMBER_ID}/groups                { subject, description? }
 *   GET    /{PHONE_NUMBER_ID}/groups
 *   GET    /{GROUP_ID}?fields=subject,description,...
 *   POST   /{GROUP_ID}                              { subject?, description? }
 *   DELETE /{GROUP_ID}
 *   GET    /{GROUP_ID}/participants
 *   DELETE /{GROUP_ID}/participants                 { participants:[{user}] }
 *   GET    /{GROUP_ID}/invite_link
 *   POST   /{GROUP_ID}/invite_link                  (reset)
 *   POST   /{PHONE_NUMBER_ID}/messages              { recipient_type:"group", to: GROUP_ID, ... }
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("meta");

function cfg() {
  const e = env();
  if (!e.META_ACCESS_TOKEN || !e.META_PHONE_NUMBER_ID) throw AppError.notConfigured("Meta Cloud API Groups", ["META_ACCESS_TOKEN", "META_PHONE_NUMBER_ID"]);
  return { token: e.META_ACCESS_TOKEN, phoneNumberId: e.META_PHONE_NUMBER_ID, base: `https://graph.facebook.com/${e.META_GRAPH_VERSION}` };
}

async function graph<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const c = cfg();
  const url = new URL(`${c.base}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const t0 = Date.now();
  log.debug({ method, path }, "→ graph");
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };
  if (!res.ok) {
    const err = json.error ?? {};
    const hint =
      err.code === 190
        ? "META_ACCESS_TOKEN expired/invalid – generate a new System User token."
        : err.code === 100
          ? "Invalid parameter – the number may not be eligible for the Groups API (needs a Cloud-API-only OBA number, not coexistence)."
          : err.code === 130501
            ? "Unsupported message type for groups."
            : "See `data` for the raw Graph API error.";
    log.error({ status: res.status, method, path, error: err, hint, ms: Date.now() - t0 }, "graph error");
    throw AppError.upstream("Meta Graph", res.status, json, hint);
  }
  log.debug({ status: res.status, ms: Date.now() - t0 }, "← graph");
  return json as T;
}

export const metaCloud = {
  enabled: () => Boolean(env().META_ACCESS_TOKEN && env().META_PHONE_NUMBER_ID),
  createGroup: (body: { subject: string; description?: string }) => graph<{ id: string }>("POST", `${cfg().phoneNumberId}/groups`, { body }),
  listGroups: () => graph<{ data: unknown[] }>("GET", `${cfg().phoneNumberId}/groups`),
  getGroup: (id: string) => graph<Record<string, unknown>>("GET", id, { query: { fields: "id,subject,description,participants_count,invite_link,created_at,status" } }),
  updateGroup: (id: string, body: { subject?: string; description?: string }) => graph<{ success: boolean }>("POST", id, { body }),
  deleteGroup: (id: string) => graph<{ success: boolean }>("DELETE", id),
  participants: (id: string) => graph<{ data: unknown[] }>("GET", `${id}/participants`),
  removeParticipants: (id: string, users: string[]) => graph<{ success: boolean }>("DELETE", `${id}/participants`, { body: { participants: users.map((user) => ({ user })) } }),
  inviteLink: (id: string) => graph<{ invite_link: string }>("GET", `${id}/invite_link`),
  resetInviteLink: (id: string) => graph<{ invite_link: string }>("POST", `${id}/invite_link`),
  sendText: (to: string, text: string, opts: { group?: boolean; previewUrl?: boolean } = {}) =>
    graph<{ messages: { id: string }[] }>("POST", `${cfg().phoneNumberId}/messages`, {
      body: { messaging_product: "whatsapp", recipient_type: opts.group ? "group" : "individual", to, type: "text", text: { body: text, preview_url: opts.previewUrl ?? false } },
    }),
  sendTemplate: (to: string, template: { name: string; language: string; components?: unknown[] }, opts: { group?: boolean } = {}) =>
    graph<{ messages: { id: string }[] }>("POST", `${cfg().phoneNumberId}/messages`, {
      body: { messaging_product: "whatsapp", recipient_type: opts.group ? "group" : "individual", to, type: "template", template: { name: template.name, language: { code: template.language }, components: template.components } },
    }),

  /** Verify X-Hub-Signature-256 from Meta webhooks. */
  verifySignature(rawBody: string, header: string | null): { ok: boolean; reason?: string } {
    const secret = env().META_APP_SECRET;
    if (!secret) return { ok: true, reason: "META_APP_SECRET not set – signature not enforced" };
    if (!header) return { ok: false, reason: "missing X-Hub-Signature-256" };
    const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
    if (expected.length !== header.length) return { ok: false, reason: "length mismatch" };
    return timingSafeEqual(Buffer.from(expected), Buffer.from(header)) ? { ok: true } : { ok: false, reason: "signature mismatch" };
  },
};

export function describeMetaError(e: unknown) {
  return errInfo(e);
}
