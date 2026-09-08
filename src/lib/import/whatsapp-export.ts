/**
 * Parser for WhatsApp "Export chat" text files (iOS and Android, any locale that uses numeric dates).
 *
 *   iOS:     [8/9/26, 10:30:15] Ana: Hola
 *   Android: 8/9/26, 10:30 - Ana: Hola      |  08/09/2026, 10:30 a. m. - Ana: Hola
 * Lines that do not start a new message are continuations of the previous one.
 * System lines (no "Name: ") are ignored. Media placeholders become typed messages without text.
 */
import { zonedToUtc } from "../bot/since";

export type ParsedMessage = { timestamp: Date; sender: string; text: string | null; type: string; line: number };

const HEADER = /^\[?(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?\s?m\.?)?\]?\s*(?:-\s*)?(.+?):\s(.*)$/i;
const MEDIA: [RegExp, string][] = [
  [/(imagen omitida|image omitted|<media omitted>|<multimedia omitido>|<archivo omitido>)/i, "image"],
  [/(v[ií]deo omitido|video omitted)/i, "video"],
  [/(audio omitido|audio omitted|nota de voz omitida)/i, "audio"],
  [/(sticker omitido|sticker omitted)/i, "sticker"],
  [/(gif omitido|gif omitted)/i, "video"],
  [/(documento omitido|document omitted)/i, "document"],
  [/(\(archivo adjunto\)|\(file attached\)|<attached: |<adjunto: )/i, "document"],
];

function clean(s: string) {
  return s.replace(/[‎‏‪-‮]/g, "").replace(/ /g, " ");
}

export function detectDateFormat(lines: string[]): "dmy" | "mdy" {
  let firstOver12 = 0, secondOver12 = 0;
  for (const raw of lines) {
    const m = clean(raw).match(HEADER);
    if (!m) continue;
    if (Number(m[1]) > 12) firstOver12++;
    if (Number(m[2]) > 12) secondOver12++;
  }
  if (firstOver12 && !secondOver12) return "dmy";
  if (secondOver12 && !firstOver12) return "mdy";
  return "dmy";
}

export function parseWhatsAppExport(content: string, opts: { timeZone: string; dateFormat?: "auto" | "dmy" | "mdy" }): { messages: ParsedMessage[]; dateFormat: "dmy" | "mdy"; skippedLines: number } {
  const lines = content.split(/\r?\n/);
  const dateFormat = !opts.dateFormat || opts.dateFormat === "auto" ? detectDateFormat(lines) : opts.dateFormat;
  const out: ParsedMessage[] = [];
  let skipped = 0;
  let current: ParsedMessage | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]);
    const m = line.match(HEADER);
    if (m) {
      const a = Number(m[1]), b = Number(m[2]);
      const yRaw = Number(m[3]);
      const y = yRaw < 100 ? 2000 + yRaw : yRaw;
      const d = dateFormat === "dmy" ? a : b;
      const mo = dateFormat === "dmy" ? b : a;
      let h = Number(m[4]);
      const min = Number(m[5]);
      const sec = Number(m[6] ?? 0);
      const ampm = m[7]?.toLowerCase().replace(/[.\s]/g, "");
      if (ampm === "pm" && h < 12) h += 12;
      if (ampm === "am" && h === 12) h = 0;
      const ts = zonedToUtc(y, mo, d, h, min, opts.timeZone);
      ts.setUTCSeconds(sec);
      if (Number.isNaN(ts.getTime()) || mo < 1 || mo > 12 || d < 1 || d > 31) {
        skipped++;
        current = undefined;
        continue;
      }
      const sender = m[8].trim();
      const body = m[9].trim();
      let type = "text";
      let text: string | null = body;
      for (const [re, t] of MEDIA) {
        if (re.test(body)) {
          type = t;
          text = body.replace(re, "").replace(/^[<(]|[>)]$/g, "").trim() || null;
          break;
        }
      }
      current = { timestamp: ts, sender, text, type, line: i + 1 };
      out.push(current);
    } else if (current && line.trim()) {
      current.text = (current.text ? current.text + "\n" : "") + line;
    } else if (line.trim()) {
      skipped++; // system line ("Ana added Luis", encryption notice…)
    }
  }
  return { messages: out, dateFormat, skippedLines: skipped };
}
