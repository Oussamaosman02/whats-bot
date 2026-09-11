/**
 * Parse a *future* time expression at the start of a command and return what is left as the message.
 *
 *   mañana 9:00 llevar el pastel          → tomorrow 09:00, rest "llevar el pastel"
 *   el lunes a las 20:00 …                → next Monday 20:00
 *   en 2h … · en 30 min … · en 3 días …   → relative
 *   a las 21:00 …                         → today, or tomorrow if already past
 *   08/09 10:30 … · 2026-09-08 10:30 …    → absolute (must be in the future)
 *   cada día a las 9:00 … · cada lunes 20:00 … · cada 2h … · todos los días 9:00 …   → recurring
 *   mañana por la tarde …                 → 17:00 (mañana 09:00 · mediodía 12:00 · tarde 17:00 · noche 21:00)
 *
 * Only the leading tokens are consumed; filler words ("el", "a", "las") between them are skipped but trailing
 * fillers stay with the message. Times are wall-clock in BOT_TIMEZONE.
 */
import type { Recurrence } from "../db/schema";
import { fmtZoned, zonedParts, zonedToUtc } from "./since";

export type When = { at: Date; recurrence?: Recurrence; label: string; rest: string };
export type WhenResult = When | { error: string };

const WEEKDAYS: Record<string, number> = {
  domingo: 0, sunday: 0, lunes: 1, monday: 1, martes: 2, tuesday: 2, miercoles: 3, miércoles: 3, wednesday: 3,
  jueves: 4, thursday: 4, viernes: 5, friday: 5, sabado: 6, sábado: 6, saturday: 6,
};
const WEEKDAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const DAY_WORDS: Record<string, number> = { hoy: 0, today: 0, mañana: 1, manana: 1, tomorrow: 1 };
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, mins: 60_000, minuto: 60_000, minutos: 60_000, minute: 60_000, minutes: 60_000, h: 3_600_000, hora: 3_600_000, horas: 3_600_000, hour: 3_600_000, hours: 3_600_000, d: 86_400_000, dia: 86_400_000, día: 86_400_000, dias: 86_400_000, días: 86_400_000, day: 86_400_000, days: 86_400_000, w: 7 * 86_400_000, semana: 7 * 86_400_000, semanas: 7 * 86_400_000, week: 7 * 86_400_000, weeks: 7 * 86_400_000 };
const PART_OF_DAY: Record<string, { h: number; min: number }> = { mañana: { h: 9, min: 0 }, manana: { h: 9, min: 0 }, morning: { h: 9, min: 0 }, mediodía: { h: 12, min: 0 }, mediodia: { h: 12, min: 0 }, noon: { h: 12, min: 0 }, tarde: { h: 17, min: 0 }, afternoon: { h: 17, min: 0 }, noche: { h: 21, min: 0 }, night: { h: 21, min: 0 }, evening: { h: 21, min: 0 }, medianoche: { h: 0, min: 0 }, midnight: { h: 0, min: 0 } };
const FILLER = new Set(["el", "la", "los", "las", "a", "at", "on", "de", "del", "por", "y", "para", "in"]);
const TIME_RE = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|h)?$/i;

function parseTime(tok: string | undefined, strict: boolean): { h: number; min: number } | null {
  if (!tok) return null;
  const m = tok.match(TIME_RE);
  if (!m) return null;
  if (strict && !m[2] && !m[3]) return null; // bare "9" only right after a day word or "a las"
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

const clean = (t: string) => t.toLowerCase().replace(/[,;:!?]+$/, "");

export function parseWhen(input: string, opts: { now?: Date; timeZone: string }): WhenResult {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone;
  const tokens = input.trim().split(/\s+/).filter(Boolean);
  let dayOffset: number | undefined;
  let weekday: number | undefined;
  let abs: { y: number; m: number; d: number } | undefined;
  let time: { h: number; min: number } | undefined;
  let relMs: number | undefined;
  let recurrence: Recurrence | undefined;
  let explicitToday = false;
  let matchedEnd = 0; // index after the last real (non-filler) match
  let afterLas = false; // "a las" / day word just seen → a bare number is an hour

  const take = (i: number) => {
    matchedEnd = i;
    afterLas = false;
  };

  let i = 0;
  while (i < tokens.length) {
    const t = clean(tokens[i]);
    const next = clean(tokens[i + 1] ?? "");
    const next2 = clean(tokens[i + 2] ?? "");

    if (FILLER.has(t)) {
      if (t === "las" || t === "a" || t === "at") afterLas = true;
      i++;
      continue; // tentatively skipped; only "kept" if a later real token matches
    }
    // "cada X" / "every X" / "todos los días"
    if (t === "cada" || t === "every" || t === "todos" || t === "todas") {
      let j = i + 1;
      if (clean(tokens[j] ?? "") === "los" || clean(tokens[j] ?? "") === "las") j++;
      const w = clean(tokens[j] ?? "");
      const w2 = clean(tokens[j + 1] ?? "");
      const n = Number(w.replace(/[a-záéíóú]+$/i, ""));
      if (["día", "dia", "días", "dias", "day", "daily"].includes(w)) recurrence = { kind: "daily" };
      else if (w in WEEKDAYS) {
        recurrence = { kind: "weekly", weekday: WEEKDAYS[w] };
        weekday = WEEKDAYS[w];
      } else if (["semana", "week", "semanas"].includes(w)) recurrence = { kind: "weekly", weekday: -1 };
      else if (["laborable", "laborables", "weekday", "weekdays"].includes(w) || (w === "entre" && w2 === "semana")) {
        recurrence = { kind: "weekdays" };
        if (w === "entre") j++;
      } else if (/^\d+$/.test(w) && w2 in UNIT_MS) {
        recurrence = { kind: "interval", ms: Number(w) * UNIT_MS[w2] };
        j++;
      } else if (n > 0 && w.replace(/^\d+/, "") in UNIT_MS) recurrence = { kind: "interval", ms: n * UNIT_MS[w.replace(/^\d+/, "")] };
      else break;
      i = j + 1;
      take(i);
      continue;
    }
    // "en 2h" / "en 30 min" / "dentro de 3 días" / "in 2 hours"
    if (t === "en" || t === "dentro") {
      let j = i + 1;
      if (t === "dentro" && clean(tokens[j] ?? "") === "de") j++;
      const w = clean(tokens[j] ?? "");
      const w2 = clean(tokens[j + 1] ?? "");
      if (/^\d+$/.test(w) && w2 in UNIT_MS) {
        relMs = Number(w) * UNIT_MS[w2];
        j++;
      } else if (/^\d+[a-z]+$/.test(w) && w.replace(/^\d+/, "") in UNIT_MS) relMs = Number(w.replace(/\D/g, "")) * UNIT_MS[w.replace(/^\d+/, "")];
      else if ((w === "una" || w === "un" || w === "1") && w2 in UNIT_MS) {
        relMs = UNIT_MS[w2];
        j++;
      } else break;
      i = j + 1;
      take(i);
      continue;
    }
    // "pasado mañana"
    if (t === "pasado" && (next === "mañana" || next === "manana")) {
      dayOffset = 2;
      i += 2;
      take(i);
      afterLas = true;
      continue;
    }
    // "por la tarde" / "a mediodía" / "esta noche" (part of day)
    if ((t === "esta" || t === "este") && next in PART_OF_DAY) {
      time = PART_OF_DAY[next];
      dayOffset ??= 0;
      i += 2;
      take(i);
      continue;
    }
    if (t in PART_OF_DAY && (time || dayOffset !== undefined || weekday !== undefined || abs) && !(t === "mañana" && dayOffset === undefined && weekday === undefined && !abs)) {
      // "mañana" after a day is the morning; a first "mañana" is tomorrow (handled below)
      if (!time) {
        time = PART_OF_DAY[t];
        i++;
        take(i);
        continue;
      }
    }
    if (t in DAY_WORDS && dayOffset === undefined && weekday === undefined && !abs) {
      dayOffset = DAY_WORDS[t];
      explicitToday = dayOffset === 0;
      i++;
      take(i);
      afterLas = true;
      continue;
    }
    if (t in WEEKDAYS && weekday === undefined && dayOffset === undefined && !abs) {
      weekday = WEEKDAYS[t];
      i++;
      take(i);
      afterLas = true;
      continue;
    }
    const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:t(\d{1,2}(?::\d{2})?))?$/);
    if (iso && !abs) {
      abs = { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) };
      if (iso[4]) time = parseTime(iso[4], false) ?? time;
      i++;
      take(i);
      afterLas = true;
      continue;
    }
    const eu = t.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
    if (eu && !abs && dayOffset === undefined && weekday === undefined) {
      const yRaw = eu[3] ? Number(eu[3]) : zonedParts(now, tz).y;
      abs = { y: yRaw < 100 ? 2000 + yRaw : yRaw, m: Number(eu[2]), d: Number(eu[1]) };
      i++;
      take(i);
      afterLas = true;
      continue;
    }
    // time: "9:00", "21h", "9 pm", or bare "9" right after a day word / "a las"
    const tm = parseTime(t, !afterLas);
    if (tm && !time) {
      time = tm;
      i++;
      if (/^(am|pm)$/i.test(next)) {
        time = parseTime(`${t}${next}`, false) ?? tm;
        i++;
      } else if (next === "y" && (next2 === "media" || next2 === "cuarto")) {
        time = { h: tm.h, min: next2 === "media" ? 30 : 15 };
        i += 2;
      }
      take(i);
      continue;
    }
    if (t === "mediodía" || t === "mediodia" || t === "medianoche") {
      time = PART_OF_DAY[t];
      i++;
      take(i);
      continue;
    }
    break;
  }

  if (!matchedEnd) return { error: "no time expression" };
  const rest = tokens.slice(matchedEnd).join(" ");
  const p = zonedParts(now, tz);
  const atDay = (offset: number, t: { h: number; min: number }) => zonedToUtc(p.y, p.m, p.d + offset, t.h, t.min, tz);
  let at: Date;
  const defaultTime = { h: 9, min: 0 };

  if (relMs !== undefined) {
    at = new Date(now.getTime() + relMs);
  } else if (abs) {
    at = zonedToUtc(abs.y, abs.m, abs.d, (time ?? defaultTime).h, (time ?? defaultTime).min, tz);
    if (at <= now) return { error: "that date is in the past" };
  } else if (weekday !== undefined && weekday >= 0) {
    const t = time ?? defaultTime;
    let ahead = (weekday - p.weekday + 7) % 7;
    if (ahead === 0 && atDay(0, t) <= now) ahead = 7;
    at = atDay(ahead, t);
  } else if (dayOffset !== undefined) {
    const t = time ?? defaultTime;
    at = atDay(dayOffset, t);
    if (at <= now) {
      if (explicitToday && time) return { error: "that time has already passed today" };
      at = atDay(dayOffset + 1, t);
    }
  } else if (time) {
    at = atDay(0, time);
    if (at <= now) at = atDay(1, time);
  } else if (recurrence) {
    at = recurrence.kind === "interval" ? new Date(now.getTime() + recurrence.ms) : atDay(0, defaultTime);
    if (at <= now) at = atDay(1, defaultTime);
  } else return { error: "no time expression" };

  if (recurrence?.kind === "weekly" && recurrence.weekday === -1) recurrence = { kind: "weekly", weekday: zonedParts(at, tz).weekday };
  if (recurrence?.kind === "weekdays") at = nextWeekday(at, tz, true);
  if (recurrence?.kind === "interval" && recurrence.ms < 10 * 60_000) return { error: "recurring jobs need at least 10 minutes between runs" };

  return { at, recurrence, label: describeWhen(at, recurrence, tz), rest };
}

function nextWeekday(d: Date, tz: string, allowSame: boolean): Date {
  let cur = d;
  for (let k = 0; k < 8; k++) {
    const wd = zonedParts(cur, tz).weekday;
    if (wd >= 1 && wd <= 5 && (allowSame || cur > d)) return cur;
    const p = zonedParts(cur, tz);
    cur = zonedToUtc(p.y, p.m, p.d + 1, p.h, p.min, tz);
  }
  return cur;
}

/** The occurrence after `after` for a recurring job (same local wall-clock time; DST-safe). */
export function nextOccurrence(rec: Recurrence, after: Date, tz: string): Date {
  const p = zonedParts(after, tz);
  switch (rec.kind) {
    case "interval":
      return new Date(after.getTime() + rec.ms);
    case "daily":
      return zonedToUtc(p.y, p.m, p.d + 1, p.h, p.min, tz);
    case "weekly":
      return zonedToUtc(p.y, p.m, p.d + 7, p.h, p.min, tz);
    case "weekdays":
      return nextWeekday(zonedToUtc(p.y, p.m, p.d + 1, p.h, p.min, tz), tz, true);
  }
}

export function describeRecurrence(rec: Recurrence | null | undefined, at: Date, tz: string): string | undefined {
  if (!rec) return undefined;
  const hm = fmtZoned(at, tz, false);
  switch (rec.kind) {
    case "daily":
      return `cada día a las ${hm}`;
    case "weekdays":
      return `de lunes a viernes a las ${hm}`;
    case "weekly":
      return `cada ${WEEKDAY_NAMES[rec.weekday]} a las ${hm}`;
    case "interval": {
      const h = rec.ms / 3_600_000;
      return h >= 24 && Number.isInteger(h / 24) ? `cada ${h / 24} días` : h >= 1 && Number.isInteger(h) ? `cada ${h} h` : `cada ${Math.round(rec.ms / 60_000)} min`;
    }
  }
}

export function describeWhen(at: Date, rec: Recurrence | null | undefined, tz: string, now = new Date()): string {
  const p = zonedParts(at, tz);
  const n = zonedParts(now, tz);
  const hm = fmtZoned(at, tz, false);
  const sameDay = p.y === n.y && p.m === n.m && p.d === n.d;
  const tomorrow = zonedParts(new Date(now.getTime() + 86_400_000), tz);
  const isTomorrow = p.y === tomorrow.y && p.m === tomorrow.m && p.d === tomorrow.d;
  const day = sameDay ? "hoy" : isTomorrow ? "mañana" : at.getTime() - now.getTime() < 6 * 86_400_000 ? `el ${WEEKDAY_NAMES[p.weekday]}` : `el ${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}`;
  const first = `${day} a las ${hm}`;
  const r = describeRecurrence(rec, at, tz);
  return r ? `${r} (primera vez ${first})` : first;
}

export const WHEN_HELP = "Ejemplos: *mañana 9:00*, *el lunes a las 20:00*, *en 2h*, *en 30 min*, *a las 21:00*, *08/09 10:30*, *cada día a las 9:00*, *cada lunes 20:00*, *mañana por la tarde*.";
