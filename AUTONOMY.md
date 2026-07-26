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
| 3 | **The crash looked like success.** The workflow step carried `continue-on-error: true`. | Every run for months: ✅ green. |
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
| `TOGETHER_API_KEY` · `OPENROUTER_API_KEY` · `XAI_API_KEY` · `FIREWORKS_API_KEY` · `NVIDIA_API_KEY` · `SAMBANOVA_API_KEY` · `GITHUB_MODELS_TOKEN` · `HUGGINGFACE_API_KEY` · `COHERE_API_KEY` | free tiers | fallback |
| `ANTHROPIC_API_KEY` | metered | tried last, so free keys go first |

> **Set at least two.** With one provider the security reviewer has to run on the
> same model that wrote the code, which defeats the point of an independent veto.
> The self-check reports this as `degraded`.

### Required for the feedback loop

| Secret | Why |
|---|---|
| `GH_PAT` | A fine-grained PAT with **Issues: read & write** on this repo. Vercel functions need it to file feedback issues and report completions. `GITHUB_TOKEN` covers this inside Actions, but Vercel has no such token. |

Then in **Vercel → Project → Settings → Environment Variables**, add `GH_PAT`
and `GITHUB_REPO=SachinthaGaurawa/wealthflow`.

### Optional

| Name | Kind | Effect |
|---|---|---|
| `EDENAI_API_KEY` | secret | Better feedback classification. Without it a local keyword classifier is used — nothing is lost. |
| `VERCEL_TOKEN` | secret | Enables automatic rollback on a health-check failure. |
| `HEALTH_URL` | var | e.g. `https://wealthflow-personal.vercel.app/api/health` |
| `AUTONOMY_LEVEL` | var | Leave **unset** (recommended). See §4. |
| `AGENT_MAX_ATTEMPTS` | var | Default 3. |
| `FIREBASE_SERVICE_ACCOUNT` | secret | Optional enrichment only. Its absence can no longer stall anything. |

### ⚠️ Vercel environment variables — REQUIRED after the security fix

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

### 🔑 Also restrict the Firebase key

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
You type feedback in Settings  ──▶  /api/feedback-triage
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
                    auto-release  ──  substantive-change gate  ──▶ Vercel
                                      (refuses to ship a fake update)
                                              ▼
                        your device pulls it via /api/version
                                              ▼
                    "✅ Your feedback is done — shipped in v7.70.0"
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
  autonomous rewrite.
- **Free tiers rate-limit.** That is why there are 15 providers and automatic
  failover rather than one.

The one thing this system now refuses to do is pretend. A crash exits non-zero, an
empty test suite fails, a release with no change is blocked, and a dead pipeline
files an issue against itself.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Liveness fails on `models` | no model key | add one secret from §2 |
| Liveness fails on `queue` | no token | `GITHUB_TOKEN` is automatic in Actions; set `GH_PAT` elsewhere |
| Liveness says `degraded` | only one provider | add a second key so the reviewer is independent |
| Feedback gets no issue number | `GH_PAT` / `GITHUB_REPO` missing in **Vercel** | add both env vars there |
| No version bump for days | nothing substantive changed | working as intended — see §1 fault 1 |
| PR sits unmerged | a required check is red, or it touches a sensitive path | read the check output; sensitive paths need the `human-approved` label |
| Agent opens no PRs | queue is empty | the run summary says so explicitly |
