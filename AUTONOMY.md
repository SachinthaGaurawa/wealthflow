# WealthFlow — Autonomous Update System

**Read this first: the system was not working, and this document says exactly why and what to switch on.**

---

## 1. What was actually wrong

The autonomous update system had never produced a single real change. Not "worked
badly" — never ran. Every piece of evidence below was verified against this
repository, not inferred.

| # | Fault | Evidence |
|---|---|---|
| 1 | **Fake releases.** `merchant-sync` pushes a `chore(merchants)` commit every hour. `auto-release` only asked *"are there commits since the last tag?"* — always yes — so it bumped v7.69.10 → .11 → .12 with zero functional change. The app announced an update, the user installed an identical app. | `node autonomy/substantive.cjs <v7.69.11> <v7.69.12>` reports **NOT substantive**: merchant data and version strings only. The self-check finds **10** such empty bumps in recent history. |
| 2 | **The agent crashed on startup.** Its first statement was `JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)` on an unset variable. | Actions run `30200095048`: step *"Run the fix agent"* **started and completed on the same second**, logged `agent error: Unexpected end of JSON input`, exited 78. |
| 3 | **The crash looked like success.** The workflow step carried `continue-on-error: true`. | Every run for months: [OK] green. |
| 4 | **Wrong key name.** The agent read `GEMINI_API_KEY`; the configured secret is `WealthFlow_API_Key`. | Job log shows `GEMINI_API_KEY:` empty. |
| 5 | **No work queue.** Its only input was Firestore `system/pendingRelease`, which nothing populated. | — |
| 6 | **Feedback never reached the pipeline.** `/api/feedback-triage` — the only path from feedback to an actionable issue — was never called by any client code. | No reference to it outside its own file. |
| 7 | **The "send system diagnosis" tick sent almost nothing** — just user-agent, screen size and language — while a full crash report sat unused. | `_submitFeedback` vs `_wfCopyDiagnostics`. |
| 8 | **The consensus reviewer did not exist.** `consensus-review.yml` ran `node consensus-review.mjs`; the file on disk was `consensus-review.js`. | Every PR failed that required check with `MODULE_NOT_FOUND`. |
| 9 | **Policy blocked every AI fix.** Rego RULE 3 demanded a test file with every `.js` change; the agent never wrote tests. | 100% of AI PRs were mathematically unmergeable. |
| 10 | **Auto-merge could never fire.** It required an `auto-safe` label that nothing in the repo ever applied. | — |
| 11 | **The test suite ran zero tests.** `vitest_config.js` is not a filename Vitest loads, its `include` pointed at a `tests/` dir that does not exist, and the real files are named `*_test.js` which matches no default glob. `--passWithNoTests` made that green. | `npm test` printed *"No test files found, exiting with code 0"*. The gate described as *"the SAFETY HARNESS that contains AI mistakes"* had never run an assertion. |
| 12 | **The fuzz gate fuzzed nothing.** `fuzz-gate.yml` sets `FUZZ_RUNS=100000`; no test read it. | Money and auth paths were fuzzed at ordinary rates. |

Any one of these alone stops the system. All twelve were live simultaneously.

---

## 2. Switch it on — 5 minutes

### Required: one model key

**Settings → Secrets and variables → Actions → Secrets → New repository secret.**

The system works with **any single one** of these. It fails over automatically
when a provider rate-limits, so more is better but one is enough:

| Secret | Free tier | Good for |
|---|---|---|
| `CEREBRAS_API_KEY` | generous, very fast | **best first choice** — code |
| `GROQ_API_KEY` | generous, very fast | general |
| `WealthFlow_API_Key` | Gemini free tier | architecture, long context |
| `DEEPSEEK_API_KEY` | cheap | code, security |
| `MISTRAL_API_KEY` | free tier | code |
| `TOGETHER_API_KEY` · `OPENROUTER_API_KEY` · `XAI_API_KEY` · `FIREWORKS_API_KEY` · `NVIDIA_API_KEY` · `SAMBANOVA_API_KEY` · `HUGGINGFACE_API_KEY` · `COHERE_API_KEY` | free tiers | fallback |
| `ANTHROPIC_API_KEY` | metered | tried last, so free keys go first |

> **Set at least two.** With one provider the security reviewer has to run on the
> same model that wrote the code, which defeats the point of an independent veto.
> The self-check reports this as `degraded`.

### Required for the feedback loop

| Secret | Why |
|---|---|
| `GH_PAT` | A fine-grained PAT with **Issues: read & write** on this repo. Vercel functions need it to file feedback issues and report completions. `GITHUB_TOKEN` covers this inside Actions, but Vercel has no such token. Give the same token **Models: read** and the AI board's GitHub Models member uses it too (`api/ai.js` reads `GH_PAT` before `GITHUB_MODELS_TOKEN`). |

Then in **Vercel → Project → Settings → Environment Variables**, add `GH_PAT`
and `GITHUB_REPO=SachinthaGaurawa/wealthflow`.

### Optional

| Name | Kind | Effect |
|---|---|---|
| `EDENAI_API_KEY` | secret | Better feedback classification. Without it a local keyword classifier is used — nothing is lost. |
| `VERCEL_TOKEN` | secret | Enables automatic rollback on a health-check failure. |
| `HEALTH_URL` | var | e.g. `https://www.wealthflow.lk/api/health` |
| `AUTONOMY_LEVEL` | var | Leave **unset** (recommended). See §4. |
| `AGENT_MAX_ATTEMPTS` | var | Default 3. |
| `FIREBASE_SERVICE_ACCOUNT` | secret | Optional enrichment only. Its absence can no longer stall anything. |

### [WARNING] Vercel environment variables — REQUIRED after the security fix

Four live provider credentials used to be hardcoded in this repo. They are now
read from the environment, so these **must** be set in
**Vercel → Project → Settings → Environment Variables** or the matching endpoints
return a clear `503` instead of working:

| Variable | Needed by | Notes |
|---|---|---|
| `FIREBASE_API_KEY` | `inbox-ack/pull/push.js`, `statement-store/view.js` | The public Firebase Web apiKey. Not a secret, but no longer a literal in the repo. |
| `ALPHA_VANTAGE_API_KEY` | `market-data.js` | Was an `EMBEDDED_KEY_FALLBACK`. **Rotate it** — the old value is in git history. |
| `GEMINI_API_KEY` *or* `WealthFlow_API_Key` | `ai-vision.js` | Server-side vision. |
| `GROQ_API_KEY` | `ai-vision.js` | Vision fallback. **Rotate it** — the old value was served to every browser. |

Each endpoint fails loudly with a named error if its variable is missing, rather
than issuing requests with `key=undefined`.

### Key Also restrict the Firebase key

The Firebase Web `apiKey` in `index.html` is public by design and cannot be
hidden — the browser SDK needs it. But the old client vision code also used that
same key against `generativelanguage.googleapis.com`, which turned a public
identifier into a **billable** credential. That code is gone; now lock the key
down so it cannot happen again:

*Google Cloud Console → APIs & Services → Credentials → the Browser key →*
- **API restrictions:** allow only the Firebase services you actually use.
  **Do not enable the Generative Language API on this key.**
- **Application restrictions:** HTTP referrers → your Vercel domain only.
- Turn on **Firebase App Check** for Firestore and Storage.

### Verify

Run **Actions → "Pipeline liveness" → Run workflow**. It prints a table and tells
you plainly whether a reported bug would actually get fixed. Locally:

```bash
npm install
npm test                      # must report real tests, not "no test files"
npm run autonomy:status       # the honest health report
```

---

## 3. How a report becomes a shipped fix

```
You type feedback in Settings  ──  /api/feedback-triage
                                      classifies it, attaches your real
                                      diagnostics, opens a GitHub issue
                                              │
                                    issues: opened  (minutes, not hours)
                                              ▼
                            autonomous-fix-agent.js  →  the 5-role swarm
   Agent 1 UI/UX · Agent 2 Feature · Agent 3 Bug  ── one authors the change
   Agent 5 Chaos Security  ── independent veto, on a DIFFERENT model provider
   Agent 4 QA              ── writes a test that proves the fix
                                              │
                    mechanical gates: structural check · node --check
                                    · sensitive-path gate
                                              ▼
                                      pull request
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
         test suite                  consensus board (3 models)        OPA / Conftest
         (157 tests)                 architecture · security · user      5 rego rules
              └───────────────────────────────┼───────────────────────────────┘
                                       all green?
                                              ▼
                                  auto-merge (no human)
                                              ▼
                    auto-release  ──  substantive-change gate  ── Vercel
                                      (refuses to ship a fake update)
                                              ▼
                        your device pulls it via /api/version
                                              ▼
                    "[OK] Your feedback is done — shipped in v7.70.0"
```

---

## 4. Autonomy levels

`AUTONOMY_LEVEL` (repo variable):

- **unset / `pr`** — *recommended, and fully autonomous.* The agent opens a PR;
  it merges by itself the moment the test suite, consensus board and policy gate
  are green. No human is involved, but every gate is real.
- **`direct`** — commits straight to `main` and ships immediately. Faster, but it
  skips the consensus board and the policy gate.

---

## 5. What the AI may never touch

Enforced in three independent places — `autonomy/agent-swarm.mjs` (mechanical),
`policy/wealthflow.rego` (OPA), and `auto-merge.yml` (labelling):

`index.html` · `sw.js` · `*.rules` · `firebase.json` · `vercel.json` ·
`package.json` · anything matching *auth / oauth / crypto / fifo / allocator /
otp* · `predict-wealth` · `market-data` · `fx-rate` · `release.cjs` ·
`.github/**` · `policy/**` · `autonomy/**` · `CODEOWNERS` · its own agent files.

Two of these deserve their own note:

- **`sw.js`** — a bad service worker traps every installed copy of the app on
  broken cached code even after the server is fixed. Your own research report
  names this the single most dangerous failure mode for an auto-updating PWA.
  Rego RULE 5 requires a human for it, always.
- **`autonomy/**` and the agent's own files** — otherwise the most attractive
  "fix" for any failing check is to delete the check.

---

## 6. Honest limits

Your own research report says this, and it is right:

> *"'Fully autonomous' cannot guarantee zero bugs, and you should not try to make
> it. Frontier agents resolve only ~45–69% of realistic novel issues... The
> reliability comes not from the model but from the guardrails."*

So, plainly:

- **A 0% bug rate is not achievable** and no part of this claims it. What is
  achievable — and is now real — is that a bug gets triaged, fixed, independently
  reviewed, tested and shipped without you doing anything, and that a *bad* fix
  is caught by the gates instead of reaching you.
- **"100,000 virtual users in a sandbox"** is implemented as property-based fuzz
  testing that generates up to 100,000 randomised cases against the money and
  routing logic (`FUZZ_RUNS`, `test/fuzz-config.js`). That is what the research
  report recommends over mock VMs, and it is genuinely running now — the suite
  goes from 1.7s to 12.3s under the heavy gate.
- **The agent edits one module file per fix.** It cannot touch `index.html`, so
  UI work that lives in the app shell still needs a human. That is a deliberate
  limit, not an oversight — a 1.5MB single file is too blunt an instrument for an
  autonomous rewrite. Inside the allowed modules it now finds the owner of a
  behaviour by searching the code for the report's own words, and edits big
  modules (up to 400 KB) with exact SEARCH/REPLACE blocks that must each match
  exactly once — it no longer has to reproduce a whole file (`autonomy/swarm-patch.mjs`).
- **Free tiers rate-limit.** That is why there are 15 providers and automatic
  failover rather than one.

The one thing this system now refuses to do is pretend. A crash exits non-zero, an
empty test suite fails, a release with no change is blocked, and a dead pipeline
files an issue against itself.

---

## 7. Why "version numbers moved but nothing shipped" happened — and what now stops it

Found on 2026-11-03 by reading the release chain against its real run history, not
by trusting this document:

| Fault | Evidence | Fix |
|---|---|---|
| **Releases waited for a human tap that never came.** `release-brain.js` writes `system/pendingRelease` with `approval.required = true`; only `/api/approve-release` flips it. `release.cjs` then exited 2 ("awaits approval"), and the workflow treated exit 2 as a green no-op. | 70+ real changes sat un-announced for weeks behind green ticks. | `auto-release.yml` now earns approval from gates: tests pass on the exact commit, production health is OK, and the change is substantive. It then calls `release.cjs --auto-approve` (`autonomy/release-approval.cjs`). A human can still approve earlier. |
| **A declined release looked like success.** | `test/auto_release_skip_not_failure_test.js` enshrined it. | After the gates pass, a decline turns the run red and files a `pipeline-health` issue. |
| **Nobody confirmed the new version was live.** | — | The workflow polls `/api/version`, `/version.json` and `/app` until all show the new version, else it fails and files an issue. |
| **Merged work could wait for a cron.** | daily cron only | Triggers: every 6 h, on every push to `main`, and manually. |
| **Nothing noticed a stall.** | — | `autonomy/release-flow.mjs` (run by Pipeline liveness) measures merged-but-unreleased work, tag-vs-`version.json` drift and deploy drift, and files an issue when substantive changes wait longer than 8 h. |

A second finding, from the first release this chain really shipped (v7.69.36, 2026-11-03):
the **code was real** (204 non-test files changed since v7.69.35; the live `/app` is
byte-identical to a fresh build of the tag, the 35 of 81 modules that changed have new
content-hashed names) but the **announcement was false** — `release.cjs` preferred the
release brain's feedback-tally notes ("Urgent security update") over the commits, and
stored an object as `JSON.stringify` text, so What's New showed raw JSON. That made a real
release look like a number change.

| Fault | Fix |
|---|---|
| Brain notes described the feedback queue, not what shipped. | The notes for a release are now **only** derived from its commits (`autonomy/release-notes.cjs`). The brain's text is kept as a log line, never as the announcement. |
| An object was written to `version.json` as a JSON string. | Structured notes are written as structured notes; `autonomy/manifest-notes.cjs` repairs an earlier string-encoded entry in the Firestore manifest. |
| The Settings card asked the owner to "approve" a release that is already earned by gates. | Settings > Software release now shows what is live, what the version changed, and how a release happens — no approve button. |
| The post-update screen showed 8 items with no count. | It shows the real count ("See all 77 changes") and opens the full list. |

**How to check any release is real, without trusting this document:**
`git diff --stat vA..vB` for the code; build both tags (`node build.mjs --write`) and compare
the module file names in `index.html` with those in the live `/app` — the names are content
hashes, so an identical name is an identical file.

What is still **not** automatic, honestly: edits to `sw.js`, `index.html`, auth, rules,
`package.json`, `.github/**` and `autonomy/**` need the `human-approved` label by
design (section 5), and rollback needs `VERCEL_TOKEN` + `HEALTH_URL` set.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Liveness fails on `models` | no model key | add one secret from §2 |
| Liveness fails on `queue` | no token | `GITHUB_TOKEN` is automatic in Actions; set `GH_PAT` elsewhere |
| Liveness says `degraded` | only one provider | add a second key so the reviewer is independent |
| Feedback gets no issue number | `GH_PAT` / `GITHUB_REPO` missing in **Vercel** | add both env vars there |
| No version bump for days | nothing substantive changed | working as intended — see §1 fault 1 |
| PR sits unmerged | a required check is red, or it touches a sensitive path | read the check output; sensitive paths need the `human-approved` label |
| Agent opens no PRs | queue is empty | the run summary says so explicitly |

## 9. The whole system on one page, and the four 2026 techniques

The picture of the entire path (report, fix agent, gates, release, canary, the device, safety nets) is in
[`docs/update-system-diagram.md`](docs/update-system-diagram.md) (Mermaid, so it stays in the repository and
is reviewed like code). Rendered copies are in the project files as `update-system-diagram.png|svg` and
`update-journey-sequence.png|svg`. Colour says how far to trust a box: green is live and exercised, blue is new
in this change and tested, amber needs something only the owner can supply, grey is not possible on a free tier.

What each of the four techniques asked for became, and where it stops:

| Technique asked for | What exists | Where it stops (said plainly) |
|---|---|---|
| **LLM-as-a-Judge in CI/CD, with a release score** | The 3-model review board now asks every reviewer for a 0-100 score, shows it in the table, prints the lowest/average as the release score, and treats a stated PASS that carries a score under 60 as a failure (`BOARD_SCORE_FLOOR`). `consensus-review.mjs`, `test/consensus_score_test.js`. | An LLM cannot certify "100% correct". The score is an opinion, so the gate stays the unanimous stated PASS plus tests, fuzz, policy rules, secret scan and the real browser. A score only catches a reviewer contradicting itself. |
| **Self-healing DOM / agentic QA** | `test/e2e/heal.mjs`: a locator tries css, then role and name, then text, in that order; refuses an ambiguous match; logs every heal with the selector to switch to. Adopted in `test/e2e/update-journey.mjs` with a drill that renames the control and checks it is healed and logged. | A control that is really gone still fails the test (checked by a drill). Healing is for tests, never for the app, and it never edits a test on its own. |
| **Autonomous schema migrations with instant revert** | `wealthflow-migrations.js` runs a migration on a copy, measures records, money and a round trip, writes a restore point first, writes through `DB.set`, reads back, and reverts on any failure; `undo(id)` takes an applied one back. Details: [`docs/data-migrations.md`](docs/data-migrations.md). | The data is schemaless Firestore plus localStorage, so this is a versioned data-shape migration, not SQL DDL. The registry is empty because no shape change is pending. A migration that deletes records needs `countMayChange` and a person. The file is on the sensitive-path lists: an AI may draft a migration, a person approves it. |
| **Canary / Vercel Rolling Releases** | After every deploy a real Chromium opens the live release and checks six things (loads, version, files, console errors, update module, service worker), twice, 30 s apart. A red canary fails the run and files a `canary-failed` issue (`autonomy/canary.mjs`, `test/canary_test.js`). Instant Rollback is wired but optional: `autonomy/rollback.mjs` names the deployment before the release, asks Vercel for exactly that one, and says "verified" only after the live `/api/version` stopped serving the bad version (the earlier `vercel rollback` with no target was the CLI's `status` command, exited 0 and moved nothing; found in review, fixed in both the canary and `health-watchdog.yml`). | Vercel Rolling Releases answered 404 on both endpoints for this project, and a 5% slice of one owner's devices is one device, so it would prove nothing. Rollback runs only when `CANARY_ROLLBACK=true`, `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` are set; all are the owner's. On the Hobby plan Vercel allows only the previous production deployment as a target, so when a later merge has already deployed after the release the script refuses and says so instead of pretending. It has been tested against a faked Vercel, not the real API, because no token exists here. |

Also added in the same change: the update flow records whether the restore point really saved (`saved` or `not-saved`)
before an update, instead of assuming it did, and the fix agent sends a change back to its author up to twice when
before/after measurement shows no visible effect.

**Why the fix agent had not opened a pull request yet, found on issue #507 (2026-11-03).** Two real attempts failed for one reason you
can reproduce: the report named `_renderSettingsCard` in code quotes, but the excerpt shown to the author was chosen by how many of the
report's words each window contains ("version" is on hundreds of lines), so the function that writes the text to change was not in it.
Attempt 1 invented a helper nothing calls; attempt 2 correctly answered CANNOT_FIX_SAFELY. `excerptFor` now takes `pin`: a function the
report names is shown whole, first, inside its own share of the budget (`symbolsFrom`, `definitionRange` in `autonomy/swarm-patch.mjs`).
A second cause is also known and not changed: `roleFor` in `autonomy/work-queue.mjs` reads words like "fails" before the `enhancement`
label, so a feature request that says "when that read fails" is handled as a bug, and the bug role skips the revision loop above.
The third attempt (run 41744901165) got past that: the author wrote a correct patch (the agent's own measurement shows `build abc123d` on the card), and then the
proving test failed against the fixed file. Reproduced by hand: the patch draws the build id only after `fetch('/api/version')` resolves, and the shared loader's
own `fetch` rejects (offline), so a test that passes no `fetchImpl`, or checks once straight after `await refresh()`, sees nothing. Agent 4's prompt now says both
(and shows `vi.waitFor`), and the measurement text says the probe's network stub is not the test's. A test written exactly as the prompt shows it is
red on the old file and green on that patch (`verifyTestProves`, run by hand).
**First pull request opened by the agent itself: #511, from issue #510 (2026-11-04).** With the excerpt pin (#508) and the test-author repair (#509) the
run went through: the draft was reviewed, the proving test ran red then green, the pull request was opened. Three things then stood between it and a merge,
none of them in the agent: (1) every `pull_request` workflow on a PR opened by `github-actions[bot]` ends `action_required` until a repo writer re-runs it
(an August agent PR shows the owner doing exactly that), so no check exists until a human or a writer-identity re-run releases it; (2) the change touches
`wealthflow-update-system.js`, a guarded path, so it needs `human-approved` by design; (3) the +1,090 bytes pushed the module over two pinned size ceilings
(`update_ui_truth_test.js` 118,700 and `perf-budget.mjs` totalJsBytes 2,831,600), which the agent may not edit. The ceilings were raised by the measured
overshoot in a separate pull request. So the chain is proven up to an opened PR; a merge without a human still needs the approval setting changed
(Settings > Actions > General) or the agent to open PRs with a token other than `GITHUB_TOKEN`, and a feature in a guarded or size-capped file will always need a person.
Until a pull request opened by the agent has merged and the release served it, this is a repaired and exercised chain, not a proven one.

**Owner-bound, still open** (nothing here can be done from the repository): `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` and `HEALTH_URL` (rollback),
`CANARY_ROLLBACK=true` (opt in to automatic rollback), and a real update tried once on the owner's phone.

**Not possible on a free tier, and not claimed:** 100,000 live agents, a quantum state snapshot, a holographic database,
a vector database service, Sentry Seer and E2B sandboxes. The research report's own conclusion applies: the reliability
comes from the guardrails, not from the model.

## Operating charter

Every model call in the update system starts with the owner's whole operating prompt, all 26 parts (`wf-charter.mjs` and `wf-charter-sections.mjs`; the owner's original is kept verbatim in `docs/elite-expert-mode.original.md`, and `docs/update-charter.md` maps each part to the code that applies it). It comes in three sizes: core (nine rules), standard (every part, short) and full (the parts a seat lives by, written out). A provider that answers "too large" is re-sent the next size down and remembered, so free tiers keep working. The reply formats that programs parse come first. It is advice; the gates still decide, and programs enforce what a model could skip: a task card with a depth chosen by risk, an independent analysis pass by a different provider whose quote is checked against the real file, owner text fenced as untrusted data, and an evidence ledger in every agent pull request with a confidence label computed from recorded facts (never written by a model). `test/charter_sections_test.js` fails if any part of the original has no section. The weekly charter probe names which providers actually follow it and which size they took. The router also sets a provider aside for ten minutes when it answers in a way that cannot change (a refused key, a payment demand, a model with no free version), so a dead provider is not paid for on every call, and it walks the charter one size down when a provider's own numbers say one request takes more than half its minute (the 2026-11-07 probe: Groq, limit 8,000 tokens, request about 6,700, failed 11 calls in a row). A rate limit never sets a provider aside. The consensus board is always shown a list of every changed file; a file that does not fit the review budget is cut with a note instead of dropped.

## Updates: what the person decides, and how feedback becomes updates

Research and sources: `docs/update-model-research.md` (Android in-app updates, Play staged rollout, Apple phased release and Background Security Improvements, Firebase rollouts, the service worker lifecycle).

- **The person decides.** Settings > Software update offers Update now, Remind me tomorrow / in a week, Install when idle and Skip this version, each undoable. A choice belongs to one version; a newer version starts clean. A required (priority 5) update cannot be skipped and can be postponed one day, but it never locks the app, because a failed install must not shut the owner out of his money records. Rules: `wealthflow-update-policy.js`.
- **Release controls in `version.json`** (all optional): `priority` (0 to 5), `rollout` (percent of devices per version), `halted` (versions offered to nobody), `features` (`since`, `channel`, `rollout`, `default`). `node release.cjs --priority N --rollout N` writes the first two. Early access on a device puts it first in line.
- **Patches, not reinstalls.** Scripts are downloaded with their validators, so unchanged files cost a 304. The screen reports what really changed.
- **Feedback to updates.** No batching for weeks: the release job cuts a version after each merge. One piece of feedback is its own update. Feedback filed on the same day (Asia/Colombo) is one update: the fix workflow waits for a burst to end (15 quiet minutes, at most 45 after the oldest, a crash or security report does not wait), works the reports together and opens one pull request that closes all of them (`autonomy/feedback-group.mjs`, `AGENT_GROUP=0` turns it off).
- **Standing by.** A device whose update did not land files one report by itself (`WFDiagnosis.standby`); `wf_diag_standby_off` = `1` switches it off.
