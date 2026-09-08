import { route, ok } from "@/lib/api";
import { migrateStickersToR2 } from "@/lib/store";

/** POST /api/maintenance/migrate-stickers → move legacy base64 sticker files into R2. */
export const POST = route(async () => ok(await migrateStickersToR2()));
