import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { metaCloud } from "@/lib/meta/cloud";
import { recordWebhookEvent, saveMessage } from "@/lib/store";
import type { NormalizedMessage } from "@/lib/whatsapp/types";

/** GET: Meta webhook verification handshake. */
export const GET = route(async ({ req }) => {
  const u = new URL(req.url);
  const mode = u.searchParams.get("hub.mode");
  const token = u.searchParams.get("hub.verify_token");
  const challenge = u.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === env().META_VERIFY_TOKEN) return new NextResponse(challenge ?? "", { status: 200 });
  throw AppError.unauthorized("Webhook verification failed.", "hub.verify_token must equal META_VERIFY_TOKEN.");
}, { auth: "none" });

type CloudPayload = {
  entry?: { id: string; changes?: { field: string; value: { metadata?: { phone_number_id?: string }; contacts?: { profile?: { name?: string }; wa_id?: string }[]; messages?: { from: string; id: string; timestamp: string; type: string; group_id?: string; text?: { body?: string }; image?: { caption?: string; mime_type?: string }; [k: string]: unknown }[] } }[] }[];
};

/** POST: inbound Cloud API events (1:1 and group messages carry `group_id`). */
export const POST = route(async ({ req, log }) => {
  const raw = await req.text();
  const sig = metaCloud.verifySignature(raw, req.headers.get("x-hub-signature-256"));
  if (!sig.ok) throw AppError.unauthorized(`Invalid signature: ${sig.reason}`, "META_APP_SECRET must match the app's secret in Meta developer settings.");
  const payload = JSON.parse(raw) as CloudPayload;
  let stored = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") {
        log.info({ field: change.field }, "cloud webhook non-message field");
        await recordWebhookEvent("cloud", `${entry.id}:${change.field}:${Date.now()}`, change.field, change.value as Record<string, unknown>);
        continue;
      }
      const names = new Map((change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of change.value.messages ?? []) {
        const fresh = await recordWebhookEvent("cloud", m.id, "message", m as Record<string, unknown>);
        if (!fresh) continue;
        const group = Boolean(m.group_id);
        const nm: NormalizedMessage = {
          id: m.id,
          chatJid: group ? `cloud:${m.group_id}` : `${m.from}@s.whatsapp.net`,
          chatKind: group ? "group" : "dm",
          senderJid: `${m.from}@s.whatsapp.net`,
          senderPhone: m.from,
          senderName: names.get(m.from),
          fromMe: false,
          timestamp: new Date(Number(m.timestamp) * 1000),
          type: m.type,
          text: m.text?.body ?? (m.image as { caption?: string } | undefined)?.caption,
          mentions: [],
          source: "cloud",
          raw: { phoneNumberId: change.value.metadata?.phone_number_id, groupId: m.group_id },
        };
        const r = await saveMessage(nm);
        if (r.inserted) stored++;
      }
    }
  }
  log.info({ stored }, "cloud webhook processed");
  return NextResponse.json({ ok: true, stored });
}, { auth: "none" });
