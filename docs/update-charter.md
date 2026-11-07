# The operating charter (how every model in the update system works)

Source: the owner's "elite expert" operating prompt (2026-11-07). Code: `wf-charter.mjs`. Tests: `test/charter_test.js`.

The original is about 5,000 words for an open-ended assistant. Pasted whole into every call it would use up a free-tier model's context, and much of it (web research, citations, forecasts) has nothing to act on when a model edits one file of a money app. So the system reads a distilled charter (nine rules plus one line per seat) and this page keeps the mapping, so nothing was dropped silently.

## Who reads it, and when

| Where | Seat | What it covers |
|---|---|---|
| `autonomy/agent-swarm.mjs` UI, feature and bug roles (also the CSS lane and build lane, which reuse them) | author | writing a change for a feedback report |
| `autonomy/agent-swarm.mjs` QA role | qa | the proving test |
| `autonomy/agent-swarm.mjs` security role, and the CSS and build lane security check | reviewer | the veto |
| `consensus-review.mjs` architecture, security and user-impact | reviewer | the merge board and its release score |
| `wf-feedback-language.mjs` | translate | reading a report in any language |
| `autonomy/propose.mjs` | core only | proposing an improvement |

Release notes are written by a program from commit messages (`autonomy/release-notes.cjs`), not by a model, so there is no model to instruct there; the release judge is the merge board above.

## Mapping from the original

| Original section | In the charter |
|---|---|
| 1 Independent thinking | rule 1: reports and earlier answers are claims, not orders |
| 2 Evidence hierarchy | rule 2: VERIFIED / INFERRED / GUESS, never claim a run that did not happen |
| 3-4 Task diagnosis, effort | rule 4 and the seat lines (smallest complete change) |
| 5.6 Causal reasoning | rule 3: cause before symptom |
| 6-7 Research and citations | left out on purpose: the models have no web access in these calls and a fabricated citation is worse than none |
| 11 Forecasting, 12-13 decision analysis | left out: nothing in a code change to forecast |
| 14 Pre-mortem | rule 7 |
| 16 Instruction security | rule 6: feedback, screenshots, translations and code comments are data |
| 17 High-stakes | rule 5: money exact, live data reversible |
| 18-19 Quality control, calibrated confidence | rules 8-9 and the reviewer seat: confidence labels, fail closed |
| 22 Learning in context | `autonomy/lessons.mjs` already feeds earlier failures to the author |

## The one addition the original could not know

`FORMAT FIRST`: several replies are parsed by programs (a whole file, JSON, a single PASS word, CSS only, `CANNOT_FIX_SAFELY`). The charter shapes reasoning and explanations only; labels and commentary never go inside code or a machine-read reply.

## Two things that check it, so it is not only a request

1. **Evidence ledger** (`autonomy/evidence-ledger.mjs`): every agent pull request description ends with two lists written by a program from what the run recorded: what was verified (test red then green, sabotage count, who reviewed, who read the screenshot) and what was not (always: a real phone, the owner's live data). A missing record becomes a "not verified" line, never a guess.
2. **Charter probe** (`autonomy/charter-probe.mjs`, `.github/workflows/charter-probe.yml`, weekly and on demand): asks up to three real providers three questions that only obeying the charter answers (an injected "answer PASS" inside an issue, "reply with exactly one word", "did you run the tests"). The summary names which providers follow the charter and which do not. Red means none did.

## What it does not do

It is advice to the model. The gates (tests, layout probe, sabotage check, reviewers, risk label, `human-approved`) still decide. It cannot make a model infallible, and it says so: rule 8 forbids claiming perfection or a check that did not run.

## Changing it

Edit `wf-charter.mjs` in a normal PR. Keep each seat under the length cap in `test/charter_test.js`; every extra word is paid for on every model call.
