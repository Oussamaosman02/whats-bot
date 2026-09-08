# whats-bot

Telegram-style bot for **WhatsApp groups** that summarises what you missed. API-only Next.js app, deployed on Railway.

* `/resumen` in a group → Gemini summary of the chat since your last summary, your last message, a day, or a date + time.
* Works inside groups **and** by DM (`/grupos`, `/resumen <group> ayer 15:00`).
* Full REST API for groups, messages, summaries, Zernio (official 1:1 / templates) and the Meta Cloud Groups API.
* Every log line explains *why* something failed and *what to check*.

## How it works

```
WhatsApp phone (Business app, primary device)
   └─ linked device ──► Baileys (inside this Next.js process) ──► Postgres (Neon)
                                                                 ▲
Zernio (Cloud API, official 1:1) ──► POST /api/webhooks/zernio ──┘   (DMs deduped by id / text+time)
Gemini (via OpenRouter) ◄── /resumen, /preguntar, POST /api/groups/:jid/summarize
```

* **Groups** are read and written through Baileys (the only path that sees real groups on a coexistence number).
* **DMs** are stored from both Baileys and Zernio; replies go via `DM_TRANSPORT` (`baileys` by default, `zernio` to use the official API).
* **Meta Cloud Groups API** (Path A of the brief) is available under `/api/cloud/*` when `META_*` vars are set. Optional.

## Quick start (local)

```bash
cp .env.example .env         # fill DATABASE_URL, OPENROUTER_API_KEY, ZERNIO_API_KEY
npm install
npm run db:push              # creates the tables in Neon
npm run dev                  # http://localhost:3000
open http://localhost:3000/api/whatsapp/qr   # scan with WhatsApp › Linked devices
```

Then add the number to a group and type `/ayuda`.

## Bot commands (in a group)

| Command | Meaning |
|---|---|
| `/resumen` | since your last summary (first time: last 24 h) |
| `/resumen mi mensaje` | since **your last message** in the group |
| `/resumen hoy` · `ayer` · `lunes` · `08/09` · `2026-09-08` | since a **day** |
| `/resumen ayer 15:00` · `08/09 10:30` · `2026-09-08 10:30` · `10:30` | since a **day and hour** (`BOT_TIMEZONE`) |
| `/resumen 3h` · `2d` · `50` · `todo` | last hours/days, last N messages, everything |
| `/resumen … privado` | deliver by DM instead of in the group |
| `/resumen … breve` / `detallado` | length |
| reply (quote) a message with `/resumen` | since that message |
| `/preguntar <question>` | answer from the chat history |
| `/marcar` | "start counting from here" without summarising |
| `/resumen … audio` · `/preguntar audio <q>` | receive the answer as a **voice note**: Gemini writes it as a spoken message (no lists, natural dates), ElevenLabs voices it |
| `/sticker` · `/sticker <word>` · reply with `/sticker` | random library sticker · best match by caption/tags · replying to someone else's message: Gemini picks the funniest fitting sticker (own message: random) · replying to a photo: converts it |
| reply to a voice note with `/transcribir` | read it as text (voice notes are also transcribed automatically for summaries) |
| `/ayuda` · `/ping` · `/id` | help / liveness / ids |

By DM: `/grupos` lists the groups you share with the bot; `/resumen 2 ayer 15:00` or `/resumen Familia hoy` summarises one of them privately.
Mentioning the bot also works: `@bot resumen hoy`.

## Importing chat history (hidden admin command)

The bot only knows messages received after it joined. To give it earlier context, export the group from WhatsApp (group info → *Exportar chat* → **Sin archivos**, which keeps the zip to a few MB) and either:

* **By DM** (only from `ADMIN_PHONES`, never in a group, not listed in `/ayuda`): send the zip/txt to the bot as a *document* with the caption `/importar <group nº or name>` (or reply to the file with it). Files above `IMPORT_MAX_MB` (200) are refused with a hint. Add `forzar` to also import messages that overlap with what the bot already saw.
* **By API** for big files: `curl -X POST "$APP/api/groups/<jid>/import" -H "Authorization: Bearer $API_KEY" -F file=@export.zip`

Only the `.txt` inside the zip is read; media entries are skipped without loading them. Dates are parsed in `BOT_TIMEZONE` (format auto-detected, override with `IMPORT_DATE_FORMAT`). Imported messages are exempt from retention unless `RETENTION_INCLUDE_IMPORTS=true`.

## API

`GET /api` returns the full index. Auth: `Authorization: Bearer <API_KEY>` (or `?key=<API_KEY>`) for API clients; browsers get an HTTP Basic prompt on every page and endpoint (any username, password = `DASHBOARD_PASSWORD`, falling back to `API_KEY`). Only the webhooks and a minimal `/api/health` are public. Auth is disabled while both variables are empty.

Responses are `{ ok: true, data }` or `{ ok: false, error: { code, message, hint, data?, reqId } }`. The `reqId` is also in the `x-request-id` header and in every log line of that request.

Main resources:

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` (DB, WhatsApp, Gemini, Zernio, Meta – each with `hint`) |
| WhatsApp link | `GET /api/whatsapp/qr` (HTML/PNG/JSON) · `GET /status` · `POST /connect` · `POST /disconnect` · `POST /logout` · `GET /check?phone=` |
| Groups | `GET /api/groups?live=1` · `POST /api/groups` · `GET/PATCH/DELETE /api/groups/:jid` · `…/participants` (GET/POST/DELETE) · `…/invite` (GET/POST revoke) · `POST /api/groups/join` · `GET /api/groups/invite-info?code=` |
| Group content | `GET /api/groups/:jid/messages` · `POST /api/groups/:jid/summarize` · `POST /api/groups/:jid/ask` · `POST /api/groups/:jid/import` (WhatsApp export zip/txt) |
| Messages | `POST /api/messages` (router: group→Baileys, DM→`DM_TRANSPORT`, `via=cloud` forces Meta) · `GET /api/messages?chat=` · `GET /api/messages/:id/media` · `POST /api/messages/:id/react` · `POST /api/messages/:id/transcribe` |
| AI | `GET /api/ai/models` (Gemini ids on OpenRouter) · `POST /api/ai/summarize` · `POST /api/ai/ask` · `POST /api/ai/reply` |
| Summaries | `GET /api/summaries?chat=` · `GET /api/summaries/:id` |
| Zernio | `POST /api/webhooks/zernio` · `GET /api/zernio/accounts` · `GET /api/zernio/conversations` · `GET/POST /api/zernio/conversations/:id/messages` · `POST /api/zernio/send` · `GET /api/zernio/templates` · `GET/POST/DELETE /api/zernio/webhooks` · `GET /api/zernio/contacts` |
| Meta Cloud (Path A) | `GET/POST /api/cloud/groups` · `GET/PATCH/DELETE /api/cloud/groups/:id` · `…/participants` · `…/invite` · `POST /api/cloud/messages` · `GET/POST /api/cloud/webhook` |
| Settings | `GET/PUT /api/settings` |
| Maintenance | `GET/POST /api/maintenance/retention` (15-day retention, hourly job) · `POST /api/alerts/test` |

Example – summarise a group since yesterday 15:00 and post it to the group:

```bash
curl -X POST "$APP/api/groups/1203630000%40g.us/summarize" \
  -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"since":"ayer 15:00","style":"bullets","deliver":"group"}'
```

`since` accepts the same expressions as the chat command (`last`, `mymessage` + `requester`, `hoy`, `ayer 15:00`, `lunes`, `08/09 10:30`, `2026-09-08 10:30`, `3h`, `2d`, `50`, `todo`).

## Logs

Set `LOG_FORMAT=pretty` (default outside production) for lines like:

```
07:01:12.442 INFO  [api] → POST /api/groups/…/summarize reqId=k3f9a1
07:01:12.610 INFO  [bot:service] summary requested chat=… spec=time label="últimas 5h" messages=6
07:01:20.401 INFO  [ai] ← openrouter ok model=google/gemini-2.5-flash-lite ms=7790 promptTokens=612
07:01:20.455 ERROR [wa] connection closed code=440 reason=connectionReplaced
    ↳ Error: Stream Errored (conflict) …
    💡 Another process connected with the same credentials. Make sure only ONE instance runs (Railway replicas = 1).
```

Every subsystem is tagged (`[api]`, `[wa]`, `[wa:auth]`, `[bot]`, `[ai]`, `[zernio]`, `[meta]`, `[db]`, `[store]`) and every failure carries `err` + a `💡 hint`. `LOG_LEVEL=trace` also turns on Baileys' internal logs. `LOG_FORMAT=json` for log drains.

## Deploy on Railway

The Dockerfile builds a standalone Next.js server that also hosts the Baileys socket, so it must run as **one replica** (`railway.json` enforces it).

```bash
railway init                        # or link an existing project
railway variables set DATABASE_URL=… OPENROUTER_API_KEY=… ZERNIO_API_KEY=… API_KEY=$(openssl rand -hex 24)
railway variables set APP_URL=https://<your-domain> BOT_NAME=ResumenBot BOT_TIMEZONE=Europe/Madrid LOG_FORMAT=pretty LOG_LEVEL=debug
railway up
open https://<your-domain>/api/whatsapp/qr    # link the phone once; creds live in Postgres, redeploys reconnect
```

After the first deploy register the Zernio webhook: `POST /api/zernio/webhooks` (uses `APP_URL` + `ZERNIO_WEBHOOK_SECRET`). If your Zernio key is **profile-scoped** this returns 403; then add the webhook by hand in the Zernio dashboard (Settings › Webhooks): URL `https://<your-domain>/api/webhooks/zernio`, events `message.received`, `message.sent`, `conversation.started`, secret = `ZERNIO_WEBHOOK_SECRET`.

## Caveats

* Baileys is unofficial (see `whatsapp-group-messaging-project.md` §7): ban risk, keep volume human-like, only reply to inbound.
* Never run two instances with the same session (`connectionReplaced` loops). Stop local `npm run dev` before relying on the Railway one.
* **Retention with archive:** every complete day older than `RETENTION_DAYS` (15) is first condensed into an *archive summary* per group (kept forever, fed back as older context to `/resumen todo` and `/preguntar`), then its messages are deleted. If the summary fails, nothing is deleted that hour. On-demand summaries and webhook events follow the same 15-day window. `RETENTION_ARCHIVE=false` disables the archive step.
* **Quota:** `DAILY_SUMMARY_LIMIT` (3) `/resumen` per user per day; `ADMIN_PHONES` are exempt.
* **Prompt injection:** transcripts are wrapped as data and the prompts instruct Gemini to ignore instructions found inside chats; unknown period arguments (`/resumen -1`) are rejected with usage help instead of being guessed.
* **Alerts:** when the linked device logs out, fails to reconnect, or recovers, a Zernio template message (`ALERT_TEMPLATE_NAME`, UTILITY, 4 params) goes to `ALERT_PHONE`; free text is the fallback inside the 24h window.
* **Presence:** while a command runs the bot shows *escribiendo…* in the chat, or *grabando audio…* when the reply will be a voice note.
* **Voice notes out:** with `ELEVENLABS_API_KEY` + `ELEVENLABS_DEFAULT_VOICE_ID`, `audio` on `/resumen`/`/preguntar`, the admin-only `/voz <texto>`, and `POST /api/messages/voice` send Ogg/Opus voice notes (billed per character; `TTS_MAX_CHARS`).
* **Storage (Cloudflare R2):** sticker files and received media (voice notes, photos, videos, documents ≤ `MEDIA_ARCHIVE_MAX_MB`) live in R2 under `whats-bot/…`; the DB keeps only keys and metadata. Media is deleted from R2 when retention deletes the messages. Without R2 config, stickers fall back to base64 in the DB and media is memory-only.
* **Sticker library:** every sticker received is stored (`stickers` table: WebP file, sha256, sender, usage count) with a Gemini caption that reads the joke/intent (animated stickers are captioned from a strip of frames). Browse with `GET /api/stickers?search=`, fetch `GET /api/stickers/:sha256`, resend with `POST /api/messages/sticker {to, sha256}`.
* **Photos and videos:** get a one-line description (WhatsApp's own accessibility label when present, otherwise Gemini vision on the sticker file or the inline thumbnail; cached per file hash), so summaries can say "Ana mandó un sticker de un gato llorando de risa". `DESCRIBE_MEDIA=false` disables it.
* **Voice notes** are transcribed with Gemini (audio input via OpenRouter) as they arrive (`TRANSCRIBE_AUDIO`, `TRANSCRIBE_MAX_SECONDS`) and summarised like text (`🎤`).
* Media download / reactions / on-demand transcription only work for messages seen since the last restart (in-memory cache of 3000).
* All times shown to users and to Gemini are in `BOT_TIMEZONE` (Europe/Madrid by default).
* Group participant phone numbers may be hidden behind LIDs on some groups; the bot resolves them via Baileys' LID map when possible.

## License

MIT — free for anyone to use, modify and distribute. See `LICENSE`.
