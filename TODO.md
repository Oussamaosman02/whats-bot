# TODO — feature backlog

Grounded in what people ask for on X/Twitter and Reddit (research done 2026-09-08 with twitterapi.io and Treg/scrapecreators Reddit search: six tweet searches, five Reddit searches, two full comment threads). Items are ordered by demand × fit with the current stack.

## What the research says

- **Plain catch-up summaries are commoditised.** The most-liked tweet found (3.1k likes, Spanish) celebrates that WhatsApp's own AI now summarises unread group messages. Our edge is what Meta AI does not do: arbitrary ranges, "since my last message", voice notes, Q&A over 15 days of history, structured extraction, and running on our own server.
- **People hate bots that talk unprompted.** Several tweets complain about friends adding Meta AI to groups. Keep "only reply when addressed" as a core principle for every feature below.
- **The real pain is buried information, not unread counts.** The Reddit thread "How do you keep track of important things in busy WhatsApp group chats?" lists exactly: shopping lists, who brings what, expenses, decisions. A parent tweet sums up the rest: 147 unread messages and one of them says the kid needs a green shirt in 20 minutes.

## Done

- [x] **In-process scheduler + scheduled digest** (2026-09-11, asked by a group member: "Breaking News de Audio cada 8 horas, a las 06:00, 14:00 y 22:00"). `/boletin 06:00 14:00 22:00 audio` in the group (admins) or by DM (`/boletin <grupo> …`, group implied when only one is shared) → `digests` row; `src/lib/bot/digest.ts` ticks every minute, claims due rows atomically (`UPDATE … WHERE next_run_at = seen`), posts a radio-bulletin voice note (`tone: "news"`) or text; skips when < `minMessages`; skips slots found > `DIGEST_MAX_LATE_MINUTES` late. API: `GET/PUT/DELETE/POST /api/groups/:jid/digest`, `GET /api/digests`. The scheduler is digest-specific for now; reminders / scheduled messages can reuse the claim pattern with their own table.
- [x] **Jobs table + reminders + scheduled messages** (2026-09-11). `jobs` table (kind message|reminder, chat, text, mentions, due_at, recurrence jsonb, status pending|running|done|cancelled|failed|missed, attempts, runs); `src/lib/bot/jobs.ts` ticks every 30 s, claims with `UPDATE … WHERE status='pending'`, retries 3×, marks `missed` past `JOBS_MAX_LATE_MINUTES`; `src/lib/bot/when.ts` parses future times (mañana 9:00, el lunes 20:00, en 2h, 08/09 10:30, cada día/lunes/2h, por la tarde…). Commands `/recordar` (anyone; group → mentions the author, DM → to self; reply to a message to be reminded of it), `/programar` (admins, posts as the bot), `/programados`, `/cancelar <id>`. API `GET/POST /api/jobs`, `GET/DELETE/POST /api/jobs/:id`.
- [x] **Action items** (2026-09-11). `/pendientes [periodo]` and `/pendientes míos` (by DM `/pendientes <grupo> …`) → `extractActionItems` prompt (tasks, unanswered questions, payments, decisions pending), saved as `summaries.trigger = "actions"` and counted in the daily quota. API `POST /api/groups/:jid/actions`. Nagging = `/recordar` (the reply suggests it); a `tasks` table with done/undone is still open.
- [x] **Private morning brief** (2026-09-11). `/boletin 8:00 privado [audio]` by DM → a `digests` row keyed by the user's DM jid; `runPrivateBrief` sends one DM with a brief digest of every shared group with ≥ minMessages new messages.
- [x] **Welcome brief** (2026-09-11). `chats.settings.welcomeBrief/welcomeDays` (`/bienvenida on|off|N`, `PATCH /api/groups/:jid {settings}`), `whatsapp.setParticipantsHandler` → on add, DM the newcomer a `/resumen Nd` + `/pendientes` (max 5 people per event, never in the group).
- [x] **`/config`** (2026-09-11): bot settings of a group (bulletin, welcome, pending jobs, quotas).
- [x] **DM group default** (2026-09-11): in private chat, `/resumen`, `/boletin` and `/importar` take the only shared group automatically instead of asking.
- [x] **Long voice-note TL;DR** — `/transcribir breve` (also `resumen`, `tldr`) replies with 2–5 bullets instead of the full text; full transcripts of long notes (≥ 60 s or ≥ 700 chars) end with a hint offering it. API: `POST /api/messages/:id/transcribe {brief: true}` adds `summary`. (`src/lib/ai/transcribe.ts` → `summarizeVoiceNote`)

## Tier 1 — high demand, fits the current stack

- [ ] **Expense splitting in the group.** `/gasto 40 cena @ana @luis` · `/gastos` · `/saldos` · `/liquidar @ana`. Evidence: Splitwala bot (209 upvotes on r/IndiaTech), tweet "why doesn't WhatsApp build Splitwise in". Table `expenses` (chat, payer, amount, currency, participants[], note, ts). No AI needed; optionally let Gemini parse free text ("pagué 40 de la cena por todos").
- [ ] **Reminders, next steps.** Assistant tool (`@bot recuérdame mañana a las 9 …`) reusing `parseWhen`; Gemini fallback for phrasings the parser rejects; "remind @ana by DM" (deliver to the mentioned person instead of the group).
- [ ] **Tasks table.** Persist `/pendientes` items with done/undone and `/hecho <n>`, so nagging can be automatic ("nudge after 2 days" → a reminder job per open task).
- [ ] **Shared lists.** `/lista compra` · `/añadir leche, pan` · `/quitar 2` · `/lista` re-posts it · `/lista cerrar`. Evidence: r/AppIdeas thread (shopping lists, items everyone needs to bring). Table `lists` + `list_items` (chat, name, item, addedBy, done).

## Tier 2 — strong asks, a bit more work

- [ ] **Events and date polls.** `/evento cena viernes 21:00 Casa Ana` · `/cuando cena` (native WhatsApp poll with candidate dates, bot tallies) · `/asisto` / `/no` RSVP · `/calendario` lists upcoming events extracted from chat and from `/evento` · `.ics` export via API. Evidence: "polls die in the chat", "WhatsApp should add a Group Calendar" tweet, Whenabouts (r/SideProject).
- [ ] **Decisions log.** `/decisiones [periodo]` → dated, structured list ("08/09 · se queda el viernes · propuesto por Ana"). Pairs with action items; same extraction prompt, different output shape. Persist as `decisions` rows so they survive retention.
- [ ] **Group stats / "wrapped".** `/stats` (month or `/stats 2026`): most active members, peak hours, longest voice note, sticker champion, most-replied message, words per person. Evidence: interactive per-member group report (300 likes), chat-pattern analyser went viral (126 upvotes, 97 comments). All data already in `messages`; add an image card later (sharp) for virality.
- [ ] **Links and files library.** `/links [periodo]` and `/archivos [periodo]` with a one-line Gemini description each; `/archivos de @ana` for the "payment slips per sender" use case (r/automation). Files already land in R2; add `GET /api/groups/:jid/files?from=&sender=`.
- [ ] **Translation.** Reply to a message with `/traducir [idioma]`; optional per-group "auto-translate messages in language X" for mixed-language groups. Trivial with Gemini; keep it on-demand by default.

## Tier 3 — niche or risky

- [ ] **Anti-spam for large communities.** Detect join-and-spam, link floods, repeated forwards; DM the admins rather than auto-kick (auto-kicks raise the ban risk for a Baileys number). Evidence: 50k-member community mods on r/CommunityManager.
- [x] **Live lookups.** Shipped 2026-09-10 as assistant tools (web_search, read_url, search_tweets, user_tweets, search_youtube, youtube_transcript, search_tiktok) via monid/treg/twitterapi/transcriptapi; log + cache in `social_lookups`, `GET/POST /api/social`. Pending: a `/buscar` slash alias.
- [ ] **Chat-pattern / relationship reports.** Went viral but privacy-sensitive; only from an explicit chat export sent by DM, never from group history. Probably skip.

## Cross-cutting

- [ ] **Per-group settings**: `chats.settings` + `/config` + `PATCH {settings}` exist (welcome brief). Still to move there: per-group quotas, auto-translate, assistant on/off.
- [ ] **Quotas**: `/pendientes` shares the `/resumen` quota; reminders are capped by `JOBS_MAX_PENDING_PER_USER`. Missing: per-group overrides.
- [ ] **Docs**: README command tables and `MEMO.md` after each shipped item.
