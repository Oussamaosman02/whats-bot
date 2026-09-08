/** Transport-agnostic message shape used by the bot, the store and the API. */
export type NormalizedMessage = {
  /** Platform message id (Baileys key.id / Zernio platformMessageId / Cloud wamid) */
  id: string;
  chatJid: string;
  chatKind: "group" | "dm";
  chatName?: string;
  senderJid?: string;
  senderPhone?: string;
  senderName?: string;
  fromMe: boolean;
  timestamp: Date;
  type: string;
  text?: string;
  media?: {
    mimetype?: string;
    fileLength?: number;
    fileName?: string;
    seconds?: number;
    caption?: string;
    /** WhatsApp-provided alt text for stickers/images, when present */
    accessibilityLabel?: string;
    isAnimated?: boolean;
    /** base64 sha256 of the file (dedupe key for descriptions) */
    sha256?: string;
    /** filled later by vision / transcription */
    description?: string;
    transcript?: string;
  };
  quoted?: { id: string; participant?: string; text?: string };
  mentions: string[];
  source: "baileys" | "zernio" | "cloud" | "import";
  raw?: Record<string, unknown>;
};

export type ConnectionStatus = "disconnected" | "connecting" | "qr" | "open" | "logged_out";

export type WhatsAppStatus = {
  status: ConnectionStatus;
  me?: { jid: string; phone?: string; name?: string };
  qrAvailable: boolean;
  lastError?: string;
  lastErrorHint?: string;
  since?: string;
  reconnectAttempts: number;
  version?: string;
};
