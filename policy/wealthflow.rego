package main

# WealthFlow autonomous-pipeline policy (Blueprint Phase 4).
# Conftest evaluates these against a JSON describing the PR:
#   { "files": ["a.js",...], "labels": ["fuzz-passed",...], "additions": <int> }
# Any `deny` blocks the merge.
# These are deterministic, mathematically-checkable
# guardrails that sit UNDER the probabilistic multi-model review.
import future.keywords.in

# ── critical paths that may only change after the fuzz gate passes ──
sensitive_exact := {"firestore.rules", "firebase.json", "firestore.indexes.json"}
sensitive_substr := ["auth", "oauth", "crypto", "fifo-reconcile", "allocator", "send-otp", "verify-otp"]

is_sensitive(f) { f in sensitive_exact }
is_sensitive(f) { some p in sensitive_substr;
contains(lower(f), p) }

fuzz_passed { "fuzz-passed" in input.labels }
human_approved { "human-approved" in input.labels }

# RULE 1 — sensitive infra (auth / rules / crypto / money) requires the fuzz gate.
# This is the PDF's "100k randomized fuzzing iterations" guard, expressed as a
# required label set by the fuzz job.
# Without it, the merge is blocked.
deny[msg] {
    some f in input.files
    is_sensitive(f)
    not fuzz_passed
    not human_approved
    msg := sprintf("BLOCKED: '%s' is a critical path; requires the fuzz gate (label 'fuzz-passed') or 'human-approved'.", [f])
}

# RULE 2 — anti "Toxic Proactivity": the agent may NOT weaken its own guardrails.
# Changes to the workflows, this policy, CODEOWNERS, or the release/approve control
# surface require an explicit human-approved label.
# This makes it impossible for the
# pipeline to disable the very checks that constrain it.
guardrail(f) { startswith(f, ".github/workflows/") }
guardrail(f) { startswith(f, "policy/") }
guardrail(f) { f == "CODEOWNERS" }
guardrail(f) { contains(f, "approve-release") }
guardrail(f) { contains(f, "consensus-review") }

deny[msg] {
    some f in input.files
    guardrail(f)
    not human_approved
    msg := sprintf("BLOCKED: '%s' governs the autonomous pipeline's own safety; requires 'human-approved'.", [f])
}

# RULE 3 — new code logic must ship with tests (the PDF's "prove its efficacy").
# If any non-test JS/MJS logic file changed, at least one test file must be present.
changed_code {
    some f in input.files
    re_match(`\.(js|mjs)$`, f)
    not contains(f, "test")
    not f == "index.html"
}
has_test {
    some f in input.files
    contains(f, "test")
}
deny[msg] {
    changed_code
    not has_test
    not human_approved
    msg := "BLOCKED: code changed without an accompanying test file (add a test or 'human-approved')."
}
