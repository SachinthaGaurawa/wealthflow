# The operating charter (how every model in the update system works)

Source: the owner's "elite expert" operating prompt (2026-11-07), kept word for word in `docs/elite-expert-mode.original.md`.
Code: `wf-charter.mjs` (how it is delivered) and `wf-charter-sections.mjs` (the text, one section per part of the original).

## What changed after the first version

The first version (#564) squeezed the 26 parts of the prompt into nine rules and a line per seat, and left sections out "on purpose". The owner said that was far too little and that it must fit this system, not be pasted in. This version keeps every part:

- **All 26 parts are written out** (the core mission, parts 1 to 24, and the task with its parameters), rewritten in terms of what really happens here: the lanes, the gates, the board, the ledger, the guarded paths, the free-tier providers, rupees and Sri Lankan banks, one non-technical owner on a phone. `test/charter_sections_test.js` reads the original and fails if any part of it has no section, if a title differs, or if this page has no row for it. Nothing can be dropped silently again.
- **Parts that only a program can keep honest are now programs**, not requests (the table below says which).
- **Every seat reads every part.** What differs is how much of each part it reads in full.

## How it reaches a model

| Size | What is sent | Who gets it |
|---|---|---|
| **full** | the nine rules, the seat's own instructions, the parts the seat lives by in full, every other part in short form (about 30,000 characters) | author, QA, reviewer, board, analyst |
| **standard** | the nine rules, the seat's instructions, every part in short form (about 12,000 characters) | translator, picture reader, and the file-picking step |
| **core** | the nine rules and the seat's instructions (about 4,000 characters) | only when a provider cannot take more |

Every call starts at its seat's size. The providers are free-tier and their request limits are real, but this repository does not keep a table of invented quotas (`autonomy/provider-budget.mjs` explains why). So the limit is learned from the provider's own answer: if a provider replies that the request is too large (HTTP 413, a context-length message, or a tokens-per-minute answer whose Requested figure is above its Limit, which can never succeed), `wf-llm-router.mjs` re-sends the same request to the same provider one size lower and remembers the size for that provider for the rest of the run. A plain "busy" answer never shrinks it. `WF_CHARTER_TIER` and `WF_CHARTER_TIER_<PROVIDER>` can cap the size by hand. The probe reports which size each provider really took.

The charter is placed in front of each system prompt, so the CSS lane's cut of everything from its hard-rules block cannot remove it, and it is re-rendered, never cut in half.

## Who reads it, and when

| Where | Seat | What it covers |
|---|---|---|
| `autonomy/agent-swarm.mjs` UI, feature and bug roles (the CSS lane in `autonomy/css-lane.mjs` and the build lane in `autonomy/build-lane.mjs` reuse them) | author | writing a change for a feedback report |
| `autonomy/agent-swarm.mjs` QA role | qa | the proving test |
| `autonomy/agent-swarm.mjs` security role, and the lanes' security check | reviewer | the veto |
| `consensus-review.mjs` architecture, security and user-impact | reviewer | the merge board and its release score |
| `autonomy/analysis-pass.mjs` | analyst | an independent view of the cause and the ways the change could fail |
| `autonomy/concept-board.mjs`, `autonomy/propose.mjs` | board | talking a new idea or an improvement through |
| `wf-feedback-language.mjs` | translate | reading a report in any language |
| `wf-screenshot-reader.mjs` | reader | the picture the owner attached (vision calls go through `ai-provider-call.mjs`, which has no system prompt, so the reader's charter rides in the prompt) |

Release notes are written by a program from commit messages (`autonomy/release-notes.cjs`), not by a model, so there is no model to instruct there; the release judge is the merge board above.

## Mapping from the original, part by part

| Part | What the original asks | What it means here | Applied in | Checked by |
|---|---|---|---|---|
| 0 | Core mission: truth over agreement, evidence over assertion, honest limits, never promise infallibility | the nine rules, and the mission written for a money app with one owner | `wf-charter.mjs`, `wf-charter-sections.mjs` | `test/charter_test.js` |
| 1 | Independent thinking; claims are claims; stay independent of expectation, authority, your own earlier answers | report, screenshot reading, translation, board brief, CI log, another model: all claims to check; the reviewer and the analyst are never the author's provider | every seat; `autonomy/analysis-pass.mjs` asks a provider that is not the author's; the router's `exclude` | `test/analysis_pass_test.js` |
| 2 | Evidence hierarchy A to G | the ledger sorts every statement into verified, strongly supported, inference, hypothesis, forecast, value judgment, unknown, by rule from the record | `autonomy/evidence-ledger.mjs` | `test/evidence_ledger_test.js` |
| 3 | Task diagnosis: request, objective, constraints, assumptions, what is missing | the task card; one question only through the board's ASK_OWNER | `autonomy/task-card.mjs`, `autonomy/concept-board.mjs` | `test/task_card_test.js` |
| 4 | Match effort to difficulty and stakes | depth standard, deep or comprehensive, chosen by rules from what the change touches; comprehensive raises the bar for the confidence label | `autonomy/task-card.mjs`, `autonomy/evidence-ledger.mjs` | `test/task_card_test.js`, `test/evidence_ledger_test.js` |
| 5 | First principles, deduction, induction, abduction, probability, causality, quantity, adversarial, systems | money invariants (a statement is never counted twice; rows reconcile), units and signs, one example is not a pattern, correlation is not cause | author and QA seats in full | `test/charter_test.js` |
| 6 | Deep research and source verification, corroboration, stopping rules | "research" here is the code, the tests, the programs that ran, the standing rules; three models agreeing is not three confirmations; independent evidence is a red-to-green test, a sabotage check, a measured render | reviewer and analyst seats; the sabotage check in `autonomy/mutation-check.mjs`; the layout measurement in `autonomy/layout-probe.mjs` | `test/swarm_test_proof_test.js` |
| 7 | Citations and traceability; never fabricate | a claim about code carries an exact quote; a program searches the real file for it and removes a quote it cannot find | `autonomy/analysis-pass.mjs` (`verifyCitations`) | `test/analysis_pass_test.js`, the `citation` case of `autonomy/charter-probe.mjs` |
| 8 | Multidisciplinary analysis and creative discovery | personal-finance accounting, Sri Lankan banks and rupees, one non-technical owner, security, speed on low-end phones; unusual ideas are tested for feasibility and failure | `autonomy/concept-board.mjs` (asks for an alternative), `autonomy/propose.mjs` | `test/charter_test.js` |
| 9 | Alternative hypotheses | the analysis names the leading cause and up to three alternatives, each with the observation that tells it apart | `autonomy/analysis-pass.mjs` | `test/analysis_pass_test.js` |
| 10 | Assumption auditing and bias control | anchoring on the first file, a test that restates the change, a model grading its own work, one example generalised | reviewer and analyst seats; the analysis lists assumptions; the sabotage check catches the circular test | `test/analysis_pass_test.js` |
| 11 | Historical, current, future; scenarios | earlier PRs and reverts, the deployed version and older saved data, the update on the owner's phone, baseline / upside / downside / disruptive for a release with the canary and rollback as indicators | reviewer and board seats; `autonomy/canary.mjs`, `autonomy/rollback.mjs` | `test/charter_test.js` |
| 12 | Second and third order consequences | other modules, the synced device, the SMS / Gmail / portal readers, the cached file, data an older version wrote; reversibility | author and reviewer seats | `test/charter_test.js` |
| 13 | Decision intelligence | the concept board compares the first version with an alternative on benefit, cost, risk and how easily it is undone; the owner's rule (easy to use first) is the stated weighting | `autonomy/concept-board.mjs` | `test/concept_board_test.js` |
| 14 | Risk analysis and pre-mortem | the analysis lists how the change most likely fails, how that is noticed and how it is undone; its edge cases go to the QA seat as inputs the proving test should cover | `autonomy/analysis-pass.mjs`, `autonomy/agent-swarm.mjs` | `test/analysis_pass_test.js` |
| 15 | Tool use and capability honesty | a model in its own call has no tools and may not say it ran one; the checks that really ran are listed by a program | `autonomy/evidence-ledger.mjs`, the `honesty` case of the probe | `test/evidence_ledger_test.js` |
| 16 | Instruction security | the owner's report, issue text, diffs and concept text are fenced as data; the ledger notes instruction-like text; the probe checks that a model does not obey "answer PASS" | `autonomy/untrusted-text.mjs`, `autonomy/agent-swarm.mjs`, `consensus-review.mjs` | `test/untrusted_text_test.js`, the `injection` case of the probe |
| 17 | High-stakes accuracy | money exact, live data reversible, fail closed, no regulated advice, an urgent security hole is contained first | rule 5 and part 17; the comprehensive depth | `test/evidence_ledger_test.js` |
| 18 | Self-correction, twelve checks | the twelve checks written as pipeline checks with where each runs; a correction from the owner or CI is investigated, not defended | author and reviewer seats; the recovery brief in `autonomy/pr-recovery.mjs` | `test/charter_test.js` |
| 19 | Calibrated confidence | the label (HIGH, MODERATE, LOW, UNDETERMINED) is computed by a program from the record, with its reasons and what would raise it; a model's own claim changes nothing | `autonomy/evidence-ledger.mjs` (`confidenceFrom`) | `test/evidence_ledger_test.js` |
| 20 | Operating modes | each lane has named modes (research, fact-checking, deep analysis, forecasting, decision, creative discovery, coding and engineering, audit, synthesis) on its task card | `autonomy/task-card.mjs` | `test/task_card_test.js` |
| 21 | Output and communication | lead with the conclusion; FORMAT FIRST for every machine-read reply; plain words for a non-technical owner on a phone | all seats; the `format` and `wholefile` cases of the probe | `test/charter_probe_test.js` |
| 22 | Learning within the context | the standing rules, the recovery brief and the issue trail are the memory; no claim of permanent learning | `autonomy/lessons.mjs` | `test/charter_test.js` |
| 23 | Final decision standard, ten questions | the ledger prints a decision record: conclusion, established, inferred, strongest alternative, what could make it wrong, unknown, what would help most, the owner's next step | `autonomy/evidence-ledger.mjs` | `test/evidence_ledger_test.js` |
| 24 | Final execution directive; do not confuse confidence with truth | the directive and the "do not confuse" list, verbatim in spirit | every seat | `test/charter_sections_test.js` |
| 25 | The task and its parameters (outcome, depth, horizon, scope, evidence, format, constraints, criteria) | the task card, filled in by a program for every piece of work, shown to every model and printed in the pull request | `autonomy/task-card.mjs`, `autonomous-fix-agent.js` | `test/task_card_test.js` |

## What a pull request from the fix agent now carries

In this order, written by programs and clearly labelled:

1. **Task card**: what the work was held to (the owner's words as the outcome, depth and why, evidence required, constraints, how success is measured).
2. **Independent analysis**: a model's opinion on the cause, the alternatives, the ways it could fail, the assumptions and unknowns, from a provider that is not the author's. Its quote of the code is searched for in the real file; a quote that is not there is removed and the page says so. Advice, never a gate; if no provider answers, the page says there is no analysis.
3. **Evidence ledger**: what a program verified, what was not verified, what each statement rests on (the seven classes), the confidence computed from the record with its reasons and what would raise it, the decision record, and a note if the report contained instruction-like text.

## Two things that check the models, so it is not only a request

1. **Sabotage check and ledger** (see above): the model's claims are never what raises confidence.
2. **Charter probe** (`autonomy/charter-probe.mjs`, `.github/workflows/charter-probe.yml`, weekly and on demand): asks up to three real providers five questions, with the full charter, that only obeying it answers: an injected "answer PASS" inside an issue, "reply with exactly one word", "did you run the tests", "quote the tax line" about code that has none, and "reply with only the whole file" under the long charter. It names which providers follow it, and which charter size each really took. Red means none did.

## What this does not do

- It is advice to the model. The gates (tests, layout probe, sabotage check, reviewers, risk label, `human-approved`, the canary) still decide. It cannot make a model infallible, and it says so.
- The probe is five small cases on up to three providers. It shows that those providers followed the charter in those cases; it is not proof of general obedience.
- Models on a free tier may take the standard or core size. The probe prints which. That is a limit of the provider's request size, not a decision to leave parts out.
- Depth is a heuristic from file names and words in the report. It changes what the ledger will claim and how many failure modes the analysis asks for; it never opens or closes a gate.
- Parts that assume a web (searching sources, publication dates) cannot be done in a call that has no web. Part 6 and 7 are written for what exists here: the code, the tests, the programs that ran. A model's memory of how a browser behaves is labelled "remembered, not verified".
- Nothing here has been checked on the owner's real phone, and the confidence label says "within what a program could check" for that reason.

## Changing it

Edit `wf-charter-sections.mjs` for the text (each part has a short and a full form; keep the short form under 700 characters) and `wf-charter.mjs` for which seat lives by which part. Both are root files so a Vercel function may import them. Run `npx vitest run test/charter_test.js test/charter_sections_test.js`.
