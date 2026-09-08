import { route, ok } from "@/lib/api";
import { ttsStatus } from "@/lib/ai/tts";

export const GET = route(async () => ok(await ttsStatus()));
