# whats-bot

API-only Next.js 16 app (App Router, TypeScript) that runs a WhatsApp group-summary bot.

- Baileys (WhatsApp Web) runs INSIDE the Next.js server process (`src/instrumentation.ts` → `src/lib/whatsapp/client.ts`). One replica only.
- Postgres (Neon) via Drizzle: `src/lib/db/schema.ts`. `npm run db:push` after schema changes.
- AI = Gemini only, through OpenRouter (`src/lib/ai/gemini.ts`, `GEMINI_MODEL=google/gemini-*`).
- Bot commands: `src/lib/bot/commands.ts` (parse) → `src/lib/bot/handler.ts` (act) → `src/lib/bot/service.ts` (summaries).
- Assistant mode (@mention): `src/lib/bot/assistant.ts` (Gemini tool calling). Lookup tools live in `src/lib/social/` (twitterapi.io + transcriptapi.com direct, monid.ai primary for web/scrape/TikTok, treg.to routed catalog as fallback); every lookup is recorded in `social_lookups`.
- Every route uses `route()` from `src/lib/api.ts` (reqId, logging, error JSON). Throw `AppError` with a `hint`.
- Logs: pino via `src/lib/logger.ts`; always log `{ err, hint }` on failure.
- Deploy (since 2026-11-08): Dokploy on 72.62.27.167, https://whats-bot.foodio.es. GitHub Actions (.github/workflows/docker.yml) builds ghcr.io/oussamaosman02/whats-bot on push to main; Dokploy app `whats-bot` only pulls + runs it (512 MB cap, auto-deploy off: click Deploy in Dokploy after the Action finishes). NEVER build on that VPS — a `next build` there took every app down. DB = shared-pg (internal host shared-pg-aegavo). Railway service is stopped (old deploy method).

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
