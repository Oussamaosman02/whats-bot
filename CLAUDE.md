# whats-bot

API-only Next.js 16 app (App Router, TypeScript) that runs a WhatsApp group-summary bot.

- Baileys (WhatsApp Web) runs INSIDE the Next.js server process (`src/instrumentation.ts` → `src/lib/whatsapp/client.ts`). One replica only.
- Postgres (Neon) via Drizzle: `src/lib/db/schema.ts`. `npm run db:push` after schema changes.
- AI = Gemini only, through OpenRouter (`src/lib/ai/gemini.ts`, `GEMINI_MODEL=google/gemini-*`).
- Bot commands: `src/lib/bot/commands.ts` (parse) → `src/lib/bot/handler.ts` (act) → `src/lib/bot/service.ts` (summaries).
- Every route uses `route()` from `src/lib/api.ts` (reqId, logging, error JSON). Throw `AppError` with a `hint`.
- Logs: pino via `src/lib/logger.ts`; always log `{ err, hint }` on failure.
- Deploy: Railway (Dockerfile). See README.md.
