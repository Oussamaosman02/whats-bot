# whats-bot

API-only Next.js 16 app (App Router, TypeScript) that runs a WhatsApp group-summary bot.

- Baileys (WhatsApp Web) runs INSIDE the Next.js server process (`src/instrumentation.ts` → `src/lib/whatsapp/client.ts`). One replica only.
- Postgres (Neon) via Drizzle: `src/lib/db/schema.ts`. `npm run db:push` after schema changes.
- AI = Gemini only, through OpenRouter (`src/lib/ai/gemini.ts`, `GEMINI_MODEL=google/gemini-*`).
- Bot commands: `src/lib/bot/commands.ts` (parse) → `src/lib/bot/handler.ts` (act) → `src/lib/bot/service.ts` (summaries).
- Assistant mode (@mention): `src/lib/bot/assistant.ts` (Gemini tool calling). Lookup tools live in `src/lib/social/` (twitterapi.io + transcriptapi.com direct, monid.ai primary for web/scrape/TikTok, treg.to routed catalog as fallback); every lookup is recorded in `social_lookups`.
- Every route uses `route()` from `src/lib/api.ts` (reqId, logging, error JSON). Throw `AppError` with a `hint`.
- Logs: pino via `src/lib/logger.ts`; always log `{ err, hint }` on failure.
- Deploy: Railway (Dockerfile). See README.md.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
