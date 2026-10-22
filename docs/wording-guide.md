# WealthFlow wording guide

One calm, professional voice across the owner app, the customer portal and the
public pages. This is the standard the wording audit applied and the rules
`test/wording_guide_test.js` keeps from drifting back.

## Voice

- Plain, respectful, specific. Say what happened and, when something went wrong,
  what to do next. Never blame the person, never joke, never hype.
- Address the person as "you" and the product as "WealthFlow". Never "me" or "I"
  (a message that says "paste it to me" is written for a developer, not a user).
- No exclamation marks, no emoji-style decoration, no slang ("Oops", "Keep pushing",
  "Feel that buzz"), no marketing superlatives ("Elite", "Infinity", "luxury",
  "satisfying", "demolish").
- No ALL-CAPS emphasis in sentences. Short status badges may stay capitalised.
- Do not expose internals: no "JSON", "scope", "Web Crypto", "engine", "module",
  "endpoint", "non-JSON answer", raw exception text standing alone, or the word
  "unknown" as a reason.

## Form

- Sentence case for headings, buttons, labels and toasts ("Add cheque", not
  "Add Cheque"). Proper names keep their capitals (Google Drive, Statement Sync).
- A toast is a full sentence and ends with a full stop. It names the thing:
  "Loan deleted.", not "Deleted".
- Use the uncontracted form ("could not", "is not", "cannot") in app messages. It
  reads formally, matches the portal, and avoids escaping mistakes in code.
- A destructive confirmation says what will be removed and whether it can be
  undone. A bare "Delete?" is not a question.
- Empty states say what belongs here and how to add it, in one or two sentences.
- Form errors name the missing fields: "Add the loan name, bank and amount."

## Vocabulary

| Use | Not |
|---|---|
| instalment, instalments | installment (British spelling, as in Sri Lanka) |
| cheque | check |
| PIN | passcode, passkey, master key |
| sign in, sign out | log in, login, log out |
| verification code | OTP (in app text) |
| restore point | "restore protocol", "vault snapshot" |
| delete (removes data) / remove (takes off a list) | wipe, format, nuke |
| backup, restore | "restore data protocol" |
| report | "Elite report", "luxury statement" |
| Statement Sync, Merchant review, Cheque Tracker | renamed variants |

Spelling follows British English: analyse, optimise, colour, favourite, centre,
cancelled. Money stays "LKR 1,234.50". Dates in messages are written out
("15 Oct"), never ISO unless the person typed it.

## Where the text lives

- Toasts: `notify(message, type)` in `index.html` and the `wealthflow-*.js` modules.
- Confirmations: `showConfirm(icon, title, detail, buttonClass, buttonLabel, callback)`.
- Customer portal strings: `tenant-lang.js` (every string needs a Sinhala entry).
- Owner app is English. Sinhala appears only where the product writes to a
  Sinhala-speaking person (portal, SMS, advisor replies), and follows the same
  voice: short, formal-polite, no machine-translated word order.
