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
| `TENANT_PORTAL_LINKS` | no | the statement link is in every text with an NIC; set `off` to stop putting it there |
| `TENANT_PORTAL_SECRET` | no | 32+ bytes. Keys the NIC and phone hashes, the one-time codes and the address counters; falls back to `OTP_SECRET`, then to a key derived from the service account. Changing it later is safe: each link is re-keyed by the next text sent for it |

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

## The tenant statement portal

Every text for a record that has an NIC ends with `Statement: https://<site>/t/<token>`. The token is 96 random bits, the
same for one lender and one NIC in every message; it only lets the page *ask* for a code.

1. The tenant opens the link and types their NIC (either shape: `853400937V` and `198534000937` are the same person).
2. A 6-digit code is texted to the number on the lender's record. The tenant cannot name the number.
3. With the right NIC **and** the right code the page shows one statement: every investment and loan under that NIC that the
   lender switched texts on for. Loans show no interest, ever. No names, notes, phone numbers, NICs or record ids are on it, and
   a repayment nobody confirmed is not on it. A reload within the session needs no new text; **Sign out** ends it.
4. If the same NIC is also a tenant of another WealthFlow lender who texts with links, that lender's records appear too, but only
   those whose recorded phone is the number this code went to (an NIC is not a secret; the phone is the second proof).

What a stranger can do: nothing they can see. A request for a code gets the same answer whether the link is real, the NIC is
right, a number exists or the gateway is down, in about the same time. A wrong NIC and a wrong code are one refusal.

| Rule | Value |
| --- | --- |
| Code | `crypto.randomInt`, 6 digits, stored only as an HMAC bound to its link, never in the log the owner reads |
| Life, tries, use | 3 minutes, 5 wrong tries, once; a new code kills the old |
| Codes | 1 a minute, 5 an hour, 10 a day per link; 300 a day in all (each is a unit you pay for) |
| Lock | 5 wrong answers lock the link 15 minutes, then 30, 60 ... a day; the live code dies |
| Session | 20 minutes from the code, not extended; `HttpOnly; Secure; SameSite=Strict` cookie, only the hash is kept |
| Per address | 30 code requests, 100 code tries and 300 statement reads an hour, a coarse net only (the address is kept only as an HMAC) |
| Page | `script-src 'self'`, nothing inline, no framing, no cache, no indexing (`vercel.json`) |

The owner's **Text messages** log shows each code sent ("Admin Alert: SMS Delivered Successfully to Tenant") or why it could not
be (out of credit, for instance), never the code. A tenant who cannot get a code is not told why: if nothing arrives, the lender
may have no number for them, or the account may be out of credit.

`wf-tenant-limits` joins the sealed collections: publish the rules with `firebase deploy --only firestore:rules`.
