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
    // With wf-inbox sealed in firestore.rules, Firestore no longer checks anything
    // here: this module IS the per-device boundary for the money ingestion path,
    // and it holds the service-account bootstrap.
    ['inbox-store.mjs',                     'the only remaining per-device boundary on the inbox'],
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

    /* =========================================================================
       MY OWN GUARD WAS WRONG, AND THIS RECORDS HOW
       -----------------------------------------------------------------------
       The first version of the assertion below was:

           const open = /allow\s+[a-z, ]*\s*:\s*if\s+true\s*;/i.test(src);
           expect(open).toBe(false);

       It rejected ANY `allow …: if true` anywhere in the file. The moment the
       real production rules were committed, it failed — because a share link
       MUST be readable without signing in, so `match /s/{shortId} { allow read:
       if true }` is correct by design, not a mistake.

       So the guard would have blocked the very file it spent three CI runs
       demanding. Its stated intent was to catch the Firebase console's TEST-MODE
       default; its implementation caught every deliberate public path as well.
       Written too broadly, a guard produces false findings, and a guard that
       produces false findings gets switched off — which is how a repository ends
       up with no guard at all.

       The replacement checks the invariant that actually distinguishes test mode
       from a real policy: what the ROOT catch-all does. Test mode is
       `match /{document=**} { allow read, write: if true }` — everything open,
       nothing scoped. A real policy ends with a default DENY and grants access
       only inside named collections.

       Deliberately NOT asserted here: that `wf-inbox/**` denies unauthenticated
       write. It currently allows it, the rules file says so in its own HARDENING
       TODO, and the fix is the firebase-admin migration in the next PR. Asserting
       it here would hold that migration hostage to a test that only the migration
       can turn green. It gets its assertion in the PR that closes it, where it
       goes green on arrival — a guard should land with its fix, not before it.
       ====================================================================== */
    it('firestore.rules is a real policy, not the console test-mode default', () => {
        const p = path.join(ROOT, 'firestore.rules');
        if (!fs.existsSync(p)) return;   // the existence assertion above already failed
        const src = fs.readFileSync(p, 'utf8');

        expect(src, 'firestore.rules names no collection — it cannot be scoping anything')
            .toMatch(/match\s+\/databases\//);

        // The root catch-all, i.e. `match /{document=**}` at the outermost level.
        // Its body is what test mode opens and a real policy closes.
        const root = src.match(/match\s+\/\{document=\*\*\}\s*\{([^}]*)\}/);
        expect(root, 'firestore.rules has no root catch-all rule, so anything not '
            + 'explicitly matched is undefined rather than denied').toBeTruthy();
        expect(root[1], 'the ROOT catch-all grants access — this is the console test-mode '
            + 'default and it leaves every collection in the database open')
            .not.toMatch(/if\s+true/i);
        expect(root[1], 'the root catch-all should deny by default').toMatch(/if\s+false/i);

        // The two collections holding private financial data must be owner-scoped.
        //
        // `[^\n]*` and not `[^{]*` here, which cost a CI round to learn: the real
        // declaration is `match /users/{uid}/{document=**} {`, so `[^{]*` stops at
        // the brace of `{document=**}` and the capture group returns the string
        // "document=**" instead of the rule body. The assertion then failed against
        // correct rules — a guard reading the wrong bytes and reporting confidently
        // on them, which is the same defect class this file exists to catch.
        for (const coll of ['users', 'userAI']) {
            const m = src.match(new RegExp(`match\\s+/${coll}/\\{uid\\}[^\\n]*\\{\\s*([^}]*)\\}`));
            expect(m, `firestore.rules does not scope /${coll}/{uid} at all`).toBeTruthy();
            expect(m[1], `/${coll}/{uid} is not restricted to its owner`).toMatch(/isOwner\(uid\)|request\.auth\.uid\s*==\s*uid/);
            expect(m[1], `/${coll}/{uid} grants unconditional access`).not.toMatch(/if\s+true/i);
        }
    });

    it('wf-inbox is sealed — the assertion #112 deferred until its fix landed', () => {
        /* #112 deliberately did NOT assert this. wf-inbox was
         * `allow read, write: if true` at the time, because inbox-push/pull/ack
         * reached Firestore over REST with only the public Web apiKey, which rules
         * see as unauthenticated. Asserting it there would have held the fix hostage
         * to a test only the fix could turn green.
         *
         * The fix is the Admin SDK migration (inbox-store.mjs): the service account
         * bypasses rules, so no client needs access to this branch at all. That is
         * what makes the assertion possible, and it goes green on arrival — a guard
         * landing WITH its fix rather than ahead of it.
         *
         * This branch holds classified bank transactions that the app applies
         * straight to the ledger, so `if true` here meant anyone who learned a
         * device hash could read a stranger's transactions, inject one they never
         * made, or delete ones they did. */
        const p = path.join(ROOT, 'firestore.rules');
        if (!fs.existsSync(p)) return;
        const src = fs.readFileSync(p, 'utf8');
        const m = src.match(/match\s+\/wf-inbox\/\{deviceHash\}[^\n]*\{\s*([^}]*)\}/);
        expect(m, 'firestore.rules no longer scopes /wf-inbox at all').toBeTruthy();
        expect(m[1], 'wf-inbox grants access to clients — it holds bank transactions the app '
            + 'applies straight to the ledger, and the server reaches it via the Admin SDK, '
            + 'which does not need a rule')
            .not.toMatch(/if\s+true/i);
        expect(m[1], 'wf-inbox should deny outright').toMatch(/if\s+false/i);
    });

    it('firestore.rules carries no unresolved placeholder', () => {
        // The file shipped for months with a commented-out
        // 'PASTE_YOUR_ADMIN_FIREBASE_UID_HERE' inside isAdmin(). It was harmless
        // (an empty `in []` list is always false) and that is exactly why it was
        // never noticed: a placeholder that fails closed looks identical to a
        // decision. isAdmin() is now a custom claim, which needs nothing pasted
        // in and can be revoked without redeploying rules.
        const src = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
        expect(src, 'firestore.rules still contains a PASTE_/YOUR_ placeholder')
            .not.toMatch(/PASTE_[A-Z_]+|YOUR_[A-Z_]+_HERE/);
        const m = src.match(/function\s+isAdmin\(\)\s*\{([^}]*)\}/);
        expect(m, 'isAdmin() is gone entirely — /feedback would lose its admin branch').toBeTruthy();
        expect(m[1], 'isAdmin() is back to an inline uid list, which drifts and needs a '
            + 'rules redeploy to revoke').not.toMatch(/uid\s+in\s+\[/);
        expect(m[1], 'isAdmin() no longer checks a custom claim').toMatch(/request\.auth\.token\.admin/);
    });

    it('the public share collections cannot be enumerated or tampered with', () => {
        /* These four hold statements a user chose to share, and every one of them
         * used to be `allow read: if true` with `allow create, update: if true`.
         *
         * Two separate holes, both invisible because sharing still worked:
         *
         *  · `read` is `get` + `list`. Nothing in the codebase ever lists these
         *    collections — every reader fetches one document by a random id — so
         *    granting `list` widened the surface for no caller at all.
         *
         *  · `update` exists here for exactly one caller: statement-view.js bumps
         *    a view counter over unauthenticated REST. Left unpinned it also
         *    covers the payload field, which is not something an anonymous
         *    counter should be able to reach.
         *
         * create stays open on s/ and shared_statements/ because statement-store.js
         * still mints them over REST with the public Web API key. That is the last
         * HARDENING TODO, and it gets its assertion in the PR that closes it. */
        const src = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
        const body = (coll) => {
            const m = src.match(new RegExp(`match\\s+/${coll}/\\{\\w+\\}[^\\n]*\\{([^}]*)\\}`));
            expect(m, `firestore.rules does not scope /${coll} at all`).toBeTruthy();
            return m[1];
        };
        for (const coll of ['shared_statements', 'shared_stmts', 's', 'links']) {
            const b = body(coll);
            expect(b, `/${coll} still uses a blanket \`read\`, which permits listing the whole `
                + 'collection — every reader in the codebase fetches a single document by id')
                .not.toMatch(/allow[^:\n]*\bread\b[^:\n]*:\s*if\s+true/i);
            expect(b, `/${coll} does not allow the single-document get its share links need`)
                .toMatch(/allow[^:\n]*\bget\b[^:\n]*:\s*if\s+true/i);
            expect(b, `/${coll} permits deletion`).not.toMatch(/allow[^:\n]*\bdelete\b[^:\n]*:\s*if\s+true/i);
        }
        // The two counters: update is allowed, but only for the counter field.
        for (const [coll, field] of [['shared_statements', 'views'], ['s', 'v']]) {
            const b = body(coll);
            expect(b, `/${coll} allows an unrestricted update — anyone could rewrite the shared `
                + 'statement itself, not just the view counter')
                .not.toMatch(/allow[^:\n]*\bupdate\b[^:\n]*:\s*if\s+true/i);
            expect(b, `/${coll} no longer pins its update to the '${field}' counter`)
                .toMatch(new RegExp(`allow\\s+update:\\s*if\\s+onlyChanges\\(\\['${field}'\\]\\)`));
        }
        // links/ has no writer left anywhere in the codebase; it must stay sealed.
        expect(body('links'), 'links/ accepts writes again — nothing in the codebase writes it')
            .toMatch(/allow[^:\n]*\bwrite\b[^:\n]*:\s*if\s+false/i);
        expect(src, 'onlyChanges() helper is missing, so the update rules above cannot evaluate')
            .toMatch(/function\s+onlyChanges\(fields\)/);
    });

    it('nothing in the browser bundle lists a share collection', () => {
        // The guard above is only safe because of this fact. If a future change
        // adds a .where()/.orderBy() on one of these, `allow list: if false`
        // silently breaks it — so the two are asserted together.
        const files = ['index.html', ...fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f))];
        for (const f of files) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            for (const coll of ['shared_statements', 'shared_stmts', 's', 'links']) {
                expect(src, `${f} runs a query against /${coll}, which \`allow list: if false\` denies`)
                    .not.toMatch(new RegExp(`collection\\('${coll}'\\)\\s*\\.(where|orderBy|limit|onSnapshot|get)\\b`));
            }
        }
    });

    it('the inbox endpoints no longer depend on that hole being open', () => {
        // The rule above may only be sealed because the code stopped needing it.
        // If an endpoint went back to the REST API with an apiKey, sealing the rule
        // would break the pipeline — so the two facts are asserted together.
        for (const f of ['inbox-push.js', 'inbox-pull.js', 'inbox-ack.js']) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
                .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
            expect(code, `${f} imports the Admin-SDK store`).toMatch(/from '\.\/inbox-store\.mjs'/);
            expect(code, `${f} is back on the Firestore REST API, which needs the rule reopened`)
                .not.toMatch(/firestore\.googleapis\.com/);
            expect(code, `${f} still uses the public apiKey`).not.toMatch(/FIREBASE_API_KEY/);
        }
    });

    it('that test-mode check can actually fail (guards the corrected guard)', () => {
        // The blunt version passed against real rules for the wrong reason and
        // then failed against them for the wrong reason. This proves the
        // replacement still rejects genuine test mode.
        const testMode = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
        const root = testMode.match(/match\s+\/\{document=\*\*\}\s*\{([^}]*)\}/);
        expect(root).toBeTruthy();
        expect(root[1]).toMatch(/if\s+true/i);          // detected
        expect(root[1]).not.toMatch(/if\s+false/i);     // and no default deny
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
