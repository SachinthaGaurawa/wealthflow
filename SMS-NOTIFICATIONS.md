# Text-message notices (Text.lk)

WealthFlow texts the people the owner has invested for or lent to, from the approved sender ID `WEALTHFLOW`, through the
Text.lk HTTP API v3 (`https://app.text.lk/api/v3/`).

## What is sent

| Layer | Where the switch is | Messages |
| --- | --- | --- |
| A | Investments tab, investment form | capital recorded, monthly interest applied, a payment received |
| B | Liquidity & Credit Hub, debtor form | loan paid out (first advance and further advances), repayment confirmed |

Layer B never calculates or sends interest. The switch is a boolean on the record, `sms_notifications_enabled`; the
form also stores `phone`, `nic` (optional) and `sms_enabled_at`, the moment the switch went on. Anything that happened
before that moment is history, not news, and is never texted.

A payment is only announced once the owner has **confirmed** it. A repayment that is still waiting for confirmation, or
one that is un-confirmed before its text goes, sends nothing.

## Environment variables (Vercel)

| Name | Needed | Meaning |
| --- | --- | --- |
| `TEXTLK_API_TOKEN` | to send | the Text.lk API token (Bearer). Never logged, never sent to the page |
| `SMS_ALLOWED_EMAILS` | to send | comma-separated verified emails allowed to use it (or a Firebase `admin` claim). Unset means nobody |
| `TEXTLK_SENDER_ID` | no | defaults to `WEALTHFLOW` |
| `CRON_SECRET` | for the daily sweep | already used by the other crons |
| `WEALTHFLOW_PUBLIC_ORIGIN` | no | origin for links in the text, defaults to the production alias |
| `TENANT_PORTAL_LINKS` | no | `on` puts the statement link in each text; off until the portal route exists |
| `TENANT_PORTAL_SECRET` | no | HMAC key for NIC hashes; falls back to `OTP_SECRET`, then to a key derived from the service account |

Check it is wired up: `GET /api/sms-notify?check=1` returns `{ configured, tokenAccepted }` and sends nothing. A signed-in
allowed account also sees `lowCredit`.

## How it works

The books are the source of truth. `sms-events.mjs` derives, from the user's document, which notices are owed, each with a
deterministic key. `sms-engine.mjs` puts each key into the ledger `wf-sms/{uid}/events/{sha256(key)}` once, in a
transaction, renders the words once, and sends it. The page nudges `/api/sms-notify` after a save; a daily cron
(`/api/sms-sweep`, 04:00 UTC = 09:30 in Colombo) derives the same notices again, so a missed nudge loses nothing.

* **Hold, don't fail.** Out of credit, a rejected token or an unapproved sender holds the message and retries every six
  hours without using attempts. The account this was built for had ten units.
* **Backoff.** Rate limits and network errors retry at 1 min, 5, 20, 60, 3 h, 6 h, 12 h, 24 h, or the gateway's own
  `Retry-After` if longer.
* **Exactly once, honestly.** The ledger makes a second queueing impossible. The gateway has no idempotency key, so a
  worker that dies mid-send can cause a second attempt; that message is flagged `possiblyDuplicated`.
* **Limits.** 300 texts per account per day, 12 per number per day, reserved before sending so concurrent sends cannot
  overshoot. Interest notices only go out between 08:00 and 20:00 in Sri Lanka.
* **Cost.** Plain GSM-7 only (no names, no symbols), one part when it can be, so a notice costs one unit.
* **The owner sees it.** Every state change is mirrored to `users/{uid}/smsLog` (read-only to the page); the page shows
  "Admin Alert: SMS Delivered Successfully to Tenant" when a delivery lands, and the **Text messages** button opens the log,
  including what is waiting and why. Firestore's realtime listener is the serverless stand-in for a websocket.

## Security

* A request can only say "look again". The recipient, amount and wording are read from the caller's own document on the
  server, so the endpoint cannot be used to text anyone the books do not already name.
* `wf-sms`, `wf-tenants` and `wf-tenant-subjects` are sealed to every client in `firestore.rules`. This only protects
  anything once the rules are published: `firebase deploy --only firestore:rules`.
* NIC numbers are never stored in the tenant index (only an HMAC) and never appear in a message.
