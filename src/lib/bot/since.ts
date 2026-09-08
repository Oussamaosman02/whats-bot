/**
 * Parse the "since" expression of /resumen.
 *
 *   (empty) | desde | last                    → since the requester's last summary (read mark)
 *   mi último mensaje | mi mensaje | mío | me  → since the requester's last message in the chat
 *   hoy | today [HH:MM]                        → today (optionally from a time)
 *   ayer | yesterday [HH:MM]                   → yesterday (optionally from a time, until today 00:00 if no time)
 *   lunes … domingo | monday … sunday [HH:MM]  → the most recent such weekday
 *   30m | 2h | 3d | 1w                         → relative window
 *   50 | 200                                   → last N messages
 *   todo | all                                 → everything (capped)
 *   2026-09-08 [10:30] | 08/09/2026 10:30 | 08/09 10:30 | 2026-09-08T10:30 → absolute date (+ hours)
 *   HH:MM                                      → today at that time (or yesterday if in the future)
 *
 * Dates and times are interpreted in `timeZone` (BOT_TIMEZONE, default Europe/Madrid).
 */
export type SinceSpec =
  | { kind: "time"; since: Date; until?: Date; label: string }
  | { kind: "count"; count: number; label: string }
  | { kind: "all"; label: string }
  | { kind: "last"; label: string }
  | { kind: "mymessage"; label: string }
  | { kind: "invalid"; raw: string; label: string };

const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
const WEEKDAYS: Record<string, number> = {
  domingo: 0, sunday: 0, lunes: 1, monday: 1, martes: 2, tuesday: 2, miercoles: 3, miércoles: 3, wednesday: 3,
  jueves: 4, thursday: 4, viernes: 5, friday: 5, sabado: 6, sábado: 6, saturday: 6,
};

/** Offset (ms) of `timeZone` at instant `date`, e.g. +7 200 000 for Europe/Madrid in summer. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - date.getTime();
}

/** Build a UTC instant from wall-clock components in `timeZone`. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min, 0);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  const off2 = tzOffsetMs(new Date(guess - off1), timeZone);
  return new Date(guess - off2);
}

/** Wall-clock parts of `date` in `timeZone`. */
export function zonedParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

export function fmtZoned(date: Date, timeZone: string, withDate = true) {
  const p = zonedParts(date, timeZone);
  const hm = `${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
  return withDate ? `${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")} ${hm}` : hm;
}

const TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|h)?$/i;
function parseTime(tok: string | undefined): { h: number; min: number } | null {
  if (!tok) return null;
  const m = tok.match(TIME_RE);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, min };
}

export function parseSince(input: string | undefined, opts: { now?: Date; timeZone?: string } = {}): SinceSpec {
  const now = opts.now ?? new Date();
  const tz = opts.timeZone ?? "Europe/Madrid";
  const s = (input ?? "").trim().toLowerCase().replace(/\s+/g, " ").replace(/^(desde|from|since)\s+/, "");
  const tokens = s.split(" ").filter(Boolean);
  const nowP = zonedParts(now, tz);
  const dayStart = (y: number, m: number, d: number, t?: { h: number; min: number } | null) => zonedToUtc(y, m, d, t?.h ?? 0, t?.min ?? 0, tz);
  const shiftDay = (days: number) => {
    const base = new Date(Date.UTC(nowP.y, nowP.m - 1, nowP.d) + days * 86_400_000);
    return { y: base.getUTCFullYear(), m: base.getUTCMonth() + 1, d: base.getUTCDate() };
  };

  if (!s || ["desde", "last", "ultimo", "último", "continuar", "continue", "resumen"].includes(s)) return { kind: "last", label: "desde tu último resumen" };
  if (/^(mi (ultimo |último )?mensaje|mio|mío|me|my (last )?message|yo)$/.test(s)) return { kind: "mymessage", label: "desde tu último mensaje" };
  if (["todo", "all", "everything"].includes(s)) return { kind: "all", label: "todo el historial" };

  // hoy / today [time]
  if (["hoy", "today"].includes(tokens[0])) {
    const t = parseTime(tokens[1]);
    const { y, m, d } = shiftDay(0);
    return { kind: "time", since: dayStart(y, m, d, t), label: t ? `hoy desde las ${fmtZoned(dayStart(y, m, d, t), tz, false)}` : "hoy" };
  }
  // ayer / yesterday [time]
  if (["ayer", "yesterday"].includes(tokens[0])) {
    const t = parseTime(tokens[1]);
    const { y, m, d } = shiftDay(-1);
    const since = dayStart(y, m, d, t);
    if (t) return { kind: "time", since, label: `desde ayer a las ${fmtZoned(since, tz, false)}` };
    const today = shiftDay(0);
    return { kind: "time", since, until: dayStart(today.y, today.m, today.d), label: "ayer" };
  }
  // anteayer
  if (["anteayer", "antier"].includes(tokens[0])) {
    const t = parseTime(tokens[1]);
    const { y, m, d } = shiftDay(-2);
    return { kind: "time", since: dayStart(y, m, d, t), label: `desde anteayer${t ? " " + tokens[1] : ""}` };
  }
  // weekday [time] → most recent occurrence (today if it is that weekday and a time is given; else last week)
  if (tokens[0] in WEEKDAYS) {
    const target = WEEKDAYS[tokens[0]];
    let back = (nowP.weekday - target + 7) % 7;
    if (back === 0 && !parseTime(tokens[1])) back = 7; // "lunes" on a Monday → last Monday
    const t = parseTime(tokens[1]);
    const { y, m, d } = shiftDay(-back);
    const since = dayStart(y, m, d, t);
    return { kind: "time", since, label: `desde el ${tokens[0]} ${fmtZoned(since, tz)}` };
  }
  // relative: 2h / 30m / 3d / 1w  (also "2 h")
  const rel = s.match(/^(\d+)\s*(m|min|h|d|w)$/);
  if (rel) {
    const ms = Number(rel[1]) * UNIT_MS[rel[2]];
    return { kind: "time", since: new Date(now.getTime() - ms), label: `últimas ${rel[1]}${rel[2]}` };
  }
  // count
  if (/^\d+$/.test(s)) return { kind: "count", count: Math.min(Number(s), 1000), label: `últimos ${s} mensajes` };
  // HH:MM → today at that time, or yesterday if that is in the future
  const onlyTime = parseTime(s);
  if (onlyTime && /[:hapm]/i.test(s)) {
    let { y, m, d } = shiftDay(0);
    let since = dayStart(y, m, d, onlyTime);
    if (since > now) {
      ({ y, m, d } = shiftDay(-1));
      since = dayStart(y, m, d, onlyTime);
    }
    return { kind: "time", since, label: `desde las ${fmtZoned(since, tz)}` };
  }
  // ISO date / datetime: 2026-09-08 [10:30] | 2026-09-08T10:30
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}(?::\d{2})?))?$/);
  if (iso) {
    const t = parseTime(iso[4]);
    const since = dayStart(Number(iso[1]), Number(iso[2]), Number(iso[3]), t);
    return { kind: "time", since, label: `desde ${fmtZoned(since, tz)}` };
  }
  // European date: 08/09[/2026] [10:30]
  const eu = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?(?:\s+(\d{1,2}(?::\d{2})?))?$/);
  if (eu) {
    const yRaw = eu[3] ? Number(eu[3]) : nowP.y;
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    const t = parseTime(eu[4]);
    const since = dayStart(y, Number(eu[2]), Number(eu[1]), t);
    return { kind: "time", since, label: `desde ${fmtZoned(since, tz)}` };
  }
  // Strict ISO datetime with timezone (API use): 2026-09-08T10:30:00Z / +02:00
  const isoTz = s.match(/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2})?(z|[+-]\d{2}:\d{2})$/);
  if (isoTz) {
    const abs = new Date(s);
    if (!Number.isNaN(abs.getTime())) return { kind: "time", since: abs, label: `desde ${fmtZoned(abs, tz)}` };
  }
  return { kind: "invalid", raw: s, label: `periodo no reconocido: "${s}"` };
}

export const SINCE_HELP = "Ejemplos: *hoy*, *ayer*, *ayer 15:00*, *lunes*, *08/09 10:30*, *3h*, *2d*, *50* (mensajes), *todo*, *mi mensaje*.";

/** True when the string looks like something parseSince understands (used to split "<group> <since>"). */
export function looksLikeSince(s: string): boolean {
  return parseSince(s).kind !== "invalid";
}
