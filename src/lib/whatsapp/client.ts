/**
 * Baileys (WhatsApp Web multi-device) client — a process-wide singleton.
 *
 * Responsibilities:
 *   • connect as a linked device, expose QR + status, auto-reconnect with backoff
 *   • persist creds/keys in Postgres (see auth-state.ts)
 *   • normalise inbound messages, store them and hand them to the bot handler
 *   • send messages and run group operations for the API
 *
 * Everything logs under mod=wa with a `hint` on failure.
 */
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  type GroupMetadata,
  type WAMessage,
  type WASocket,
  type AnyMessageContent,
  type ParticipantAction,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { getLogger, rootLogger, errInfo } from "../logger";
import { env } from "../env";
import { AppError } from "../errors";
import { usePostgresAuthState } from "./auth-state";
import { normalizeBaileysMessage } from "./normalize";
import { isGroupJid, phoneFromJid, toJid } from "./jid";
import type { NormalizedMessage, WhatsAppStatus, ConnectionStatus } from "./types";
import { markParticipants, replaceParticipants, saveMessage, setMediaDescription, setMessageTranscript, setSetting, upsertChat } from "../store";
import { captionSticker, describeMedia, type MediaKind } from "../ai/vision";
import { getSticker, setStickerCaption, upsertSticker } from "../store";
import { createHash } from "node:crypto";
import { r2, r2Enabled, extFromMime } from "../storage/r2";
import { findMessageByWaId, setMediaStorageKey } from "../store";
import { transcribeAudio } from "../ai/transcribe";
import { sendAlert } from "../alerts";

const log = getLogger("wa");

export type InboundHandler = (m: NormalizedMessage, raw: WAMessage) => Promise<void>;

const DISCONNECT_HINTS: Record<number, string> = {
  [DisconnectReason.loggedOut]: "The phone unlinked this device. Call POST /api/whatsapp/logout then GET /api/whatsapp/qr and scan again.",
  [DisconnectReason.badSession]: "Stored session is corrupt. POST /api/whatsapp/logout to wipe it, then rescan the QR.",
  [DisconnectReason.connectionReplaced]: "Another process connected with the same credentials. Make sure only ONE instance of this server runs (Railway replicas = 1).",
  [DisconnectReason.restartRequired]: "WhatsApp asked for a restart – reconnecting automatically.",
  [DisconnectReason.connectionLost]: "Connection lost / timed out – reconnecting automatically.",
  [DisconnectReason.connectionClosed]: "Connection closed – reconnecting automatically.",
  [DisconnectReason.multideviceMismatch]: "Multi-device mismatch. Wipe the session (POST /api/whatsapp/logout) and rescan.",
  [DisconnectReason.forbidden]: "WhatsApp refused the connection (403). The number may be banned or rate-limited – slow down and retry later.",
  [DisconnectReason.unavailableService]: "WhatsApp service unavailable – retrying.",
};

class WhatsAppClient {
  private sock?: WASocket;
  private status: ConnectionStatus = "disconnected";
  private since = new Date();
  private qr?: string;
  private lastError?: string;
  private lastErrorHint?: string;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private starting?: Promise<void>;
  private stopRequested = false;
  private version?: string;
  private handler?: InboundHandler;
  private groupCache = new Map<string, { at: number; meta: GroupMetadata }>();
  private recent = new Map<string, WAMessage>();
  /** downloaded media bytes by message id (avoids downloading twice for archive + transcribe/describe) */
  private mediaBuf = new Map<string, Buffer>();
  private clearCreds?: () => Promise<void>;
  private outageAlerted = false;

  setInboundHandler(h: InboundHandler) {
    this.handler = h;
  }

  getStatus(): WhatsAppStatus {
    const me = this.sock?.user;
    return {
      status: this.status,
      me: me ? { jid: me.id, phone: phoneFromJid(me.id), name: me.name ?? undefined } : undefined,
      qrAvailable: Boolean(this.qr),
      lastError: this.lastError,
      lastErrorHint: this.lastErrorHint,
      since: this.since.toISOString(),
      reconnectAttempts: this.reconnectAttempts,
      version: this.version,
    };
  }

  getQr(): string | undefined {
    return this.qr;
  }

  async getQrDataUrl(): Promise<string | undefined> {
    return this.qr ? QRCode.toDataURL(this.qr, { margin: 1, width: 360 }) : undefined;
  }

  get meJid(): string | undefined {
    return this.sock?.user?.id;
  }

  private setStatus(s: ConnectionStatus, extra: Record<string, unknown> = {}) {
    if (s !== this.status) {
      log.info({ from: this.status, to: s, ...extra }, `connection status → ${s}`);
      this.status = s;
      this.since = new Date();
      void setSetting("whatsapp_status", { status: s, since: this.since.toISOString(), ...extra }).catch(() => {});
    }
  }

  /** Idempotent: starts the socket if not already connecting/open. */
  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.sock && (this.status === "open" || this.status === "connecting" || this.status === "qr")) return;
    this.stopRequested = false;
    this.starting = this.connect().finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async connect() {
    this.setStatus("connecting");
    const { state, saveCreds, clear } = await usePostgresAuthState();
    this.clearCreds = clear;

    let version: [number, number, number] | undefined;
    try {
      const v = await fetchLatestBaileysVersion();
      version = v.version;
      this.version = v.version.join(".");
      log.debug({ version: this.version, isLatest: v.isLatest }, "using WhatsApp Web version");
    } catch (e) {
      log.warn({ err: errInfo(e), hint: "Could not fetch the latest WA Web version; Baileys' bundled default will be used." }, "fetchLatestBaileysVersion failed");
    }

    const baileysLog = rootLogger.child({ mod: "baileys" });
    baileysLog.level = env().LOG_LEVEL === "trace" ? "trace" : "warn";

    const sock = makeWASocket({
      version,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, baileysLog) },
      logger: baileysLog,
      browser: Browsers.macOS(env().BOT_NAME),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      cachedGroupMetadata: async (jid) => this.groupCache.get(jid)?.meta,
      getMessage: async (key) => this.recent.get(key.id ?? "")?.message ?? undefined,
    });
    this.sock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (u.qr) {
        this.qr = u.qr;
        this.setStatus("qr");
        log.info("QR code ready → GET /api/whatsapp/qr (open it in a browser) and scan with WhatsApp › Linked devices");
      }
      if (u.connection === "open") {
        this.qr = undefined;
        this.reconnectAttempts = 0;
        this.lastError = undefined;
        this.lastErrorHint = undefined;
        this.setStatus("open", { me: sock.user?.id });
        log.info({ me: sock.user?.id, name: sock.user?.name }, "✅ WhatsApp connected");
        if (this.outageAlerted) {
          this.outageAlerted = false;
          void sendAlert("recovered", `WhatsApp vuelve a estar conectado como ${sock.user?.name ?? sock.user?.id ?? "?"}.`, "open");
        }
        void this.syncGroups().catch((e) => log.warn({ err: errInfo(e) }, "initial group sync failed"));
      }
      if (u.connection === "close") {
        this.qr = undefined;
        const boom = u.lastDisconnect?.error as Boom | undefined;
        const code = boom?.output?.statusCode ?? 0;
        const reasonName = DisconnectReason[code] ?? "unknown";
        const hint = DISCONNECT_HINTS[code] ?? "Unknown disconnect reason – see the error above; reconnecting automatically.";
        this.lastError = `${reasonName} (${code}): ${boom?.message ?? "connection closed"}`;
        this.lastErrorHint = hint;
        log.warn({ code, reason: reasonName, err: boom ? errInfo(boom) : undefined, hint }, "connection closed");

        if (code === DisconnectReason.loggedOut || code === DisconnectReason.badSession || code === DisconnectReason.multideviceMismatch) {
          this.setStatus("logged_out");
          this.outageAlerted = true;
          void sendAlert("logged_out", `El dispositivo vinculado se ha desconectado de WhatsApp (${reasonName}). Hay que volver a escanear el QR: ${env().APP_URL}/api/whatsapp/qr`, "logged_out");
          void clear().then(() => log.warn("session wiped; call GET /api/whatsapp/qr to link again"));
          this.sock = undefined;
          // A fresh socket is needed to produce a new QR
          if (!this.stopRequested) this.scheduleReconnect(2000);
          return;
        }
        this.setStatus("disconnected");
        this.sock = undefined;
        if (!this.stopRequested) this.scheduleReconnect();
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      for (const raw of messages) {
        try {
          if (raw.key.id) this.remember(raw.key.id, raw);
          const chatJid = raw.key.remoteJid ?? "";
          const chatName = isGroupJid(chatJid) ? (await this.groupMeta(chatJid).catch(() => undefined))?.subject : undefined;
          const m = await normalizeBaileysMessage(raw, {
            resolveLid: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid),
            chatName,
            meJid: sock.user?.id,
          });
          if (!m) continue;
          const saved = await saveMessage(m);
          log.debug(
            { chat: m.chatJid, kind: m.chatKind, from: m.senderPhone ?? m.senderJid, type: m.type, id: m.id, inserted: saved.inserted, upsertType: type, text: m.text?.slice(0, 80) },
            saved.inserted ? "message stored" : saved.enriched ? "message already stored by zernio → enriched with media" : "message already stored",
          );
          // Voice notes → transcript; stickers / photos / videos → short description; media → R2 archive.
          // All async so they never delay other messages. Also runs when the Zernio webhook stored the row
          // first (its copy has no file) – see saveMessage().
          const firstTimeFromBaileys = saved.inserted || saved.enriched === true;
          if (firstTimeFromBaileys && type === "notify") {
            if (m.type === "audio") void this.archiveInbound(m, raw).then(() => this.transcribeInbound(m, raw));
            else if (m.type === "sticker" || m.type === "image" || m.type === "video") void this.archiveInbound(m, raw).then(() => this.describeInbound(m, raw));
            else if (m.type === "document") void this.archiveInbound(m, raw);
          }
          // Only react to live messages (not history sync / our own sends)
          if (type === "notify" && !m.fromMe && this.handler) {
            await this.handler(m, raw);
          }
        } catch (e) {
          log.error({ err: errInfo(e), chat: raw.key.remoteJid, id: raw.key.id, hint: "The message was received but could not be processed. If this repeats, share this stack with the dev." }, "failed to handle inbound message");
        }
      }
    });

    sock.ev.on("groups.upsert", async (groups) => {
      for (const g of groups) await this.rememberGroup(g);
    });
    sock.ev.on("groups.update", async (updates) => {
      for (const u of updates) {
        if (!u.id) continue;
        this.groupCache.delete(u.id);
        await upsertChat({ jid: u.id, kind: "group", name: u.subject, description: u.desc }).catch(() => {});
      }
    });
    sock.ev.on("group-participants.update", async ({ id, participants: raw, action }) => {
      // v7: participants are objects { id, phoneNumber?, admin? }; older versions sent plain jids
      const participants = raw.map((p) => (typeof p === "string" ? p : ((p as { phoneNumber?: string }).phoneNumber ?? p.id)));
      log.info({ group: id, action, participants }, "group participants update");
      this.groupCache.delete(id);
      const me = sock.user?.id ? phoneFromJid(sock.user.id) : undefined;
      const affectsMe = participants.some((p) => phoneFromJid(p) === me);
      if (affectsMe && action === "remove") {
        await upsertChat({ jid: id, kind: "group", botIsMember: false });
        log.warn({ group: id }, "bot was removed from group");
        return;
      }
      if (affectsMe && action === "add") {
        await upsertChat({ jid: id, kind: "group", botIsMember: true });
        await this.groupMeta(id, true).catch(() => {});
      }
      await markParticipants(id, participants, action as "add" | "remove" | "promote" | "demote").catch(() => {});
    });
  }

  /**
   * Give a sticker / photo / video a one-line description so summaries know what was sent.
   * Uses WhatsApp's accessibility label when present (free); otherwise Gemini vision on the sticker file,
   * the inline thumbnail (images/videos) or the full image as a last resort. Cached per file hash.
   */
  async describeInbound(m: NormalizedMessage, raw: WAMessage): Promise<string | undefined> {
    const e = env();
    const kind = m.type as MediaKind;
    const tag = kind === "sticker" ? "sticker" : kind === "video" ? "vídeo" : "foto";
    try {
      if (kind === "sticker") return await this.storeSticker(m, raw);
      if (m.media?.accessibilityLabel) {
        const desc = `(${tag}: ${m.media.accessibilityLabel})`;
        await setMediaDescription(m.chatJid, m.id, desc, { keepText: Boolean(m.text) });
        log.debug({ chat: m.chatJid, id: m.id, kind, label: m.media.accessibilityLabel }, "media described from WhatsApp label");
        return desc;
      }
      if (!e.DESCRIBE_MEDIA || !e.OPENROUTER_API_KEY) return undefined;
      const content = raw.message as Record<string, { jpegThumbnail?: Uint8Array; mimetype?: string } | undefined> | undefined;
      const inner = content?.imageMessage ?? content?.videoMessage ?? content?.stickerMessage ?? (content?.documentWithCaptionMessage as unknown as { message?: { imageMessage?: { jpegThumbnail?: Uint8Array } } } | undefined)?.message?.imageMessage;
      let buffer: Buffer | undefined;
      let mimetype = m.media?.mimetype;
      if (inner?.jpegThumbnail?.length) {
        buffer = Buffer.from(inner.jpegThumbnail);
        mimetype = "image/jpeg";
      } else if (kind === "image") {
        if ((m.media?.fileLength ?? 0) > 6_000_000) return undefined; // don't pull huge files just for a caption
        buffer = await this.downloadOnce(m, raw);
      }
      if (!buffer) return undefined;
      const { description, cached } = await describeMedia(buffer, { kind, mimetype, sha256: m.media?.sha256, reqId: m.id.slice(-8) });
      const desc = `(${tag}: ${description})`;
      await setMediaDescription(m.chatJid, m.id, desc, { keepText: Boolean(m.text) });
      log.info({ chat: m.chatJid, id: m.id, kind, cached, desc }, "media described");
      return desc;
    } catch (err) {
      log.warn({ err: errInfo(err), chat: m.chatJid, id: m.id, kind, hint: "Media left without description. Animated stickers or expired media can fail; harmless." }, "media description failed");
      return undefined;
    }
  }

  /** Download a message's media once (cached in memory for the follow-up steps). */
  async downloadOnce(m: NormalizedMessage, raw: WAMessage): Promise<Buffer> {
    const hit = this.mediaBuf.get(m.id);
    if (hit) return hit;
    const buf = (await downloadMediaMessage(raw, "buffer", {}, { logger: rootLogger.child({ mod: "baileys" }), reuploadRequest: this.sock!.updateMediaMessage })) as Buffer;
    this.mediaBuf.set(m.id, buf);
    if (this.mediaBuf.size > 200) {
      const first = this.mediaBuf.keys().next().value;
      if (first) this.mediaBuf.delete(first);
    }
    return buf;
  }

  /** Copy received media (audio/image/video/document, stickers excluded – they have their own library) to R2. */
  async archiveInbound(m: NormalizedMessage, raw: WAMessage): Promise<string | undefined> {
    const e = env();
    if (!e.MEDIA_ARCHIVE || !r2Enabled() || m.type === "sticker") return undefined;
    const size = m.media?.fileLength ?? 0;
    if (size > e.MEDIA_ARCHIVE_MAX_MB * 1e6) {
      log.debug({ id: m.id, sizeMb: (size / 1e6).toFixed(1) }, "media too large for archive (MEDIA_ARCHIVE_MAX_MB)");
      return undefined;
    }
    try {
      const buf = await this.downloadOnce(m, raw);
      const key = `whats-bot/media/${m.chatJid.replace(/[^\w.@-]/g, "_")}/${m.id}.${extFromMime(m.media?.mimetype)}`;
      await r2.put(key, buf, m.media?.mimetype?.split(";")[0] || "application/octet-stream", { chat: m.chatJid, sender: m.senderPhone ?? "" });
      await setMediaStorageKey(m.chatJid, m.id, key);
      log.info({ id: m.id, chat: m.chatJid, type: m.type, bytes: buf.length, key }, "📦 media archived to R2");
      return key;
    } catch (err) {
      log.warn({ err: errInfo(err), id: m.id, hint: "Media not archived; it is still processed from memory. Check R2 credentials (GET /api/health)." }, "media archive failed");
      return undefined;
    }
  }

  /**
   * Bytes of a message's media: in-memory cache → live download (recent cache) → R2 archive.
   * Lets /transcribir, /sticker and GET /api/messages/:id/media work after restarts.
   */
  async getMediaBuffer(chatJid: string, waId: string): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string } | undefined> {
    const cached = this.mediaBuf.get(waId);
    const raw = this.recent.get(waId);
    if (cached) {
      const inner = raw?.message ? Object.values(raw.message as Record<string, { mimetype?: string; fileName?: string } | undefined>).find((v) => v && typeof v === "object" && "mimetype" in v) : undefined;
      return { buffer: cached, mimetype: inner?.mimetype, fileName: inner?.fileName };
    }
    if (raw?.message && this.status === "open") {
      try {
        const buffer = (await downloadMediaMessage(raw, "buffer", {}, { logger: rootLogger.child({ mod: "baileys" }), reuploadRequest: this.sock!.updateMediaMessage })) as Buffer;
        const inner = Object.values(raw.message as Record<string, { mimetype?: string; fileName?: string } | undefined>).find((v) => v && typeof v === "object" && "mimetype" in v);
        return { buffer, mimetype: inner?.mimetype, fileName: inner?.fileName };
      } catch (e) {
        log.debug({ err: errInfo(e), waId }, "live media download failed – trying R2");
      }
    }
    const row = await findMessageByWaId(chatJid, waId);
    const key = row?.media?.storageKey as string | undefined;
    if (key && r2Enabled()) {
      const { buffer, contentType } = await r2.get(key);
      return { buffer, mimetype: (row?.media?.mimetype as string | undefined) ?? contentType, fileName: row?.media?.fileName as string | undefined };
    }
    return undefined;
  }

  /** Save a sticker into the library (file + AI caption) and attach the caption to the message. */
  private async storeSticker(m: NormalizedMessage, raw: WAMessage): Promise<string | undefined> {
    const e = env();
    if ((m.media?.fileLength ?? 0) > 3_000_000) return undefined;
    const webp = await this.downloadOnce(m, raw);
    const sha256 = m.media?.sha256 ?? createHash("sha256").update(webp).digest("base64");
    const { row, isNew } = await upsertSticker({ sha256, data: webp, mimetype: m.media?.mimetype, isAnimated: m.media?.isAnimated, chatJid: m.chatJid, senderJid: m.senderJid, senderName: m.senderName });
    let caption = row?.caption ?? undefined;
    if (!caption && (e.DESCRIBE_MEDIA || m.media?.accessibilityLabel) && e.OPENROUTER_API_KEY) {
      try {
        const c = await captionSticker(webp, { animated: m.media?.isAnimated, reqId: m.id.slice(-8) });
        caption = c.caption;
        await setStickerCaption(sha256, c.caption, c.tags, c.model);
      } catch (err) {
        if (m.media?.accessibilityLabel) caption = m.media.accessibilityLabel;
        log.warn({ err: errInfo(err), sha256, hint: "Sticker stored without caption; will be captioned next time it is seen." }, "sticker caption failed");
      }
    }
    if (caption) await setMediaDescription(m.chatJid, m.id, `(sticker: ${caption})`);
    log.info({ chat: m.chatJid, id: m.id, sha256: sha256.slice(0, 12), isNew, animated: Boolean(m.media?.isAnimated), bytes: webp.length, caption }, isNew ? "🧩 new sticker stored" : "🧩 sticker seen again");
    return caption ? `(sticker: ${caption})` : undefined;
  }

  /** Download an audio message and store its Gemini transcript as the message text. */
  async transcribeInbound(m: NormalizedMessage, raw: WAMessage): Promise<string | undefined> {
    const e = env();
    if (!e.TRANSCRIBE_AUDIO || !e.OPENROUTER_API_KEY) return undefined;
    const seconds = m.media?.seconds ?? 0;
    if (seconds > e.TRANSCRIBE_MAX_SECONDS) {
      log.info({ chat: m.chatJid, id: m.id, seconds, max: e.TRANSCRIBE_MAX_SECONDS }, "audio too long – skipping transcription (TRANSCRIBE_MAX_SECONDS)");
      return undefined;
    }
    const t0 = Date.now();
    try {
      const buffer = await this.downloadOnce(m, raw);
      const res = await transcribeAudio(buffer, { mimetype: m.media?.mimetype, seconds, reqId: m.id.slice(-8), context: m.chatName ? `WhatsApp group "${m.chatName}"` : undefined });
      await setMessageTranscript(m.chatJid, m.id, res.transcript, { model: res.model, ms: Date.now() - t0 });
      log.info({ chat: m.chatJid, id: m.id, from: m.senderPhone ?? m.senderJid, seconds, chars: res.transcript.length, ms: Date.now() - t0, preview: res.transcript.slice(0, 80) }, "🎤 voice note transcribed");
      return res.transcript;
    } catch (err) {
      log.error({ err: errInfo(err), chat: m.chatJid, id: m.id, hint: "Voice note kept as [audio]. If this repeats: check OPENROUTER_API_KEY / GEMINI_MODEL supports audio (GET /api/ai/models), or the media download failed (expired media?)." }, "transcription failed");
      return undefined;
    }
  }

  private scheduleReconnect(delayMs?: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts += 1;
    const delay = delayMs ?? Math.min(60_000, 2_000 * 2 ** Math.min(this.reconnectAttempts - 1, 5));
    log.info({ attempt: this.reconnectAttempts, delayMs: delay }, "scheduling reconnect");
    if (this.reconnectAttempts === 4 && this.status !== "logged_out" && !this.outageAlerted) {
      // ~30 s of failed reconnects → tell the operator (recovery alert follows when it comes back)
      this.outageAlerted = true;
      void sendAlert("disconnected", `WhatsApp lleva ${this.reconnectAttempts} intentos sin reconectar. Último error: ${this.lastError ?? "?"}`, this.status);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.start().catch((e) => {
        log.error({ err: errInfo(e), hint: "Reconnect failed; will retry with backoff." }, "reconnect failed");
        this.scheduleReconnect();
      });
    }, delay);
  }

  async stop() {
    this.stopRequested = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.end(undefined);
    this.sock = undefined;
    this.setStatus("disconnected");
    log.info("WhatsApp socket stopped by request");
  }

  async logout() {
    this.stopRequested = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      await this.sock?.logout();
    } catch (e) {
      log.warn({ err: errInfo(e) }, "logout() on socket failed (session may already be dead) – wiping stored session anyway");
    }
    this.sock = undefined;
    if (this.clearCreds) await this.clearCreds();
    else {
      const { clear } = await usePostgresAuthState();
      await clear();
    }
    this.qr = undefined;
    this.setStatus("logged_out");
  }

  private remember(id: string, m: WAMessage) {
    this.recent.set(id, m);
    if (this.recent.size > 3000) {
      const first = this.recent.keys().next().value;
      if (first) this.recent.delete(first);
    }
  }

  getRecent(id: string) {
    return this.recent.get(id);
  }

  /** Re-request an expired media upload (used by media downloads). */
  updateMedia(msg: WAMessage) {
    return this.requireSocket().updateMediaMessage(msg);
  }

  // ───────────────────────── outbound ─────────────────────────

  private requireSocket(): WASocket {
    if (!this.sock || this.status !== "open") {
      throw new AppError(503, "whatsapp_not_connected", `WhatsApp is not connected (status: ${this.status}).`, {
        hint:
          this.status === "qr"
            ? "Scan the QR at GET /api/whatsapp/qr with the phone (WhatsApp › Linked devices)."
            : this.status === "logged_out"
              ? "Session was logged out. GET /api/whatsapp/qr to link again."
              : "Check GET /api/whatsapp/status → lastError / lastErrorHint. POST /api/whatsapp/connect to (re)start.",
      });
    }
    return this.sock;
  }

  async sendText(to: string, text: string, opts: { quotedId?: string; mentions?: string[] } = {}) {
    const sock = this.requireSocket();
    const jid = toJid(to);
    const quoted = opts.quotedId ? this.recent.get(opts.quotedId) : undefined;
    const t0 = Date.now();
    try {
      const res = await sock.sendMessage(jid, { text, mentions: opts.mentions }, { quoted });
      if (res?.key?.id) this.remember(res.key.id, res);
      log.info({ to: jid, id: res?.key?.id, chars: text.length, ms: Date.now() - t0 }, "message sent");
      if (res) {
        const m = await normalizeBaileysMessage(res, { resolveLid: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid), meJid: sock.user?.id });
        if (m) await saveMessage(m).catch(() => {});
      }
      return { id: res?.key?.id ?? null, to: jid };
    } catch (e) {
      throw new AppError(502, "send_failed", `Failed to send message to ${jid}: ${errInfo(e).message}`, {
        hint: isGroupJid(jid)
          ? "Check the bot is still a member of the group (GET /api/groups?live=1) and the group is not admin-only (announcement)."
          : "Check the number exists on WhatsApp and is formatted as country code + number (e.g. 34600111222).",
        cause: e,
      });
    }
  }

  async sendMedia(to: string, media: { url: string; type: "image" | "video" | "audio" | "document"; caption?: string; fileName?: string; mimetype?: string }) {
    const sock = this.requireSocket();
    const jid = toJid(to);
    let content: AnyMessageContent;
    switch (media.type) {
      case "image":
        content = { image: { url: media.url }, caption: media.caption };
        break;
      case "video":
        content = { video: { url: media.url }, caption: media.caption };
        break;
      case "audio":
        content = { audio: { url: media.url }, mimetype: media.mimetype ?? "audio/mp4" };
        break;
      default:
        content = { document: { url: media.url }, fileName: media.fileName ?? "file", mimetype: media.mimetype ?? "application/octet-stream", caption: media.caption };
    }
    try {
      const res = await sock.sendMessage(jid, content);
      log.info({ to: jid, id: res?.key?.id, type: media.type }, "media sent");
      return { id: res?.key?.id ?? null, to: jid };
    } catch (e) {
      throw new AppError(502, "send_failed", `Failed to send ${media.type} to ${jid}: ${errInfo(e).message}`, {
        hint: "Check the media URL is publicly reachable and the mimetype matches the file.",
        cause: e,
      });
    }
  }

  /** Show "typing…" / "recording audio…" in a chat. Best-effort: never throws. */
  async presence(jid: string, kind: "composing" | "recording" | "paused") {
    try {
      await this.requireSocket().sendPresenceUpdate(kind, toJid(jid));
    } catch (e) {
      log.debug({ err: errInfo(e), jid, kind }, "presence update failed (ignored)");
    }
  }

  /**
   * Keep a presence indicator alive while `fn` runs (WhatsApp drops it after ~10 s, so it is re-sent
   * every 6 s), then clear it. The result of `fn` is returned unchanged.
   */
  async withPresence<T>(jid: string, kind: "composing" | "recording", fn: () => Promise<T>): Promise<T> {
    await this.presence(jid, kind);
    const timer = setInterval(() => void this.presence(jid, kind), 6_000);
    try {
      return await fn();
    } finally {
      clearInterval(timer);
      void this.presence(jid, "paused");
    }
  }

  /** Send a WebP buffer as a sticker. Convert first with toStickerWebp() unless it already is a 512px WebP. */
  async sendSticker(to: string, webp: Buffer, opts: { quotedId?: string } = {}) {
    const sock = this.requireSocket();
    const jid = toJid(to);
    const quoted = opts.quotedId ? this.recent.get(opts.quotedId) : undefined;
    try {
      const res = await sock.sendMessage(jid, { sticker: webp }, { quoted });
      if (res?.key?.id) this.remember(res.key.id, res);
      log.info({ to: jid, id: res?.key?.id, bytes: webp.length }, "sticker sent");
      return { id: res?.key?.id ?? null, to: jid };
    } catch (e) {
      throw new AppError(502, "send_failed", `Failed to send sticker to ${jid}: ${errInfo(e).message}`, { hint: "Stickers must be WebP ≤ 512×512; use toStickerWebp() to convert.", cause: e });
    }
  }

  /** Send an Ogg/Opus buffer as a WhatsApp voice note (ptt). */
  async sendVoice(to: string, audio: Buffer, opts: { mimetype?: string; quotedId?: string; seconds?: number } = {}) {
    const sock = this.requireSocket();
    const jid = toJid(to);
    const quoted = opts.quotedId ? this.recent.get(opts.quotedId) : undefined;
    try {
      const res = await sock.sendMessage(jid, { audio, mimetype: opts.mimetype ?? "audio/ogg; codecs=opus", ptt: true, seconds: opts.seconds }, { quoted });
      if (res?.key?.id) this.remember(res.key.id, res);
      log.info({ to: jid, id: res?.key?.id, bytes: audio.length }, "voice note sent");
      return { id: res?.key?.id ?? null, to: jid };
    } catch (e) {
      throw new AppError(502, "send_failed", `Failed to send voice note to ${jid}: ${errInfo(e).message}`, { hint: "Check the bot is connected and is a member of the chat.", cause: e });
    }
  }

  async react(chatJid: string, messageId: string, emoji: string) {
    const sock = this.requireSocket();
    const raw = this.recent.get(messageId);
    if (!raw) throw AppError.notFound(`Message ${messageId} is not in the recent cache.`, "Reactions need the original message key; only messages seen since the last restart can be reacted to.");
    await sock.sendMessage(chatJid, { react: { text: emoji, key: raw.key } });
  }

  async downloadMedia(messageId: string): Promise<{ buffer: Buffer; mimetype?: string; fileName?: string }> {
    const raw = this.recent.get(messageId);
    if (!raw?.message) throw AppError.notFound(`Message ${messageId} is not in the recent cache.`, "Media can only be downloaded for messages received since the last restart (cache of 3000).");
    const sock = this.requireSocket();
    const buffer = await downloadMediaMessage(raw, "buffer", {}, { logger: rootLogger.child({ mod: "baileys" }), reuploadRequest: sock.updateMediaMessage });
    const content = raw.message as Record<string, { mimetype?: string; fileName?: string } | undefined>;
    const inner = Object.values(content).find((v) => v && typeof v === "object" && "mimetype" in v);
    return { buffer: buffer as Buffer, mimetype: inner?.mimetype, fileName: inner?.fileName };
  }

  // ───────────────────────── groups ─────────────────────────

  private async rememberGroup(meta: GroupMetadata) {
    this.groupCache.set(meta.id, { at: Date.now(), meta });
    await upsertChat({
      jid: meta.id,
      kind: "group",
      name: meta.subject,
      description: meta.desc ?? null,
      participantCount: meta.participants?.length ?? meta.size ?? null,
      botIsMember: true,
      metadata: { owner: meta.owner, creation: meta.creation, announce: meta.announce, restrict: meta.restrict, isCommunity: meta.isCommunity, addressingMode: meta.addressingMode },
    });
    await replaceParticipants(
      meta.id,
      (meta.participants ?? []).map((p) => {
        const pn = (p as { phoneNumber?: string }).phoneNumber ?? (p.id.endsWith("@s.whatsapp.net") ? p.id : undefined);
        return { userJid: pn ?? p.id, phone: phoneFromJid(pn), isAdmin: Boolean(p.admin), name: (p as { name?: string }).name };
      }),
    );
  }

  async groupMeta(jid: string, force = false): Promise<GroupMetadata> {
    const cached = this.groupCache.get(jid);
    if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.meta;
    const sock = this.requireSocket();
    try {
      const meta = await sock.groupMetadata(jid);
      await this.rememberGroup(meta);
      return meta;
    } catch (e) {
      throw new AppError(502, "group_metadata_failed", `Could not fetch metadata for ${jid}: ${errInfo(e).message}`, {
        hint: "Is the bot a member of this group? Group jids end in @g.us; list them with GET /api/groups?live=1.",
        cause: e,
      });
    }
  }

  async syncGroups(): Promise<GroupMetadata[]> {
    const sock = this.requireSocket();
    const t0 = Date.now();
    const all = await sock.groupFetchAllParticipating();
    const list = Object.values(all);
    for (const g of list) await this.rememberGroup(g);
    log.info({ groups: list.length, ms: Date.now() - t0 }, "groups synced from WhatsApp");
    return list;
  }

  async groupCreate(subject: string, participants: string[]) {
    const sock = this.requireSocket();
    const meta = await sock.groupCreate(subject, participants.map(toJid));
    await this.rememberGroup(meta);
    log.info({ group: meta.id, subject }, "group created");
    return meta;
  }

  async groupUpdate(jid: string, patch: { subject?: string; description?: string; setting?: "announcement" | "not_announcement" | "locked" | "unlocked" }) {
    const sock = this.requireSocket();
    if (patch.subject !== undefined) await sock.groupUpdateSubject(jid, patch.subject);
    if (patch.description !== undefined) await sock.groupUpdateDescription(jid, patch.description);
    if (patch.setting) await sock.groupSettingUpdate(jid, patch.setting);
    log.info({ group: jid, patch }, "group updated");
    return this.groupMeta(jid, true);
  }

  async groupParticipants(jid: string, participants: string[], action: ParticipantAction) {
    const sock = this.requireSocket();
    const res = await sock.groupParticipantsUpdate(jid, participants.map(toJid), action);
    await this.groupMeta(jid, true).catch(() => {});
    log.info({ group: jid, action, result: res }, "group participants updated");
    return res;
  }

  async groupLeave(jid: string) {
    const sock = this.requireSocket();
    await sock.groupLeave(jid);
    this.groupCache.delete(jid);
    await upsertChat({ jid, kind: "group", botIsMember: false });
    log.info({ group: jid }, "left group");
  }

  async groupInvite(jid: string, revoke = false) {
    const sock = this.requireSocket();
    const code = revoke ? await sock.groupRevokeInvite(jid) : await sock.groupInviteCode(jid);
    return { code, link: code ? `https://chat.whatsapp.com/${code}` : null };
  }

  async groupJoin(codeOrLink: string) {
    const sock = this.requireSocket();
    const code = codeOrLink.replace(/^https?:\/\/chat\.whatsapp\.com\//, "").trim();
    const jid = await sock.groupAcceptInvite(code);
    if (jid) await this.groupMeta(jid, true).catch(() => {});
    log.info({ group: jid, code }, "joined group via invite");
    return { jid };
  }

  async groupInviteInfo(codeOrLink: string) {
    const sock = this.requireSocket();
    const code = codeOrLink.replace(/^https?:\/\/chat\.whatsapp\.com\//, "").trim();
    return sock.groupGetInviteInfo(code);
  }

  async checkNumber(phone: string) {
    const sock = this.requireSocket();
    const res = await sock.onWhatsApp(toJid(phone));
    return res?.[0] ?? { exists: false, jid: toJid(phone) };
  }
}

// Singleton across Next.js hot reloads.
const g = globalThis as unknown as { __whatsbotWa?: WhatsAppClient };
export const whatsapp: WhatsAppClient = g.__whatsbotWa ?? (g.__whatsbotWa = new WhatsAppClient());
