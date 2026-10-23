# "Alerts to my own number": a number is added only after its code is entered

Owner ask 2026-10-23: when a number is added to "Alerts to my own number", a one-time code is texted to it, and the number is accepted only once the code
has been entered correctly. This is what the code does today.

## The rule

The alerts (`sms-owner.mjs`) go only to the number the **server** has recorded as verified. `settings.owner_sms` (the switch, the number as typed) syncs between
devices and is a request; `wf-sms/{uid}.ownerVerified = { phone, at }` is the permission. That document is sealed in `firestore.rules` (server only), so no browser
can write it. `sms-engine.mjs` (`sweepUser`) reads it first and overwrites whatever the synced settings claim (`withVerifiedOwner`); a saved number that is not the
verified one produces no alerts and the status card says why (`phone-not-verified`). Anything already queued for it is cancelled by the next sweep.

An older saved number has no verification record, so it waits for its code too (one text, once). Nothing is grandfathered: a client-written date or flag cannot be
trusted, and the server has no other proof that the number is the owner's.

## The flow

1. The owner types a number. The button reads **Send code** (any number that is not the verified one) instead of **Save**.
2. `POST /api/sms-notify {action:'owner-otp-send', phone}` (same sign-in and `SMS_ALLOWED_EMAILS` check as every other call). The server texts a 6-digit code to that
   number. The page shows the code row (code, Verify, Resend with a countdown).
3. `POST /api/sms-notify {action:'owner-otp-verify', phone, code}`. On success the number becomes `ownerVerified`, the status card carries it to every device, and
   the page saves the number into the settings (with the switch as it was ticked). The saved number is never replaced by one that is not verified: a new number
   waits for its code while the verified one keeps receiving alerts. Switching the alerts off needs no code.

## The code (`sms-owner-otp.mjs`)

- `crypto.randomInt`, 6 digits; stored only as HMAC-SHA256(`OTP_SECRET`, uid, number, code) and compared in constant time, so a database read does not reveal it and a
  code for another account or number is worthless.
- Valid 10 minutes, single use, 5 wrong tries then dead, one text at least 45 s after the last, at most 5 texts per account in 24 hours (also the cost cap).
- The reservation (the new hash and the send log) is one Firestore transaction **before** the gateway is called, so a double tap or a second device sends one text.
  A gateway refusal gives the reservation back; a timeout that may have been delivered keeps it, so a code that does arrive still works.
- Already verified, same number: nothing is sent.
- Sri Lankan mobile numbers only (`wealthflow-phone.js`), like every recipient.

## Needs on the deployment

`OTP_SECRET` (at least 32 bytes; the same variable the recovery codes use), a working Text.lk token, and the account's email in `SMS_ALLOWED_EMAILS`. Each code costs
one text of SMS credit. Without `OTP_SECRET` the endpoint answers 503 "not set up" and sends nothing.

## Tests

`test/sms_owner_otp_test.js` (code, send, verify, engine, endpoint door, panel markup, page glue), `test/sms_owner_test.js` (derivation with a verified number), and
`test/e2e/owner-otp.mjs` (the panel in real Chromium against a stand-in server; it found two defects the unit tests could not: a redraw on `change` swallowed the
click on Send code, and a pasted "482 913" was cut by `maxlength`).

Not run here: a real text to a real phone, and the Firestore transaction under two simultaneous requests (the in-memory stand-in is single-threaded; the guarantee
is Firestore's own).
