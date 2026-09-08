# MEMO — whats-bot: what was built and decided (2026-09-08)

> Public version. Live identifiers (numbers, account ids, domain) are kept in `MEMO.private.md`, which is git-ignored.

A Telegram-style bot for WhatsApp groups whose main job is to **summarise group chats** ("resumen") for members, from a chosen point. API-only Next.js app, deployed on Railway, with all the resources from `whatsapp-group-messaging-project.md` implemented.

## 1. Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Group access | **Baileys** (WhatsApp Web, linked device) | Only path that sees real groups on a coexistence number (Cloud API blocks the Groups API there). |
| Hosting | **Railway**, one replica, Dockerfile | Baileys needs a persistent WebSocket; Vercel functions cannot hold one. Baileys runs *inside* the Next.js server (`src/instrumentation.ts`), no separate worker. |
| Session storage | Postgres table `baileys_auth` | Redeploys reconnect without rescanning the QR. |
| Database | Neon Postgres via Drizzle (`src/lib/db/schema.ts`) | Tables: chats, participants, messages, summaries, read_marks, webhook_events, settings, baileys_auth. `unaccent` extension enabled. |
| AI | **Gemini only**, via OpenRouter | Summaries/transcription: `google/gemini-2.5-flash-lite` (benchmarked, ~5-6× cheaper than 2.5-flash, equal quality). Questions (`/preguntar`): `google/gemini-2.5-flash` (better at consolidating hundreds of hits). |
| Official 1:1 / templates | **Zernio** (Cloud API wrapper) | Inbound webhook + send/template/contact proxies. DM replies via Baileys by default (`DM_TRANSPORT`). |
| Meta Cloud Groups API (Path A) | Implemented under `/api/cloud/*`, **untested** | Needs a Cloud-API-only OBA number; off until `META_*` vars are set. |
| Voice out | **ElevenLabs** TTS → Ogg/Opus voice notes | Gemini writes a dedicated "spoken" text (no lists, natural dates) before it is voiced. Two voice ids in env. |
| Storage | **Cloudflare R2** (S3-compatible), keys under `whats-bot/` | Sticker files and received media live in R2; the DB keeps only keys/metadata. Bucket is shared with another project. |
| UI | None | Landing page + JSON `GET /api` index only. |

## 2. Bot commands (Spanish first, English aliases)

| Command | Behaviour |
|---|---|
| `/resumen` | since your last summary (first time: last 24 h) |
| `/resumen mi mensaje` | since your last message in the group |
| `/resumen hoy` · `ayer` · `lunes` · `08/09` · `2026-09-08` | from a day |
| `/resumen ayer 15:00` · `08/09 10:30` · `2026-09-08 10:30` · `10:30` | from a day and hour (Madrid time) |
| `/resumen 3h` · `2d` · `50` · `todo` | last hours/days, last N messages, everything (cap `SUMMARY_MAX_MESSAGES`=1500) |
| `… privado` / `… breve` / `… detallado` | deliver by DM / length |
| reply (quote) a message with `/resumen` | since that message |
| `/preguntar <question>` | answer from the **whole** stored history (keyword search + recent + archive summaries) |
| `/marcar` | "start counting from here" without summarising |
| `/resumen … audio` · `/preguntar audio <q>` | reply as a **voice note** written for the ear (spoken style) |
| reply to a voice note with `/transcribir` | read it as text (voice notes are also transcribed automatically) |
| `/sticker` · `/sticker <word>` · reply with `/sticker` | random library sticker · best match by caption/tags · replying to someone else's message: Gemini picks the funniest fitting sticker (own message: random) · replying to a photo: converts it |
| `/voz <texto>` (admins) | the bot says it as a voice note |
| `/grupos` (DM) · `/resumen <nº or name> [period]` (DM) | list shared groups / summarise one privately |
| `/ayuda` · `/ping` · `/id` | help / liveness / ids |
| `/importar <group>` **(hidden, DM only, admins only)** | import a WhatsApp chat export (zip/txt) as older context |

Rules: unknown period arguments are rejected with usage help (no guessing); 15 s cooldown per user; **3 `/resumen` per user per day** (`DAILY_SUMMARY_LIMIT`, admins exempt); all times shown in `BOT_TIMEZONE` (Europe/Madrid). While a command runs the chat shows *escribiendo…* (or *grabando audio…* for voice replies).

## 3. Features delivered (chronological)

1. **Scaffold & core**: Next.js 16 (App Router, TS), env validation with readable errors, pino logging with `reqId`, uniform error JSON `{code, message, hint, reqId}`.
2. **WhatsApp client**: connect/QR/status/logout, auto-reconnect with backoff and per-reason hints, groups sync, send text/media, reactions, media download, LID→phone resolution (Baileys v7).
3. **Bot**: command parser (prefix or @mention, `/cmd@bot` style), summary service with read marks per user, Gemini summaries, Q&A, draft replies.
4. **Zernio**: inbound webhook (HMAC verified, idempotent by event id), DM dedupe against the Baileys copy, accounts/conversations/messages/templates/contacts proxies, free-text sends reuse the existing conversation.
5. **Auth**: Bearer `API_KEY` for clients; HTTP Basic (`DASHBOARD_PASSWORD`) for browsers on every page including the QR; only webhooks and a minimal `/api/health` are public.
6. **Railway deploy**: Dockerfile (standalone), health check, variables set via CLI, public domain.
7. **Bug fixed from a live test**: chat upsert failed on a raw-SQL Date param (would have broken every incoming message); logger now prints the `cause` chain.
8. **Voice notes**: transcribed with Gemini (audio input, ogg/opus) on arrival; transcript becomes the message text (🎤 in summaries); `/transcribir`; `POST /api/messages/:id/transcribe`.
9. **Madrid time** everywhere (prompts, headers, `/ping`, `/grupos`).
10. **Model benchmark** (2.5 Flash vs 2.5 Flash-Lite, same chat + synthesized Spanish voice note): Lite 5-6× cheaper, equal quality → Lite is the default.
11. **Retention** (15 days) with **archive-before-delete**: each complete old day becomes an archive summary per group (kept forever, fed back as context); if Gemini fails nothing is deleted. Imported history exempt. Hourly job + `POST /api/maintenance/retention` (`dryRun`).
12. **Alerts** to `ALERT_PHONE` via Zernio when the device logs out, fails to reconnect (4 attempts) or recovers. Template `bot_alert` (UTILITY, es, id in Zernio) **pending Meta review**; until approved, free text is used inside the 24 h window (test alert delivered). `POST /api/alerts/test`.
13. **Chat import**: `/importar` by DM (document + caption, or reply to the file) and `POST /api/groups/:jid/import` (multipart/raw). Streams only the `.txt` out of the zip (media never loaded), iOS/Android formats, auto day/month detection, idempotent, skips messages after the bot joined unless `forzar`. Recommended export: **"Sin archivos"**. The test group's full export (~14 k messages) is imported.
14. **Whole-history questions**: `/preguntar` = keyword hits (accent-insensitive) ± 2 neighbours + last 200 messages + matching archive summaries, char-budgeted; consolidation rules, duplicate-line collapse, bullet cap (14), truncation trimming.
15. **Prompt-injection hardening**: transcripts wrapped as data, explicit guard in every prompt, strict period parsing (`/resumen -1` is refused).
16. **Voice notes out (ElevenLabs)**: `audio` flag on `/resumen` and `/preguntar`, admin `/voz`, `POST /api/messages/voice`, `GET /api/tts/status`. Ogg/Opus straight from ElevenLabs (no conversion). A **spoken** Gemini style (`spoken` / `spoken_detailed`) writes conversational text before TTS so it does not sound like read-out bullets. `TTS_MAX_CHARS` caps cost.
17. **Presence**: "typing…" / "recording audio…" indicators refreshed every 6 s while a command runs.
18. **Sticker library**: every received sticker is stored (file in R2, row in `stickers` with sha256, sender, usage count) and captioned by Gemini with the humour/intent it conveys plus search tags; animated stickers are captioned from a strip of up to 6 frames. Photos/videos get a one-line description (WhatsApp accessibility label first, else Gemini on the thumbnail), cached by hash in `media_descriptions`.
19. **`/sticker` behaviours**: random, search by word, AI-picked humorous reply to someone else's message, random for own messages, photo→sticker conversion, resend a sticker. API: `GET /api/stickers?search=`, `GET /api/stickers/:sha256`, `POST /api/messages/sticker {to, sha256|url|imageBase64}`.
20. **Zernio⇄Baileys dedupe by `wamid`**: Meta's `wamid` base64-encodes the WhatsApp Web message id, so Cloud-API copies of DMs are normalised to the same id and never duplicate the Baileys row. When Zernio's copy arrives first, the Baileys copy *enriches* it and still runs media processing (this race had silently skipped a batch of stickers).
21. **Sticker recovery tools**: `POST /api/maintenance/backfill-stickers` (re-downloads stickers seen only via Zernio, using its media proxy + API key; recovered 68 in one go), `POST /api/maintenance/recaption-stickers` (fixes missing/malformed captions), `POST /api/maintenance/migrate-stickers` (base64 → R2).
22. **Cloudflare R2 storage**: sticker files (`whats-bot/stickers/<sha>.webp`) and received media ≤ `MEDIA_ARCHIVE_MAX_MB` (`whats-bot/media/<chat>/<id>`) go to R2; media is downloaded once and shared with transcription/captioning; `/transcribir`, `/sticker` on old photos and `GET /api/messages/:id/media` fall back to R2 after restarts; retention deletes the day's objects with its messages. Stickers table shrank from 11 MB to 80 kB after migration (whole DB ≈ 15 MB).

## 4. Live state (as of 2026-09-08)

- URL: https://<your-railway-domain> — Railway project `whats-bot`, service `whats-bot`.
- Linked number: <business number>, status **open**; one test group.
- Zernio: WhatsApp account `<zernio account id>`; webhook "WhatsBot" registered by hand (profile-scoped key cannot manage webhooks); secret synced to Railway.
- Secrets live in Railway variables (`railway variables`): `API_KEY`, `DASHBOARD_PASSWORD`, `ZERNIO_WEBHOOK_SECRET`, keys. The owner's number is `ALERT_PHONE` / `ADMIN_PHONES` (env only, never in code).
- ElevenLabs: pay-as-you-go plan, both voice ids in env (`ELEVENLABS_DEFAULT_VOICE_ID`, `ELEVENLABS_SECONDARY_VOICE_ID`); ~13 k characters were left until 14 Sep at last check.
- R2: a shared bucket with a public host; 75 sticker objects (~8 MB) after migration.
- Sticker library: 75 captioned stickers (20 animated), all recovered/migrated; 0 broken captions.
- Verified in production: health, auth (Bearer + Basic), signed Zernio webhook, groups sync, live message storage, summaries, Q&A over 14 k messages, transcription path, import via API, alert delivery (free text), retention dry run, voice notes to the owner's number (both voices), sticker send (base64 and library), wamid dedupe replay, R2 put/get, sticker migration.

## 5. Known gaps / next steps

- `bot_alert` template awaits Meta approval; alerts fall back to free text until then.
- Meta Cloud Groups API routes are untested (need an OBA Cloud-only number).
- Media received before R2 archiving was enabled (or above `MEDIA_ARCHIVE_MAX_MB`) is only available while it is in the in-memory cache; everything since is in R2.
- The R2 bucket has a public endpoint configured, so objects are reachable by exact key (unguessable hashes/ids). Leave `CLOUDFLARE_S3_API_PUBLIC_ENDPOINT` empty to switch to presigned URLs.
- Some sticker captions quote crude text printed on the sticker itself; `/sticker` replies can surface them in the group.
- Not in git yet: `git init` + GitHub + Railway auto-deploy recommended.
- Suggested later: group allowlist, scheduled daily digests, unit tests for the parsers, migrate `railway.json` to `.railway/railway.ts` before 2026-12-01.
- Baileys is unofficial (ToS/ban risk): keep volume human-like, reply only to inbound, never run two instances with the same session.

## 6. Where things are

```
src/lib/env.ts             validated env + feature flags        src/lib/whatsapp/*      Baileys client, auth state, normaliser
src/lib/logger.ts          pino, pretty/json, hints             src/lib/bot/*           commands, handler, service, since-parser
src/lib/api.ts             route() wrapper, auth, errors        src/lib/ai/*            gemini (OpenRouter), summarize, transcribe
src/lib/store.ts           persistence helpers                  src/lib/zernio/client.ts, src/lib/meta/cloud.ts
src/lib/maintenance.ts     retention + archive                  src/lib/alerts.ts, src/lib/import/* (chat export + sticker backfill)
src/lib/ai/tts.ts          ElevenLabs voice notes               src/lib/ai/vision.ts    sticker/photo captions, sticker picker
src/lib/storage/r2.ts      Cloudflare R2 client                 src/lib/whatsapp/sticker.ts  image → WebP sticker
src/app/api/**             all endpoints (GET /api lists them)  README.md               setup, commands, API, deploy, logs
```
