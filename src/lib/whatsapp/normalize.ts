import { getContentType, jidNormalizedUser, type WAMessage, type WAMessageKey } from "@whiskeysockets/baileys";
import type { NormalizedMessage } from "./types";
import { isGroupJid, isLid, phoneFromJid } from "./jid";

type LidResolver = (lid: string) => Promise<string | null>;

function tsToDate(ts: WAMessage["messageTimestamp"]): Date {
  if (!ts) return new Date();
  const n = typeof ts === "number" ? ts : Number((ts as { toNumber?: () => number }).toNumber?.() ?? ts);
  return new Date((Number.isFinite(n) ? n : Date.now() / 1000) * 1000);
}

/** Pick the phone-number jid for a key, preferring *Alt fields (v7 LID support) and falling back to the signal LID map. */
async function resolvePn(jid: string | null | undefined, alt: string | null | undefined, resolve: LidResolver): Promise<string | undefined> {
  if (!jid) return undefined;
  if (!isLid(jid)) return jidNormalizedUser(jid);
  if (alt && !isLid(alt)) return jidNormalizedUser(alt);
  try {
    const pn = await resolve(jid);
    if (pn) return jidNormalizedUser(pn);
  } catch {
    /* resolver failed – keep the LID */
  }
  return jidNormalizedUser(jid);
}

export async function normalizeBaileysMessage(
  msg: WAMessage,
  opts: { resolveLid: LidResolver; chatName?: string; meJid?: string },
): Promise<NormalizedMessage | null> {
  const key = msg.key as WAMessageKey;
  if (!key?.remoteJid || !key.id) return null;
  const content = msg.message;
  if (!content) return null; // e.g. protocol / reaction placeholders without payload

  let type = getContentType(content) ?? "unknown";
  // A document sent with a caption arrives wrapped: documentWithCaptionMessage.message.documentMessage
  let unwrapped: Record<string, unknown> | undefined;
  if (type === "documentWithCaptionMessage") {
    unwrapped = (content.documentWithCaptionMessage?.message?.documentMessage ?? {}) as Record<string, unknown>;
    type = "documentMessage";
  }
  // Ignore purely technical messages
  if (type === "protocolMessage" || type === "senderKeyDistributionMessage") return null;

  const chatIsGroup = isGroupJid(key.remoteJid);
  const chatJid = chatIsGroup ? key.remoteJid : (await resolvePn(key.remoteJid, key.remoteJidAlt, opts.resolveLid)) ?? key.remoteJid;

  let senderJid: string | undefined;
  if (key.fromMe) senderJid = opts.meJid;
  else if (chatIsGroup) senderJid = await resolvePn(key.participant, key.participantAlt, opts.resolveLid);
  else senderJid = chatJid;

  const anyContent = content as Record<string, Record<string, unknown> | undefined>;
  const payload = unwrapped ?? anyContent[type] ?? {};
  const ctx = (payload as { contextInfo?: { stanzaId?: string; participant?: string; quotedMessage?: Record<string, unknown>; mentionedJid?: string[] } }).contextInfo;

  let text: string | undefined;
  let media: NormalizedMessage["media"] | undefined;
  switch (type) {
    case "conversation":
      text = content.conversation ?? undefined;
      break;
    case "extendedTextMessage":
      text = content.extendedTextMessage?.text ?? undefined;
      break;
    case "imageMessage":
    case "videoMessage":
    case "documentMessage":
    case "audioMessage":
    case "stickerMessage": {
      const m = payload as { caption?: string; mimetype?: string; fileLength?: number | { toNumber(): number }; fileName?: string; seconds?: number; accessibilityLabel?: string; isAnimated?: boolean; fileSha256?: Uint8Array };
      text = m.caption;
      media = {
        mimetype: m.mimetype,
        fileLength: typeof m.fileLength === "object" && m.fileLength ? m.fileLength.toNumber() : (m.fileLength as number | undefined),
        fileName: m.fileName,
        seconds: m.seconds,
        caption: m.caption,
        accessibilityLabel: m.accessibilityLabel ?? undefined,
        isAnimated: m.isAnimated ?? undefined,
        sha256: m.fileSha256 ? Buffer.from(m.fileSha256).toString("base64") : undefined,
      };
      break;
    }
    case "reactionMessage":
      text = `(reacción ${content.reactionMessage?.text ?? ""})`;
      break;
    case "locationMessage":
      text = `(ubicación ${content.locationMessage?.degreesLatitude},${content.locationMessage?.degreesLongitude})`;
      break;
    case "contactMessage":
      text = `(contacto ${content.contactMessage?.displayName ?? ""})`;
      break;
    case "pollCreationMessage":
    case "pollCreationMessageV3":
      text = `(encuesta) ${(payload as { name?: string }).name ?? ""}`;
      break;
    default:
      text = undefined;
  }

  let quotedText: string | undefined;
  if (ctx?.quotedMessage) {
    const q = ctx.quotedMessage as { conversation?: string; extendedTextMessage?: { text?: string }; imageMessage?: { caption?: string } };
    quotedText = q.conversation ?? q.extendedTextMessage?.text ?? q.imageMessage?.caption;
  }

  return {
    id: key.id,
    chatJid,
    chatKind: chatIsGroup ? "group" : "dm",
    chatName: opts.chatName,
    senderJid,
    senderPhone: phoneFromJid(senderJid),
    senderName: msg.pushName ?? undefined,
    fromMe: Boolean(key.fromMe),
    timestamp: tsToDate(msg.messageTimestamp),
    type: type.replace(/Message$/, ""),
    text,
    media,
    quoted: ctx?.stanzaId ? { id: ctx.stanzaId, participant: ctx.participant ?? undefined, text: quotedText } : undefined,
    mentions: ctx?.mentionedJid ?? [],
    source: "baileys",
  };
}
