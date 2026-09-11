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
import { countStickers, countUserSummariesSince, findMessageByWaId, getChat, getGroupSettings, getSticker, getStickerBytes, groupsForUser, listParticipants, listStickers, markMessageAsCommand, randomSticker, setGroupSettings, setReadMark, upsertChat } from "../store";
import type { Chat, Digest } from "../db/schema";
import { deleteDigest, describeDigest, getDigest, hoursEvery, normalizeHours, runDigest, upsertDigest } from "./digest";
import { cancelJob, countPendingByUser, createJob, describeJob, getJob, listJobs } from "./jobs";
import { parseWhen, WHEN_HELP } from "./when";
import { sendDm } from "./deliver";
import { pickStickerReply } from "../ai/vision";
import { zonedParts, zonedToUtc } from "./since";
import { helpText, parseCommand, type Command } from "./commands";
import { runActionItems, runQuestion, runSummary } from "./service";
import { fmtZoned, looksLikeSince, parseSince, SINCE_HELP, type SinceSpec } from "./since";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootLogger } from "../logger";
import { importExportText, readExportFile } from "../import";
import { synthesize, ttsEnabled } from "../ai/tts";
import { runAssistant } from "./assistant";
import { countAssistantCallsSince } from "../store";
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

export async function handleInbound(m: NormalizedMessage, raw: WAMessage): Promise<void> {
  const reqId = m.id.slice(-8);
  const me = whatsapp.meJid;
  const meLid = whatsapp.meLid;
  const botPhone = phoneFromJid(me);
  const norm = (j: string) => j.split(":")[0].split("@")[0];
  const botMentioned =
    m.mentions.some((j) => (botPhone && phoneFromJid(j) === botPhone) || (me && norm(j) === norm(me)) || (meLid && norm(j) === norm(meLid))) ||
    (botPhone ? (m.text ?? "").includes(`@${botPhone}`) : false);
  const isDm = m.chatKind === "dm";
  const e = env();

  // Assistant mode: explicit @mention in a GROUP with free text (slash commands still work as before).
  // Quoting/replying to the bot does not count as a mention.
  if (botMentioned && !isDm && e.ASSISTANT_ENABLED && !(m.text ?? "").trim().startsWith(e.BOT_COMMAND_PREFIX)) {
    const alog = log.child({ reqId, chat: m.chatJid, from: m.senderPhone ?? m.senderJid, mode: "assistant" });
    alog.info({ text: m.text?.slice(0, 160) }, "assistant mention");
    await markMessageAsCommand(m.chatJid, m.id).catch(() => {});
    const reply = (text: string) => whatsapp.sendText(m.chatJid, text, { quotedId: m.id });
    if (m.senderJid && e.ASSISTANT_DAILY_LIMIT > 0 && !isAdmin(m.senderPhone)) {
      const p = zonedParts(new Date(), e.BOT_TIMEZONE);
      const used = await countAssistantCallsSince(m.senderJid, zonedToUtc(p.y, p.m, p.d, 0, 0, e.BOT_TIMEZONE), e.BOT_COMMAND_PREFIX);
      if (used > e.ASSISTANT_DAILY_LIMIT) {
        await reply(`⛔ Has llegado al límite de ${e.ASSISTANT_DAILY_LIMIT} peticiones al asistente por hoy.`);
        return;
      }
    }
    try {
      await whatsapp.withPresence(m.chatJid, "composing", () => runAssistant(m, raw, { botPhone, reqId, reply, isAdmin: isAdmin(m.senderPhone) }));
    } catch (err) {
      alog.error({ err: errInfo(err), hint: isAppError(err) ? err.hint : "Assistant failed; see stack." }, "assistant failed");
      await reply(`⚠️ No he podido con eso (${isAppError(err) ? err.code : "error"}). Inténtalo de nuevo.`).catch(() => {});
    }
    return;
  }

  const cmd = parseCommand(m.text, { isDm, botMentioned, botPhone });
  if (!cmd) return;

  const blog = log.child({ reqId, chat: m.chatJid, from: m.senderPhone ?? m.senderJid, cmd: cmd.name });
  blog.info({ text: m.text?.slice(0, 120) }, "command received");
  await markMessageAsCommand(m.chatJid, m.id).catch(() => {});

  const reply = (text: string) => whatsapp.sendText(m.chatJid, text, { quotedId: m.id });

  // "escribiendo…" while we work; "grabando audio…" when the answer will be a voice note
  const wantsAudio = ((cmd.name === "summary" || cmd.name === "ask") && cmd.audio && ttsEnabled()) || cmd.name === "say";
  const presenceKind = wantsAudio ? "recording" : "composing";
  const quick = ["help", "ping", "id", "unknown", "schedule", "remind", "jobs", "cancel", "welcome", "config"].includes(cmd.name) || (cmd.name === "digest" && cmd.action !== "now");

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
        await reply(`Grupos que compartimos:\n${lines.join("\n")}\n\n${groups.length === 1 ? "Como solo compartimos uno, basta con */resumen [periodo]* aquí." : "Usa */resumen <nº> [periodo]* para resumir uno aquí."}`);
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
      case "digest":
        await handleDigest(cmd, m, reqId, reply);
        return;
      case "schedule":
      case "remind":
        await handleJob(cmd, m, reqId, reply);
        return;
      case "jobs":
        await handleJobsList(m, reply);
        return;
      case "cancel":
        await handleCancel(cmd, m, reqId, reply);
        return;
      case "actions":
        await handleActions(cmd, m, reqId, reply);
        return;
      case "welcome":
        await handleWelcomeConfig(cmd, m, reqId, reply);
        return;
      case "config":
        await handleConfig(m, reply);
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

/** 15 s cooldown per user+chat and the DAILY_SUMMARY_LIMIT (shared by /resumen and /pendientes; admins exempt). */
async function aiQuotaOk(m: NormalizedMessage, reply: (t: string) => Promise<unknown>, blog: { info: (o: object, msg: string) => void }) {
  const requester = m.senderJid;
  const key = `${m.chatJid}:${requester}`;
  const last = lastRun.get(key) ?? 0;
  if (Date.now() - last < COOLDOWN_MS) {
    await reply("⏳ Espera unos segundos antes de pedir otro resumen.");
    return false;
  }
  lastRun.set(key, Date.now());
  const limit = env().DAILY_SUMMARY_LIMIT;
  if (requester && limit > 0 && !isAdmin(m.senderPhone)) {
    const tz = env().BOT_TIMEZONE;
    const p = zonedParts(new Date(), tz);
    const dayStart = zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
    const used = await countUserSummariesSince(requester, dayStart);
    if (used >= limit) {
      blog.info({ requester, used, limit }, "daily summary quota reached");
      await reply(`⛔ Ya has usado tus ${limit} resúmenes de hoy. Mañana podrás pedir más 🙂`);
      return false;
    }
  }
  return true;
}

async function handleSummary(cmd: Extract<Command, { name: "summary" }>, m: NormalizedMessage, raw: WAMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const isDm = m.chatKind === "dm";
  const requester = m.senderJid;
  const blog = log.child({ reqId });

  if (!(await aiQuotaOk(m, reply, blog))) return;

  // Which chat? In a group: this one, args = since expression.
  // In a DM: args = "<group number|name> [since expression]".
  let targetJid = m.chatJid;
  let sinceText = cmd.args.join(" ");
  if (isDm) {
    if (!requester) return;
    const r = await resolveGroupArg(m, cmd.args, reply, { usage: `*${env().BOT_COMMAND_PREFIX}resumen <nº o nombre> [desde]*` });
    if (!r) return;
    targetJid = r.group.jid;
    sinceText = r.rest.join(" ");
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

/**
 * In a DM, which shared group does the user mean? `args` may start with the group number (from /grupos) or a
 * (prefix of the) group name. When the user shares exactly ONE group with the bot it is taken by default, so
 * nobody has to name it every time. Replies with guidance and returns undefined when it cannot decide.
 */
async function resolveGroupArg(m: NormalizedMessage, args: string[], reply: (t: string) => Promise<unknown>, opts: { usage: string }): Promise<{ group: Chat; rest: string[] } | undefined> {
  if (!m.senderJid) return undefined;
  const groups = await groupsForUser(m.senderJid, m.senderPhone);
  if (!groups.length) {
    await reply("No compartimos ningún grupo todavía (o aún no he sincronizado). Añádeme a un grupo y escribe algo en él.");
    return undefined;
  }
  let pick: Chat | undefined;
  let used = 0;
  if (args.length && /^\d+$/.test(args[0]) && Number(args[0]) >= 1 && Number(args[0]) <= groups.length) {
    pick = groups[Number(args[0]) - 1];
    used = 1;
  } else {
    // longest token prefix that matches a group name (exact, then contains)
    for (let n = args.length; n > 0 && !pick; n--) {
      const needle = args.slice(0, n).join(" ").toLowerCase();
      pick = groups.find((g) => (g.name ?? "").toLowerCase() === needle) ?? groups.find((g) => (g.name ?? "").toLowerCase().includes(needle));
      if (pick) used = n;
    }
  }
  if (!pick && groups.length === 1) {
    pick = groups[0]; // the only shared group → implicit
    used = 0;
  }
  if (!pick) {
    await reply(args.length ? `No encuentro el grupo "${args[0]}". Usa */grupos* para ver la lista.` : `Por privado dime qué grupo: */grupos* para verlos y luego ${opts.usage}.`);
    return undefined;
  }
  return { group: pick, rest: args.slice(used) };
}

/** WhatsApp group admin (participants snapshot) – by jid or phone, LID-safe. */
async function isGroupAdmin(chatJid: string, userJid?: string, phone?: string) {
  if (!userJid && !phone) return false;
  const ps = await listParticipants(chatJid);
  return ps.some((p) => p.isAdmin && ((userJid && p.userJid === userJid) || (phone && p.phone === phone)));
}

/**
 * /boletin – scheduled digest ("breaking news") of a group at fixed hours, as a voice note or text.
 * Anyone can look at it; only group admins (or ADMIN_PHONES) change it. Works in the group or by DM
 * (`/boletin <grupo> …`; the group is implicit when only one is shared).
 */
async function handleDigest(cmd: Extract<Command, { name: "digest" }>, m: NormalizedMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const blog = log.child({ reqId, cmd: "digest", action: cmd.action });
  const isDm = m.chatKind === "dm";
  const p = env().BOT_COMMAND_PREFIX;
  let group: Chat | undefined;
  let extra: string[] = cmd.args;
  if (cmd.private) {
    // Private brief: the digest row belongs to the user's DM chat and covers every shared group
    if (!isDm) {
      await reply(`El boletín privado se configura por privado: escríbeme *${p}boletin 8:00 privado* en nuestro chat.`);
      return;
    }
    group = await getChat(m.chatJid);
    if (!group) {
      await upsertChat({ jid: m.chatJid, kind: "dm", name: m.senderName ?? null, lastMessageAt: m.timestamp });
      group = await getChat(m.chatJid);
    }
    if (!group) return;
  } else if (isDm) {
    const r = await resolveGroupArg(m, cmd.args, reply, { usage: `*${p}boletin <nº o nombre> 06:00 14:00 22:00 audio*` });
    if (!r) return;
    group = r.group;
    extra = r.rest;
  } else {
    group = await getChat(m.chatJid);
    if (!group) {
      await reply("Todavía no conozco este grupo; escribe algo y vuelve a intentarlo.");
      return;
    }
  }
  if (extra.length) {
    await reply(`No entiendo "${extra.join(" ")}". Ejemplos: *${p}boletin 06:00 14:00 22:00 audio* · *${p}boletin cada 8h desde 06:00* · *${p}boletin texto* · *${p}boletin off* · *${p}boletin ahora*.`);
    return;
  }
  const existing = await getDigest(group.jid);
  const priv = cmd.private;
  if (cmd.action === "show") {
    await reply(existing ? describeDigest(existing, group.name, priv) : priv ? `No tienes boletín privado. Créalo con *${p}boletin 8:00 privado* (texto) o *${p}boletin 8:00 privado audio*.` : `Este grupo no tiene boletín programado. Un admin puede crearlo con *${p}boletin 06:00 14:00 22:00 audio* (nota de voz con las novedades a esas horas) o *${p}boletin cada 8h desde 06:00*.`);
    return;
  }
  const allowed = priv || isAdmin(m.senderPhone) || (await isGroupAdmin(group.jid, m.senderJid, m.senderPhone));
  if (!allowed) {
    blog.warn({ from: m.senderPhone ?? m.senderJid, chat: group.jid }, "digest change attempted by non-admin – refused");
    await reply("Solo los administradores del grupo pueden configurar el boletín 🙂");
    return;
  }
  switch (cmd.action) {
    case "set": {
      let hours: string[] | undefined = cmd.hours.length ? normalizeHours(cmd.hours) : undefined;
      if (cmd.every) hours = hoursEvery(cmd.every, hours?.[0] ?? "06:00");
      if (!hours && !existing) {
        await reply(`¿A qué horas? Ej: *${p}boletin 06:00 14:00 22:00 audio* o *${p}boletin cada 8h desde 06:00*.`);
        return;
      }
      const d = await upsertDigest({ chatJid: group.jid, hours, audio: priv ? (cmd.audio ?? existing?.audio ?? false) : cmd.audio, style: cmd.style, enabled: true, createdBy: m.senderJid, createdByName: m.senderName ?? m.senderPhone });
      const ttsNote = d.audio && !ttsEnabled() ? "\n⚠️ La voz no está configurada (ELEVENLABS_API_KEY): irá en texto." : "";
      await reply(`${existing ? "Boletín actualizado" : "Boletín programado"} ✅\n${describeDigest(d, group.name, priv)}${ttsNote}\n\n_${priv ? "Solo incluyo los grupos con" : "Solo publico si hay"} al menos ${d.minMessages} mensajes nuevos. *${p}boletin ${priv ? "privado " : ""}ahora* para probarlo, *${p}boletin ${priv ? "privado " : ""}off* para pausarlo._`);
      return;
    }
    case "off":
    case "on": {
      if (!existing) {
        await reply(`Este grupo no tiene boletín. Créalo con *${p}boletin 06:00 14:00 22:00 audio*.`);
        return;
      }
      const d = await upsertDigest({ chatJid: group.jid, enabled: cmd.action === "on" });
      await reply(cmd.action === "on" ? `Boletín reactivado ✅ Próximo: ${fmtZoned(d.nextRunAt, env().BOT_TIMEZONE)}.` : "Boletín pausado ⏸️ Vuelve con *" + p + "boletin on*.");
      return;
    }
    case "remove": {
      const removed = await deleteDigest(group.jid);
      await reply(removed ? "Boletín eliminado 🗑️" : "Este grupo no tenía boletín.");
      return;
    }
    case "now": {
      // Preview: post one digest right now (does not touch the schedule). Without a config, the last 8 h.
      const now = new Date();
      const d: Digest = existing ?? { id: 0, chatJid: group.jid, hours: ["06:00", "14:00", "22:00"], audio: cmd.audio ?? true, style: cmd.style ?? "bullets", enabled: false, minMessages: 1, createdBy: null, createdByName: null, lastRunAt: new Date(now.getTime() - 8 * 3_600_000), lastSentAt: null, lastError: null, nextRunAt: now, createdAt: now, updatedAt: now };
      if (isDm) await reply(priv ? "🌅 Preparando tu boletín…" : `📰 Preparando el boletín de *${group.name ?? group.jid}*…`);
      const r = await runDigest(existing ? { ...d, audio: cmd.audio ?? d.audio, style: cmd.style ?? d.style } : priv ? { ...d, audio: cmd.audio ?? false } : d, { force: true, reqId: `dig-now-${reqId}` });
      if (r.posted) {
        if (isDm && !priv) await reply(`✅ Boletín enviado a *${group.name ?? group.jid}* (${r.messages} mensajes, ${r.audio ? "nota de voz" : "texto"}).`);
        return;
      }
      await reply(r.reason === "not_connected" ? "⚠️ No estoy conectado a WhatsApp ahora mismo." : `Nada que contar: ${r.messages ? `solo ${r.messages} mensajes` : "no hay mensajes nuevos"} desde las ${fmtZoned(r.from, env().BOT_TIMEZONE, false)}.`);
      return;
    }
  }
}

const jidUser = (j?: string) => (j ?? "").split(":")[0].split("@")[0];

/** /programar (admins, posts as the bot) and /recordar (anyone; mentions the author, or DM to self). */
async function handleJob(cmd: Extract<Command, { name: "schedule" | "remind" }>, m: NormalizedMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const blog = log.child({ reqId, cmd: cmd.name });
  const isDm = m.chatKind === "dm";
  const p = env().BOT_COMMAND_PREFIX;
  const kind = cmd.name === "schedule" ? "message" : "reminder";
  if (!m.senderJid) return;
  let tokens = cmd.text.split(/\s+/).filter(Boolean);
  const leadMentions: string[] = [];
  while (tokens[0]?.startsWith("@")) leadMentions.push(tokens.shift()!);
  let targetJid = m.chatJid;
  let targetName: string | undefined;
  if (isDm && kind === "message") {
    const r = await resolveGroupArg(m, tokens, reply, { usage: `*${p}programar <grupo> mañana 9:00 <texto>*` });
    if (!r) return;
    targetJid = r.group.jid;
    targetName = r.group.name ?? undefined;
    tokens = r.rest;
  }
  if (!tokens.length) {
    await reply(kind === "reminder" ? `¿Cuándo y qué? Ej: *${p}recordar mañana 9:00 llevar el pastel*. ${WHEN_HELP}` : `¿Cuándo y qué? Ej: *${p}programar el lunes 9:00 Recordad traer el DNI*. ${WHEN_HELP}`);
    return;
  }
  const when = parseWhen(tokens.join(" "), { timeZone: env().BOT_TIMEZONE });
  if ("error" in when) {
    blog.info({ text: tokens.join(" ").slice(0, 80), error: when.error }, "when expression not understood");
    await reply(when.error === "that date is in the past" || when.error === "that time has already passed today" ? "Esa hora ya ha pasado 🙂 Dime una futura." : `No entiendo cuándo. ${WHEN_HELP}`);
    return;
  }
  let text = [...leadMentions, when.rest].join(" ").trim();
  if (!text && m.quoted?.text) text = m.quoted.text.trim();
  if (!text) {
    await reply(kind === "reminder" ? "¿Qué te recuerdo? Escribe el texto después de la hora, o responde a un mensaje con el comando." : "¿Qué mensaje publico? Escríbelo después de la hora.");
    return;
  }
  const admin = isAdmin(m.senderPhone) || (await isGroupAdmin(targetJid, m.senderJid, m.senderPhone));
  if (kind === "message" && !admin) {
    blog.warn({ from: m.senderPhone ?? m.senderJid, chat: targetJid }, "scheduled message attempted by non-admin – refused");
    await reply(`Solo los administradores pueden programar mensajes del bot. Para ti mismo usa *${p}recordar …* 🙂`);
    return;
  }
  if (!isAdmin(m.senderPhone)) {
    const pending = await countPendingByUser(m.senderJid);
    if (pending >= env().JOBS_MAX_PENDING_PER_USER) {
      await reply(`Ya tienes ${pending} recordatorios pendientes (máximo ${env().JOBS_MAX_PENDING_PER_USER}). Cancela alguno con *${p}programados* y *${p}cancelar <nº>*.`);
      return;
    }
  }
  const me = whatsapp.meJid;
  const meLid = whatsapp.meLid;
  const mentions = m.mentions.filter((j) => jidUser(j) !== jidUser(me) && jidUser(j) !== jidUser(meLid));
  const job = await createJob({ kind, chatJid: targetJid, originJid: m.chatJid, text, mentions, dueAt: when.at, recurrence: when.recurrence, createdBy: m.senderJid, createdByName: m.senderName ?? m.senderPhone });
  blog.info({ id: job.id, kind, chat: targetJid, due: job.dueAt.toISOString(), recurrence: job.recurrence?.kind }, "job scheduled by command");
  const where = targetName ? ` en *${targetName}*` : "";
  await reply(`${kind === "reminder" ? "⏰ Te lo recuerdo" : "🗓️ Programado"} ${when.label}${where}.\n_#${job.id} · *${p}programados* para verlos · *${p}cancelar ${job.id}* para anularlo_`);
}

/** /programados – pending jobs of this group, or (by DM) everything the user scheduled. */
async function handleJobsList(m: NormalizedMessage, reply: (t: string) => Promise<unknown>) {
  const isDm = m.chatKind === "dm";
  const p = env().BOT_COMMAND_PREFIX;
  const rows = isDm && m.senderJid ? await listJobs({ createdBy: m.senderJid, status: ["pending"], limit: 30 }) : await listJobs({ chatJid: m.chatJid, status: ["pending"], limit: 30 });
  if (!rows.length) {
    await reply(`No hay nada programado${isDm ? "" : " en este grupo"}. *${p}recordar mañana 9:00 <texto>* para crear un recordatorio.`);
    return;
  }
  const names = new Map<string, string | null>();
  for (const j of rows) if (isDm && j.chatJid !== m.chatJid && !names.has(j.chatJid)) names.set(j.chatJid, (await getChat(j.chatJid))?.name ?? j.chatJid);
  const lines = rows.map((j) => describeJob(j, { chatName: names.get(j.chatJid) }) + (!isDm && j.createdByName ? ` _(${j.createdByName})_` : ""));
  await reply(`🗓️ *Programado* (${env().BOT_TIMEZONE}):\n${lines.join("\n")}\n\n_*${p}cancelar <nº>* para anular uno._`);
}

/** /cancelar <id> – creator, ADMIN_PHONES or a group admin of the target chat. */
async function handleCancel(cmd: Extract<Command, { name: "cancel" }>, m: NormalizedMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const p = env().BOT_COMMAND_PREFIX;
  if (!cmd.id) {
    await reply(`¿Cuál? *${p}cancelar <nº>* (mira *${p}programados*).`);
    return;
  }
  const job = await getJob(cmd.id);
  const visible = job && (job.chatJid === m.chatJid || job.originJid === m.chatJid || job.createdBy === m.senderJid);
  if (!job || !visible) {
    await reply(`No encuentro el nº ${cmd.id}. Mira *${p}programados*.`);
    return;
  }
  const mine = job.createdBy === m.senderJid || (m.senderPhone && phoneFromJid(job.createdBy ?? undefined) === m.senderPhone);
  const allowed = mine || isAdmin(m.senderPhone) || (await isGroupAdmin(job.chatJid, m.senderJid, m.senderPhone));
  if (!allowed) {
    log.warn({ reqId, id: job.id, from: m.senderPhone ?? m.senderJid }, "cancel attempted by someone else – refused");
    await reply("Solo quien lo creó (o un admin) puede cancelarlo.");
    return;
  }
  const c = await cancelJob(job.id);
  await reply(c ? `❌ Cancelado el nº ${job.id} (${job.text.slice(0, 60)}).` : `El nº ${job.id} ya no estaba pendiente (${job.status}).`);
}

/** /pendientes [míos] [periodo] – open tasks, promises, questions and debts; by DM: /pendientes [grupo] … */
async function handleActions(cmd: Extract<Command, { name: "actions" }>, m: NormalizedMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const blog = log.child({ reqId, cmd: "actions" });
  const isDm = m.chatKind === "dm";
  const p = env().BOT_COMMAND_PREFIX;
  let chatJid = m.chatJid;
  let args = cmd.args;
  if (isDm) {
    const r = await resolveGroupArg(m, cmd.args, reply, { usage: `*${p}pendientes <nº o nombre> [periodo]*` });
    if (!r) return;
    chatJid = r.group.jid;
    args = r.rest;
  }
  const since = args.join(" ");
  if (since && !looksLikeSince(since)) {
    await reply(`No entiendo el periodo "${since}". ${SINCE_HELP}`);
    return;
  }
  if (!(await aiQuotaOk(m, reply, blog))) return;
  const res = await runActionItems({ chatJid, since: since || undefined, requesterJid: m.senderJid, requesterPhone: m.senderPhone, forName: cmd.mine ? (m.senderName ?? m.senderPhone) : undefined, forPhone: cmd.mine ? m.senderPhone : undefined, reqId });
  const title = `📋 *Pendientes${cmd.mine ? " tuyos" : ""}${isDm && res.chatName ? ` de ${res.chatName}` : ""}* – ${res.label}`;
  await reply(`${title}\n\n${res.text}${res.empty ? "" : `\n\n_*${p}recordar mañana 9:00 <tarea>* para que lo avise a tiempo._`}`);
}

/** /bienvenida [grupo] [on|off|N días] – DM newcomers a brief of the last N days. */
async function handleWelcomeConfig(cmd: Extract<Command, { name: "welcome" }>, m: NormalizedMessage, reqId: string, reply: (t: string) => Promise<unknown>) {
  const isDm = m.chatKind === "dm";
  const p = env().BOT_COMMAND_PREFIX;
  let group: Chat | undefined;
  if (isDm) {
    const r = await resolveGroupArg(m, cmd.args, reply, { usage: `*${p}bienvenida <nº o nombre> on*` });
    if (!r) return;
    group = r.group;
  } else group = await getChat(m.chatJid);
  if (!group) return;
  const settings = await getGroupSettings(group.jid);
  const days = settings.welcomeDays ?? env().WELCOME_BRIEF_DAYS;
  if (cmd.action === "show") {
    await reply(settings.welcomeBrief ? `👋 Bienvenida activa en *${group.name ?? group.jid}*: a quien entre le mando por privado un resumen de los últimos ${days} días y los pendientes. *${p}bienvenida off* para desactivarla, *${p}bienvenida 7* para cambiar los días.` : `👋 Bienvenida desactivada en *${group.name ?? group.jid}*. Un admin puede activarla con *${p}bienvenida on* (resumen de los últimos ${days} días por privado a quien entre) o *${p}bienvenida 7* (días).`);
    return;
  }
  if (!(isAdmin(m.senderPhone) || (await isGroupAdmin(group.jid, m.senderJid, m.senderPhone)))) {
    log.warn({ reqId, from: m.senderPhone ?? m.senderJid, chat: group.jid }, "welcome change attempted by non-admin – refused");
    await reply("Solo los administradores del grupo pueden cambiar esto 🙂");
    return;
  }
  const saved = await setGroupSettings(group.jid, cmd.action === "on" ? { welcomeBrief: true, welcomeDays: cmd.days ?? settings.welcomeDays } : { welcomeBrief: false });
  await reply(cmd.action === "on" ? `👋 Bienvenida activada en *${group.name ?? group.jid}*: resumen de los últimos ${saved.welcomeDays ?? env().WELCOME_BRIEF_DAYS} días + pendientes, por privado, a quien entre. Nunca escribo en el grupo por esto.` : `👋 Bienvenida desactivada en *${group.name ?? group.jid}*.`);
}

/** /config – everything the bot has configured for this group. */
async function handleConfig(m: NormalizedMessage, reply: (t: string) => Promise<unknown>) {
  const isDm = m.chatKind === "dm";
  const p = env().BOT_COMMAND_PREFIX;
  let group: Chat | undefined;
  if (isDm) {
    const r = await resolveGroupArg(m, [], reply, { usage: `*${p}config*` });
    if (!r) return;
    group = r.group;
  } else group = await getChat(m.chatJid);
  if (!group) return;
  const [digest, settings, jobs, priv] = await Promise.all([getDigest(group.jid), getGroupSettings(group.jid), listJobs({ chatJid: group.jid, status: ["pending"], limit: 100 }), isDm ? getDigest(m.chatJid) : Promise.resolve(undefined)]);
  const e = env();
  const lines = [
    `⚙️ *${group.name ?? group.jid}*`,
    digest ? describeDigest(digest, null) : `📰 Boletín: no programado (*${p}boletin 06:00 14:00 22:00 audio*)`,
    settings.welcomeBrief ? `👋 Bienvenida: activa, ${settings.welcomeDays ?? e.WELCOME_BRIEF_DAYS} días` : `👋 Bienvenida: desactivada (*${p}bienvenida on*)`,
    `🗓️ Programado: ${jobs.length} pendiente${jobs.length === 1 ? "" : "s"} (*${p}programados*)`,
    `📏 Cuotas: ${e.DAILY_SUMMARY_LIMIT} resúmenes/pendientes, ${e.ASSISTANT_DAILY_LIMIT} peticiones al asistente y ${e.ASSISTANT_AUDIO_DAILY_LIMIT} audios por persona y día · zona horaria ${e.BOT_TIMEZONE}`,
  ];
  if (isDm) lines.push(priv ? describeDigest(priv, null, true) : `🌅 Boletín privado: no configurado (*${p}boletin 8:00 privado*)`);
  await reply(lines.join("\n"));
}

/**
 * Welcome brief: when someone is added to a group with `welcomeBrief` on, DM them (never the group) a
 * summary of the last N days plus the open items. At most 5 people per event; failures are logged only.
 */
async function handleParticipants(groupJid: string, participants: string[], action: "add" | "remove" | "promote" | "demote") {
  if (action !== "add") return;
  const settings = await getGroupSettings(groupJid);
  if (!settings.welcomeBrief) return;
  const reqId = `wel-${Date.now().toString(36)}`;
  const wlog = log.child({ reqId, chat: groupJid, mode: "welcome" });
  const e = env();
  const me = whatsapp.meJid;
  const targets = participants.filter((j) => jidUser(j) !== jidUser(me) && jidUser(j) !== jidUser(whatsapp.meLid)).slice(0, 5);
  if (!targets.length) return;
  const chat = await getChat(groupJid);
  const days = settings.welcomeDays ?? e.WELCOME_BRIEF_DAYS;
  const name = chat?.name ?? "el grupo";
  const p = e.BOT_COMMAND_PREFIX;
  let summary: string | undefined;
  let pending: string | undefined;
  try {
    summary = (await runSummary({ chatJid: groupJid, since: `${days}d`, style: "bullets", trigger: "welcome", reqId })).text;
  } catch (err) {
    if (!(isAppError(err) && err.code === "no_messages")) wlog.warn({ err: errInfo(err), hint: isAppError(err) ? err.hint : "Summary failed; sending a plain welcome." }, "welcome summary failed");
  }
  if (summary) {
    try {
      const r = await runActionItems({ chatJid: groupJid, since: `${days}d`, reqId });
      if (!r.empty) pending = r.text;
    } catch (err) {
      wlog.warn({ err: errInfo(err) }, "welcome action items failed – skipped");
    }
  }
  const text = [
    `👋 ¡Hola! Soy *${e.BOT_NAME}*, el bot de *${name}*. Te pongo al día por privado para no llenar el grupo.`,
    summary ? `\n📝 *Lo último (${days} días)*\n${summary}` : `\nEn los últimos ${days} días no ha habido mucho movimiento.`,
    pending ? `\n📋 *Pendientes*\n${pending}` : "",
    `\n_En el grupo puedes escribir *${p}resumen*, *${p}preguntar <algo>* o mencionarme. *${p}ayuda* para verlo todo._`,
  ].join("\n");
  for (const [i, jid] of targets.entries()) {
    try {
      await sendDm(jid, text, reqId);
      wlog.info({ to: jid, days, summary: Boolean(summary), pending: Boolean(pending) }, "👋 welcome brief sent");
    } catch (err) {
      wlog.warn({ err: errInfo(err), to: jid, hint: isAppError(err) ? err.hint : "Could not DM the newcomer (privacy settings or unknown number)." }, "welcome brief not delivered");
    }
    if (i < targets.length - 1) await new Promise((r) => setTimeout(r, 3_000 + Math.random() * 3_000));
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
  const r = await resolveGroupArg(m, cmd.args, reply, { usage: "*/importar <nº o nombre>*" });
  if (!r) return;
  const pick = r.group;
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
  whatsapp.setParticipantsHandler(handleParticipants);
  log.info({ name: env().BOT_NAME, prefix: env().BOT_COMMAND_PREFIX, lang: env().BOT_LANGUAGE, dmTransport: env().DM_TRANSPORT, model: env().GEMINI_MODEL }, "bot handler registered");
}
