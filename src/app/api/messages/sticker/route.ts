import { route, ok, z } from "@/lib/api";
import { whatsapp } from "@/lib/whatsapp/client";
import { fetchImage, toStickerWebp } from "@/lib/whatsapp/sticker";
import { getStickerBytes } from "@/lib/store";
import { AppError } from "@/lib/errors";

/**
 * POST /api/messages/sticker {to, sha256 | url | imageBase64, quotedId?, crop?}
 * sha256 → resend a sticker from the library; url/imageBase64 → convert any image to a 512×512 WebP sticker.
 */
export const POST = route(async ({ body }) => {
  const b = await body(z.object({ to: z.string().min(3), sha256: z.string().optional(), url: z.string().url().optional(), imageBase64: z.string().optional(), quotedId: z.string().optional(), crop: z.boolean().default(false) }).refine((v) => v.sha256 || v.url || v.imageBase64, "Provide sha256, url or imageBase64"));
  let webp: Buffer;
  if (b.sha256) {
    const s = await getStickerBytes(b.sha256);
    if (!s) throw AppError.notFound("Sticker not found in the library.", "GET /api/stickers?search=… to find one.");
    webp = s.buffer;
  } else {
    const input = b.url ? await fetchImage(b.url) : Buffer.from(b.imageBase64!.replace(/^data:[^,]+,/, ""), "base64");
    webp = await toStickerWebp(input, { pad: !b.crop });
  }
  const sent = await whatsapp.sendSticker(b.to, webp, { quotedId: b.quotedId });
  return ok({ ...sent, bytes: webp.length });
});
