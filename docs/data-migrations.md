# Data migrations that cannot lose the books

`wealthflow-migrations.js` (`window.WFMigrations`) is how the shape of the owner's data changes: splitting a record, renaming a field,
moving records between lists. The books are schemaless (Firestore plus localStorage), so a change of shape is a program that rewrites
money data on the owner's own device. Four older one-off migrations live in `index.html` (`_migrateBankNames`,
`_migrateStatementCategoryNames`, `_migrateCCOTPaidFix`, `_migrateIncomeSplit`); they are left as they are. **New shape changes go
through the runner**, whether a person or the fix agent writes them.

The runner does not trust a migration. It measures it.

## What happens to one migration

1. **It is checked.** An id (`2026-11-05-short-name`), the keys it `touches`, an `up`, a `down`, and a `fixture` (an old-shaped sample).
   No `down` or no fixture: it cannot be registered.
2. **A restore point of exactly the touched keys is written to localStorage first.** If that cannot be written (storage full, or the keys
   are larger than 1.5 million characters) the migration does not run. A cloud backup is asked for as well; its result (`saved` or
   `not-saved`) is recorded as it came out and never assumed. The cloud backup never holds the books for more than 8 seconds.
3. **`up` runs on a copy; nothing is written.** The result must keep the declared keys, survive JSON, keep every record (unless the
   migration declares `countMayChange`), keep the money (sum of `amount`, or `moneyFields`, unless `moneyMayChange`), pass the migration's
   own `check(before, after)`, and be **idempotent** (`up(up(x))` equals `up(x)`), because another device may still hold the old shape and
   merge it back after this device migrated.
4. **Only then is anything written**, key by key, through `DB.set` (the official path: record stamps, sync, redraw). Each key is read back
   and measured again. If a write fails or the read-back does not check out, every touched key is put back from the restore point and
   read back again. If even that fails the result is `revert-failed`, the restore point is kept, and the ledger says so loudly.
5. **A page that dies half way** leaves the restore point marked `in-progress`. The next launch puts it back before anything else runs.
6. **A failed migration is not retried on the same build** (no loop). A new build gets one more try. Migrations run oldest first and the
   runner stops at the first one that does not go through, because later ones may rely on it.

`WFMigrations.undo(id)` takes an applied migration back with its own `down`, with the same proof and the same revert-on-failure.

## What it does not do

* It cannot make a wrong migration right. It keeps a wrong one from being kept: counts, money and the round trip are measured.
* A migration that **deletes records** must say `countMayChange: true`, and a person approves it: `DB.set` turns removed records into
  tombstones that sync to other devices, and putting them back is not the same as never having removed them.
* It cannot see another device. Idempotence is what makes a late merge of old-shaped records harmless, so it is enforced.
* Nothing is registered today (no shape change is pending), so `run()` does nothing at all: no read, no write, no backup.

## Adding one

Append an object to `MIGRATIONS` in `wealthflow-migrations.js` (never edit one that has shipped; write a new one):

```js
{ id: '2026-11-05-split-memo', touches: ['transactions'],
  up(d)   { /* d = { transactions: [...] } copies; return the new shape */ return d; },
  down(d) { /* exactly the reverse */ return d; },
  fixture: { transactions: [ /* old-shaped sample records */ ] } }
```

`test/migrations_test.js` runs `checkMigration` over every registered migration: it must give the fixture's money and records back,
be idempotent, and `down(up(fixture))` must equal the fixture exactly. A migration that cannot do that does not pass CI.

`wealthflow-migrations.js` is on the sensitive-path lists (Risk gate, auto-merge classifier, rego, CODEOWNERS, the fix agent's own
forbidden list), so any change to it needs `human-approved` after the last push. An AI can draft a migration; a person decides whether
it ships.
