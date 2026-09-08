/**
 * Inbound message handler: turns a NormalizedMessage into bot actions.
 * Registered on the WhatsApp client at boot (see src/instrumentation.ts).
 */
import type { WAMessage } from "@whiskeysockets/baileys";
import { env } from "../env";
import { getLogger, errInfo } from "../logger";
import { isAppError } from "../errors";
import { whatsapp } from "../whatsapp/client";
import { phoneFromJid } from "../whatsapp/jid";
import type { NormalizedMessage } from "../whatsapp/types";
import { countStickers, countUserSummariesSince, findMessageByWaId, getSticker, getStickerBytes, groupsForUser, listStickers, markMessageAsCommand, randomSticker, setReadMark } from "../store";
import { pickStickerReply } from "../ai/vision";
import { zonedParts, zonedToUtc } from "./since";
import { helpText, parseCommand, type Command } from "./commands";
import { runQuestion, runSummary } from "./service";
import { fmtZoned, looksLikeSince, parseSince, SINCE_HELP, type SinceSpec } from "./since";
import { zernio } from "../zernio/client";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootLogger } from "../logger";
import { importExportText, readExportFile } from "../import";
import { synthesize, ttsEnabled } from "../ai/tts";
import { isLongVoiceNote, summarizeVoiceNote, transcribeAudio } from "../ai/transcribe";
import { setMessageTranscript } from "../store";
import { toStickerWebp } from "../whatsapp/sticker";

const log = getLogger("bot");
const lastRun = new Map<string, number>();
const COOLDOWN_MS = 15_000;

function fmtRange(from: Date, to: Date) {
  const tz = env().BOT_TIMEZONE;
  return `${fmtZoned(from, tz)} → ${fmtZoned(to, tz)}`;
}

/** 75 → "1:15 min", 40 → "40 s" */
function fmtSeconds(s: number) {
  const n = Math.round(s);
  return n < 60 ? `${n} s` : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")} min`;
}

/** Sends a DM to a user, via Baileys or Zernio depending on DM_TRANSPORT. */
async function sendDm(userJid: string, text: string, reqId: string) {
  const phone = phoneFromJid(userJid);
  if (env().DM_TRANSPORT === "zernio" && phone) {
    await zernio.sendToPhone({ phone, text, reqId });
    return;
  }
  await whatsapp.sendText(userJid, text);
}

export async function handleInbound(m: NormalizedMessage, raw: WAMessage): Promise<void> {
  const reqId = m.id.slice(-8);
  const me = whatsapp.meJid;
  const botPhone = phoneFromJid(me);
  const botMentioned = m.mentions.some((j) => phoneFromJid(j) === botPhone || j === me) || (botPhone ? (m.text ?? "").includes(`@${botPhone}`) : false);
  const isDm = m.chatKind === "dm";
  const cmd = parseCommand(m.text, { isDm, botMentioned, botPhone });
  if (!cmd) return;

  const blog = log.child({ reqId, chat: m.chatJid, from: m.senderPhone ?? m.senderJid, cmd: cmd.name });
  blog.info({ text: m.text?.slice(0, 120) }, "command received");
  await markMessageAsCommand(m.chatJid, m.id).catch(() => {});

  const reply = (text: string) => whatsapp.sendText(m.chatJid, text, { quotedId: m.id });

  // "escribiendo…" while we work; "grabando audio…" when the answer will be a voice note
  const wantsAudio = ((cmd.name === "summary" || cmd.name === "ask") && cmd.audio && ttsEnabled()) || cmd.name === "say";
  const presenceKind = wantsAudio ? "recording" : "composing";
  const quick = cmd.name === "help" || cmd.name === "ping" || cmd.name === "id" || cmd.name === "unknown";

  try {
    await (quick ? Promise.resolve() : whatsapp.withPresence(m.chatJid, presenceKind, () => runCommand()));
    if (quick) await runCommand();
  } catch (e) {
    const info = errInfo(e);
    const hint = isAppError(e) ? e.hint : undefined;
    blog.error({ err: info, hint: hint ?? "Command failed; see stack." }, "command failed");
    const userMsg = isAppError(e) && e.code === "no_messages" ? `${e.message} Prueba */resumen 24h* o */resumen todo*.` : `⚠️ No pude completar el comando (${isAppError(e) ? e.code : "error"}). Inténtalo de nuevo en un momento.`;
    await reply(userMsg).catch((e2) => blog.error({ err: errInfo(e2) }, "could not even send the error reply"));
  }

  async function runCommand() {
    switch (cmd!.name) {
      case "help":
        await reply(helpText({ isDm }));
        return;
      case "ping":
        await reply(`pong 🏓 (${env().BOT_NAME} · ${fmtZoned(new Date(), env().BOT_TIMEZONE)} ${env().BOT_TIMEZONE})`);
        return;
      case "id":
        await reply(`chat: ${m.chatJid}\nyou: ${m.senderJid ?? "?"}\nmsg: ${m.id}`);
        return;
      case "mark": {
        if (!m.senderJid) return;
        await setReadMark(m.chatJid, m.senderJid, m.timestamp);
        await reply("📍 Marcado. El próximo */resumen* empezará desde aquí.");
        return;
      }
      case "transcribe": {
        if (!m.quoted?.id) {
          await reply("Responde (cita) a una nota de voz con */transcribir*.");
          return;
        }
        const quoted = await findMessageByWaId(m.chatJid, m.quoted.id);
        if (!quoted || quoted.type !== "audio") {
          await reply("El mensaje citado no es una nota de voz.");
          return;
        }
        const seconds = quoted.media?.seconds as number | undefined;
        let text = quoted.media?.transcript as string | undefined;
        if (!text) {
          const media = await whatsapp.getMediaBuffer(m.chatJid, m.quoted.id);
          if (!media) {
            await reply("No puedo recuperar ese audio (es anterior a mi llegada o no se archivó).");
            return;
          }
          const t = await transcribeAudio(media.buffer, { mimetype: media.mimetype ?? (quoted.media?.mimetype as string | undefined), seconds, reqId });
          text = t.transcript;
          await setMessageTranscript(m.chatJid, quoted.waId, t.transcript, { model: t.model, ms: t.ms });
        }
        if (!text || text === "[inaudible]") {
          await reply(text ? "En esa nota de voz no se entiende nada 🙈" : "No he podido transcribir ese audio. Mira los logs (transcription failed).");
          return;
        }
        const who = quoted.senderName ?? "Nota de voz";
        if (cmd.brief) {
          // TL;DR: the point of the voice note in a few bullets (short ones come back as they are).
          const s = await summarizeVoiceNote(text, { senderName: quoted.senderName ?? undefined, seconds, reqId });
          await reply(s.condensed ? `🎤 *${who}* (resumen${seconds ? `, ${fmtSeconds(seconds)}` : ""}):\n${s.summary}` : `🎤 *${who}:*\n${s.summary}\n\n_(era corta, te la dejo entera)_`);
          return;
        }
        const hint = isLongVoiceNote(text, seconds) ? `\n\n_${env().BOT_COMMAND_PREFIX}transcribir breve → solo lo importante_` : "";
        await reply(`🎤 *${who}:*\n${text}${hint}`);
        return;
      }
      case "groups": {
        if (!isDm || !m.senderJid) {
          await reply("Este comando solo funciona por privado 🙂");
          return;
        }
        const groups = await groupsForUser(m.senderJid, m.senderPhone);
        if (!groups.length) {
          await reply("No compartimos ningún grupo todavía (o aún no he sincronizado). Añádeme a un grupo y escribe algo en él.");
          return;
        }
        const lines = groups.map((g, i) => `*${i + 1}.* ${g.name ?? g.jid}${g.lastMessageAt ? ` _(${fmtZoned(g.lastMessageAt, env().BOT_TIMEZONE)})_` : ""}`);
        await reply(`Grupos que compartimos:\n${lines.join("\n")}\n\nUsa */resumen <nº> [periodo]* para resumir uno aquí.`);
        return;
      }
      case "ask": {
        if (!cmd.question) {
          await reply("¿Qué quieres preguntar? Ej: */preguntar qué se decidió sobre la cena*");
          return;
        }
        const audio = cmd.audio && ttsEnabled();
        const res = await runQuestion({ chatJid: m.chatJid, question: cmd.question, reqId, spoken: audio });
        if (audio) await replyVoice(m, res.text, reqId, reply);
        else await reply(res.text);
        return;
      }
      case "sticker":
        await handleSticker(cmd, m, raw, reqId, reply);
        return;
      case "say": {
        // admin-only: make the bot say something as a voice note
        if (!isAdmin(m.senderPhone) || !cmd.text) return;
        if (!ttsEnabled()) {
          await reply("La voz no está configurada (ELEVENLABS_API_KEY).");
          return;
        }
        await replyVoice(m, cmd.text, reqId, reply);
        return;
      }
      case "summary":
        await handleSummary(cmd, m, raw, reqId, reply);
        return;
      case "import":
        await handleImport(cmd, m, raw, reqId, reply);
        return;
      case "unknown":
        await reply(`No conozco *${cmd!.raw}*. Escribe *${env().BOT_COMMAND_PREFIX}ayuda* para ver los comandos.`);
        return;
    }
  }
}

async function handleSummary(cmd: Extract<Command, { name: "summary" }>, m: NormalizedMessage, raw: WAMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const isDm = m.chatKind === "dm";
  const requester = m.senderJid;
  const blog = log.child({ reqId });

  // Cooldown per user
  const key = `${m.chatJid}:${requester}`;
  const last = lastRun.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    await reply("⏳ Espera unos segundos antes de pedir otro resumen.");
    return;
  }
  lastRun.set(key, Date.now());

  // Daily quota per user (admins exempt)
  const limit = env().DAILY_SUMMARY_LIMIT;
  if (requester && limit > 0 && !isAdmin(m.senderPhone)) {
    const tz = env().BOT_TIMEZONE;
    const p = zonedParts(new Date(), tz);
    const dayStart = zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
    const used = await countUserSummariesSince(requester, dayStart);
    if (used >= limit) {
      blog.info({ requester, used, limit }, "daily summary quota reached");
      await reply(`⛔ Ya has usado tus ${limit} resúmenes de hoy. Mañana podrás pedir más 🙂`);
      return;
    }
  }

  // Which chat? In a group: this one, args = since expression.
  // In a DM: args = "<group number|name> [since expression]".
  let targetJid = m.chatJid;
  let sinceText = cmd.args.join(" ");
  if (isDm) {
    if (!requester) return;
    if (!cmd.args.length) {
      await reply("Por privado dime qué grupo: */grupos* para verlos y luego */resumen <nº o nombre> [desde]*.");
      return;
    }
    const groups = await groupsForUser(requester, m.senderPhone);
    let pick: (typeof groups)[number] | undefined;
    let used = 0;
    if (/^\d+$/.test(cmd.args[0]) && Number(cmd.args[0]) <= groups.length) {
      pick = groups[Number(cmd.args[0]) - 1];
      used = 1;
    } else {
      // longest token prefix that matches a group name (exact, then contains)
      for (let n = cmd.args.length; n > 0 && !pick; n--) {
        const needle = cmd.args.slice(0, n).join(" ").toLowerCase();
        pick = groups.find((g) => (g.name ?? "").toLowerCase() === needle) ?? groups.find((g) => (g.name ?? "").toLowerCase().includes(needle));
        if (pick) used = n;
      }
    }
    if (!pick) {
      await reply(`No encuentro el grupo "${cmd.args[0]}". Usa */grupos* para ver la lista.`);
      return;
    }
    targetJid = pick.jid;
    sinceText = cmd.args.slice(used).join(" ");
  }
  if (sinceText && !looksLikeSince(sinceText)) {
    const spec = parseSince(sinceText, { timeZone: env().BOT_TIMEZONE });
    blog.info({ sinceText }, "unrecognised since expression – asking user");
    await reply(`No entiendo el periodo "${spec.kind === "invalid" ? spec.raw : sinceText}". ${SINCE_HELP}`);
    return;
  }

  // "Since" – reply-to-message wins, then explicit arg, then read mark
  let spec: SinceSpec | string | undefined = sinceText || undefined;
  let quotedNote = "";
  if (m.quoted?.id) {
    const quoted = await findMessageByWaId(m.chatJid, m.quoted.id);
    if (quoted) {
      spec = { kind: "time", since: new Date(quoted.timestamp.getTime() - 1000), label: "desde el mensaje citado" };
      quotedNote = " (desde el mensaje citado)";
    } else {
      blog.warn({ quoted: m.quoted.id }, "quoted message not found in store; falling back to since arg");
    }
  }

  // Deliver privately? In a group we confirm briefly; in DM the reply already is private.
  const toPrivate = cmd.private && !isDm && requester;
  if (toPrivate) await reply("📩 Te envío el resumen por privado.").catch(() => {});

  const requesterName = m.senderName;
  const audio = cmd.audio && ttsEnabled();
  const style = audio ? (cmd.style === "detailed" ? "spoken_detailed" : "spoken") : cmd.style;
  const res = await runSummary({
    chatJid: targetJid,
    since: spec,
    until: m.timestamp,
    requesterJid: requester,
    requesterPhone: m.senderPhone,
    requesterName,
    style,
    trigger: "command",
    reqId,
  });

  const header = `📝 *Resumen${res.chatName && (isDm || toPrivate) ? ` de ${res.chatName}` : ""}* – ${res.label}${quotedNote}\n_${res.messageCount} mensajes · ${fmtRange(res.from, res.to)}_\n\n`;
  const text = header + res.text;

  if (audio) {
    const target = toPrivate && requester ? requester : m.chatJid;
    try {
      const a = await synthesize(res.text, { reqId });
      await whatsapp.sendVoice(target, a.buffer, { mimetype: a.mimetype, quotedId: target === m.chatJid ? m.id : undefined });
      return;
    } catch (e) {
      blog.warn({ err: errInfo(e), hint: isAppError(e) ? e.hint : undefined }, "voice note failed – sending text instead");
    }
  }
  if (toPrivate && requester) {
    await sendDm(requester, text, reqId);
    return;
  }
  await reply(text);

  blog.debug({ target: targetJid, sinceText }, "summary delivered");
  void raw;
}

/**
 * /sticker behaviours:
 *   reply to a photo            → that photo as a sticker
 *   reply to a sticker          → resend it
 *   /sticker <words>            → best library match by caption/tags
 *   reply to someone's message  → Gemini picks the funniest fitting sticker from the library
 *   reply to your own message   → random sticker
 *   /sticker alone              → random sticker
 */
async function handleSticker(cmd: Extract<Command, { name: "sticker" }>, m: NormalizedMessage, raw: WAMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const blog = log.child({ reqId, cmd: "sticker" });
  const sendLib = async (sha256: string, quotedId: string, note?: string) => {
    const s = await getSticker(sha256);
    const bytes = s ? await getStickerBytes(sha256) : undefined;
    if (!s || !bytes) return false;
    await whatsapp.sendSticker(m.chatJid, bytes.buffer, { quotedId });
    blog.info({ sha256: sha256.slice(0, 12), caption: s.caption, note }, "library sticker sent");
    return true;
  };
  const noLibrary = async () => reply("Todavía no tengo stickers guardados. Manda algunos al grupo y los iré aprendiendo 🙂");

  // 1) media targets: quoted photo/sticker, or a photo with the command as caption
  const mediaId = m.quoted?.id ?? (m.type === "image" ? m.id : undefined);
  if (mediaId) {
    const stored = await findMessageByWaId(m.chatJid, mediaId);
    const kind = stored?.type === "image" || stored?.type === "sticker" ? stored.type : m.type === "image" && mediaId === m.id ? "image" : undefined;
    if (kind) {
      const media = await whatsapp.getMediaBuffer(m.chatJid, mediaId);
      if (!media) {
        await reply("No puedo recuperar esa imagen (es anterior a mi llegada o no se archivó).");
        return;
      }
      const webp = kind === "sticker" ? media.buffer : await toStickerWebp(media.buffer);
      await whatsapp.sendSticker(m.chatJid, webp, { quotedId: m.id });
      return;
    }
  }

  // 2) explicit search
  if (cmd.query) {
    if (!(await countStickers())) return void (await noLibrary());
    const hits = await listStickers({ search: cmd.query, limit: 5 });
    if (!hits.length) {
      await reply(`No tengo ningún sticker que pegue con "${cmd.query}". Prueba con otra palabra o */sticker* a secas para uno al azar.`);
      return;
    }
    // small randomness among the top hits so the same word does not always give the same sticker
    const pick = hits[Math.floor(Math.random() * Math.min(hits.length, 3))];
    await sendLib(pick.sha256, m.id, `search:${cmd.query}`);
    return;
  }

  if (!(await countStickers())) return void (await noLibrary());

  // 3) replying to a text message
  if (m.quoted?.id) {
    const quoted = await findMessageByWaId(m.chatJid, m.quoted.id);
    const quotedText = quoted?.text ?? m.quoted.text ?? "";
    const isOwn = quoted ? quoted.senderJid === m.senderJid || (quoted.senderPhone && quoted.senderPhone === m.senderPhone) || (quoted.fromMe && m.fromMe) : (m.quoted.participant ?? "") === (m.senderJid ?? "");
    if (!isOwn && quotedText.trim()) {
      const candidates = await listStickers({ limit: 80 });
      const choice = await pickStickerReply({ text: quotedText, senderName: quoted?.senderName ?? undefined }, candidates, { reqId }).catch((e) => {
        blog.warn({ err: errInfo(e) }, "sticker picker failed – falling back to random");
        return undefined;
      });
      if (choice && (await sendLib(choice.sha256, m.quoted.id, `reply:${choice.why}`))) return;
    }
    const r = await randomSticker();
    if (r) await sendLib(r.sha256, m.quoted.id, isOwn ? "own-message→random" : "no-fit→random");
    return;
  }

  // 4) nothing quoted, no query → random
  const r = await randomSticker();
  if (r) await sendLib(r.sha256, m.id, "random");
}

/** Speak `text` as a voice note in the chat; falls back to text on TTS failure. */
async function replyVoice(m: NormalizedMessage, text: string, reqId: string, reply: (t: string) => Promise<unknown>) {
  try {
    const a = await synthesize(text, { reqId });
    await whatsapp.sendVoice(m.chatJid, a.buffer, { mimetype: a.mimetype, quotedId: m.id });
  } catch (e) {
    log.warn({ reqId, err: errInfo(e), hint: isAppError(e) ? e.hint : undefined }, "voice note failed – sending text instead");
    await reply(text);
  }
}

function isAdmin(phone?: string) {
  const e = env();
  const admins = e.ADMIN_PHONES.length ? e.ADMIN_PHONES : e.ALERT_PHONE ? [e.ALERT_PHONE.replace(/[^\d]/g, "")] : [];
  return Boolean(phone && admins.includes(phone));
}

/**
 * Hidden admin command (not in /ayuda): in a private chat, send the WhatsApp "Export chat" zip/txt as a
 * document with caption `/importar <group nº|name>` (or reply to the document with that command).
 * Only the .txt inside the zip is read; media is skipped without loading.
 */
async function handleImport(cmd: Extract<Command, { name: "import" }>, m: NormalizedMessage, raw: WAMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const blog = log.child({ reqId, cmd: "import" });
  if (m.chatKind !== "dm") {
    blog.warn({ chat: m.chatJid }, "import attempted in a group – ignored");
    return; // never acknowledge in groups
  }
  if (!isAdmin(m.senderPhone)) {
    blog.warn({ from: m.senderPhone }, "import attempted by non-admin – ignored");
    return;
  }
  // The file: this message (document with caption) or the quoted message
  let fileMsg: WAMessage | undefined = m.type === "document" ? raw : undefined;
  let fileMeta = m.type === "document" ? m.media : undefined;
  if (!fileMsg && m.quoted?.id) {
    const q = whatsapp.getRecent(m.quoted.id);
    const stored = await findMessageByWaId(m.chatJid, m.quoted.id);
    if (q?.message?.documentMessage || q?.message?.documentWithCaptionMessage) {
      fileMsg = q;
      fileMeta = (stored?.media as NormalizedMessage["media"]) ?? undefined;
    }
  }
  if (!fileMsg) {
    await reply("📎 Envíame el archivo exportado del chat (zip o txt) *como documento* con el texto */importar <nº o nombre del grupo>*, o responde a ese archivo con el comando.\nConsejo: exporta *sin archivos* para que pese poco.");
    return;
  }
  if (!cmd.args.length || !m.senderJid) {
    await reply("¿A qué grupo? */importar <nº o nombre>* (mira */grupos*).");
    return;
  }
  const groups = await groupsForUser(m.senderJid, m.senderPhone);
  const needle = cmd.args.join(" ").toLowerCase();
  const pick = (/^\d+$/.test(needle) && groups[Number(needle) - 1]) || groups.find((g) => (g.name ?? "").toLowerCase() === needle) || groups.find((g) => (g.name ?? "").toLowerCase().includes(needle));
  if (!pick) {
    await reply(`No encuentro el grupo "${cmd.args.join(" ")}". Usa */grupos*.`);
    return;
  }
  const sizeMb = (fileMeta?.fileLength ?? 0) / 1e6;
  if (sizeMb > env().IMPORT_MAX_MB) {
    await reply(`El archivo pesa ${sizeMb.toFixed(0)} MB (máximo ${env().IMPORT_MAX_MB} MB por WhatsApp). Exporta el chat *sin archivos* o súbelo por la API (POST /api/groups/<jid>/import).`);
    return;
  }
  await reply(`📥 Importando en *${pick.name ?? pick.jid}*… ${sizeMb ? `(${sizeMb.toFixed(1)} MB)` : ""}`);
  const dir = await mkdtemp(join(tmpdir(), "wa-import-"));
  const fileName = fileMeta?.fileName ?? "export.zip";
  const path = join(dir, fileName.replace(/[^\w.\-]/g, "_"));
  try {
    const stream = await downloadMediaMessage(fileMsg, "stream", {}, { logger: rootLogger.child({ mod: "baileys" }), reuploadRequest: (msg) => whatsapp.updateMedia(msg) });
    await pipeline(stream, createWriteStream(path));
    const { text, entry } = await readExportFile(path, fileName);
    const r = await importExportText(pick.jid, text, { force: cmd.force, reqId });
    const f = (iso?: string) => (iso ? fmtZoned(new Date(iso), env().BOT_TIMEZONE) : "?");
    await reply(
      `✅ Importado *${entry}* en *${pick.name ?? pick.jid}*\n- ${r.inserted} mensajes nuevos (${f(r.from)} → ${f(r.to)})\n- ${r.duplicates} ya existían · ${r.skippedAfterLive} omitidos por ser posteriores a mi llegada${cmd.force ? "" : " (usa *forzar* para incluirlos)"}\n- formato de fecha: ${r.dateFormat} · remitentes reconocidos: ${r.sendersMapped}/${r.parsed}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Wire the handler into the WhatsApp client (idempotent). */
export function registerBot() {
  whatsapp.setInboundHandler(handleInbound);
  log.info({ name: env().BOT_NAME, prefix: env().BOT_COMMAND_PREFIX, lang: env().BOT_LANGUAGE, dmTransport: env().DM_TRANSPORT, model: env().GEMINI_MODEL }, "bot handler registered");
}
