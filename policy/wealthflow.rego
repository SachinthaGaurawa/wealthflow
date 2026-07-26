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
guardrail(f) if startswith(f, ".github/workflows/")
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
