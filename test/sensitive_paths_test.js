/* =============================================================================
 * test/sensitive_paths_test.js
 * -----------------------------------------------------------------------------
 * THE VULNERABILITY THIS PINS
 *
 * Two workflows each carried their own hand-written list of "sensitive paths",
 * and they had drifted apart:
 *
 *   auto-merge.yml     SENSITIVE        covered .github/, policy/, autonomy/,
 *                                       release.cjs, CODEOWNERS, and more
 *   wealthflow-ci.yml  SENSITIVE_REGEX  covered none of them
 *
 * The second one is the job literally named "Risk gate (sensitive paths need
 * human approval)". So a PR touching only .github/workflows/ — the files that
 * define every gate in this repository, including the Risk gate itself — was
 * told "✓ No sensitive paths touched — eligible for auto-merge". PR #61
 * demonstrated it live: Risk gate green, conftest red.
 *
 * Nothing shipped unreviewed, because auto-merge.yml's classifier and the rego
 * both still covered those paths. But a boundary gate that abstains on the
 * highest-privilege file class leaves the rego as the only control that must
 * not fail — and a gate that fails open is a defect this pipeline has already
 * produced once (the consensus board, #57).
 *
 * WHY THIS TEST SHELLS OUT TO grep
 * The regexes are evaluated by `grep -iE` inside a GitHub runner. POSIX ERE and
 * JavaScript RegExp are NOT the same language, so re-implementing the match in
 * JS would test a different engine than the one that guards the repository —
 * a green test describing a match that never happens. Every case below runs the
 * literal string from the YAML through the literal command the workflow uses.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** Pull a single-quoted shell assignment out of a workflow file. */
function extractRegex(file, varName) {
    const src = read(file);
    const m = new RegExp(`${varName}='([^']*)'`).exec(src);
    if (!m) throw new Error(`${varName} not found in ${file} — retarget this test`);
    return m[1];
}

/** Exactly what the workflow runs: echo "$CHANGED" | grep -iE "$REGEX". */
function matches(regex, filePath) {
    try {
        const out = execFileSync('grep', ['-iE', regex], {
            input: filePath, encoding: 'utf8',
        });
        return out.trim().length > 0;
    } catch (e) {
        if (e.status === 1) return false;   // grep: no match
        throw e;                            // grep: actual error (bad regex)
    }
}

const RISK_GATE = extractRegex('.github/workflows/wealthflow-ci.yml', 'SENSITIVE_REGEX');
const AUTO_SAFE = extractRegex('.github/workflows/auto-merge.yml', 'SENSITIVE');

/**
 * Paths that must require human approval, with the reason each one is here.
 * This list is the single source of truth; the two workflow regexes are checked
 * against it rather than against each other, so "both are equally wrong" cannot
 * pass.
 */
const MUST_BE_GATED = [
    // The pipeline's own machinery — the gap that prompted this test.
    ['.github/workflows/wealthflow-ci.yml', 'the Risk gate itself'],
    ['.github/workflows/auto-merge.yml',    'the auto-merge classifier'],
    ['.github/actions/changed-files/action.yml', 'the diff every gate reads'],
    ['policy/release.rego',                 'the rego firewall'],
    ['autonomy/substantive.cjs',            'decides when the owner is told an update exists'],
    ['autonomy/perf-budget.mjs',            'the payload ceilings'],
    ['release.cjs',                         'cuts and pushes releases'],
    ['release-brain.js',                    'decides what ships'],
    ['CODEOWNERS',                          'who must review'],
    ['consensus-review.mjs',                'the review board'],
    ['autonomous-fix-agent.js',             'writes code unattended'],
    ['vitest.config.js',                    'can disable the suite wholesale'],
    // Money, auth, data rules, and the code the browser executes.
    ['index.html',                          'the app itself'],
    ['sw.js',                               'decides what code the device runs'],
    ['vercel.json',                         'routing and cache headers'],
    ['firestore.rules',                     'who can read the owner data'],
    ['firebase.json',                       'hosting + rules deployment'],
    ['package.json',                        'dependency surface'],
    ['package-lock.json',                   'the resolved dependency tree'],
    ['send-otp.js',                         'auth'],
    ['verify-otp.js',                       'auth'],
    // The shared-statement capability. `?s=<id>` is the ONLY thing between the
    // public internet and someone's loan statement or Elite Report PDF: store
    // mints that id, view serves the document to whoever presents it. Neither
    // was gated by anything until a masked `require()` was found to have
    // silently downgraded the id from a CSPRNG to Math.random() for the whole
    // life of the file — a change no automated check would have questioned.
    ['statement-store.js',                  'mints the only access token on a shared statement'],
    ['statement-view.js',                   'serves that statement to whoever presents the token'],
    // sw.js decides what code the device RUNS; this decides whether the device
    // is ever TOLD new code exists. It owns the version comparison, the update
    // prompt and the "Required security update" banner, and it was covered by
    // nothing until #107 — a PR fixing a live update-suppression bug that
    // passed every gate in this repo without a human being asked.
    ['wealthflow-update-system.js',         'decides whether users are ever offered an update'],
    // api/router.js is the SINGLE function Vercel builds. Every /api request on
    // this deployment enters through it; it picks the handler AND decides how the
    // handler is called. A change here cannot break one endpoint — it breaks all
    // 33. #111 is the proof: a convention mismatch between the router and its
    // handlers left twelve endpoints answering 500 or nothing at all for months,
    // and that PR was auto-labelled `auto-safe` because no list matched it.
    ['api/router.js',                       'every /api request enters here, and it decides how each handler is called'],
    // The ingestion path for money. sms-ingest accepts a bank SMS from the public
    // internet; inbox-push writes the classified transaction; inbox-pull serves it
    // back and the app applies it STRAIGHT TO THE LEDGER; inbox-ack deletes it. A
    // defect here does not merely lose data — it can write a transaction nobody
    // made, or delete one they did.
    ['sms-ingest.js',                       'accepts a bank SMS from the public internet'],
    ['inbox-push.js',                       'writes a classified transaction under a device capability'],
    ['inbox-pull.js',                       'serves transactions the app applies straight to the ledger'],
    ['inbox-ack.js',                        'deletes transactions on the caller\'s word'],
    // Lowering this file's default, or removing its abort, silently removes the
    // deadline from every outbound call the server makes.
    ['fetch-timeout.mjs',                   'the timeout policy for every outbound server call'],
];

/* =============================================================================
   THE GATE MUST GUARD A FILE THAT EXISTS
   ---------------------------------------------------------------------------
   Every assertion above tests a REGEX against a STRING. That is necessary and
   not sufficient: `firestore.rules` and `firebase.json` were listed as gated,
   matched by all three layers, and asserted here — while neither file had ever
   been committed to this repository. `git log --all --diff-filter=A` returns
   nothing for both.

   So the governance was airtight around an absence. Three independent layers
   stood ready to demand human approval for a change to a file that could not be
   changed, because it was not there, and every one of them reported success.

   It matters more than a missing config, because of what these two files ARE.
   autonomy/secret-scan.mjs allows the public Firebase apiKey to live in this
   repo with the justification that "access is controlled by Firestore/Storage
   security rules and App Check" — so the repo's own security argument rests on a
   control that is not version-controlled, cannot be reviewed in a PR, cannot be
   diffed when it changes, and cannot be restored if someone edits it in the
   Firebase console by mistake.

   These assertions therefore check the filesystem, not a pattern. They are
   expected to FAIL until the live rules are exported and committed, and that
   failure is the point: it is the first time this repository has been able to
   say the files are missing.
   ========================================================================== */
const MUST_EXIST = [
    ['firestore.rules', 'the only control protecting the owner\'s financial data, and the one '
        + 'autonomy/secret-scan.mjs cites to justify shipping the public Firebase key'],
    ['firebase.json', 'declares WHICH rules file is deployed and to which targets — without it, '
        + 'a committed firestore.rules is a document nothing publishes'],
];

describe('the files the gate protects are actually in the repository', () => {
    for (const [file, why] of MUST_EXIST) {
        it(`${file} exists — ${why}`, () => {
            const p = path.join(ROOT, file);
            expect(
                fs.existsSync(p),
                `${file} is gated by all three layers and asserted by this test, but the file is `
                + `NOT IN THE REPOSITORY. Export it from the live project and commit it:\n`
                + `    firebase init  (or)  firebase firestore:rules:get > firestore.rules\n`
                + `Until then every guard covering it passes over an absence.`,
            ).toBe(true);
        });

        it(`${file} is not an empty placeholder`, () => {
            // A zero-byte file would satisfy existsSync and re-create the same
            // vacuum with a filename attached.
            const p = path.join(ROOT, file);
            if (!fs.existsSync(p)) return;   // the assertion above already failed
            expect(fs.readFileSync(p, 'utf8').trim().length,
                `${file} exists but is empty — that is the same absence with a filename`)
                .toBeGreaterThan(0);
        });
    }

    it('firestore.rules actually restricts something, rather than allowing everything', () => {
        // `allow read, write: if true;` is the Firebase console's test-mode default.
        // A committed rules file containing it would pass every check above while
        // leaving the database open to the internet, which is precisely the
        // "machinery present, signal absent" shape this whole test file exists for.
        const p = path.join(ROOT, 'firestore.rules');
        if (!fs.existsSync(p)) return;
        const src = fs.readFileSync(p, 'utf8');
        const open = /allow\s+[a-z, ]*\s*:\s*if\s+true\s*;/i.test(src);
        expect(open, 'firestore.rules grants unconditional access (`if true`) — that is test mode, '
            + 'not a security rule, and it leaves the owner\'s data readable and writable by anyone')
            .toBe(false);
        expect(src, 'firestore.rules names no collection — it cannot be scoping anything')
            .toMatch(/match\s+\/databases\//);
    });

    it('the existence check can fail (guards a vacuous pass)', () => {
        // Without this, a typo in MUST_EXIST would make the loop above assert
        // nothing while still printing green.
        expect(fs.existsSync(path.join(ROOT, 'this-file-does-not-exist.rules'))).toBe(false);
        expect(MUST_EXIST.length).toBeGreaterThan(1);
        for (const [f] of MUST_EXIST) {
            expect(MUST_BE_GATED.some(([g]) => g === f), `${f} must also be in MUST_BE_GATED`).toBe(true);
        }
    });
});

describe('the Risk gate covers the files that define the Risk gate', () => {
    for (const [file, why] of MUST_BE_GATED) {
        it(`gates ${file} — ${why}`, () => {
            expect(matches(RISK_GATE, file), `${file} is NOT gated by the Risk gate`).toBe(true);
        });
    }
});

describe('the two gates agree, so they cannot drift apart again', () => {
    for (const [file] of MUST_BE_GATED) {
        it(`auto-safe classifier also covers ${file}`, () => {
            expect(matches(AUTO_SAFE, file), `${file} is NOT covered by auto-merge.yml`).toBe(true);
        });
    }
});

describe('ordinary changes still flow without a human', () => {
    // A gate that stops everything gets switched off. These must NOT be flagged,
    // or the whole autonomous pipeline deadlocks on trivia.
    const ORDINARY = [
        'wealthflow-insights.js',
        'wealthflow-merchants.js',
        'test/feedback_test.js',
        'CHANGELOG.md',
        'merchants.json',
        'README.md',
    ];
    for (const file of ORDINARY) {
        it(`does not gate ${file}`, () => {
            expect(matches(RISK_GATE, file), `${file} should NOT need human approval`).toBe(false);
        });
    }
});

describe('the rego agrees with both workflows', () => {
    /* THE THIRD LIST. This test was written to stop the Risk gate and the
     * auto-merge classifier drifting apart — but policy/wealthflow.rego holds a
     * third copy of the same judgement, and nothing compared it to the other
     * two. That is the identical defect one layer down: the rego is the control
     * that MUST NOT fail, and it was the only one with no cross-check.
     *
     * The rego expresses the boundary as rules rather than a regex, so this
     * asserts coverage rather than string equality — every gated path must be
     * reachable by some `guardrail(f)` or `is_sensitive(f)` clause. */
    const REGO = fs.readFileSync(path.join(ROOT, 'policy/wealthflow.rego'), 'utf8');

    // Mirror of the rego's two mechanisms, kept deliberately dumb so a change to
    // the rego that this mirror cannot express shows up as a failure here.
    const exactSet = (REGO.match(/sensitive_exact\s*:=\s*\{([^}]*)\}/) || [, ''])[1]
        .split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const substrList = (REGO.match(/sensitive_substr\s*:=\s*\[([^\]]*)\]/) || [, ''])[1]
        .split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const startsWith = [...REGO.matchAll(/guardrail\(f\) if startswith\(f,\s*"([^"]+)"\)/g)].map((m) => m[1]);
    const equals     = [...REGO.matchAll(/guardrail\(f\) if f == "([^"]+)"/g)].map((m) => m[1]);
    const contains   = [...REGO.matchAll(/guardrail\(f\) if contains\(f,\s*"([^"]+)"\)/g)].map((m) => m[1]);
    // Both spellings of the argument. The first version of this mirror read only
    // `regex.match(`P`, f)`, so a clause written against `lower(f)` — the more
    // careful spelling, since it also catches Inbox-Push.js — was INVISIBLE to the
    // cross-check and reported as an ungated file. Same shape as the sw.js false
    // finding below: a checker that does not model everything it is checking.
    const patterns = [...REGO.matchAll(/guardrail\(f\) if regex\.match\(`([^`]+)`,\s*(lower\()?f\)?\)/g)]
        .map((m) => ({ re: m[1], lower: !!m[2] }));
    // Not every human-approval requirement lives in guardrail(). RULE 5 pins
    // sw.js with an inline `lower(f) == "sw.js"` inside its own deny block, and
    // the first version of this mirror missed it and reported sw.js as an
    // ungated file — a false finding produced by a checker that did not model
    // what it was checking. Exactly the failure this suite exists to catch, so
    // it is named here rather than quietly patched.
    const inlineEq = [...REGO.matchAll(/lower\(f\)\s*==\s*"([^"]+)"/g)].map((m) => m[1]);

    const regoGates = (f) =>
        exactSet.includes(f)
        || substrList.some((p) => f.toLowerCase().includes(p))
        || startsWith.some((p) => f.startsWith(p))
        || equals.includes(f)
        || contains.some((p) => f.includes(p))
        || inlineEq.includes(f.toLowerCase())
        || patterns.some((p) => new RegExp(p.re).test(p.lower ? f.toLowerCase() : f));

    it('parsed real rules out of the rego rather than an empty list', () => {
        // Without this the whole block passes loudest when the parse breaks.
        expect(exactSet.length + substrList.length, 'sensitive_* did not parse').toBeGreaterThan(5);
        expect(startsWith.length + equals.length + contains.length + patterns.length,
            'no guardrail() clauses parsed').toBeGreaterThan(5);
    });

    for (const [file, why] of MUST_BE_GATED) {
        it(`rego also gates ${file} — ${why}`, () => {
            expect(regoGates(file), `${file} is gated by the workflows but NOT by the rego`).toBe(true);
        });
    }

    it('still lets ordinary files through', () => {
        for (const f of ['wealthflow-insights.js', 'CHANGELOG.md', 'merchants.json']) {
            expect(regoGates(f), `${f} would deadlock every autonomous change`).toBe(false);
        }
    });
});

describe('the regexes are valid and were really found', () => {
    it('both were extracted, not silently defaulted', () => {
        expect(RISK_GATE.length).toBeGreaterThan(50);
        expect(AUTO_SAFE.length).toBeGreaterThan(50);
    });

    it('grep accepts both — a malformed regex must fail loudly here, not in CI', () => {
        // grep exits 2 on a bad pattern; matches() rethrows that, so a syntax
        // error in either list surfaces as a red test rather than as a gate that
        // errors at merge time.
        expect(() => matches(RISK_GATE, 'anything.js')).not.toThrow();
        expect(() => matches(AUTO_SAFE, 'anything.js')).not.toThrow();
    });
});
