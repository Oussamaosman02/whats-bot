/**
 * Image → WhatsApp sticker (WebP, 512×512, transparent padding). Animated WebP/GIF input keeps the first frame.
 */
import sharp from "sharp";
import { AppError } from "../errors";
import { getLogger, errInfo } from "../logger";

const log = getLogger("sticker");

export async function toStickerWebp(input: Buffer, opts: { pad?: boolean } = {}): Promise<Buffer> {
  try {
    const out = await sharp(input, { animated: false })
      .resize(512, 512, { fit: opts.pad === false ? "cover" : "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
    log.debug({ inBytes: input.length, outBytes: out.length }, "image converted to sticker webp");
    return out;
  } catch (e) {
    throw new AppError(400, "sticker_convert_failed", `Could not convert image to a sticker: ${errInfo(e).message}`, { hint: "Send a PNG/JPG/WebP/GIF image (≤ ~5 MB).", cause: e });
  }
}

/** Fetch an image URL for sticker conversion (5 MB cap). */
export async function fetchImage(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "whats-bot/1.0 (+https://github.com/whats-bot)", Accept: "image/*,*/*;q=0.8" } });
  if (!res.ok) throw new AppError(400, "image_fetch_failed", `Image URL responded ${res.status}`, { hint: "The URL must be publicly reachable and return an image." });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 5_000_000) throw AppError.badRequest("Image is larger than 5 MB.");
  return buf;
}
