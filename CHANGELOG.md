# WealthFlow — CHANGELOG

## v7.69.33 — 2026-09-20

- Statement backlog processing is split into short, durable interactive requests instead of one request that can exceed the client timeout.
- Remaining work continues automatically after each confirmed server response.
- Every fresh sign-in performs a silent two-month exact-sender Gmail reconciliation before the encrypted cloud vault worker unlocks and files the queue.
- Automatic sign-in sync no longer duplicates the warning owned by a manual **Check now** action.
- Scheduled reconciliation retains its full time-boxed drain for autonomous catch-up.

## v7.69.32 — 2026-09-20

**What changed for you**

- **Check now** now reports a real result and cannot silently return because the statement module missed Firebase's auth callback.
- Every successful vault unlock re-syncs added or edited statement passwords to the encrypted autonomous vault.
- Statement Sync shows only exact approved senders. Legacy unapproved mail is retired before its attachment is downloaded.
- Deep content inspection retires proven invoices and receipts without ledger writes or misleading Needs Review cards.

**Under the hood**

- Gmail push remains the real-time trigger, with history reconciliation and a daily scheduled safety-net for delayed or dropped notifications.
- Added cold-server simulations for delayed auth, refused cloud starts, updated passwords, unapproved legacy senders, and non-statement retirement.

## v7.69.31 — 2026-09-20

**What changed for you**

- Historical scans now find valid PDF/HTML attachments from every exact approved sender even when the bank omits or encodes the filename.
- The Statement Sync card shows the complete pending queue while iPhone safely opens one statement at a time; a large backlog no longer looks like a single scan result.
- A clear queue status explains how many statements remain and that processing continues in memory-safe batches.

**Under the hood**

- Newly backfilled statements wake the same server-side autonomous statement reader, unanimous AI classification board, and durable ledger pipeline as live Gmail delivery.
- Exact sender-address approval remains a fail-closed boundary before attachment bytes are fetched or processed.
- Added regression coverage for filename-less bank PDFs, complete lightweight queue hydration, stable payload-to-row mapping, and autonomous owner gating.

## v7.69.30 — 2026-09-19

**What changed for you**

- Entering your WealthFlow PIN now unlocks the Bank Statement Password Vault for the same session.
- If the vault is locked, **Check now** pauses before downloading any statements, opens the unlock prompt, and resumes automatically after a successful unlock.
- Existing device vault entries are copied to the encrypted private cloud vault after unlock when cloud storage is configured, enabling autonomous processing without exposing plaintext passwords.

**Under the hood**

- The PIN remains memory-only: it is never retained, logged or uploaded.
- Statement processing can no longer misclassify password-protected files as review failures merely because the saved-password vault was still locked.

## v7.69.29 — 2026-09-19

**What changed for you**

- Old waiting statements repair missing sender metadata on a safe rescan, so exact approved senders can release them instead of leaving “From — not on your sender list” forever.
- Small Gmail attachments embedded directly in a message are now collected, and unencrypted PDF/HTML statements work without forcing a password vault.
- A dedicated daily Statement Sync catch-up recovers delayed or dropped Gmail push notifications.
- Every fresh sign-in starts authenticated cloud collection and processing when the private cloud vault is enabled.

**Under the hood**

- Historical scan pages fail closed and remain retryable when Gmail or Firestore fails transiently; no cursor advances past an unstored message.
- PDF text is reconstructed by visual row and column coordinates, while each parse uses isolated VM state.
- Unknown filed keys cannot create phantom manifests, connected mailbox status no longer requests a redundant token, and failed recent sweeps are immediately retryable.
- Stored attachment ciphertext is pinned to a SHA-256 digest; changed bytes fail closed, while row occurrence and fingerprint hashes keep repeated processing idempotent.

## v7.69.28 — 2026-09-13

**What changed for you**

- Checking Statement Sync now fetches names and status only; it never downloads encrypted attachments in the background.
- iPhone and iPad process one complete statement per review pass, preventing attachment and parsed-row memory from accumulating.
- Only exact approved sender addresses can receive attachment bytes; missing, unknown, blocked and unreadable sender-policy states fail closed.

**Under the hood**

- Removed closed full-screen blurred modal layers from the compositor and disabled backdrop sampling on iOS.
- Stopped decoding PDFs into redundant full-size text strings and scoped icon observers to newly added DOM nodes.
- Coalesced mail-card updates until scroll idle and moved Service Worker cache writes off the navigation critical path.
- Canonicalised navigation cache entries and preserved the independent backup cache during code-cache cleanup.
- Counted unknown-layout teaching text against the same one-statement mobile memory budget instead of retaining an unbounded teaching backlog.

## v7.69.27 — 2026-09-13

**What changed for you**

- Fast dashboard scrolling after Statement Sync no longer collides with an asynchronous Chart.js redraw on iPhone/iPad.
- Mobile keeps the same monthly and category values in lightweight, accessible DOM charts without GPU-backed canvas pressure.

**Under the hood**

- Disabled automatic dashboard Chart.js loading on iOS, coarse-pointer mobile and low-memory devices; desktop charts remain unchanged.
- Added a compositor-safe scroll-idle gate that coalesces reactive and cloud-snapshot DOM paints while native momentum scrolling is active.
- Disabled iOS whole-page entrance transforms and automatic restoration to a crash scroll position.
- Extended real-browser mobile pressure coverage to assert zero dashboard Chart.js construction/download, one coalesced repaint and all 12 monthly values after 30 rapid scroll-time update requests.

## v7.69.26 — 2026-09-13

**What changed for you**

- Statement review now keeps only 12 transaction rows mounted at once, so even a single unusually large statement cannot exhaust iPhone/iPad browser memory while scrolling.
- Previous/Next controls preserve edits across every page; Save, cloud review, bulk routing and AI auto-sort still process the complete statement.

**Under the hood**

- Replaced the review modal's DOM-as-database assumption with a bounded view over a complete in-memory transaction model.
- Added executable 200-row mobile-pressure simulations covering rapid navigation, hidden-row filing, cloud review and AI queue hand-off.

## v7.69.25 — 2026-09-13

**What changed for you**

- Recover approved statements missed behind Gmail's history cursor with a bounded 14-day reconciliation.
- Keep exact approved sender addresses authoritative and hide obvious legacy invoices and receipts from the statement queue.

**Under the hood**

- Wait for every eligible AI engine before reducing a result; structured financial AI and autonomous security review now fail closed.
- Make duplicate matching deterministic across device timezones.

## v7.69.24 — 2026-08-16

**Internal changes only**

- Version floor, reject regurgitated review findings, gate the statement tokens (#102)

## v7.69.23 — 2026-08-16

**What changed for you**

- The release brain has never run — and three other masked failures (#98)

## v7.69.22 — 2026-08-16

Contentless release, explicitly authorised: forces release-brain to create system/pendingRelease so the proposal-intake chain can be validated end to end.

## v7.69.21 — 2026-08-12

**What changed for you**

- Standardise fingerprint identity across time, and give intake its own workflow (#95)
- Firestore proposals become trackable work without duplicating it (#94)
- The app ignored two answers the server was already giving it (#92)

**Under the hood**

- Three checks that reported infrastructure failure as a result (#93)

## v7.69.20 — 2026-08-06

**What changed for you**

- Google Drive was never routed — and every feedback is now critical (#91)
- Feedback could not become a work item — the dedupe label was too long (#89)
- Icons share one symbol sprite — 3714 nodes to 3501, measured (#87)
- A profile photo that fails to load no longer shows a broken icon (#86)
- Give the two images that lacked alt text an accessible name (#85)
- Overdue alerts survive a stray tap, and a full disk says so (#84)
- Stop the first paint waiting on gstatic.com four times over (#77)

**Under the hood**

- Commit the cross-page access probe that vetoed the #66 "obvious fix" (#88)
- Stop retrying a bug the agent cannot win, and count the tries (#83)
- Make the red→green verification visible to the reviewer (#82)
- Execute the proving test, and bar the agent from the harness (#81)

## v7.69.19 — 2026-08-03

**What changed for you**

- The What's-New sheet showed another release's notes rather than none (#69)

**Under the hood**

- Say what actually shipped, instead of "improvements and fixes" (#68)

## v7.69.18 — 2026-08-02

Improvements and fixes in this release.

## v7.69.17 — 2026-08-01

Improvements and fixes in this release.

## v7.69.16 — 2026-07-31

Improvements and fixes in this release.

## v7.69.15 — 2026-07-30

Improvements and fixes in this release.

## v7.69.14 — 2026-07-29

Improvements and fixes in this release.

## v7.69.13 — 2026-07-27

Improvements and fixes in this release.

## v7.69.12 — 2026-07-26

Improvements and fixes in this release.

## v7.69.11 — 2026-07-25

Improvements and fixes in this release.

## v7.69.10 — 2026-07-24

Improvements and fixes in this release.

## v7.69.9 — 2026-07-23

Improvements and fixes in this release.

## v7.69.8 — 2026-07-22

Improvements and fixes in this release.

## v7.69.7 — 2026-07-21

Improvements and fixes in this release.

## v7.69.6 — 2026-07-20

Improvements and fixes in this release.

## v7.69.5 — 2026-07-19

Improvements and fixes in this release.

## v7.69.4 — 2026-07-18

Improvements and fixes in this release.

## v7.69.3 — 2026-07-17

Improvements and fixes in this release.

## v7.69.2 — 2026-07-16

Improvements and fixes in this release.

## v7.69.1 — 2026-07-15

Improvements and fixes in this release.

## v7.67.2 — 2026-07-14

Improvements and fixes in this release.

## v7.63.2 — 2026-07-13

Improvements and fixes in this release.

## v7.63.1 — 2026-07-13 (security)

Security & stability update.
