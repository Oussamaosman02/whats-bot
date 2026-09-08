# WhatsApp Group Messaging — Project Brief

> Goal: **Send and receive WhatsApp *group* messages** for a business number, and be able to reply to users who message us — something the official Cloud API (as wired through Zernio) does **not** allow on our current setup.

_Last updated: 2026-09-08_

---

## 1. The problem

We want to:

1. Receive incoming messages from WhatsApp **groups** the number belongs to.
2. Send messages into those groups.
3. Reply freely to users who write to us.

Our number is currently connected to **Zernio** (Meta Cloud API wrapper) in **WhatsApp Business App Coexistence** mode. That mode **blocks the Groups API entirely**, so none of the above works for groups today.

---

## 2. Why it's blocked (coexistence + Groups API)

Confirmed from both Meta's docs and Zernio's docs.

**Zernio coexistence limitations:**

| Feature | Status (coexistence) |
|---|---|
| Group chats (app-side) | **Not synced. WA Business app groups are not visible via API** |
| Groups API | **Not supported.** Requires a non-coexistence number (Cloud API only) |
| Throughput | Fixed at 20 messages/sec |
| Voice/video calls | Not supported via API |

**Meta's Groups API doc** echoes this: groups are not available for WhatsApp Business app numbers or numbers onboarded via multi-partner/coexistence conversations.

**Root cause:** During Meta Embedded Signup, choosing *"Connect existing WhatsApp Business app account"* activates Coexistence, which disables the group create/manage endpoints. The groups the number is in live entirely inside the WhatsApp Business app and are invisible to the Cloud API — so their messages never reach the Cloud API webhook.

**Key rule:** You cannot have *both* "keep using the WhatsApp Business app on this number" *and* the official Groups API on the same number. It's one or the other.

---

## 3. Two viable paths

### Path A — Official Cloud API (Groups API)

Requires a **non-coexistence, Cloud-API-only number** that is **not** tied to the WhatsApp Business app.

Steps:
1. Connect a new/separate WABA number in Zernio. During Meta Embedded Signup, **do not** pick "Connect existing WhatsApp Business app account" — create a new WABA / pick a number not already in the WA Business app.
2. Number must be an **OBA (Official Business Account)** in good standing (see §5).
3. **Create and manage groups via the Groups API** (you do not import existing app-side groups — those stay in the app).
4. Receive group messages on the normal `messages` webhook, tagged with `group_id`, plus the four `group_*` metadata fields.

How receiving works (official):
- Group messages arrive on the **same `messages` webhook** as 1:1.
- Each message object carries `group_id` (which group) and `from` (the participant who sent it).
- Optional metadata webhook fields: `group_lifecycle_update`, `group_participants_update`, `group_settings_update`, `group_status_update`.

Official group limits: max **8 participants/group**, up to **10,000 groups** per business number, **1 Cloud API business** per group. Unsupported inbound in groups: calls, disappearing, view-once, auth/marketing/interactive (arrive as `type: "unsupported"`, error `130501`).

Sending (official):
```bash
curl 'https://graph.facebook.com/v26.0/<PHONE_NUMBER_ID>/messages' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{
    "messaging_product": "whatsapp",
    "recipient_type": "group",
    "to": "<GROUP_ID>",
    "type": "text",
    "text": { "body": "Hello group" }
  }'
```

**Downside:** message must fit Cloud API rules — outside the 24h window you can only send approved (paid) template messages; you give up the WhatsApp Business app on that number; group sizes are tiny (8).

### Path B — Unofficial WhatsApp-Web library (recommended for our actual need)

Connect as a **linked/companion device** (QR scan) to the number's WhatsApp Business app. Behaves like a normal WhatsApp account → **full access to real groups** (including existing ones) and **no messaging restrictions**.

Top libraries:

| Library | Stack | Notes |
|---|---|---|
| **Baileys** (`@whiskeysockets/baileys`) | Node/TS, pure WebSocket | Most popular, lightweight, no Chromium. **Recommended default.** |
| whatsapp-web.js | Node + Puppeteer | Very mature, heavier (runs headless Chrome). |
| WPPConnect | Node + Puppeteer | Good docs, active. |
| whatsmeow | Go (Python via Neonize) | Rock-solid multi-device. |

Receiving with Baileys: listen to `messages.upsert`; a message is a group message when `key.remoteJid` ends in `@g.us` (vs `@s.whatsapp.net` for 1:1); `key.participant` = the sender inside the group.

Sending: free-form text/media to anyone, any group, **no 24h window, no templates, no per-message fees.**

---

## 4. Can Path B coexist with Zernio? — Yes (on our coexistence number)

Because we're on **coexistence**, the WhatsApp Business app stays active on the number and acts as the **primary device**. That lets everything run in parallel on the **same number**:

- **WhatsApp Business app** → primary device (holds the groups)
- **Zernio / Cloud API** → official 1:1 messaging, templates
- **Baileys** → linked/companion device → **groups** read/send

This is the sweet spot: Cloud API can't see groups, but Baileys linked to the same app can.

Architecture guidance:
- Use **Baileys for groups**, **Zernio for 1:1/templates**.
- Expect **duplicate 1:1 events** (both Cloud API and Baileys see incoming DMs) → route by chat type and **dedupe** by message id.
- WhatsApp allows only ~**4 linked devices** — enough, but a limit.

> Does **not** work on a pure Cloud-API-only number: it has no phone app to scan a QR from, so there's nothing for Baileys to link to. Coexistence is what makes the combo possible.

---

## 5. OBA (Official Business Account) — what's needed (only relevant for Path A)

1. **Business verification** — complete Meta Business Verification in Business Manager (legal name, address, docs). Hard prerequisite.
2. **Approved display name** on the number, compliant with WhatsApp display-name rules.
3. **Good standing** — no policy violations, healthy quality rating.
4. **Verified badge**, via either **Meta Verified for business** (paid monthly, the accessible route) or Meta's notability-based grant (well-known brands, Meta's discretion).

Managed from WhatsApp Manager → phone number → account settings, once the business is verified. Criteria change often — check Meta's live docs before committing.

---

## 6. Comparison

| | Path A — Cloud API (official) | Path B — Baileys (unofficial) |
|---|---|---|
| Sees existing app-side groups | ❌ (create new via API only) | ✅ full access |
| Group size | 8 participants | normal WhatsApp limits (large) |
| Free-form replies anytime | ❌ (24h window + paid templates) | ✅ no restrictions |
| Per-message fees | Yes | No |
| Needs OBA | Yes | No |
| Works on our coexistence number | ❌ (needs separate CA-only number) | ✅ |
| ToS compliant / supported | ✅ | ❌ (reverse-engineered, ban risk) |
| Stability | High | Breaks when Meta changes protocol |

---

## 7. Risks & caveats (Path B)

- **Violates WhatsApp/Meta Terms of Service.** Runs on the real account → **ban risk**, higher with automation, bulk, or cold outreach. Replying to inbound is the lowest-risk use.
- **One number** → a ban kills both Zernio and Baileys.
- Unofficial = unsupported; expect breakage on WhatsApp protocol changes.
- Use a number we can afford to lose; keep volume human-like; avoid random hosted "WhatsApp gateway" SaaS wrapping these — self-host to keep control.

---

## 8. Recommended plan for this project

1. **Keep the coexistence number + Zernio** for official 1:1 / templates.
2. **Add a self-hosted Baileys service** as a linked device on the same number for **group** send/receive and free-form replies.
3. Build a small router: `@g.us` → group logic (Baileys); DMs → Zernio (dedupe against Baileys' copy).
4. Persist Baileys auth state; monitor for the linked-device disconnect / re-link.
5. If we ever need official, supported groups at scale: provision a **separate Cloud-API-only OBA number** (Path A) — but note its 8-participant cap and template rules.

---

## 9. References

- Meta — Groups API: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/
- Meta — Group messaging (send/receive, webhooks): https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging
- Zernio — WhatsApp connection & coexistence: https://docs.zernio.com/platforms/whatsapp/connection#whatsapp-business-app-coexistence
- Baileys: https://github.com/WhiskeySockets/Baileys
