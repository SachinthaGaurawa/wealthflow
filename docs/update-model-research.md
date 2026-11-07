# How updates should work in WealthFlow: what Android and iOS do, and what fits here

Researched 2026-11-07 for the owner's question "how do Android and iOS updates work, the user can update or not, features differ per user, patches arrive over time, integrate the best of it". Every claim below says where it came from and whether it was read in full, so nothing here is stronger than its evidence.

## 1. What the platforms do (sources read on 2026-11-07)

| Practice | Android | iOS / Apple | Evidence |
|---|---|---|---|
| The person can say no or later | Play offers a **flexible** update: download and install in the background while the app is used, finish when the person chooses. | Updates can be postponed; automatic install is a setting. | Android: [in-app updates](https://developer.android.com/guide/playcore/in-app-updates), read in full. Apple postpone: general product behaviour, no page read. |
| A blocking update exists, for critical cases only | **Immediate** update: full screen, the app cannot be used until updated. "Best for cases where an update is critical." | none for apps | same Android page |
| How strongly to push | Each release carries a **priority 0 to 5** and the app can read how many days it has been available (staleness), to wait a few days before a flexible prompt and a few more before an immediate one. | none | Android Kotlin/Java guide, seen through search results only, not opened in full |
| Staged rollout | Play gives a release to a **random share** of users; the share rises only when the publisher raises it; **halt** stops new users, those who have it keep it; halt is not a rollback; resume keeps the same users. | **Phased release** over 7 days: 1, 2, 5, 10, 20, 50, 100 percent, only users with automatic updates; **anyone can still update by hand at any time**; pause up to 30 days. | Play: [help 6346149](https://support.google.com/googleplay/android-developer/answer/6346149), read in full. Apple: [phased release](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases), read in full |
| Small security fixes between full updates | **Project Mainline**: system components updated through Play on their own schedule, installed and rolled back atomically. | **Background Security Improvements** (iOS 26.1 and later; successor of Rapid Security Response): on by default, can be switched off, can be removed by the person, Apple can pull one and re-issue it. | Android: [source.android.com](https://source.android.com/docs/core/ota/modular-system). Apple: [support.apple.com/102657](https://support.apple.com/102657). Both read in full |
| Per-user features | Remote Config **rollouts**: a feature goes to a small share first, expands in steps, can be rolled back for all or one segment. | same idea via flags | [Firebase Remote Config rollouts](https://firebase.google.com/docs/remote-config/rollouts), read in full |
| Web apps | A new service worker **waits** until the old one has no pages; `skipWaiting()` can mix old and new files on one page; the right pattern is to tell the person and activate on their tap. | n/a | [web.dev service worker lifecycle](https://web.dev/articles/service-worker-lifecycle), read in full |

**Not verified:** the exact wording of Apple's postpone options ("Remind me later", "Tonight") and Android's "unmetered only" download rule. They are described from product behaviour, not from a page I read, so WealthFlow copies the idea, not the wording.

## 2. What WealthFlow already had (read in the code, not assumed)

A full install flow with a restore point first, real file download, a claim that is settled against the code that actually runs, failure memory, signed releases, canary and rollback, release notes written from commits, a Settings > Software update card, a dashboard pill, a nav badge, a type (full, minor, security), a mandatory list, and an opt-in "auto-install urgent security updates". The person could install or ignore, but could not say "later" or "skip", the pill showed forever, a device behind by six versions saw only the last version's notes, and the agreement had to be read again for every one of the 66 patch releases.

## 3. What was built (v7.69.67 line, PR on branch `claude/project-thread-156kee`)

| Platform idea | In WealthFlow | Where |
|---|---|---|
| Flexible update, the person decides | **Remind me tomorrow / in a week**, **Skip this version**, **Install when idle**, each undoable; a choice applies to one version only, so the next version starts clean | `wealthflow-update-policy.js`, Settings card |
| Priority 0 to 5 + staleness | Priority from the release (explicit `priority` in version.json, else mandatory 5, security 4, full 3, minor 2); stance quiet / offer / urge / required; "offered N days ago" | policy + card |
| Immediate update | **Deliberately not copied.** WealthFlow is the only way to reach the person's money records and an install that fails halfway must never lock them out. A required update cannot be skipped and can be postponed one day, and the card says plainly that the app keeps working but the device stays exposed. | policy `canSkip`, `maxSnoozeDays` |
| Staged rollout, halt, manual override | `rollout` percent per version, a stable random bucket per device, **Early access** switch (always first in line), `halted` list (offered to nobody), "Install now anyway" while a rollout has not reached the device | policy, version.json, `release.cjs --rollout N` |
| Background Security Improvements | The existing opt-in auto-install of urgent security updates now also honours **Wi-Fi only** (when the browser says the connection is metered; Safari does not say, then nothing is held back) | update system |
| Patches that download only what changed | Scripts are fetched with `cache: 'no-cache'` so the server answers **304** for unchanged files. Measured in Chromium on 2026-11-07 with an ETag server: 3 files of 50 KB, 304 and 300 bytes each against 50,300 each with `reload`. The page document keeps `reload` because the service worker treats a 304 on a navigation as unusable. The install screen reports "N of M files changed, about X KB" from Resource Timing, and says nothing when the browser gives no numbers. | `_executeProgress`, `_measure` |
| Everything since my version | What's new and the welcome sheet join the notes of every release in between (newest first, repeats removed) | `mergeNotes` |
| Agreement shown once | Once per major.minor line, so 60 patches do not each ask | `LS_EULA_OK` |
| Update history | Last 30 events on the device: installed (with files changed, KB, restore point), failed, postponed, skipped | Settings > Update history |
| Features differ per user/device | `features` in version.json: `since`, `channel` (stable or early), `rollout`, `default`; the person's own switch always wins; `wfUpdate.featureOn(id)` for code behind a flag; unknown features are on | policy `featureState`, Settings > Features |
| Diagnosis must respect choices | An update the person postponed or skipped is no longer reported as a fault by the diagnosis | `wealthflow-diagnosis.js` |
| Standing by | A device whose update **did not land** now files one report by itself (two version numbers, no free text, once per day per target) | `WFDiagnosis.standby` |

## 4. How feedback becomes updates (owner's rule, 2026-11-07)

- **No batching for weeks.** A problem is fixed and shipped now; the release job still cuts a version right after each merge.
- **One piece of feedback = its own update.**
- **Several pieces on the same day (Sri Lanka calendar) = one update.** The fix workflow waits until a burst is over (15 quiet minutes, never more than 45 after the oldest; a newer report restarts the wait; a crash or security report does not wait), the agent fixes the first report, then works the others of that day on top of it, and opens **one** pull request that closes all of them.
- Limits stated honestly: the group is capped at five reports and 20 extra minutes per run; a report that cannot be fixed is left for its own update and does not hold the others; the direct-ship mode keeps one fix per update.

## 5. What already existed for the AI side, so it was not rebuilt

A short report is expanded into a task card with a depth level; an independent second AI analyses cause and alternatives; screenshots of any size are read by a vision model; new ideas go to a concept board where several AIs discuss them before the build lane starts; reports in any language are translated first; weekly feature proposals and daily discovery run on their own; monthly and daily security updates run on cron.

## 6. Open decisions for the owner

1. **Required updates never block.** If the owner wants Android's blocking behaviour for the highest priority, it is one rule in `wealthflow-update-policy.js` (`announce` / `canSkip`), but a failed install would then leave no way into the data.
2. **Staged rollout is symbolic with one person.** It matters when the owner has several devices: switch Early access on the phone that tries things first.
3. **Per-feature flags have no consumer yet.** Nothing in the app is behind a flag today; the build lane can now ship a risky feature dark.
