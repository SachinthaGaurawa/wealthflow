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
    -> syncToCloud (plain HTTPS, `_wfCloudSync`): compare each top-level field's fingerprint with the copy the account held when this device last merged it;
       send ONLY the fields that differ in one documents:commit that carries the version it was based on (currentDocument.updateTime)
       refused because someone saved in between -> read the newer copy, merge it in (the same merge), send again (up to 5 times)
    -> success: setDirty(false)      failure or no answer within its own deadline: stays dirty, is explained, is retried
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
- Every request to the account has its own deadline and is cut off by it: a save 20 s plus 1 s per KB sent (at most 2 min), a read 45 s, the "has anything
  changed?" check 15 s, the sign-in token 20 s. A request that never answers is a failure like any other: counted, explained, retried. (The old library
  path, kept only for a page whose connection module did not load, is cut off after 30 s, `window._wfPushDeadlineMs`.)
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
| The account over plain HTTPS: value codec, fingerprints, only-what-changed saves, version precondition, conflict merge, deadlines | `test/cloud_rest_test.js` (against `test/helpers/fake-firestore-rest.js`) |
| The same engine against Google's own Firestore emulator (skipped in CI: needs Java) | `test/cloud_rest_emulator_test.js` |
| Account guard, push deadline, rules text | `test/cross_device_guards_test.js` |
| Two devices, switches that must not revert | `test/e2e/settings-sync.mjs` |
| Notice, auto-retry, Check Connection | `test/e2e/sync-banner.mjs` |
| Live listener: ON/OFF/ON, error, silent stall, foreground | `test/e2e/live-sync.mjs` |
| Three devices: rapid flips, simultaneous records, duplicates, missed event, hung upload, account switch, latency | `test/e2e/convergence.mjs` |

The e2e tests run in real Chromium against a stateful stand-in for Firestore (`test/e2e/firebase-cloud.mjs`: optimistic transactions, listeners, cut-off and
reconnect, and the account's REST endpoint on the same document). They prove the app's logic, not Google's network; latency measured there (median about 350 ms, 95th percentile about 410 ms over 24 flips,
including the 300 ms upload debounce) excludes the real round trip to Firestore.

## The account over plain HTTPS (2026-11-02)

Reported by the owner (Mac, Safari 17.6): "Reading your account" and "Saving to your account" both ended at 12 s with `deadline-exceeded`, in the fast and the
steady mode, while a save sent straight to the account with the sign-in token took 1.2 s. The library's transaction runner (firebase 10.8.0) can hang for ever
on an error whose code is not a Firestore code (and can poison its single work queue, after which every read and save of that page waits), and every save
read and rewrote the whole document (786 KB on that device). Saves, the 20 s "has anything changed?" check and reads of the account now go through
`documents:batchGet` / `documents:commit` (`wealthflow-sync-health.js`, "THE ACCOUNT, OVER PLAIN HTTPS"). The data model, the merge, the rules and the
server are unchanged; the live listener stays as a hint. What is proven, what is inferred and what is not done is written at the top of that section. Run
the emulator check with
`npx firebase-tools emulators:exec --only firestore --project demo-wf "npx vitest run test/cloud_rest_emulator_test.js"`.

## Update state across devices (2026-11-07)

`updateSync` is a declared `appData` key: which version each device runs, the newest version the person installed on purpose, and which agreement lines were accepted. One fact per leaf (a string), so the per-field merge cannot split it. The rules are `wealthflow-update-policy.js` (pure), the screens `wealthflow-update-system.js`; proven by `test/update_follow_test.js` and, across three real browsers sharing one cloud document, `test/e2e/update-follow.mjs`. See `docs/update-model-research.md`.

## Known limits

- The document is still one Firestore document of up to 1 MiB (the owner's is about 75% of it). A save sends only what changed, but an edit to the largest
  field (expenses, 513 KB on that device) still sends that whole field. Splitting the big lists into their own documents is the next step and needs a
  backed-up migration; it was not done here.
- The restore points written by Back up now still use the library's batch write.
- The cause on the owner's phone is not proven, because no phone was available. When it happens again the notice names the reason; "Copy Report" in Check
  Connection carries the exact step.
- Real-device behaviours (iOS suspending a page mid-upload, a VPN or private relay blocking Firestore) are covered by the deadline, the retry and the
  flush on hide, not by a physical-device run.
- Rules were not run against the emulator (see above).
- Deletion markers are kept about 100 days (`_WF_TOMB_TTL`). A device that stays offline longer than that and then edits a record that was deleted
  meanwhile can bring that record back.
- One Firestore document holds the books, so the account is limited by Firestore's 1 MiB document size; Check Connection shows how close the data is.
