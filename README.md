# whats-bot 🤖📝

**A Telegram-style bot for WhatsApp groups that summarises what you missed.**

Add the bot's number to a group, type `/resumen`, and get a summary of everything since you last looked: from your last message, from a day, or from a date and hour. It also answers questions about the chat history, transcribes voice notes, learns the group's stickers and replies with the funniest one, and can talk back in voice notes.

Built as an API-only Next.js app that runs on one small server (Railway), uses Gemini for all AI, Postgres for data and Cloudflare R2 for files.

> ⚠️ It connects to WhatsApp as a *linked device* through [Baileys](https://github.com/WhiskeySockets/Baileys), which is not an official WhatsApp API. Meta may ban numbers that use it. Use a number you can afford to lose, keep volume human-like and only reply to people who talk to the bot.

---

## What it does

| Feature | How |
|---|---|
| **Assistant mode** | Mention the bot in a group (`@ResumenBot haz un audio diciendo feliz cumple Luis`, `@ResumenBot resume desde ayer en audio`, `@ResumenBot manda un sticker de risa`, `@ResumenBot ¿qué opinas de…?`) and Gemini decides what to do with tools: summarise, answer from history, create a voice note (secondary voice), send a sticker, transcribe, or just chat, and now create/list/cancel reminders (`@ResumenBot recuérdame mañana comprar pan`) and list pending items. Reply to a **voice note** with a bare mention and the bot acts on what was said in it (your own audio "recuérdame mañana comprar pan" + `@ResumenBot` → the reminder gets created). Groups only; replying to the bot does not trigger it. |
| **Superpowers (lookups)** | In assistant mode the bot can also look outside the chat: `@ResumenBot qué dice midudev en Twitter`, `@ResumenBot busca un vídeo sobre Next 16 y resúmelo`, `@ResumenBot explícale a Pau quién es midudev`, `@ResumenBot qué dice este enlace` (reply to a link). Tools: X/Twitter search + user timelines (twitterapi.io, treg fallback), YouTube search + transcripts (transcriptapi.com, treg fallback), web search + read any URL (monid.ai → context.dev, treg Google SERP fallback), TikTok search (TikHub via monid/treg). Every lookup is logged with provider, cost and results in `social_lookups` (`GET /api/social`), cached for `SOCIAL_CACHE_MINUTES`, and capped at `SOCIAL_DAILY_LIMIT` per user per day. |
| **Scheduled bulletins ("breaking news")** | `/boletin 06:00 14:00 22:00 audio` (group admins) → at those hours the bot posts a radio-style voice note with everything said since the previous one; `/boletin cada 8h desde 06:00`, `… texto` for a written digest. Nothing is posted when fewer than 5 new messages (`DIGEST_MIN_MESSAGES`). State lives in Postgres (`digests`), an in-process scheduler claims each slot atomically, so restarts never double-post; slots missed while the server was down are skipped, not posted late. |
| **Reminders & scheduled messages** | `/recordar mañana 9:00 llevar el pastel` (also `el lunes 20:00`, `en 2h`, `cada día a las 9:00`, `cada lunes 20:00`; reply to a message with `/recordar mañana` to be reminded of it) → the bot mentions you in the group at that time, or DMs you if you asked by DM. Admins: `/programar el lunes 9:00 Recordad el DNI` posts as the bot. `/programados` · `/cancelar <nº>`. Jobs live in Postgres (`jobs`), claimed atomically, retried 3×, marked *missed* if the server was down for longer than `JOBS_MAX_LATE_MINUTES`. |
| **Action items** | `/pendientes` → open tasks, promises ("lo mando el viernes"), unanswered questions and debts of the last 7 days (`/pendientes 2d`); `/pendientes míos` → only what concerns you. Same daily quota as `/resumen`. |
| **Private morning brief** | By DM: `/boletin 8:00 privado` → every morning one message (or `… audio` voice note) with a short digest of *every* group you share with the bot. |
| **Welcome brief** | `/bienvenida on` (admins) → whoever joins the group gets, by DM and never in the group, a summary of the last 3 days (`/bienvenida 7` for a week) plus the open items. |
| **Catch-up summaries** | `/resumen` in the group → Gemini summary since your last summary, your last message, a day, or a date + time. Delivered in the group or by DM. |
| **Ask the chat** | `/preguntar ¿qué se decidió de la cena?` → searches the whole stored history (keywords + recent context + archived summaries) and answers. |
| **Voice notes in** | Every voice note is transcribed (Gemini audio) and becomes part of summaries. Reply to one with `/transcribir` to read it, or `/transcribir breve` for a TL;DR of a long one (the bot offers it itself past 60 s). |
| **Voice notes out** | `/resumen audio`, `/preguntar audio …` → the answer is *written for the ear* by Gemini and voiced by ElevenLabs as a native WhatsApp voice note. |
| **Stickers** | Every sticker the bot sees is stored and captioned by Gemini (humour/intent aware, animated ones too). `/sticker` sends a random one, `/sticker alonso` searches, and replying to someone with `/sticker` sends the funniest fitting sticker. Reply to a photo with `/sticker` to convert it. |
| **Photos & videos** | Get a one-line description so summaries can say "Ana mandó una foto de la tarta". |
| **History import** | Send a WhatsApp chat export (zip/txt) to the bot by DM with `/importar <grupo>` so it knows what happened before it joined. Only the text is read; media is skipped. |
| **Memory that forgets** | Messages are kept 15 days. Before a day is deleted, an *archive summary* of it is written and kept forever, so old context survives while personal data doesn't. |
| **Operator alerts** | If the linked device logs out or stops reconnecting, you get a WhatsApp message (via the official Cloud API through Zernio) with the link to relink. |
| **Official 1:1 channel** | Optional: Zernio (Meta Cloud API wrapper) for DMs, templates and an inbound webhook; the Meta Groups API is wired too for numbers that qualify. |

Everything is exposed as a REST API as well (`GET /api` lists every endpoint), protected by an API key for scripts and a password prompt for browsers.

## Commands

| In a group | |
|---|---|
| `/resumen` | since your last summary (first time: last 24 h) |
| `/resumen mi mensaje` | since your last message |
| `/resumen hoy` · `ayer` · `lunes` · `08/09` | since a day |
| `/resumen ayer 15:00` · `08/09 10:30` · `10:30` | since a day and hour |
| `/resumen 3h` · `2d` · `50` · `todo` | last hours/days, last N messages, everything |
| `… privado` · `… audio` · `… breve` / `detallado` | by DM · as voice note · length |
| reply to a message with `/resumen` | since that message |
| `/preguntar <question>` · `/preguntar audio <question>` | answer from the chat history (text / voice) |
| `/marcar` | "start counting from here" without summarising |
| `/sticker` · `/sticker <word>` · reply with `/sticker` | random · search · best humorous reply (own message → random) · photo → sticker |
| reply to a voice note with `/transcribir` · `/transcribir breve` | read it · just the gist (long voice notes) |
| `/boletin` · `/boletin 06:00 14:00 22:00 audio` · `/boletin cada 8h desde 06:00` · `… texto` · `… breve`/`detallado` | see the scheduled bulletin · (admins) schedule it as voice notes · every N hours · as text · length |
| `/boletin off` · `on` · `ahora` · `quitar` | pause · resume · post one now (preview) · remove |
| `/recordar mañana 9:00 <texto>` · `el lunes 20:00` · `en 2h` · `cada día a las 9:00` · `cada lunes 20:00` · reply + `/recordar mañana` | reminder that mentions you at that time (recurring ones supported) |
| `/programar <cuándo> <texto>` (admins) | the bot posts that text at that time |
| `/programados` · `/cancelar <nº>` | pending reminders/messages of the group · cancel one (creator or admin) |
| `/pendientes` · `/pendientes 2d` · `/pendientes míos` | open tasks, promises, questions, debts · period · only yours |
| `/bienvenida` · `/bienvenida on` / `off` / `7` (admins) | welcome brief for newcomers by DM: status · enable · disable · days |
| `/config` | the group's bot settings (bulletin, welcome, pending jobs, quotas) |
| `/ayuda` · `/ping` · `/id` | help · liveness · ids |

| By DM | |
|---|---|
| `/grupos` | groups you share with the bot |
| `/resumen 2 ayer 15:00` · `/resumen Familia hoy` · `/resumen hoy` | summarise one of them privately (if you share only one group with the bot it is implied) |
| `/boletin Familia 06:00 14:00 22:00 audio` · `/boletin 2 off` · `/boletin ahora` | configure a group's bulletin from your DM (group admins / `ADMIN_PHONES`; the group is implied when you share only one) |
| `/boletin 8:00 privado` · `… audio` · `/boletin privado ahora` | your private morning brief of every shared group |
| `/recordar en 2h llamar al médico` | reminder delivered to you by DM |
| `/programar Familia mañana 9:00 <texto>` · `/pendientes Familia míos` · `/bienvenida Familia on` · `/config` | the same group commands, from your DM |
| `/importar <grupo>` (admins, hidden) | attach a chat export to add history |
| `/voz <texto>` (admins, hidden) | the bot says it as a voice note |

Limits: 15 s cooldown, 3 `/resumen` per user per day, 20 assistant requests, 3 assistant audios and 15 external lookups per user per day (all exempt for `ADMIN_PHONES`), unknown periods are refused with examples instead of guessed. Spanish by default (`BOT_LANGUAGE`), times in `BOT_TIMEZONE`.

## How it works

```
WhatsApp phone (WhatsApp Business app = primary device)
   └─ linked device ──► Baileys, running inside the Next.js server ──► Postgres (Neon)
                              │                                            ▲
                              ├─ voice notes ─► Gemini (audio) ─► transcript│
                              ├─ stickers/photos ─► Gemini (vision) ─► captions, sticker library
                              └─ files ─► Cloudflare R2 (stickers, media)   │
Zernio (official Cloud API) ─► POST /api/webhooks/zernio ─────────────────┘  (DM copies deduped by id)
Gemini (via OpenRouter) ◄── /resumen, /preguntar, archive summaries
ElevenLabs ◄── /resumen audio, /voz
```

* **Why a linked device?** On a number that uses the WhatsApp Business app (coexistence), Meta's Cloud API cannot see groups at all. A linked device sees everything the phone sees.
* **Why one server?** The WhatsApp connection is a persistent WebSocket, so the app runs as a single long-lived process (Railway, Fly, a VPS). Not serverless.
* **Session survives redeploys**: credentials are stored in Postgres, so you scan the QR once.
* **Models**: everything is Gemini through OpenRouter. Summaries and captions use `gemini-2.5-flash-lite` (cheap, good); questions use `gemini-2.5-flash` (better at consolidating hundreds of matches). One summary of 1,500 messages costs well under a cent.

## Quick start

Requirements: Node 20+, a Postgres database (Neon works great), an [OpenRouter](https://openrouter.ai) key, a WhatsApp number on a phone you control.

```bash
git clone https://github.com/Oussamaosman02/whats-bot && cd whats-bot
npm install
cp .env.example .env            # fill DATABASE_URL, OPENROUTER_API_KEY, API_KEY, DASHBOARD_PASSWORD
npm run db:push                 # creates the tables
npm run dev                     # http://localhost:3000
open http://localhost:3000/api/whatsapp/qr    # enter the password, scan with WhatsApp › Linked devices
```

Add the number to a group and type `/ayuda`.

Optional services, each enabled by its env vars (see `.env.example`): ElevenLabs (voice out), Cloudflare R2 (file storage; without it stickers are stored in the DB and media only in memory), Zernio (official DMs, templates, alerts), Meta Cloud API Groups (`META_*`, only for Cloud-API-only OBA numbers).

## Deploy on Railway

```bash
railway init && railway add --service whats-bot
railway variables --set DATABASE_URL=… --set OPENROUTER_API_KEY=… --set API_KEY=$(openssl rand -hex 24) --set DASHBOARD_PASSWORD=…
railway domain
railway variables --set APP_URL=https://<your-domain>
railway up
```

The Dockerfile builds a standalone Next.js server. Keep **one replica** (`railway.json` enforces it): two instances with the same WhatsApp session kick each other out. Health check: `/api/health`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres | required |
| `OPENROUTER_API_KEY` | Gemini access | required for AI |
| `GEMINI_MODEL` / `ASK_MODEL` / `TRANSCRIBE_MODEL` | Gemini ids for summaries / questions / audio | `google/gemini-2.5-flash-lite` / `google/gemini-2.5-flash` / = `GEMINI_MODEL` |
| `API_KEY` · `DASHBOARD_PASSWORD` | Bearer key for scripts · password for browsers | open when both empty (dev only) |
| `BOT_NAME` · `BOT_LANGUAGE` · `BOT_TIMEZONE` · `BOT_COMMAND_PREFIX` | identity | ResumenBot · es · Europe/Madrid · `/` |
| `ADMIN_PHONES` · `ALERT_PHONE` | who can import / say; who gets outage alerts | – |
| `DAILY_SUMMARY_LIMIT` · `SUMMARY_MAX_MESSAGES` | quotas | 3 · 1500 |
| `DIGEST_ENABLED` · `DIGEST_MIN_MESSAGES` · `DIGEST_MAX_LATE_MINUTES` | scheduled bulletins: master switch, minimum new messages to post, skip slots found later than this after a restart | true · 5 · 90 |
| `JOBS_MAX_LATE_MINUTES` · `JOBS_MAX_PENDING_PER_USER` · `WELCOME_BRIEF_DAYS` | reminders found later than this after a restart are marked missed · pending jobs per user · days covered by the welcome brief | 180 · 20 · 3 |
| `RETENTION_DAYS` · `RETENTION_ARCHIVE` | delete after N days, archive first | 15 · true |
| `TRANSCRIBE_AUDIO` · `DESCRIBE_MEDIA` | voice-note transcription, sticker/photo captions | true · true |
| `ELEVENLABS_API_KEY` · `ELEVENLABS_DEFAULT_VOICE_ID` · `ELEVENLABS_SECONDARY_VOICE_ID` · `TTS_MAX_CHARS` | voice out | – / 2500 |
| `CLOUDFLARE_S3_API_ENDPOINT` · `CLOUDFLARE_S3_ACCESS_KEY` · `CLOUDFLARE_S3_SECRET_KEY` · `CLOUDFLARE_R2_BUCKET_NAME` · `MEDIA_ARCHIVE_MAX_MB` | R2 storage | – / 15 |
| `ZERNIO_API_KEY` · `ZERNIO_WEBHOOK_SECRET` · `ALERT_TEMPLATE_NAME` · `DM_TRANSPORT` | official Cloud API via Zernio | – / baileys |
| `LOG_LEVEL` · `LOG_FORMAT` | logging | debug · pretty (json in production) |

## API

`GET /api` returns the full index. Responses are `{ ok, data }` or `{ ok: false, error: { code, message, hint, reqId } }`; the `hint` says what to check.

| Area | Endpoints |
|---|---|
| Health & link | `GET /api/health` · `GET /api/whatsapp/qr` · `GET /api/whatsapp/status` · `POST /api/whatsapp/{connect,disconnect,logout}` |
| Groups | `GET/POST /api/groups` · `GET/PATCH/DELETE /api/groups/:jid` · participants, invite, join · `GET …/messages` · `POST …/summarize` · `POST …/ask` · `POST …/import` · `GET/PUT/DELETE/POST /api/groups/:jid/digest` (scheduled bulletin; POST posts one now) · `GET /api/digests` · `POST …/actions` (open items) · `PATCH /api/groups/:jid {settings: {welcomeBrief, welcomeDays}}` |
| Jobs | `GET /api/jobs?chat=&status=` · `POST /api/jobs {chat, text, when: "mañana 9:00" \| dueAt, kind?, mentions?, recurrence?}` · `GET/DELETE /api/jobs/:id` · `POST /api/jobs/:id` (deliver now) |
| Messages | `POST /api/messages` (text/media, routed to the right channel) · `POST /api/messages/voice` · `POST /api/messages/sticker` · `GET /api/messages/:id/media` · `POST /api/messages/:id/transcribe` (`brief` → adds a TL;DR) · `POST /api/messages/:id/react` |
| Stickers | `GET /api/stickers?search=` · `GET /api/stickers/:sha256` |
| AI | `GET /api/ai/models` · `POST /api/ai/{summarize,ask,reply}` · `GET /api/tts/status` |
| Summaries | `GET /api/summaries` · `GET /api/summaries/:id` |
| Zernio / Meta | `POST /api/webhooks/zernio` · `GET /api/zernio/*` · `POST /api/zernio/send` · `/api/cloud/*` · `/api/cloud/webhook` |
| Maintenance | `GET/POST /api/maintenance/retention` · `POST /api/maintenance/{backfill-stickers,recaption-stickers,migrate-stickers}` · `POST /api/alerts/test` · `GET/PUT /api/settings` |

Example — summarise a group since yesterday 15:00 and post it there:

```bash
curl -X POST "$APP/api/groups/<jid>/summarize" -H "Authorization: Bearer $API_KEY" \
  -H "content-type: application/json" -d '{"since":"ayer 15:00","deliver":"group"}'
```

## Logs

Every line is tagged by subsystem and every failure carries the error and a 💡 hint:

```
10:01:12.442 INFO  [api] → POST /api/groups/…/summarize reqId=k3f9a1
10:01:20.401 INFO  [ai] ← openrouter ok model=google/gemini-2.5-flash-lite ms=7790 promptTokens=612
10:01:20.455 ERROR [wa] connection closed code=440 reason=connectionReplaced
    ↳ Error: Stream Errored (conflict)
    💡 Another process connected with the same credentials. Make sure only ONE instance runs.
```

## Privacy & safety

* Group messages of real people are stored. Retention deletes them after 15 days (archive summaries and the sticker library remain). Imported exports are exempt.
* Prompts treat chat text as data, not instructions, and refuse to reveal their prompt.
* Never commit `.env`. The alert/admin phone numbers, keys and domain live only in env vars.
* Baileys is unofficial; see the warning at the top.

## Contributing

Issues and PRs are welcome. `npm run typecheck` and `npm run build` must pass. See `CLAUDE.md` for code conventions and `MEMO.md` for the design history.

## License

MIT — free for anyone to use, modify and distribute. See `LICENSE`.
