package main

# =============================================================================
# WealthFlow autonomous-pipeline policy (Blueprint Phase 4)
# -----------------------------------------------------------------------------
# Conftest evaluates these rules against a JSON description of the PR:
#   { "files": ["a.js", ...], "labels": ["fuzz-passed", ...], "additions": <int> }
# Any `deny` blocks the merge. These are the deterministic, mathematically
# checkable guardrails that sit UNDERNEATH the probabilistic multi-model review.
#
# WHAT CHANGED AND WHY (RULE 3)
#   The previous RULE 3 denied any PR that changed a .js file without also
#   touching a file whose path contains "test". That is the right instinct, but
#   the autonomous agent never wrote tests — so 100% of AI-authored PRs were
#   mathematically unmergeable. Combined with the agent crashing on startup and
#   consensus-review.yml pointing at a filename that did not exist, the pipeline
#   had three independent deadlocks stacked on top of each other.
#
#   The rule is kept, because "new logic ships with a test" is genuinely what
#   makes autonomy safe. It is now SATISFIABLE instead of impossible:
#     • Agent 4 (QA) writes a proving test alongside every fix, so the normal
#       path supplies one honestly.
#     • The rule now only fires for changes that can actually alter behaviour —
#       a comment-only or data-only change no longer demands a test.
#     • `contains(f, "test")` was also too loose: a file named
#       `latest-rates.js` satisfied it by accident. It now requires a real test
#       path or filename.
# =============================================================================
# rego.v1 enables `if`, `contains`, and `some … in` together, and is required for
# the `deny contains msg if { … }` form used below. Verified against Conftest
# 0.56.0 / OPA 0.69.0, the same version the policy-gate workflow installs.
import rego.v1

# ── critical paths that may only change after the fuzz gate passes ───────────
sensitive_exact := {"firestore.rules", "firebase.json", "firestore.indexes.json"}
sensitive_substr := ["auth", "oauth", "crypto", "fifo-reconcile", "allocator", "send-otp", "verify-otp"]

is_sensitive(f) if f in sensitive_exact
is_sensitive(f) if {
    some p in sensitive_substr
    contains(lower(f), p)
}

fuzz_passed if "fuzz-passed" in input.labels
human_approved if "human-approved" in input.labels

# A real test file: lives under test/ or tests/, or is named *_test.* / *.test.*
# This replaces the old `contains(f, "test")`, which `latest-rates.js` satisfied.
is_test_file(f) if startswith(lower(f), "test/")
is_test_file(f) if startswith(lower(f), "tests/")
is_test_file(f) if regex.match(`(^|/)[^/]*[._]test\.[a-z]+$`, lower(f))
is_test_file(f) if regex.match(`(^|/)[^/]*\.spec\.[a-z]+$`, lower(f))

# ── RULE 1 ───────────────────────────────────────────────────────────────────
# Sensitive infrastructure (auth / rules / crypto / money) requires the fuzz gate.
# This is the blueprint's heavy randomised-fuzzing guard, expressed as a label
# that only the fuzz job can legitimately apply.
deny contains msg if {
    some f in input.files
    is_sensitive(f)
    not fuzz_passed
    not human_approved
    msg := sprintf("BLOCKED: '%s' is a critical path; requires the fuzz gate (label 'fuzz-passed') or 'human-approved'.", [f])
}

# ── RULE 2 — anti "toxic proactivity" ────────────────────────────────────────
# The pipeline may not weaken its own guardrails. Changes to the workflows, this
# policy, CODEOWNERS, the release/approve control surface, the autonomy engine
# itself, or the test configuration require an explicit human-approved label.
# Without this, the most attractive "fix" for any failing check is to delete the
# check.
# `.github/` and not just `.github/workflows/`: the composite action at
# .github/actions/changed-files/action.yml computes the file list that EVERY
# gate in this repository reads, including this one. It sat outside the rego
# while both workflow regexes covered it — found by the rego cross-check in
# test/sensitive_paths_test.js, which until now compared the two workflows to
# each other and never to the policy they are supposed to back up.
guardrail(f) if startswith(f, ".github/")
guardrail(f) if startswith(f, "policy/")
guardrail(f) if startswith(f, "autonomy/")
guardrail(f) if f == "CODEOWNERS"
guardrail(f) if contains(f, "approve-release")
guardrail(f) if contains(f, "consensus-review")
guardrail(f) if contains(f, "autonomous-fix-agent")
guardrail(f) if contains(f, "release.cjs")
# The test configuration is a guardrail too. A silently-inert vitest config is
# precisely how this repo ended up with a green "safety harness" that ran zero
# assertions for months.
guardrail(f) if regex.match(`^vitest\.config\.[a-z]+$`, f)
guardrail(f) if f == "package.json"
# Both workflow regexes gated these; the rego did not. Every one is already
# blocked at merge time by the Risk gate and the auto-merge classifier, so
# adding them here deadlocks nothing new — it removes the case where the rego,
# the control that must not fail, was the ONLY layer abstaining.
# package-lock.json: the resolved dependency tree.
# index.html:        the application itself.
# vercel.json:       routing, cache headers, function config.
# release-brain:     decides what ships, and writes the in-app update manifest.
guardrail(f) if f == "package-lock.json"
guardrail(f) if f == "index.html"
guardrail(f) if f == "vercel.json"
guardrail(f) if contains(f, "release-brain")
# statement-store MINTS THE ACCESS TOKEN. `?s=<id>` is the only thing between
# the public internet and someone's loan statement or Elite Report PDF, and
# statement-view serves the document to whoever presents that id. This is
# RULE 2 rather than RULE 1 deliberately: RULE 1 accepts `fuzz-passed` as an
# alternative to review, and a fuzzer cannot tell you whether a token is
# guessable. It was not covered by any gate until a masked `require()` was
# found to have silently downgraded that token to Math.random() for the
# lifetime of the file — a change no automated check would have questioned.
guardrail(f) if contains(f, "statement-store")
guardrail(f) if contains(f, "statement-view")
# sw.js is already pinned by RULE 5 because it decides WHAT CODE THE DEVICE
# RUNS. This file decides whether the device is ever TOLD that new code exists:
# it resolves the available version, owns the update prompt, and owns the
# "Required security update" banner. It was covered by no gate at all until
# #107 changed it — a PR that fixed a live suppression bug and passed every
# governance control in the repo without a human being asked.
#
# RULE 2 rather than RULE 1, for the same reason as the statement pair: RULE 1
# accepts `fuzz-passed` in place of review, and a fuzzer cannot tell you that a
# version comparison silently stopped offering updates to anyone.
guardrail(f) if contains(f, "wealthflow-update-system")
# api/router.js is the SINGLE function Vercel builds. Every /api request on this
# deployment enters through it, it decides which handler runs, and it decides how
# that handler is CALLED — Node's (req, res) or a Web Request built from it. A
# change here cannot break one endpoint; it breaks or silently disables all 33 at
# once. #111 is the proof: a mismatch between the router's convention and its
# handlers' left twelve endpoints answering 500 or nothing at all, for months,
# while every governance control in this repository stayed green. That PR was
# auto-labelled `auto-safe` and matched no gate.
guardrail(f) if f == "api/router.js"
# The inbox trio and sms-ingest are the INGESTION PATH for money. sms-ingest
# accepts a bank SMS from the public internet, inbox-push writes the classified
# transaction to the database under a hashed device token, inbox-pull serves it
# back and inbox-ack deletes it. The app auto-applies what inbox-pull returns
# straight into the user's ledger, so a defect here does not merely lose data —
# it can write a transaction nobody made, or delete one they did.
#
# RULE 2 rather than RULE 1, like the statement pair: RULE 1 accepts
# `fuzz-passed` in place of review, and a fuzzer cannot tell you that an endpoint
# is reporting a hand-off it never completed.
guardrail(f) if regex.match(`(^|/)inbox-[a-z]+\.(js|mjs)$`, lower(f))
guardrail(f) if contains(f, "sms-ingest")
# fetch-timeout.mjs is the deadline policy for every outbound call the server
# makes. Lowering its default breaks all of them at once; removing the abort
# removes every deadline in the repository with no symptom until an upstream
# stalls, which is precisely the failure it was written to end.
guardrail(f) if contains(f, "fetch-timeout")

deny contains msg if {
    some f in input.files
    guardrail(f)
    not human_approved
    msg := sprintf("BLOCKED: '%s' governs the autonomous pipeline's own safety; requires 'human-approved'.", [f])
}

# ── RULE 3 — new logic must ship with a test ─────────────────────────────────
# Only fires for files that can actually change behaviour. A change confined to
# data, docs, or the version manifest does not need a test to prove anything.
non_behavioural(f) if regex.match(`\.(json|md|txt|pdf|png|jpg|svg|ico|yml|yaml|rego)$`, lower(f))
non_behavioural(f) if startswith(lower(f), "autonomy/state/")

changed_logic contains f if {
    some f in input.files
    regex.match(`\.(js|mjs|cjs)$`, lower(f))
    not is_test_file(f)
    not non_behavioural(f)
}

has_test if {
    some f in input.files
    is_test_file(f)
}

deny contains msg if {
    count(changed_logic) > 0
    not has_test
    not human_approved
    msg := sprintf("BLOCKED: %d logic file(s) changed with no accompanying test (%v). Add a test, or label 'human-approved'.", [count(changed_logic), changed_logic])
}

# ── RULE 4 — blast-radius cap on autonomous changes ─────────────────────────
# A well-behaved autonomous fix is small. A PR that rewrites half the app is
# either a runaway agent or a prompt-injection payload, and either way a human
# should look at it first. The blueprint calls for bounding the blast radius;
# this is that bound, and it is deliberately generous for human work.
deny contains msg if {
    count(changed_logic) > 8
    not human_approved
    msg := sprintf("BLOCKED: this PR changes %d logic files. An autonomous change should be minimal; requires 'human-approved'.", [count(changed_logic)])
}

# ── RULE 5 — the service worker is never touched autonomously ───────────────
# A bad service worker can trap every installed copy of the app on broken cached
# code even after the server is fixed. The research report names this the single
# most dangerous failure mode for an auto-updating PWA, and it is exactly the
# component the user reported as broken. It changes only with a human present.
deny contains msg if {
    some f in input.files
    lower(f) == "sw.js"
    not human_approved
    msg := "BLOCKED: 'sw.js' can brick every installed PWA if it is wrong. Service-worker changes require 'human-approved'."
}

# ── RULE 6 — an autonomous PR may NEVER touch the test harness config ───────
# THIS RULE HAS NO `human-approved` ESCAPE. That is the entire point of it, and
# it is the only rule in this file built that way.
#
# WHY IT EXISTS
# Issue #78 reported that the swarm's generated tests were never executed. The
# swarm's answer, in PR #79 and then again — byte-identical — in PR #80, was to
# flip vitest.config.js from `environment: 'node'` to `environment: 'jsdom'`
# without adding the dependency. Measured on that branch: 904 passing tests
# become 0 tests and 33 errors, because `jsdom` is not installed. Told its tests
# did not run, the agent disabled every test in the repository. agent-swarm.mjs
# was never touched, so the actual defect survived untouched too.
#
# WHY A LABEL IS NOT ENOUGH HERE
# RULE 2 already listed vitest.config.* as a guardrail, and RULE 2 would have
# stopped #79. It did not stop #80 — because #80 arrived already carrying
# `human-approved`. One mislabelled PR is all it takes, and `human-approved` is
# a master key that unlocks every other rule at once. A control whose failure
# mode is "the whole suite silently runs nothing" is exactly the control that
# must not be openable by accident: this repository has already shipped a green
# safety harness that ran zero assertions for months, and that is the cost of
# being wrong here.
#
# An agent may not edit the instrument that judges it. A human editing the test
# config in a human-authored PR is unaffected — this only fires on PRs the
# pipeline itself opened, identified by the `ai-fix` label that the fix workflow
# applies to every PR it creates.
autonomous if "ai-fix" in input.labels

test_harness_config(f) if regex.match(`^vitest\.config\.[a-z]+$`, lower(f))
test_harness_config(f) if regex.match(`^vite\.config\.[a-z]+$`, lower(f))

deny contains msg if {
    autonomous
    some f in input.files
    test_harness_config(f)
    msg := sprintf("BLOCKED: '%s' configures the harness that validates autonomous work, and an autonomous PR may never change it. This denial is deliberately NOT unlockable with 'human-approved' — see RULE 6. If the test environment genuinely needs to change, a human must open that PR themselves.", [f])
}
