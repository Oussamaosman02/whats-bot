/**
 * Pure schedule maths for scheduled digests: "HH:MM" slot lists in BOT_TIMEZONE → next / previous instant.
 * No I/O here so it can be unit-tested without the WhatsApp client.
 */
import { env } from "../env";
import { AppError } from "../errors";
import { zonedParts, zonedToUtc } from "./since";

const HOUR_RE = /^(\d{1,2})(?:[:.h](\d{2}))?h?$/i;

/** "6" → "06:00", "14:30" → "14:30", "22h" → "22:00"; null when it is not a time. */
export function parseHour(tok: string): string | null {
  const m = tok.trim().match(HOUR_RE);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Sorted, unique, valid HH:MM list (throws a 400 with a hint when something is off). */
export function normalizeHours(input: string[]): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    for (const tok of raw.split(",")) {
      if (!tok.trim()) continue;
      const h = parseHour(tok);
      if (!h) throw AppError.badRequest(`"${tok}" is not a valid time.`, "Use HH:MM in 24 h format, e.g. 06:00 14:00 22:00.");
      out.add(h);
    }
  }
  if (!out.size) throw AppError.badRequest("At least one time is required.", "Example: 06:00 14:00 22:00");
  if (out.size > 12) throw AppError.badRequest("Too many slots (max 12 per day).", "Keep it to a handful of bulletins a day.");
  return [...out].sort();
}

/** `every` hours starting at `from` (HH:MM) → e.g. every 8 from 06:00 → 06:00, 14:00, 22:00. */
export function hoursEvery(every: number, from = "06:00"): string[] {
  if (!Number.isInteger(every) || every < 1 || every > 24) throw AppError.badRequest(`"cada ${every}h" is not valid.`, "Use a whole number of hours between 1 and 24.");
  const [h0, m0] = from.split(":").map(Number);
  const out: string[] = [];
  for (let h = h0; h < h0 + 24; h += every) out.push(`${String(h % 24).padStart(2, "0")}:${String(m0).padStart(2, "0")}`);
  return normalizeHours(out);
}

/** Next instant strictly after `now` at which one of `hours` occurs in `tz`. */
export function nextSlot(hours: string[], now = new Date(), tz = env().BOT_TIMEZONE): Date {
  const p = zonedParts(now, tz);
  let best: Date | undefined;
  for (const dayOffset of [0, 1, 2]) {
    for (const hm of hours) {
      const [h, m] = hm.split(":").map(Number);
      const t = zonedToUtc(p.y, p.m, p.d + dayOffset, h, m, tz);
      if (t.getTime() > now.getTime() && (!best || t < best)) best = t;
    }
    if (best) return best;
  }
  /* istanbul ignore next – hours is never empty */
  return new Date(now.getTime() + 86_400_000);
}

/** Most recent instant at or before `now` at which one of `hours` occurs (window start for a first run). */
export function prevSlot(hours: string[], now = new Date(), tz = env().BOT_TIMEZONE): Date {
  const p = zonedParts(now, tz);
  let best: Date | undefined;
  for (const dayOffset of [0, -1, -2]) {
    for (const hm of hours) {
      const [h, m] = hm.split(":").map(Number);
      const t = zonedToUtc(p.y, p.m, p.d + dayOffset, h, m, tz);
      if (t.getTime() <= now.getTime() && (!best || t > best)) best = t;
    }
    if (best) return best;
  }
  return new Date(now.getTime() - 86_400_000);
}

