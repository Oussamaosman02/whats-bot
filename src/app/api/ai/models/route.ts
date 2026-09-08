import { route, ok } from "@/lib/api";
import { listGeminiModels } from "@/lib/ai/gemini";
import { env } from "@/lib/env";

export const GET = route(async () => ok({ current: env().GEMINI_MODEL, models: await listGeminiModels() }));
