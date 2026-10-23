# How WealthFlow keeps every device on one account the same

Written 2026-10-23 after the owner reported, again, that a change on one device did not reach the others (a switch turned ON on the phone, a "Settle in full"
that sent no text). This is what the code does today, the rule each piece follows, and the test that proves it. It describes the code that exists; nothing
here is a plan.

## The account, the document, the identity

- Sign-in is Firebase Auth with Google. The account id is the Firebase `uid`; every device that signs in with the same Google account gets the same `uid`.
- All of an account's books live in ONE Firestore document, `users/{uid}`: income, loans, cards, cheques, expenses, targets, subscriptions, debtors, people,
  settings, and the sync metadata (`_tomb`, `_kut`, `_kuf`). Larger server-owned data lives in subcollections (`smsLog`, `statement*`) and in `wf-sms/**`.
- `firestore.rules`: `users/{uid}` and everything under it is readable and writable only when `request.auth.uid == uid`; the server-owned subcollections
  cannot be written from a browser; `wf-inbox`, `wf-mail`, `wf-sms` and the tenant branches are sealed (server only). `test/cross_device_guards_test.js`
  pins this text. The rules have **not** been run against the Firebase emulator here (it cannot be downloaded in the build sandbox), so cross-account
  denial is verified from the rule text and from the fact that the path is keyed by `uid`, not from a live probe.
- One browser, two accounts: `wf_account_uid` records whose books are in this browser. When a different account signs in, `_wfAccountSwitched` removes
  the `wf2_*` books, the stamps, the delete queue, the dirty flag and the account's notices, records the new uid and reloads, so the old books are never
  merged into, or uploaded to, the new account. (`test/e2e/convergence.mjs` check 6 fails without this: the other account's record ends up in the
  new account's cloud copy.)

## Where a change goes

```
tap -> DB.set(key, value) -> stamp (record _ut / field _kuf / key _kut, HLC) -> localStorage -> setDirty -> debouncedSync (300 ms)
    -> syncToCloud: runTransaction { tx.get(users/uid); merge the cloud copy in; tx.set(users/uid, merged, {merge:true}) }
    -> success: setDirty(false)      failure or no answer in 30 s: stays dirty, is explained, is retried
other device: onSnapshot (live) | reconcile read (every 20 s, on focus, on return to the foreground, on regaining the network)
    -> _wfApplyCloudData (the same merge) -> localStorage -> repaint
```

## Who wins when two devices disagree

The merge is the same function on every path (first sign-in, live listener, reconcile, manual refresh, and inside the push transaction). It is
commutative and idempotent, so the order and the number of deliveries do not matter.

- Records in a list (`income`, `loans`, `debtors`, …): per record, the later `_ut` stamp wins. A record deleted later than it was edited stays deleted
  (tombstone in `_tomb`); one edited after the delete comes back.
- Settings and other plain fields: per field, the later `_kuf` stamp wins, so a device that never touched a setting cannot revert another device's choice.
- Stamps are hybrid-logical clocks (`_wfStampNow`): a device with a slow clock cannot go back behind a stamp it has already seen.
- The push is a transaction that re-reads the cloud copy and merges it before writing, so two devices saving at the same moment cannot overwrite each
  other; the later stamp decides per record and per field. Money records are never merged field by field into a different record: the unit is the record.
- Duplicate delivery changes nothing (idempotent merge) and writes nothing (an unchanged merge is not dirty).

## What keeps a device from going deaf

- The live listener has an error callback and starts again after 2, 5, 15 s, then every minute (`_wfListen`, `_wfLive`).
- The read every 20 s (and on focus, resume, online) finds what the listener missed, applies it, and starts the listener again.
- A push that never answers is cut off after 30 s (`window._wfPushDeadlineMs`) and treated as a network failure.
- A failed push shows "Not saved to your account yet" with the reason in plain words, retries by itself with a growing pause, is retried by a watchdog
  when a change has waited with no push running, is flushed when the page is hidden, and can be diagnosed with Check Connection (server, Google, sign-in,
  read, write, live listener, the data itself). Refresh, Sync now and the text-message toasts say when the account does not have the change yet.
- Offline: changes stay on the device and dirty; they are pushed on reconnect. A change is never reported as saved before the transaction commits.

## Account-owned state that stays on one device on purpose

Device identity and lock (`wf_device_id`, `wf2_skip_lock`, `wf2_device_biometric`), view preferences (`wf_exp_view`, `wf_inc_view`), the day's notice
dismissals and OS-notification de-duplication (`wf_notif_dismissed_*`, `wf_alerted_today`, `wf2_notif_history`), the Drive/Gmail OAuth handles, the AI
scanner's learned model (`aiMLModel`). Every key read or written through `DB` is a declared `appData` key (checked by script on 2026-10-23: the only
one not declared is `aiMLModel`), so none of the shared books is device-local.

## Rule for new features

1. Shared account data goes through `DB.set` on a key declared in `appData` (and, for lists, in `_WF_RECORD_KEYS`). A key missing from `appData` is
   uploaded but never read back.
2. Never write the account document from a component directly; the transaction and the merge are in `syncToCloud`.
3. A surface that reads a key repaints from `_wfTouch(key)`, which `DB.set` calls and so does every incoming merge.
4. A new `onSnapshot` must pass an error callback and say how it starts again.
5. Any toast that promises something later (a text, a backup) must wait on `_wfUploadNow()` and say when the account does not have the change.

## Tests

| What | Where |
| --- | --- |
| Merge, stamps, tombstones | `test/settings_sync_revert_test.js`, `test/refresh_test.js`, `test/backup_honesty_test.js` |
| Failure words, retry loop, checks | `test/sync_health_test.js` |
| Account guard, push deadline, rules text | `test/cross_device_guards_test.js` |
| Two devices, switches that must not revert | `test/e2e/settings-sync.mjs` |
| Notice, auto-retry, Check Connection | `test/e2e/sync-banner.mjs` |
| Live listener: ON/OFF/ON, error, silent stall, foreground | `test/e2e/live-sync.mjs` |
| Three devices: rapid flips, simultaneous records, duplicates, missed event, hung upload, account switch, latency | `test/e2e/convergence.mjs` |

The e2e tests run in real Chromium against a stateful stand-in for Firestore (`test/e2e/firebase-cloud.mjs`: optimistic transactions, listeners, cut-off and
reconnect). They prove the app's logic, not Google's network; latency measured there (median about 350 ms, 95th percentile about 410 ms over 24 flips,
including the 300 ms upload debounce) excludes the real round trip to Firestore.

## Known limits

- The cause on the owner's phone is not proven, because no phone was available. When it happens again the notice names the reason; "Copy Report" in Check
  Connection carries the exact step.
- Real-device behaviours (iOS suspending a page mid-upload, a VPN or private relay blocking Firestore) are covered by the deadline, the retry and the
  flush on hide, not by a physical-device run.
- Rules were not run against the emulator (see above).
- Deletion markers are kept about 100 days (`_WF_TOMB_TTL`). A device that stays offline longer than that and then edits a record that was deleted
  meanwhile can bring that record back.
- One Firestore document holds the books, so the account is limited by Firestore's 1 MiB document size; Check Connection shows how close the data is.
