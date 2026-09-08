/**
 * Summary service used by both the chat commands and the HTTP API.
 * Resolves a "since" spec into a message set, calls Gemini, stores the summary and
 * (optionally) advances the requester's read mark.
 */
import { env } from "../env";
import { AppError } from "../errors";
import { getLogger } from "../logger";
import { answerQuestion, summarizeMessages, type SummaryStyle } from "../ai/summarize";
import { getChat, getReadMark, lastMessageFromUser, lastMessages, listArchiveSummaries, listMessages, saveSummary, searchArchiveSummaries, searchMessages, setReadMark } from "../store";
import { fmtZoned, parseSince, SINCE_HELP, type SinceSpec } from "./since";
import type { Message } from "../db/schema";

const log = getLogger("bot:service");

export type SummaryRequest = {
  chatJid: string;
  since?: string | SinceSpec;
  until?: Date;
  requesterJid?: string;
  requesterPhone?: string;
  requesterName?: string;
  /** exclude messages after this instant (e.g. the command message itself) */
  style?: SummaryStyle;
  focus?: string;
  language?: string;
  model?: string;
  trigger?: "api" | "command";
  /** advance requester's read mark after summarising (default true when requesterJid given) */
  advanceMark?: boolean;
  reqId?: string;
};

export type SummaryResult = {
  id: number;
  text: string;
  messageCount: number;
  from: Date;
  to: Date;
  label: string;
  model: string;
  chatName?: string;
  ms: number;
};

export async function resolveMessages(spec: SinceSpec, chatJid: string, requesterJid?: string, until?: Date, requesterPhone?: string): Promise<{ messages: Message[]; label: string }> {
  const max = env().SUMMARY_MAX_MESSAGES;
  const tz = env().BOT_TIMEZONE;
  switch (spec.kind) {
    case "invalid":
      throw AppError.badRequest(`No entiendo el periodo "${spec.raw}".`, SINCE_HELP, { raw: spec.raw });
    case "mymessage": {
      if (!requesterJid) throw AppError.badRequest("since=mymessage needs a requester.", "Pass `requester` (phone or jid).");
      const mine = await lastMessageFromUser(chatJid, requesterJid, until, requesterPhone);
      if (!mine) throw new AppError(404, "no_messages", "No encuentro ningún mensaje tuyo en este chat.", { hint: "The requester has no stored message in this chat; try since=24h." });
      // include the requester's own message as context (since is exclusive)
      const rows = await listMessages({ chatJid, since: new Date(mine.timestamp.getTime() - 1), until, limit: max, newestFirst: true, excludeCommands: true });
      return { messages: rows.reverse(), label: `desde tu último mensaje (${fmtZoned(mine.timestamp, tz)})` };
    }
    case "count":
      return { messages: await lastMessages(chatJid, Math.min(spec.count, max), { excludeCommands: true }), label: spec.label };
    case "all":
      return { messages: await lastMessages(chatJid, max, { excludeCommands: true }), label: spec.label };
    case "time": {
      const rows = await listMessages({ chatJid, since: spec.since, until: spec.until ?? until, limit: max, newestFirst: true, excludeCommands: true });
      return { messages: rows.reverse(), label: spec.label };
    }
    case "last": {
      const mark = requesterJid ? await getReadMark(chatJid, requesterJid) : undefined;
      const since = mark?.lastSummaryAt ?? new Date(Date.now() - 24 * 3_600_000);
      const rows = await listMessages({ chatJid, since, until, limit: max, newestFirst: true, excludeCommands: true });
      return { messages: rows.reverse(), label: mark ? `desde tu último resumen (${fmtZoned(since, tz)})` : "últimas 24h" };
    }
  }
}

export async function runSummary(req: SummaryRequest): Promise<SummaryResult> {
  const t0 = Date.now();
  const chat = await getChat(req.chatJid);
  if (!chat) throw AppError.notFound(`Chat ${req.chatJid} is unknown.`, "The bot has not seen this chat yet. GET /api/groups?live=1 to sync groups, or send a message in the group first.");
  const spec = typeof req.since === "string" || req.since === undefined ? parseSince(req.since, { timeZone: env().BOT_TIMEZONE }) : req.since;
  const { messages, label } = await resolveMessages(spec, req.chatJid, req.requesterJid, req.until, req.requesterPhone);
  log.info({ chat: req.chatJid, spec: spec.kind, label, messages: messages.length, requester: req.requesterJid, reqId: req.reqId }, "summary requested");
  if (!messages.length) {
    throw new AppError(404, "no_messages", "No hay mensajes en ese periodo.", { hint: "Try a wider range: since=24h, since=all or since=200.", data: { label } });
  }
  // Older context (archive summaries) only when the request spans everything
  const archives = spec.kind === "all" ? await listArchiveSummaries(req.chatJid, 5) : [];
  const completion = await summarizeMessages(messages, {
    chatName: chat.name ?? undefined,
    language: req.language,
    style: req.style,
    focus: req.focus,
    model: req.model,
    reqId: req.reqId,
    requesterName: req.requesterName,
    archives,
    periodLabel: label,
  });
  const from = messages[0].timestamp;
  const to = messages[messages.length - 1].timestamp;
  const row = await saveSummary({
    chatJid: req.chatJid,
    requestedBy: req.requesterJid ?? null,
    trigger: req.trigger ?? "api",
    fromTs: from,
    toTs: to,
    messageCount: messages.length,
    text: completion.text,
    model: completion.model,
    promptTokens: completion.promptTokens ?? null,
    completionTokens: completion.completionTokens ?? null,
  });
  if (req.requesterJid && req.advanceMark !== false) await setReadMark(req.chatJid, req.requesterJid, to);
  log.info({ summaryId: row.id, chat: req.chatJid, messages: messages.length, ms: Date.now() - t0, model: completion.model }, "summary generated");
  return { id: row.id, text: completion.text, messageCount: messages.length, from, to, label, model: completion.model, chatName: chat.name ?? undefined, ms: Date.now() - t0 };
}

const STOP = new Set(["que","qué","quien","quién","cual","cuál","cuando","cuándo","donde","dónde","como","cómo","por","para","con","sin","del","los","las","una","uno","unos","unas","the","what","who","when","where","how","which","about","sobre","dijo","dice","hablo","habló","hay","fue","era","son","esta","está","este","esto","esa","ese","eso","algo","alguien","sabes","sabe","saber","tiene","tienen","han","has","hemos","the","and","les","nos","mis","sus","tus","ultimo","último","ultima","última","mensaje","mensajes","grupo","chat","resumen","resume","alguna","algun","algún","pasado","pasó","paso","quien","dime","cuenta","explica","hablado","hablaron","comentado","decidido","decidió"]);

function keywords(question: string): string[] {
  return [...new Set(question.toLowerCase().replace(/[¿?¡!.,;:"'()]/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))].slice(0, 8);
}
export async function runQuestion(req: { chatJid: string; question: string; since?: string; language?: string; model?: string; reqId?: string; spoken?: boolean }) {
  const e = env();
  const chat = await getChat(req.chatJid);
  if (!chat) throw AppError.notFound(`Chat ${req.chatJid} is unknown.`);
  const t0 = Date.now();
  let messages: Message[];
  let scope: string;
  let archives: Awaited<ReturnType<typeof listArchiveSummaries>> = [];
  if (req.since) {
    // explicit window
    const spec = parseSince(req.since, { timeZone: e.BOT_TIMEZONE });
    ({ messages } = await resolveMessages(spec.kind === "last" || spec.kind === "mymessage" ? parseSince("7d") : spec, req.chatJid));
    scope = spec.label;
  } else {
    // hybrid: keyword hits over the whole history (+ neighbours) ∪ most recent messages, chronological, char-capped
    const terms = keywords(req.question);
    const [hits, recent, archiveHits] = await Promise.all([
      terms.length ? searchMessages(req.chatJid, terms, { limit: e.ASK_KEYWORD_HITS, around: 2 }) : Promise.resolve([] as Message[]),
      lastMessages(req.chatJid, e.ASK_RECENT_MESSAGES, { excludeCommands: true }),
      terms.length ? searchArchiveSummaries(req.chatJid, terms, 5) : Promise.resolve([]),
    ]);
    archives = archiveHits;
    const byId = new Map<number, Message>();
    for (const m of [...hits, ...recent]) byId.set(m.id, m);
    messages = [...byId.values()].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    // trim oldest until within the char budget
    let chars = messages.reduce((n, m) => n + (m.text?.length ?? 20) + 40, 0);
    while (messages.length > 50 && chars > e.ASK_MAX_CHARS) {
      const dropped = messages.shift()!;
      chars -= (dropped.text?.length ?? 20) + 40;
    }
    scope = `${hits.length} coincidencias de "${terms.join(", ")}" + ${recent.length} recientes${archives.length ? ` + ${archives.length} resúmenes de archivo` : ""}`;
    log.info({ chat: req.chatJid, terms, hits: hits.length, recent: recent.length, archives: archives.length, total: messages.length, chars, reqId: req.reqId }, "question context assembled");
  }
  if (!messages.length && !archives.length) throw new AppError(404, "no_messages", "No hay mensajes con los que responder.", { hint: "Try since=all." });
  const completion = await answerQuestion(messages, req.question, { chatName: chat.name ?? undefined, language: req.language, model: req.model ?? e.ASK_MODEL, reqId: req.reqId, scope, archives, spoken: req.spoken });
  log.info({ chat: req.chatJid, messages: messages.length, ms: Date.now() - t0, model: completion.model, reqId: req.reqId }, "question answered");
  return { text: completion.text, messageCount: messages.length, model: completion.model, scope };
}
