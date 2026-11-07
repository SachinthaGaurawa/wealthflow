# What would make WealthFlow a superior system: measured gaps, reasoning, roadmap

Written 2026-11-07 for the owner's ask: "do deep research on what features, UX and UI would make this the best system in the world; think logically (if this, then that); user friendliness first."

## 1. How this was done, and what it can and cannot claim

| Kind of evidence | Used for | Strength |
| --- | --- | --- |
| **Measured on this app** (`test/e2e/a11y-audit.mjs`, real Chromium, invented books, 25 screens, dark and light, 390 px and 1280 px) | The gap list in section 3 | Strong: reproducible, anyone can re-run it |
| **W3C WCAG 2.2** (read from w3.org/TR/WCAG22): 1.4.3 contrast 4.5:1 (3:1 large text), 2.1.1 keyboard, 2.4.7 focus visible, 2.4.11 focus not obscured, 2.5.8 target size 24 px, 4.1.2 name/role/value | The pass/fail bar | Strong: the standard itself |
| **General product knowledge** of how leading finance and phone apps behave (undo, plain-language errors, skeleton loading, per-device settings) | Ideas in section 4 | Weak: from memory, not looked up. Each idea is marked as an idea, not a finding |
| **Web search** | Tried; results were mostly affiliate blogs | Not relied on. Nothing in this document depends on a blog claim |

What this document does **not** claim: that any of this makes the app "the best in the world". That is not measurable. What can be shown is a list of measured defects, which of them are fixed, and what is left.

## 2. The logic used to pick what matters

1. If one person trusts the app with all their money records, then **a wrong number or a lost record costs far more than any missing feature**. So correctness and recoverability come before anything new. (Already the working standard: backups before live-data changes, soft delete.)
2. If the app is used every day on a phone and a laptop, then **friction per tap is paid hundreds of times**. So things that waste taps or make the person wonder ("did it save?", "which version is this device on?") come next.
3. If a control cannot be read aloud, reached by keyboard or seen when focused, then **it is broken for some people and awkward for everyone** (keyboard shortcuts, voice control, glare on a phone in sunlight all hit the same defects). Accessibility defects are therefore also usability defects, and they are the only ones that can be measured exactly. That is why the measurable work started there.
4. If the AI system makes changes on its own, then **the person must always be able to see what changed and on which device**. So update history, per-device versions and the restore point are part of the user interface, not just plumbing.
5. If a feature has no consumer yet (per-feature flags today), then **it is not a feature**; it is cost. Do not add more of those.

## 3. Measured gaps, before and after this change

Re-run any time: `WF_CHROME=<chromium> node test/e2e/a11y-audit.mjs` from the repository root (`SHOW=n` prints more rows, `KEEP_THEME=1` skips the theme sweep).

| Check (WCAG 2.2) | Before | After | What changed |
| --- | --- | --- | --- |
| On/off switches and fields with no name a screen reader can say (4.1.2, 1.3.1) | 84 switches, 13 distinct fields (88 hits) | 0 | The frame (`wealthflow-shell.js`) names a control from the label already written beside it; fixed names for the 7 fields with none |
| Switches could not be flipped from the keyboard (2.1.1) | Space and Enter did nothing | They flip the switch | One key handler |
| Focus ring invisible on coloured buttons (2.4.7) | 5 of 25 tab stops | 0 | A solid outline on top of the glow |
| Text contrast under 4.5:1 / 3:1 (1.4.3) | 110 hits, 43 distinct | 18 hits, 11 distinct | Light-theme red, gold and grey text, dark-theme grey text darkened or lightened by a few percent; white-on-amber numbers; text over the 3D cash-flow canvas (1.6:1 in light theme) |
| Pop-ups not announced as dialogs (4.1.2) | 10 | named `role="dialog"` where none was set | Same pass in the frame |
| No way past the sidebar, no main landmark (2.4.1) | none | skip link, `role="main"` | Skip link shown only when focused |
| Automatic installs (security, "when idle", and the new following) | **Could never start**: the hidden notification panel is a permanent `role="dialog"` and counted as "the person is busy" | Only dialogs that are on screen count | Found while testing the cross-device update. Not an accessibility finding, but a real defect the audit's dialog count pointed at |

**Still failing (11 distinct, all measured, none hidden):** the `score` screen digits drawn in light-theme gold and pink (2.2 to 2.7:1), `sessions` IP text (3.9:1), and three Settings headings and counters whose accent colour is set inline (now darkened by a filter, to be re-measured). One reported item, the "Open" button in AI settings, is a false alarm: its fill is a gradient the audit cannot read. The audit script reports it as it is.

**Not measured at all (to be honest about the edge of this work):** screen reader behaviour in a real reader (names are checked by rule, not by listening), focus return after a dialog closes, keyboard traps, zoom to 200% and 400% (1.4.4, 1.4.10), text spacing (1.4.12), colour-only meaning in charts (1.4.1), and Sinhala text rendering. These need a real reader or a device.

## 4. Ideas, ranked by the logic in section 2

Each idea says what to check first, because several may already exist.

| Rank | Idea | If / then | Check first |
| --- | --- | --- | --- |
| 1 | **Undo for every destructive tap** (delete, mark paid, settle) with a few seconds to take it back | If a mis-tap changes money records, then a one-tap undo removes the fear that makes people double-check everything | How many delete paths already soft-delete; the tombstone mechanism in `docs/sync-architecture.md` already keeps deletes reversible for about 100 days |
| 2 | **Every save says where it is**: "saved on this device", "saved to your account" | If sync fails silently, trust is lost | Largely present (sync banner, Check Connection); look for screens that bypass it |
| 3 | **Remaining contrast and focus defects**, then measure zoom 200%/400% and text spacing | If it can be measured it can be closed | Section 3 list |
| 4 | **Per-device facts in one place**: version, last seen, following on/off | If the same account is on a phone and a laptop, the person needs to know why they differ | **Built in this change** (Settings > Software update > Your devices) |
| 5 | **Plain-language errors with one next step** | If an error names a code, the person cannot act | `docs/wording-guide.md` exists; audit the long tail of toasts |
| 6 | **Sinhala (and Tamil) interface** | If the owner's own language is Sinhala, then English-only screens are friction every day | **This is the owner's decision, not a defect.** Large: every string, number and date format, and fonts. Needs a go/no-go and a scope |
| 7 | **Skeleton loading in place of blank areas** | If a screen is blank for a moment, it feels slower than it is | Measure first paint per screen before building anything |
| 8 | **Fewer, better defaults**: hide advanced controls until asked | If a screen has 20 controls, the 3 used daily are hard to find | Needs real usage data; none is collected, and none should be without the owner asking |

Ideas deliberately **not** proposed: more AI features for their own sake, gamification, social features, or anything that sends money data to a new service. None of them passes the test in section 2.

## 5. What this change delivers

1. **An update on one device reaches the others.** See `docs/update-model-research.md` for the update model and the new section below it for the account record. A device that installs on purpose tells the account; the other devices install the same build when the person is not using them, with the backup first and the rollback if it fails. It respects "skip", "remind me later", Wi-Fi only, and a per-device off switch. A device that is closed updates the next time it is opened. Early-access devices never pull the others along.
2. **The accessibility fixes in section 3**, each with a test (`test/shell_access_test.js`, the audit script).
3. **The repair of the hidden-dialog bug**, which had made every automatic install a no-op.

## 6. Known limits of what was built

- The first time, a device must be updated once the ordinary way, because an old build cannot read or write the new account record.
- If two devices write the account version in the same second, the later stamp wins. In practice a deployment only moves forward, so the worst case is that other devices stop following until the next deliberate install.
- Installing the same build needs a deployment that still serves it. If the server has moved to a newer build, the device installs that newer one (never older).
- The real iOS and Android browsers were not available; the update flow was proven in Chromium with a stand-in for the account.
