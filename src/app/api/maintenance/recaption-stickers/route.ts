import { route, ok } from "@/lib/api";
import { recaptionBrokenStickers } from "@/lib/ai/vision";
import { reconcileStickerCaptions } from "@/lib/maintenance";

/** POST /api/maintenance/recaption-stickers → re-run Gemini on stickers with missing/malformed captions. */
export const POST = route(async () => {
  const recaption = await recaptionBrokenStickers();
  const reconciled = await reconcileStickerCaptions();
  return ok({ ...recaption, reconciledMessages: reconciled });
});
