import { route, ok } from "@/lib/api";
import { recaptionBrokenStickers } from "@/lib/ai/vision";

/** POST /api/maintenance/recaption-stickers → re-run Gemini on stickers with missing/malformed captions. */
export const POST = route(async () => ok(await recaptionBrokenStickers()));
