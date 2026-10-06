# Text-message notices (Text.lk)

WealthFlow texts the people the owner has invested for or lent to, from the approved sender ID `WEALTHFLOW`, through the
Text.lk HTTP API v3 (`https://app.text.lk/api/v3/`).

## What is sent

| Layer | Where the switch is | Messages |
| --- | --- | --- |
| A | Investments tab, investment form | capital recorded, monthly interest applied, a payment received, the investment settled and closed |
| B | Liquidity & Credit Hub, debtor form | loan paid out (first advance and further advances), repayment confirmed (with the balance that is left), balance on request, the loan settled and closed |

Any country, any person: the number is stored as an international (E.164) number, with a country picked from a list of 240+
countries (default Sri Lanka, changed once under **Saved people**), and a person with no Sri Lankan NIC is identified by a passport or
ID number (stored as `ID:XXXX`, so the two can never be mistaken for each other). A recipient's quiet hours (08:00 to 20:00) are
kept in *their* time zone, and a number the gateway cannot route is reported as a destination problem, not as an outage.

Layer B never calculates or sends interest. The switch is a boolean on the record, `sms_notifications_enabled`; the
form also stores `phone`, `nic` (optional) and `sms_enabled_at`, the moment the switch went on. Anything that happened
before that moment is history, not news, and is never texted.

A payment is only announced once the owner has **confirmed** it. A repayment that is still waiting for confirmation, or
one that is un-confirmed before its text goes, sends nothing.

### A debtor who pays in parts

Every confirmed repayment text carries the balance that is left, so a part payment says how much remains:
`Repayment LKR 20,000.00 received on 05 Oct 2026, ref DEB-8E4EF6. Balance LKR 30,000.00. Statement: <link>`. The payment that settles the loan is acknowledged the same way (`Balance LKR 0.00`); that the loan is closed is a text of its own, below.

On the debtor's card:

* **Log repayment** shows what is owed now, then the balance that will be left as the amount is typed, and calls out a figure larger than is
  owed before it is saved. It says what the debtor will be texted, and when. A repayment is still logged as *waiting for confirmation* unless
  the owner ticks **I can already see this money in my bank, count it now** (the box starts unticked: nothing posts itself).
* **Send balance** (shown when the texts are on and something is still owed) texts the *confirmed* balance and the statement link on request.
  It asks first, then writes one `{ id, at }` request on the debtor (`sms_requests`); the server derives the text from the books, so the page
  never names an amount or a recipient. A second tap within ten minutes is refused before any question is asked (a text costs a unit).
  The text is written when it is queued, so a request that cannot go out within half an hour (no credit, a rejected token) is dropped and the
  message log says so, rather than sent later with a figure that has moved.

### Settled and closed (a text of its own)

* **A loan** is closed when a *confirmed* repayment brings the balance to nothing after money was lent. The server derives it from the books
  (key `B:<loan>:<payment>:closed`), so it needs no button and cannot be sent for a payment the owner has not confirmed. It goes after the
  receipt for that payment, never before it. A loan that is borrowed on again and settled again is closed again.
* **An investment** is closed by the owner: **Settle & close** on its card (it asks first). That stamps `closedAt`, brings the end date to today when it
  was empty or ahead (the date it had is kept for **Re-open**) and moves the investment to Ended. The server sends one text keyed by that stamp
  (`A:<investment>:closed:<closedAt>`) and announces no interest for a day after it. Re-opening and closing again is a new stamp, so a new text.
* Both read `Loan ref … is fully settled and closed on <date>. Thank you.` (or `Investment ref …`). Each costs one text unit, like any other.

### A second number (optional)

Every person, loan and investment can carry a second mobile number (`phone2`). Every text then goes to **both** numbers: the ledger holds one entry per
number (the second keyed `<key>:2`), so a failure on one never blocks or repeats the other, and the receipt always leaves before the closing text. The second
number has to be a real mobile number and not the first one again (the form says so). It is saved in E.164 like the first, shared with the saved person
like the first, and shown in the message log as "(second number)". The tenant statement's one-time code goes to the **first** number only. Because each text
is sent per number, a second number doubles the units a record uses.

### Late-payment reminders (optional, per debtor)

Off unless the owner ticks **Also remind when a payment is late** on that debtor's form (it needs an *Expected back by* date; the form refuses
the tick without one). While it is ticked and money is still confirmed as owed:

* One text the day after the date (the debtor's own calendar day, from their number's country), then one a week later, then 15 and 22 days
  after: at most four. Each is sent between 08:00 and 20:00 where the debtor is, never overnight.
  `Reminder: LKR 50,000.00 is still outstanding, due 02 Oct 2026, ref DEB-7E1E60. Statement: <link>`
* No interest, no penalty and no demand: the figure is the confirmed balance and the date is the one the owner set.
* Nothing is sent for a day that was over before the box was ticked, and an edit keeps the moment it was ticked (`sms_remind_at`).
* A reminder whose day has gone by more than 24 hours ago is dropped, not sent late; a payment confirmed before it goes out cancels it.
* **Held back while a repayment is waiting for your confirmation.** A repayment you have logged but not yet checked against the bank means
  the debtor says they have paid; "still outstanding" would be wrong exactly then. Once you confirm it, a reminder (if one is still due)
  carries what is really left; if you delete it, they are reminded as before. A balance you ask for with **Send balance** is not held back:
  it states the confirmed figure and nothing else.
* Layer A (investments) has no such box: capital is not a debt.

## Saved people and payment details (Investments tab and Liquidity & Credit Hub)

**Saved people** (button on the Investments tab and on the Debtors card) is one address book for both tabs.

* Add a person once (name, phone with country, NIC or passport / ID, email, notes). On the next loan or investment pick them from the list
  at the top of the form and everything fills in. **Everybody named on a loan or an investment is saved to the book automatically**, an
  investor typed by name alone included (untick *Save to my people list* on a form to skip it). People already named on existing loans and
  investments are filed the same way as soon as the app is open, with no button to press; the same name is the same person (two
  investments for one investor are one investor), and two devices that do this before they sync end up with the same people.
* Edit or delete a saved person from the list. Changing a person's name, phone or NIC asks once: update it on every loan and investment
  they are linked to, on this record only, or cancel. Every save of a person also puts right a linked record that had fallen out of step
  (a number or ID it lacked), and a number a record already holds is never blanked by an unrelated edit. **Deleting a saved person never
  touches a loan or an investment**: they keep their own copy of the details and are simply unlinked.
* **Contacts** (the button beside every mobile-number box, and **Import contacts** in the book). Only Chrome on Android lets a web page open the
  address book, and there the button opens it at once. On every other device (iPhone, iPad, Mac, Windows, Linux, other browsers) it opens a
  sheet with the ways that do work there, and says which steps fit the device it is on:
  a contacts file chosen or dropped on the sheet (**vCard** `.vcf` from Contacts, Google or iCloud; **CSV** from Google Contacts or Outlook,
  with `;`, `,` or tab as the separator and several numbers in one cell), or text copied from a contacts app and pasted (a bare number,
  `Name: number`, a whole contact card, a list) or read from the clipboard. One pasted number fills the form with no second tap. Numbers
  copied with a `tel:` link, invisible direction marks or digits in another script (Arabic, Sinhala, Tamil, Devanagari) are read as the same
  number. Contacts are read in the page, nothing is uploaded, and only what the owner taps is used.
* **Add them to the list** (shown only if something could not be filed automatically, such as a full book) files everyone in the books in one tap.

**Payment details** (second tab of the same screen) is where the owner enters the bank accounts a debtor repays into or an investor adds
capital to: bank, name on the account, number, branch, SWIFT / IBAN, a note. Each account says who sees it (debtors, investors or both)
and can be switched off without deleting it. The statement page and the PDF show only the accounts meant for that kind of record. They
read six fields (bank, name, number, branch, SWIFT / IBAN, note) and nothing else.

## Environment variables (Vercel)

| Name | Needed | Meaning |
| --- | --- | --- |
| `TEXTLK_API_TOKEN` | to send | the Text.lk API token (Bearer). Never logged, never sent to the page |
| `SMS_ALLOWED_EMAILS` | to send | comma-separated verified emails allowed to use it (or a Firebase `admin` claim). Unset means nobody |
| `TEXTLK_SENDER_ID` | no | defaults to `WEALTHFLOW` |
| `SMS_CREDIT_RESERVE` | no | units kept for the texts people are waiting for; defaults to `20`, `0` switches the rule off. Under it, late-payment reminders wait (see *Credit reserve* below) |
| `SMS_ALERT_WEBHOOK_URL` | no | an `https` endpoint (a Slack or Discord incoming webhook, or anything that takes JSON) told when credit falls under the reserve and when Firebase sign-in has not answered on two runs in a row; at most once a day each. Addresses that only mean something inside a network (`localhost`, IPs, `*.internal`, a port) are refused |
| `CRON_SECRET` | for the daily sweep | already used by the other crons |
| `WEALTHFLOW_PUBLIC_ORIGIN` | no | origin for links in the text, defaults to the production alias |
| `TENANT_PORTAL_LINKS` | no | the statement link is in every text with an NIC; set `off` to stop putting it there |
| `TENANT_PORTAL_SECRET` | no | 32+ bytes. Keys the NIC and phone hashes, the one-time codes and the address counters; falls back to `OTP_SECRET`, then to a key derived from the service account. Changing it later is safe: each link is re-keyed by the next text sent for it |

Check it is wired up: `GET /api/sms-notify?check=1` returns `{ configured, tokenAccepted }` and sends nothing. A signed-in
allowed account also sees `lowCredit`.

## How it works

The books are the source of truth. `sms-events.mjs` derives, from the user's document, which notices are owed, each with a
deterministic key. `sms-engine.mjs` puts each key into the ledger `wf-sms/{uid}/events/{sha256(key)}` once, in a
transaction, renders the words once, and sends it. The page nudges `/api/sms-notify` after a save; the cron
(`/api/sms-sweep`, at 04:00, 12:00 and 18:00 UTC) derives the same notices again, so a missed nudge loses nothing. The three
times are there for the window below: 04:00 UTC is 09:30 in Colombo (Asia and the Pacific), 12:00 the Gulf, Europe and the
eastern Americas, 18:00 the rest of the Americas. A run with nothing owed sends nothing and costs nothing.

* **Who is swept.** An account is on the cron's list because it registered, but that is not a licence for ever: before an account's
  texts are sent the sweep asks Firebase Auth again whether the sign-in may still use SMS (not disabled, a verified email, on
  `SMS_ALLOWED_EMAILS` or carrying the `admin` claim). One that may not is switched off (`active: false` on its `wf-sms/{uid}` document,
  with `deactivatedReason`; nothing is queued, retried or sent for it, and its tenants can no longer be sent one-time codes), and the
  owner's next visit registers it again once it is allowed. A sign-in service that does not answer is not a verdict: the account is
  skipped for that run and left as it is. A registration whose data document no longer exists is switched off too, so it cannot hold one of
  the 40 places in a run. The registered accounts are read in pages of 500 (up to 2,000) and ordered by when each was last swept, so a long
  list is covered across runs.
* **Credit reserve.** The sweep reads the gateway balance once per run (free). Under `SMS_CREDIT_RESERVE` units (20 unless set) the
  late-payment reminders, and only those, are not queued or sent: they stay owed by the books, and the first sweep that sees the
  balance back at the reserve queues and sends them, once. Receipts, closing notices, disbursements and a balance you asked for
  still go, because someone is waiting for them. A reminder that waited past its own shelf life expires, as it always did, instead of
  going out late. A run that did not read the balance itself (the page's nudge after a save) reads it only if a reminder is in play.
  An unreadable balance never stops a text. The panel says "Late-payment reminders are paused" and the sweep logs
  `[WF-SMS] credit is under the reserve`. With `SMS_ALERT_WEBHOOK_URL` set the owner is also told, once a day at most, and told again
  at once if credit recovers and falls again. Reminders are not bundled into a digest: one text per reminder keeps each one worded from
  the books as they are when it is sent.
* **When sign-in does not answer.** Each Firebase Auth check is tried twice (a quick failure once more after 250 ms; a timeout is not
  repeated). An account that still could not be checked is skipped and left exactly as it is. Three such accounts in a row open a
  breaker for the rest of the run: the remaining accounts wait for the next run instead of each spending its whole deadline, and the
  response says `authDegraded` and how many were `authSkipped`. Nothing is sent on a remembered "it was allowed last time": an account
  whose access has just been removed must not keep spending the balance because Auth happened to be down. Queued texts stay queued
  and go out as soon as Auth answers; nothing is switched off by an outage. The page's own save-time nudge is unaffected (it uses the
  signed-in user's own token). After two degraded runs in a row the webhook (if set) says so.
* **Hold, don't fail.** Out of credit, a rejected token or an unapproved sender holds the message and retries every six
  hours without using attempts. The account this was built for had ten units.
* **Backoff.** Rate limits and network errors retry at 1 min, 5, 20, 60, 3 h, 6 h, 12 h, 24 h, or the gateway's own
  `Retry-After` if longer.
* **Exactly once, honestly.** The ledger makes a second queueing impossible. The gateway has no idempotency key, so a
  worker that dies mid-send can cause a second attempt; that message is flagged `possiblyDuplicated`.
* **Limits.** 300 texts per account per day, 12 per number per day, reserved before sending so concurrent sends cannot
  overshoot. **Scheduled** texts (monthly interest, late-payment reminders) go out only between 08:00 and 20:00 where the
  *recipient* is (the country of the number), and the engine checks that when it claims a text, not only when it queues one:
  a text queued for the morning is never sent at 03:00 because that is when a sweep got to it. It waits for the next window
  (reminders are dropped after a day, interest notices after a month). A text that is news the moment it happens (a receipt,
  a disbursement, a balance you asked for, a one-time code) is sent at once, at any hour.
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
3. With the right NIC (or passport / ID number) **and** the right code the page shows one statement: every investment and loan under that
   identity that the lender switched texts on for. Loans show no interest, ever. No names, notes, phone numbers, NICs or record ids are on it, and
   a repayment nobody confirmed is not on it. A reload within the session needs no new text; **Sign out** ends it.
   What a person can do on it: see when the next interest is due or when a loan is expected back, see where to pay (the lender's bank
   accounts, with a **Copy** button on the account number), **Download PDF**, **Print**, read it in English or Sinhala (one button; nothing
   is stored), and **Sign out**.
4. If the same NIC is also a tenant of another WealthFlow lender who texts with links, that lender's records appear too, but only
   those whose recorded phone is the number this code went to (an NIC is not a secret; the phone is the second proof).

### The PDF

`POST /api/tenant-portal { action: 'pdf', token }` with the session cookie returns the same statement as an `application/pdf` attachment
(`WealthFlow-statement-<date>.pdf`: no name in the file name). It is built from the object the page shows, so it holds the same figures
and nothing more, plus the lender's payment details. It has its own address limit (30 an hour). The writer (`tenant-pdf.mjs`) is
dependency-free PDF 1.4 with Helvetica, a few kilobytes. **It prints English letters and digits only**: Sinhala, Tamil and other scripts in
an account name come out as `?`, so enter the payment details in English.

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
may have no number for them, the account may be out of credit, or the lender may no longer be allowed to send texts.

`wf-tenant-limits` joins the sealed collections: publish the rules with `firebase deploy --only firestore:rules`.
