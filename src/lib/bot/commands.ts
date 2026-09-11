/**
 * Telegram-style command parsing for WhatsApp messages.
 *
 *   /resumen [desde] [privado] [breve|detallado]      summarise this group
 *   /resumen <grupo> [desde]                         (in DM) summarise a shared group
 *   /preguntar <pregunta>                            answer a question from the chat history
 *   /marcar                                          "start counting from here" (sets your read mark)
 *   /transcribir [breve]                             (reply to a voice note) full transcript, or a TL;DR
 *   /grupos                                          (in DM) list groups you share with the bot
 *   /boletin [grupo] 06:00 14:00 22:00 [audio|texto]  (admins) scheduled digest at those hours · off | on | ahora | quitar
 *   /boletin 8:00 privado                            (in DM) morning brief of every shared group, sent to you
 *   /programar <cuándo> <texto>                      (admins) post a message as the bot at that time
 *   /recordar <cuándo> <texto> [@alguien]            reminder (mentions you in the group; DM → to yourself)
 *   /programados · /cancelar <id>                    list pending jobs · cancel one
 *   /pendientes [míos] [periodo]                     open tasks, promises, questions, debts (default 7 days)
 *   /bienvenida [on|off|N]                           (admins) DM newcomers a summary of the last N days
 *   /config                                          bot settings of the group
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
  | { name: "digest"; args: string[]; hours: string[]; every?: number; audio?: boolean; style?: "brief" | "detailed" | "bullets"; action: "show" | "set" | "off" | "on" | "now" | "remove"; private: boolean }
  | { name: "schedule"; text: string }
  | { name: "remind"; text: string }
  | { name: "jobs" }
  | { name: "cancel"; id?: number }
  | { name: "actions"; args: string[]; mine: boolean }
  | { name: "welcome"; args: string[]; action: "show" | "on" | "off"; days?: number }
  | { name: "config" }
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
  boletin: "digest",
  boletín: "digest",
  noticias: "digest",
  digest: "digest",
  bulletin: "digest",
  programar: "schedule",
  programa: "schedule",
  schedule: "schedule",
  recordar: "remind",
  recuerda: "remind",
  recuérdame: "remind",
  recuerdame: "remind",
  recordatorio: "remind",
  remind: "remind",
  reminder: "remind",
  programados: "jobs",
  recordatorios: "jobs",
  reminders: "jobs",
  scheduled: "jobs",
  cancelar: "cancel",
  cancela: "cancel",
  cancel: "cancel",
  olvidar: "cancel",
  olvida: "cancel",
  pendientes: "actions",
  pendiente: "actions",
  tareas: "actions",
  tasks: "actions",
  pending: "actions",
  bienvenida: "welcome",
  welcome: "welcome",
  config: "config",
  ajustes: "config",
  settings: "config",
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
const TEXT_WORDS = new Set(["texto", "text", "escrito"]);
const DIGEST_ACTIONS: Record<string, "off" | "on" | "now" | "remove"> = { off: "off", parar: "off", stop: "off", pausa: "off", pausar: "off", desactivar: "off", apagar: "off", on: "on", activar: "on", reanudar: "on", encender: "on", ahora: "now", now: "now", ya: "now", test: "now", probar: "now", prueba: "now", quitar: "remove", borrar: "remove", eliminar: "remove", remove: "remove", delete: "remove" };
/** "06:00", "6:30", "22h" – a bare number is NOT an hour (in a DM it would clash with the group number) */
const DIGEST_HOUR_RE = /^\d{1,2}(:\d{2}|h)$/i;
const DIGEST_FILLER = new Set(["a", "las", "y", "desde", "from", "at", "en", "el", "la"]);
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
  } else if (opts.isDm && /^(resumen|resume|ayuda|help|grupos|groups|ping|preguntar|pregunta|recordar|recuérdame|recuerdame|programar|programados|recordatorios|cancelar|pendientes|boletin|boletín|bienvenida|config)\b/i.test(body)) {
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
    case "digest": {
      // /boletin [grupo] 06:00 14:00 22:00 [audio|texto] [breve|detallado] · cada 8h [desde 06:00] · off|on|ahora|quitar
      const cmd: Command = { name: "digest", args: [], hours: [], action: "show", private: false };
      let explicit: "show" | "off" | "on" | "now" | "remove" = "show";
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const lower = a.toLowerCase().replace(/,+$/, "");
        if (DIGEST_ACTIONS[lower]) explicit = DIGEST_ACTIONS[lower];
        else if (lower === "cada" || lower === "every") {
          const n = Number((args[i + 1] ?? "").toLowerCase().replace(/h(oras?)?$/, ""));
          if (Number.isInteger(n) && n > 0) {
            cmd.every = n;
            i++;
          }
        } else if (/^cada\d+h?$/.test(lower)) cmd.every = Number(lower.replace(/\D/g, ""));
        else if (lower.includes(",") && lower.split(",").every((t) => DIGEST_HOUR_RE.test(t))) cmd.hours.push(...lower.split(","));
        else if (DIGEST_HOUR_RE.test(lower)) cmd.hours.push(lower);
        else if (AUDIO_WORDS.has(lower)) cmd.audio = true;
        else if (TEXT_WORDS.has(lower)) cmd.audio = false;
        else if (PRIVATE_WORDS.has(lower)) cmd.private = true;
        else if (STYLE_WORDS[lower]) cmd.style = STYLE_WORDS[lower];
        else if (lower === "normal") cmd.style = "bullets";
        else if (DIGEST_FILLER.has(lower)) continue;
        else cmd.args.push(a);
      }
      cmd.action = explicit !== "show" ? explicit : cmd.hours.length || cmd.every || cmd.audio !== undefined || cmd.style ? "set" : "show";
      return cmd;
    }
    case "schedule":
    case "remind":
      return { name, text: args.join(" ").trim() };
    case "cancel": {
      const id = Number((args[0] ?? "").replace(/^#/, ""));
      return { name: "cancel", id: Number.isInteger(id) && id > 0 ? id : undefined };
    }
    case "actions": {
      const mine = args.some((a) => /^(m[ií]os?|m[ií]as?|mine|me|yo|para\s*m[ií])$/i.test(a));
      return { name: "actions", args: args.filter((a) => !/^(m[ií]os?|m[ií]as?|mine|me|yo)$/i.test(a)), mine };
    }
    case "welcome": {
      const cmd: Command = { name: "welcome", args: [], action: "show" };
      for (const a of args) {
        const lower = a.toLowerCase();
        if (/^(on|activar|s[ií]|si|yes|activa)$/.test(lower)) cmd.action = "on";
        else if (/^(off|desactivar|no|quitar|apagar)$/.test(lower)) cmd.action = "off";
        else if (/^\d{1,2}$/.test(lower) && Number(lower) >= 1 && Number(lower) <= 30) {
          cmd.days = Number(lower);
          cmd.action = "on";
        } else if (/^(d[ií]as?|days?)$/.test(lower)) continue;
        else cmd.args.push(a);
      }
      return cmd;
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
    lines.push(`*${p}grupos* – lista los grupos que compartimos`, `*${p}resumen <nº o nombre del grupo> [periodo]* – resume ese grupo aquí (si solo compartimos un grupo, no hace falta indicarlo)`);
  } else {
    lines.push(`Escríbeme por privado y usa *${p}grupos* para resumir cualquier grupo compartido.`);
  }
  lines.push(
    `*${p}recordar mañana 9:00 llevar el pastel* – te lo recuerdo a esa hora (también *el lunes 20:00*, *en 2h*, *cada día a las 9:00*); responde a un mensaje con *${p}recordar mañana* para que te lo recuerde. *${p}programados* los lista · *${p}cancelar <nº>*${opts.isDm ? " · por privado el recordatorio te llega a ti" : ""}`,
    `*${p}pendientes* – tareas, promesas, preguntas sin responder y pagos abiertos de los últimos 7 días (*${p}pendientes 2d*, *${p}pendientes míos* → solo lo que te toca a ti)`,
  );
  lines.push(`*${p}boletin* – ver el boletín programado del grupo · admins: *${p}boletin 06:00 14:00 22:00 audio* lo programa (nota de voz con las novedades a esas horas), *${p}boletin cada 8h desde 06:00*, *… texto*, *… off* / *on* / *ahora* / *quitar*${opts.isDm ? ` · por privado: *${p}boletin <grupo> …*` : ""}`);
  if (opts.isDm) lines.push(`*${p}boletin 8:00 privado* – cada mañana te mando por aquí un resumen de todos tus grupos`);
  lines.push(`Admins: *${p}programar mañana 9:00 <texto>* publica un mensaje a esa hora · *${p}bienvenida on* manda a quien entre un resumen de los últimos días por privado · *${p}config* muestra los ajustes del grupo.`);
  lines.push("", `_${p}ayuda_ para ver esto de nuevo.`);
  return lines.join("\n");
}
