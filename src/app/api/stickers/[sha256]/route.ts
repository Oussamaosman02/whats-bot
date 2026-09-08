import { NextResponse } from "next/server";
import { route, ok } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { getSticker, getStickerBytes } from "@/lib/store";

/** GET /api/stickers/:sha256 → the WebP file (add ?meta=1 for JSON). */
export const GET = route<{ sha256: string }>(async ({ params, req }) => {
  const s = await getSticker(decodeURIComponent(params.sha256));
  if (!s) throw AppError.notFound("Sticker not found.", "List stickers with GET /api/stickers.");
  if (new URL(req.url).searchParams.get("meta")) {
    const { data, ...meta } = s;
    void data;
    return ok(meta);
  }
  const bytes = await getStickerBytes(s.sha256);
  if (!bytes) throw AppError.notFound("Sticker file missing.", "The row exists but neither R2 nor the legacy column holds the file.");
  return new NextResponse(new Uint8Array(bytes.buffer), { headers: { "Content-Type": bytes.mimetype, "Cache-Control": "private, max-age=86400" } });
});
