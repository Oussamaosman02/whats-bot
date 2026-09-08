import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { zernio } from "@/lib/zernio/client";
import { AppError } from "@/lib/errors";
import { recordWebhookEvent, saveMessage, setMessageTranscript, upsertChat } from "@/lib/store";
import { transcribeAudio } from "@/lib/ai/transcribe";
import { env } from "@/lib/env";
import { errInfo } from "@/lib/logger";
import type { NormalizedMessage } from "@/lib/whatsapp/types";

type ZernioMessageEvent = {
  id: string;
  event: string;
  timestamp?: string;
  message?: {
    id: string;
    conversationId: string;
    platform: string;
    platformMessageId?: string;
    direction: "incoming" | "outgoing";
    text?: string | null;
    attachments?: { type?: string; url?: string; filename?: string }[];
    sender?: { id?: string; name?: string; phoneNumber?: string | null; username?: string };
    sentAt?: string;
  };
  conversation?: { id: string; participantId?: string; participantName?: string; participantUsername?: string };
  account?: { id: string; platform?: string; username?: string };
};

/**
 * POST /api/webhooks/zernio – receives message.received / message.sent (and other) events.
 * Stores WhatsApp DM messages (deduped against the Baileys copy) and acknowledges everything else.
 * Signature: X-Zernio-Signature (HMAC-SHA256) when ZERNIO_WEBHOOK_SECRET is set.
 */
export const POST = route(async ({ req, log }) => {
  const raw = await req.text();
  const sig = zernio.verifySignature(raw, req.headers.get("x-zernio-signature") ?? req.headers.get("x-late-signature"));
  if (!sig.ok) {
    log.warn({ reason: sig.reason, hint: "The secret in ZERNIO_WEBHOOK_SECRET must equal the `secret` of the webhook in Zernio (GET /api/zernio/webhooks)." }, "zernio webhook signature rejected");
    throw AppError.unauthorized(`Invalid webhook signature: ${sig.reason}`);
  }
  let payload: ZernioMessageEvent;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw AppError.badRequest("Webhook body is not JSON.");
  }
  const eventName = payload.event ?? req.headers.get("x-zernio-event") ?? "unknown";
  const eventId = payload.id ?? req.headers.get("x-zernio-event-id") ?? `${eventName}:${Date.now()}`;
  const fresh = await recordWebhookEvent("zernio", eventId, eventName, payload as unknown as Record<string, unknown>);
  if (!fresh) {
    log.info({ eventId, eventName }, "duplicate zernio event ignored (already processed)");
    return NextResponse.json({ ok: true, duplicate: true });
  }
  log.info({ eventId, eventName, platform: payload.message?.platform ?? payload.account?.platform }, "zernio webhook received");

  if ((eventName === "message.received" || eventName === "message.sent") && payload.message?.platform === "whatsapp") {
    const msg = payload.message;
    const incoming = msg.direction === "incoming";
    const phone = (msg.sender?.phoneNumber ?? msg.sender?.id ?? payload.conversation?.participantId ?? "").replace(/[^\d]/g, "");
    const contactPhone = incoming ? phone : (payload.conversation?.participantId ?? "").replace(/[^\d]/g, "");
    if (!contactPhone) {
      log.warn({ eventId, hint: "Neither sender.phoneNumber nor conversation.participantId contained digits; message skipped." }, "cannot derive contact phone from zernio payload");
      return NextResponse.json({ ok: true, skipped: "no_phone" });
    }
    const chatJid = `${contactPhone}@s.whatsapp.net`;
    const att = msg.attachments?.[0];
    const normalized: NormalizedMessage = {
      id: msg.platformMessageId ?? msg.id,
      chatJid,
      chatKind: "dm",
      chatName: payload.conversation?.participantName ?? msg.sender?.name,
      senderJid: incoming ? chatJid : undefined,
      senderPhone: incoming ? contactPhone : undefined,
      senderName: incoming ? msg.sender?.name ?? payload.conversation?.participantName : undefined,
      fromMe: !incoming,
      timestamp: new Date(msg.sentAt ?? payload.timestamp ?? Date.now()),
      type: att?.type ?? "text",
      text: msg.text ?? undefined,
      media: att ? { fileName: att.filename, mimetype: undefined } : undefined,
      mentions: [],
      source: "zernio",
      raw: { conversationId: msg.conversationId, zernioMessageId: msg.id, accountId: payload.account?.id },
    };
    const saved = await saveMessage(normalized);
    await upsertChat({ jid: chatJid, kind: "dm", name: normalized.chatName, metadata: { zernioConversationId: msg.conversationId, zernioAccountId: payload.account?.id } });
    log.info({ chat: chatJid, inserted: saved.inserted, dedupedBy: saved.dedupedBy, direction: msg.direction }, "zernio message processed");
    if (saved.inserted && att?.type === "audio" && att.url && env().TRANSCRIBE_AUDIO) {
      // fire-and-forget: the transcript lands on the row when ready
      void (async () => {
        try {
          const r = await fetch(att.url!);
          if (!r.ok) throw new Error(`attachment download → HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          const t = await transcribeAudio(buf, { mimetype: r.headers.get("content-type") ?? undefined, reqId: eventId.slice(-8) });
          await setMessageTranscript(chatJid, normalized.id, t.transcript, { model: t.model, ms: t.ms });
          log.info({ chat: chatJid, id: normalized.id, chars: t.transcript.length }, "🎤 zernio audio transcribed");
        } catch (e) {
          log.error({ err: errInfo(e), chat: chatJid, id: normalized.id, hint: "Audio kept as [audio]; the Zernio attachment URL may have expired." }, "zernio audio transcription failed");
        }
      })();
    }
    return NextResponse.json({ ok: true, stored: saved.inserted, dedupedBy: saved.dedupedBy });
  }
  return NextResponse.json({ ok: true, ignored: eventName });
}, { auth: "none" });

export const GET = route(async () => NextResponse.json({ ok: true, hint: "POST Zernio events here. Register with POST /api/zernio/webhooks." }), { auth: "none" });
