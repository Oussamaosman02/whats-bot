/**
 * Short descriptions of stickers / photos / video thumbnails with Gemini (image input via OpenRouter),
 * cached per file hash so a popular sticker is only described once.
 */
import { eq, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db";
import { env } from "../env";
import { getLogger } from "../logger";
import { chatComplete } from "./gemini";
import sharp from "sharp";
import { getStickerBytes } from "../store";

const log = getLogger("ai:vision");

export type MediaKind = "sticker" | "image" | "video";

const LANG_NAMES: Record<string, string> = { es: "Spanish", en: "English", pt: "Portuguese", fr: "French", de: "German", it: "Italian", ca: "Catalan" };

export async function describeMedia(buffer: Buffer, opts: { kind: MediaKind; mimetype?: string; sha256?: string; reqId?: string }): Promise<{ description: string; cached: boolean; model?: string }> {
  if (opts.sha256) {
    const hit = await db.select().from(schema.mediaDescriptions).where(eq(schema.mediaDescriptions.sha256, opts.sha256)).limit(1);
    if (hit[0]) return { description: hit[0].description, cached: true, model: hit[0].model ?? undefined };
  }
  const lang = LANG_NAMES[env().BOT_LANGUAGE] ?? "Spanish";
  const what = opts.kind === "sticker" ? "a WhatsApp sticker" : opts.kind === "video" ? "the thumbnail of a video" : "a photo";
  const mimetype = opts.mimetype?.split(";")[0] || (opts.kind === "sticker" ? "image/webp" : "image/jpeg");
  const res = await chatComplete(
    [
      {
        role: "system",
        content: `Describe ${what} sent in a group chat in ONE short sentence in ${lang} (max 20 words), so someone who cannot see it understands what it conveys. For stickers describe the character/expression/emotion and any text on it. If there is readable text, quote it. Output only the description, no quotes, no preamble.`,
      },
      { role: "user", content: [{ type: "text", text: "Describe it." }, { type: "image_url", image_url: { url: `data:${mimetype};base64,${buffer.toString("base64")}` } }] },
    ],
    { temperature: 0.2, maxTokens: 80, reqId: opts.reqId },
  );
  const description = res.text.replace(/^["“”']+|["“”']+$/g, "").trim();
  if (opts.sha256) {
    await db.insert(schema.mediaDescriptions).values({ sha256: opts.sha256, kind: opts.kind, description, model: res.model }).onConflictDoNothing();
  }
  log.info({ kind: opts.kind, bytes: buffer.length, ms: res.ms, description, reqId: opts.reqId }, "🖼️ media described");
  return { description, cached: false, model: res.model };
}


/**
 * Build a single image from an animated WebP: up to 6 evenly spaced frames in a row, so a still-image
 * model can "see" the motion. Falls back to the first frame on any error.
 */
export async function animatedContactSheet(webp: Buffer): Promise<{ buffer: Buffer; frames: number }> {
  try {
    const meta = await sharp(webp, { animated: true }).metadata();
    const pages = meta.pages ?? 1;
    if (pages <= 1) return { buffer: await sharp(webp).png().toBuffer(), frames: 1 };
    const take = Math.min(6, pages);
    const idx = Array.from({ length: take }, (_, i) => Math.floor((i * (pages - 1)) / Math.max(1, take - 1)));
    const size = 256;
    const frames = await Promise.all(idx.map((page) => sharp(webp, { page }).resize(size, size, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } }).png().toBuffer()));
    const sheet = await sharp({ create: { width: size * take, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
      .composite(frames.map((input, i) => ({ input, left: i * size, top: 0 })))
      .png()
      .toBuffer();
    return { buffer: sheet, frames: take };
  } catch (e) {
    log.debug({ err: String(e) }, "contact sheet failed – using first frame");
    return { buffer: await sharp(webp, { page: 0 }).png().toBuffer().catch(() => webp), frames: 1 };
  }
}

export type StickerCaption = { caption: string; tags: string[]; model?: string };

/** Humour/intent-aware caption for a sticker (static or animated). */
export async function captionSticker(webp: Buffer, opts: { animated?: boolean; reqId?: string } = {}): Promise<StickerCaption> {
  const lang = LANG_NAMES[env().BOT_LANGUAGE] ?? "Spanish";
  const { buffer, frames } = opts.animated ? await animatedContactSheet(webp) : { buffer: await sharp(webp).png().toBuffer().catch(() => webp), frames: 1 };
  const res = await chatComplete(
    [
      {
        role: "system",
        content: `You caption WhatsApp stickers for a chat summariser. Stickers are almost always used humorously or as a reaction (mockery, sarcasm, laughter, affection, "no way", "I'm dead", etc.).
Return JSON only: {"caption": "...", "tags": ["...", "..."]}.
- caption: ONE sentence in ${lang}, max 25 words: what is shown (character/meme/celebrity if recognisable, expression, any text quoted verbatim) AND what it is typically used to express in a chat.
- tags: 3–6 lowercase ${lang} keywords (emotion, subject, meme name, text words).${frames > 1 ? `\n- The image shows ${frames} frames of an ANIMATED sticker left→right; describe the motion.` : ""}`,
      },
      { role: "user", content: [{ type: "text", text: "Caption this sticker." }, { type: "image_url", image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` } }] },
    ],
    { temperature: 0.3, maxTokens: 160, reqId: opts.reqId },
  );
  const cleaned = res.text.replace(/```(?:json)?/gi, "").trim();
  let caption = cleaned;
  let tags: string[] = [];
  try {
    const j = JSON.parse(cleaned) as { caption?: string; tags?: string[] };
    caption = (j.caption ?? caption).trim();
    tags = (j.tags ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 8);
  } catch {
    // Not valid JSON (usually an unescaped quote inside the caption) – salvage with regexes
    const c = cleaned.match(/"caption"\s*:\s*"([\s\S]*?)"\s*,\s*"tags"/) ?? cleaned.match(/"caption"\s*:\s*"([\s\S]*?)"\s*}?\s*$/);
    if (c) caption = c[1].trim();
    const t = cleaned.match(/"tags"\s*:\s*\[([^\]]*)\]/);
    if (t) tags = t[1].split(",").map((x) => x.replace(/["']/g, "").toLowerCase().trim()).filter(Boolean).slice(0, 8);
    if (!c) caption = cleaned.replace(/^\{?\s*"caption"\s*:\s*"?/, "").replace(/"?\s*,?\s*"tags"[\s\S]*$/, "").trim();
  }
  caption = caption.replace(/^["“”']+|["“”']+$/g, "").trim();
  log.info({ frames, caption, tags, ms: res.ms, reqId: opts.reqId }, "🧩 sticker captioned");
  return { caption, tags, model: res.model };
}

export type StickerCandidate = { sha256: string; caption: string | null; tags: string[] | null };

/**
 * Ask Gemini which library sticker is the funniest / most fitting reply to a message.
 * Returns the chosen sha256 (or undefined when nothing fits).
 */
export async function pickStickerReply(message: { text: string; senderName?: string }, candidates: StickerCandidate[], opts: { reqId?: string } = {}): Promise<{ sha256: string; why: string } | undefined> {
  const usable = candidates.filter((c) => c.caption);
  if (!usable.length) return undefined;
  const list = usable.map((c, i) => `${i + 1}. ${c.caption}${c.tags?.length ? ` [${c.tags.join(", ")}]` : ""}`).join("\n");
  const res = await chatComplete(
    [
      {
        role: "system",
        content: `You pick the best WhatsApp sticker to reply to a chat message. Stickers are used humorously: as a reaction, mockery, sarcasm, empathy or a punchline. Choose the one whose meaning makes the funniest or most fitting reply to the message. Return JSON only: {"pick": <number>, "why": "<max 12 words>"}. If none fits at all, {"pick": 0}.`,
      },
      { role: "user", content: `Message${message.senderName ? ` from ${message.senderName}` : ""}: "${message.text.slice(0, 600)}"\n\nStickers:\n${list}` },
    ],
    { temperature: 0.7, maxTokens: 80, reqId: opts.reqId },
  );
  try {
    const j = JSON.parse(res.text.replace(/^```(?:json)?\s*|```$/g, "").trim()) as { pick?: number; why?: string };
    const n = Number(j.pick ?? 0);
    if (n >= 1 && n <= usable.length) {
      log.info({ pick: n, why: j.why, candidates: usable.length, ms: res.ms, reqId: opts.reqId }, "🎯 sticker reply picked");
      return { sha256: usable[n - 1].sha256, why: j.why ?? "" };
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Re-caption stickers with missing or malformed captions (e.g. a stray code fence). Returns how many were fixed. */
export async function recaptionBrokenStickers(): Promise<{ checked: number; fixed: number; failed: number }> {
  const rows = await db.select().from(schema.stickers).where(dsql`${schema.stickers.caption} is null or ${schema.stickers.caption} like '%\`\`\`%' or ${schema.stickers.caption} like '{"caption"%' or length(${schema.stickers.caption}) < 8`);
  let fixed = 0, failed = 0;
  for (const r of rows) {
    try {
      const bytes = await getStickerBytes(r.sha256);
      if (!bytes) throw new Error("sticker file missing");
      const c = await captionSticker(bytes.buffer, { animated: r.isAnimated });
      await db.update(schema.stickers).set({ caption: c.caption, tags: c.tags, model: c.model ?? null }).where(eq(schema.stickers.sha256, r.sha256));
      await db.update(schema.messages).set({ media: dsql`coalesce(${schema.messages.media}, '{}'::jsonb) || ${JSON.stringify({ description: `(sticker: ${c.caption})` })}::jsonb` as unknown as Record<string, unknown>, text: `(sticker: ${c.caption})` }).where(dsql`${schema.messages.type} = 'sticker' and ${schema.messages.media}->>'sha256' = ${r.sha256}`);
      fixed++;
    } catch (e) {
      failed++;
      log.warn({ err: String(e), sha256: r.sha256.slice(0, 12) }, "recaption failed");
    }
  }
  return { checked: rows.length, fixed, failed };
}
