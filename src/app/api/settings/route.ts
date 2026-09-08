import { route, ok, z } from "@/lib/api";
import { env } from "@/lib/env";
import { getSetting, setSetting } from "@/lib/store";

const SettingsSchema = z.object({
  autoSummaryHintInGroups: z.boolean().optional(),
  defaultSince: z.string().optional(),
  defaultStyle: z.enum(["brief", "bullets", "detailed", "spoken", "spoken_detailed"]).optional(),
  language: z.string().optional(),
  notes: z.string().optional(),
});
export type BotSettings = z.infer<typeof SettingsSchema>;

export const GET = route(async () => {
  const stored = await getSetting<BotSettings>("bot", {});
  const wa = await getSetting("whatsapp_status", null);
  const e = env();
  return ok({ env: { botName: e.BOT_NAME, language: e.BOT_LANGUAGE, prefix: e.BOT_COMMAND_PREFIX, dmTransport: e.DM_TRANSPORT, model: e.GEMINI_MODEL, summaryMaxMessages: e.SUMMARY_MAX_MESSAGES }, stored, whatsappStatus: wa });
});

export const PUT = route(async ({ body, log }) => {
  const patch = await body(SettingsSchema);
  const current = await getSetting<BotSettings>("bot", {});
  const next = { ...current, ...patch };
  await setSetting("bot", next);
  log.info({ patch }, "settings updated");
  return ok(next);
});
