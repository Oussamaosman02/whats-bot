/**
 * Telegram-style command parsing for WhatsApp messages.
 *
 *   /resumen [desde] [privado] [breve|detallado]      summarise this group
 *   /resumen <grupo> [desde]                         (in DM) summarise a shared group
 *   /preguntar <pregunta>                            answer a question from the chat history
 *   /marcar                                          "start counting from here" (sets your read mark)
 *   /transcribir [breve]                             (reply to a voice note) full transcript, or a TL;DR
 *   /grupos                                          (in DM) list groups you share with the bot
 *   /ayuda | /ping | /id
 */
import { env } from "../env";

export type Command =
  | { name: "summary"; args: string[]; private: boolean; style?: "brief" | "detailed"; audio: boolean }
  | { name: "ask"; question: string; audio: boolean }
  | { name: "say"; text: string }
  | { name: "sticker"; query: string }
  | { name: "mark" }
  | { name: "transcribe"; brief: boolean }
  | { name: "import"; args: string[]; force: boolean }
  | { name: "groups" }
  | { name: "help" }
  | { name: "ping" }
  | { name: "id" }
  | { name: "unknown"; raw: string };

const ALIASES: Record<string, Command["name"]> = {
  resumen: "summary",
  resume: "summary",
  resumir: "summary",
  summary: "summary",
  summarize: "summary",
  sum: "summary",
  preguntar: "ask",
  pregunta: "ask",
  ask: "ask",
  q: "ask",
  marcar: "mark",
  marca: "mark",
  desde: "mark",
  mark: "mark",
  grupos: "groups",
  transcribir: "transcribe",
  importar: "import",
  voz: "say",
  sticker: "sticker",
  stiker: "sticker",
  say: "say",
  di: "say",
  import: "import",
  transcribe: "transcribe",
  texto: "transcribe",
  groups: "groups",
  ayuda: "help",
  help: "help",
  start: "help",
  comandos: "help",
  ping: "ping",
  id: "id",
};

const PRIVATE_WORDS = new Set(["privado", "private", "dm", "pv", "md"]);
const AUDIO_WORDS = new Set(["audio", "voz", "voice", "nota"]);
const BRIEF_WORDS = new Set(["resumen", "resume", "resumir", "resumido", "tldr", "tl;dr", "summary", "summarize", "sum"]);
const STYLE_WORDS: Record<string, "brief" | "detailed"> = { breve: "brief", corto: "brief", brief: "brief", short: "brief", detallado: "detailed", detalle: "detailed", detailed: "detailed", largo: "detailed", long: "detailed" };

/**
 * Returns the command if `text` addresses the bot, else null.
 * A message addresses the bot when it starts with the prefix, or when the bot is mentioned
 * (mentions list or "@<phone>") and the remaining text contains a command word.
 */
export function parseCommand(text: string | undefined, opts: { isDm: boolean; botMentioned: boolean; botPhone?: string }): Command | null {
  if (!text) return null;
  const prefix = env().BOT_COMMAND_PREFIX;
  let body = text.trim();
  if (opts.botPhone) body = body.replace(new RegExp(`@${opts.botPhone}\\b`, "g"), " ").trim();

  let addressed = false;
  if (body.startsWith(prefix)) {
    addressed = true;
    body = body.slice(prefix.length);
  } else if (opts.botMentioned) {
    addressed = true;
  } else if (opts.isDm && /^(resumen|resume|ayuda|help|grupos|groups|ping|preguntar|pregunta)\b/i.test(body)) {
    addressed = true; // in a DM, bare words are enough
  }
  if (!addressed) return null;

  let tokens = body.split(/\s+/).filter(Boolean);
  if (!tokens.length) return { name: "help" };
  const viaMention = opts.botMentioned && !text.trim().startsWith(prefix);
  if (viaMention) {
    // "@bot, hazme un resumen de hoy" → start at the first command word
    const idx = tokens.findIndex((t) => ALIASES[t.toLowerCase().replace(/^[/!.]/, "").replace(/[,.:!?]+$/, "")]);
    if (idx === -1) return null;
    tokens = tokens.slice(idx);
  }
  const head = tokens[0].toLowerCase().replace(/^[/!.]/, "").replace(/[,.:!?]+$/, "").replace(/@.*$/, ""); // strip "/cmd@botname" like Telegram
  const name = ALIASES[head];
  if (!name) return { name: "unknown", raw: tokens[0] };

  const args = tokens.slice(1);
  switch (name) {
    case "summary": {
      // Flags can appear anywhere; everything else is passed to the handler as `args`
      // (in a group: the "since" expression; in a DM: "<group> [since]").
      const cmd: Command = { name: "summary", private: false, args: [], audio: false };
      for (const a of args) {
        const lower = a.toLowerCase();
        if (PRIVATE_WORDS.has(lower)) cmd.private = true;
        else if (AUDIO_WORDS.has(lower)) cmd.audio = true;
        else if (STYLE_WORDS[lower]) cmd.style = STYLE_WORDS[lower];
        else cmd.args.push(a);
      }
      return cmd;
    }
    case "ask": {
      const audio = args.length > 0 && AUDIO_WORDS.has(args[0].toLowerCase());
      return { name: "ask", question: (audio ? args.slice(1) : args).join(" "), audio };
    }
    case "transcribe":
      // "/transcribir breve|resumen|tldr" → TL;DR of the quoted voice note instead of the full text
      return { name: "transcribe", brief: args.some((a) => STYLE_WORDS[a.toLowerCase()] === "brief" || BRIEF_WORDS.has(a.toLowerCase())) };
    case "say":
      return { name: "say", text: args.join(" ") };
    case "sticker":
      return { name: "sticker", query: args.join(" ").trim() };
    case "import": {
      // hidden admin command: /importar <group nº|name> [forzar]
      const force = args.some((a) => /^(forzar|force)$/i.test(a));
      return { name: "import", args: args.filter((a) => !/^(forzar|force)$/i.test(a)), force };
    }
    case "unknown":
      return { name: "unknown", raw: tokens[0] };
    default:
      return { name } as Command;
  }
}

export function helpText(opts: { isDm: boolean }) {
  const p = env().BOT_COMMAND_PREFIX;
  const bot = env().BOT_NAME;
  const lines = [
    `*${bot}* – resúmenes de chats de grupo 📝`,
    "",
    `*${p}resumen* – desde tu último resumen`,
    `*${p}resumen mi mensaje* – desde tu último mensaje en el grupo`,
    `*${p}resumen hoy* / *ayer* / *lunes* / *08/09* – desde un día`,
    `*${p}resumen ayer 15:00* / *08/09 10:30* / *2026-09-08 10:30* – desde un día y hora`,
    `*${p}resumen 3h* / *2d* / *50* – últimas horas/días o últimos N mensajes`,
    `*${p}resumen privado* – te lo envío por mensaje directo`,
    `*${p}resumen audio* – te lo mando como nota de voz 🔊 (también *${p}preguntar audio …*)`,
    `*${p}resumen breve* / *detallado* – longitud`,
    `Responde (cita) a un mensaje con *${p}resumen* para resumir desde ese punto.`,
    `*${p}preguntar* <pregunta> – pregunta sobre lo hablado en el chat`,
    `*${p}marcar* – "empieza a contar desde aquí" (sin resumir)`,
    `Responde a una nota de voz con *${p}transcribir* para leerla, o *${p}transcribir breve* para quedarte solo con lo importante (las notas de voz ya se transcriben solas para los resúmenes).`,
    `*${p}sticker* – un sticker al azar · *${p}sticker <palabra>* – busca uno · respondiendo a un mensaje: el que mejor le pegue · respondiendo a una foto: la convierte en sticker.`,
  ];
  if (!opts.isDm) lines.push(`Menciónáme (*@${bot}*) y pídemelo en lenguaje natural: "resume desde ayer", "haz un audio diciendo…", "manda un sticker de risa", o pregúntame lo que quieras.`);
  if (opts.isDm) {
    lines.push(`*${p}grupos* – lista los grupos que compartimos`, `*${p}resumen <nº o nombre del grupo> [periodo]* – resume ese grupo aquí`);
  } else {
    lines.push(`Escríbeme por privado y usa *${p}grupos* para resumir cualquier grupo compartido.`);
  }
  lines.push("", `_${p}ayuda_ para ver esto de nuevo.`);
  return lines.join("\n");
}
