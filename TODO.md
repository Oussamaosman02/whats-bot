# TODO — feature backlog

Grounded in what people ask for on X/Twitter and Reddit (research done 2026-09-08 with twitterapi.io and Treg/scrapecreators Reddit search: six tweet searches, five Reddit searches, two full comment threads). Items are ordered by demand × fit with the current stack.

## What the research says

- **Plain catch-up summaries are commoditised.** The most-liked tweet found (3.1k likes, Spanish) celebrates that WhatsApp's own AI now summarises unread group messages. Our edge is what Meta AI does not do: arbitrary ranges, "since my last message", voice notes, Q&A over 15 days of history, structured extraction, and running on our own server.
- **People hate bots that talk unprompted.** Several tweets complain about friends adding Meta AI to groups. Keep "only reply when addressed" as a core principle for every feature below.
- **The real pain is buried information, not unread counts.** The Reddit thread "How do you keep track of important things in busy WhatsApp group chats?" lists exactly: shopping lists, who brings what, expenses, decisions. A parent tweet sums up the rest: 147 unread messages and one of them says the kid needs a green shirt in 20 minutes.

## Done

- [x] **Long voice-note TL;DR** — `/transcribir breve` (also `resumen`, `tldr`) replies with 2–5 bullets instead of the full text; full transcripts of long notes (≥ 60 s or ≥ 700 chars) end with a hint offering it. API: `POST /api/messages/:id/transcribe {brief: true}` adds `summary`. (`src/lib/ai/transcribe.ts` → `summarizeVoiceNote`)

## Tier 1 — high demand, fits the current stack

- [ ] **In-process scheduler** (prerequisite for several items). One replica already, so a `setInterval`/cron loop inside `instrumentation.ts` that polls a `jobs` table (due_at, kind, payload, status) is enough. Must survive restarts (state in Postgres, not memory) and must send through Baileys with human-like pacing.
- [ ] **Expense splitting in the group.** `/gasto 40 cena @ana @luis` · `/gastos` · `/saldos` · `/liquidar @ana`. Evidence: Splitwala bot (209 upvotes on r/IndiaTech), tweet "why doesn't WhatsApp build Splitwise in". Table `expenses` (chat, payer, amount, currency, participants[], note, ts). No AI needed; optionally let Gemini parse free text ("pagué 40 de la cena por todos").
- [ ] **Reminders and nagging.** `/recordar mañana 9:00 llevar el pastel`, `/recordar cada lunes 20:00 …`, `/recordatorios`, `/olvidar <n>`. Evidence: family "AI task manager" thread on r/automation ("nudge people after 2 days"), reminder bots on r/delhi. Gemini parses natural-language time (reuse `since.ts` ideas); needs the scheduler. Recurring reminders and "remind @ana" (DM or group mention).
- [ ] **Action items and commitments.** `/pendientes` → extract from stored history: tasks, promises ("lo mando el viernes"), open questions, who owes what. `/pendientes míos` by DM → what needs *me* (mentions, questions addressed to me). Evidence: Munshi "chief of staff" (r/ClaudeAI), the class-group parent tweet. Prompt-only first (like `/preguntar`), later a `tasks` table with done/undone.
- [ ] **Shared lists.** `/lista compra` · `/añadir leche, pan` · `/quitar 2` · `/lista` re-posts it · `/lista cerrar`. Evidence: r/AppIdeas thread (shopping lists, items everyone needs to bring). Table `lists` + `list_items` (chat, name, item, addedBy, done).
- [ ] **Scheduled digest.** `/resumen diario 21:00` (group, admins) or `/resumen diario 8:00 privado` (DM morning brief of every shared group). Opt-in per group, `/resumen diario off`. Reuses `service.ts` unchanged; needs the scheduler. Evidence: "send a daily summary at 8pm" (r/automation), Munshi morning brief.
- [ ] **Welcome brief for newcomers.** On Baileys `group-participants.update` (add), DM the new member a summary of the last N days (`/resumen 3d` semantics) plus the group's `/pendientes`. Evidence: WhatsApp's own "share 25–100 past messages with new members" launch (650 likes) shows the demand. Respect a per-group toggle; never post in the group.

## Tier 2 — strong asks, a bit more work

- [ ] **Events and date polls.** `/evento cena viernes 21:00 Casa Ana` · `/cuando cena` (native WhatsApp poll with candidate dates, bot tallies) · `/asisto` / `/no` RSVP · `/calendario` lists upcoming events extracted from chat and from `/evento` · `.ics` export via API. Evidence: "polls die in the chat", "WhatsApp should add a Group Calendar" tweet, Whenabouts (r/SideProject).
- [ ] **Decisions log.** `/decisiones [periodo]` → dated, structured list ("08/09 · se queda el viernes · propuesto por Ana"). Pairs with action items; same extraction prompt, different output shape. Persist as `decisions` rows so they survive retention.
- [ ] **Group stats / "wrapped".** `/stats` (month or `/stats 2026`): most active members, peak hours, longest voice note, sticker champion, most-replied message, words per person. Evidence: interactive per-member group report (300 likes), chat-pattern analyser went viral (126 upvotes, 97 comments). All data already in `messages`; add an image card later (sharp) for virality.
- [ ] **Links and files library.** `/links [periodo]` and `/archivos [periodo]` with a one-line Gemini description each; `/archivos de @ana` for the "payment slips per sender" use case (r/automation). Files already land in R2; add `GET /api/groups/:jid/files?from=&sender=`.
- [ ] **Scheduled messages.** `/programar mañana 9:00 Recordad traer el DNI` → posts as the bot at that time (`/programados`, `/cancelar <n>`). Top ask in "3 features WhatsApp should have added 10 years ago". Needs the scheduler; admins-only in groups.
- [ ] **Translation.** Reply to a message with `/traducir [idioma]`; optional per-group "auto-translate messages in language X" for mixed-language groups. Trivial with Gemini; keep it on-demand by default.

## Tier 3 — niche or risky

- [ ] **Anti-spam for large communities.** Detect join-and-spam, link floods, repeated forwards; DM the admins rather than auto-kick (auto-kicks raise the ban risk for a Baileys number). Evidence: 50k-member community mods on r/CommunityManager.
- [ ] **Live lookups.** `/buscar <query>` with web search grounding: sports scores, weather, prices. Evidence: football-scores bot (45 upvotes). Keep answers short; never post unprompted.
- [ ] **Chat-pattern / relationship reports.** Went viral but privacy-sensitive; only from an explicit chat export sent by DM, never from group history. Probably skip.

## Cross-cutting

- [ ] **Per-group settings** (`GET/PUT /api/groups/:jid` already exists): toggles for welcome brief, daily digest, auto-translate, quotas. Expose `/config` for admins in the group.
- [ ] **Quotas for the new commands** (same 15 s cooldown; per-user daily caps for AI-backed ones).
- [ ] **Docs**: README command tables and `MEMO.md` after each shipped item.
