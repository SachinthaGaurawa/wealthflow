/* =============================================================================
 * autonomy/agent-swarm.mjs — the 5-role cognitive swarm
 * ---------------------------------------------------------------------------
 * Implements the five specialised agents from the blueprint as a real, ordered
 * pipeline over autonomy/llm-router.mjs:
 *
 *   Agent 1  ui        Hyper-Personalised UI/UX      — layout, copy, a11y, feel
 *   Agent 2  feature   Core Feature Architect        — new capability, maths
 *   Agent 3  bug       Bug & Memory Exterminator     — diagnose + minimal fix
 *   Agent 4  qa        QA & Testing Engine           — writes the proving test
 *   Agent 5  security  Chaos Security Auditor        — adversarial review, veto
 *
 * HOW THEY COMPOSE (one issue → one candidate change)
 *   route(issue) picks ONE author from {ui, feature, bug}. That author rewrites
 *   exactly one file. Agent 4 then writes a Vitest test that fails before the
 *   change and passes after it. Agent 5 reviews the diff adversarially and holds
 *   a hard veto. Only a unanimous pass reaches the local validator (node --check
 *   + the real test suite), and only a green validator reaches a PR.
 *
 * WHY A TEST IS MANDATORY, NOT OPTIONAL
 *   policy/wealthflow.rego RULE 3 denies any PR that changes .js without also
 *   touching a test file. The old agent NEVER wrote tests, so 100% of its PRs
 *   were mathematically unmergeable — a silent deadlock on top of the silent
 *   crash. Agent 4 exists to make the policy satisfiable rather than to satisfy
 *   it artificially: the test must genuinely exercise the fixed behaviour.
 *
 * ANTI "TOXIC PROACTIVITY"
 *   Every role is told, and the code enforces, that guardrails are off-limits.
 *   The swarm may not touch auth, crypto, money maths, Firestore rules, the
 *   service worker, dependency manifests, CI, or this policy — not even to make
 *   its own change pass. isSensitive() is the mechanical backstop.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chat, stripFences, extractJson } from './llm-router.mjs';

// ── the mechanical safety gate (mirrors CODEOWNERS + rego + risk-gate) ───────
const SENSITIVE = [
    /^index\.html$/i,              // 1.5MB app shell — too blunt an instrument for an agent
    /\.rules$/i, /^firebase\.json$/i, /^vercel\.json$/i,
    /^package(-lock)?\.json$/i,
    /^sw\.js$/i,                   // a bad service worker can brick every install
    /auth/i, /oauth/i, /crypto/i,
    /fifo-reconcile/i, /allocator/i,
    /approve-release/i, /release-brain/i, /release\.cjs$/i,
    /send-otp/i, /verify-otp/i,
    /predict-wealth/i, /market-data/i, /fx-rate/i,
    /^\.github\//i, /^policy\//i, /^CODEOWNERS$/i,
    /^autonomy\//i,                // the swarm may not rewrite the swarm
    // …nor the processes that drive it. Without these, the agent's single most
    // tempting "fix" for any failing run is to edit the agent that failed.
    /^autonomous-fix-agent\.js$/i,
    /^autonomous-brain\.js$/i,
    /^consensus-review\.(js|mjs)$/i,
    // THE TEST HARNESS ITSELF — an absolute bar, added after the agent tried
    // twice (PRs #79 and #80, byte-identical) to "fix" its non-running tests by
    // flipping vitest.config.js from environment 'node' to 'jsdom' without
    // adding the dependency. That change takes the suite from 904 passing to
    // 0 tests / 33 errors: it does not make the agent's tests run, it stops
    // EVERY test running. #80 even arrived carrying `human-approved`.
    //
    // An agent may not edit the instrument that judges it. There is no
    // legitimate autonomous reason to change the environment for all 34 test
    // files, and the failure mode is total and silent — precisely how this repo
    // once shipped a green "safety harness" that ran zero assertions for months.
    /^vitest\.config\.[a-z]+$/i,
    /^vite\.config\.[a-z]+$/i,
    /^HANDLEAISCAN_PATCH\.js$/i,   // a raw patch dump, not a live module
    /^ai-vision\.js$/i,            // holds provider credentials server-side
    /^inbox-(ack|pull|push)\.js$/i,
    /^statement-(store|view)\.js$/i,
];

export function isSensitive(p) {
    const f = String(p || '').trim().replace(/^\.\//, '');
    if (!f) return true;
    return SENSITIVE.some((re) => re.test(f));
}

/** Files the swarm may edit: root-level, non-sensitive, reasonably sized JS modules. */
export function candidateFiles(allFiles, { repoDir = process.cwd(), maxBytes = 120_000 } = {}) {
    return (allFiles || [])
        .filter((f) => /\.js$/i.test(f) && !f.includes('/') && !isSensitive(f) && !/\.test\.js$/i.test(f))
        .filter((f) => {
            try { return fs.statSync(path.join(repoDir, f)).size <= maxBytes; } catch { return false; }
        })
        .sort();
}

// ── role definitions ────────────────────────────────────────────────────────
const HARD_RULES = `
ABSOLUTE CONSTRAINTS — these outrank the task itself:
  • You may edit exactly ONE file, the one named in the request.
  • NEVER weaken, disable, or delete a security check, input validation,
    authentication step, or money calculation to make anything "work".
  • NEVER touch: index.html, sw.js, firestore.rules, package.json, vercel.json,
    vitest.config.*, anything matching auth/oauth/crypto/fifo/allocator/otp,
    .github/, policy/.
  • If a correct fix would require any of the above, DO NOT invent a workaround.
    Reply with exactly: CANNOT_FIX_SAFELY followed by one sentence of reasoning.
  • Preserve the file's existing style, module pattern (IIFE / window globals),
    and public API. This is a vanilla-JS PWA with no build step and no bundler:
    no imports, no TypeScript, no JSX, no optional chaining beyond ES2020.
  • Make the SMALLEST change that fully fixes the issue. Do not refactor.
`.trim();

export const ROLES = {
    ui: {
        id: 'ui',
        agent: 'Agent 1 — Hyper-Personalised UI/UX',
        prefer: ['general', 'fast'],
        system: `You are Agent 1 of WealthFlow's autonomous engineering swarm: the Hyper-Personalised UI/UX specialist for a luxury personal-finance PWA.

Your priority order is: (1) the user can understand it instantly, (2) it looks premium, (3) it is accessible (contrast, hit targets >=44px, respects prefers-reduced-motion), (4) it is fast. User-friendliness outranks cleverness every single time — this app has exactly one user and their comfort is the product.

${HARD_RULES}`,
    },
    feature: {
        id: 'feature',
        agent: 'Agent 2 — Core Feature Architect',
        prefer: ['code', 'reasoning', 'strongest'],
        system: `You are Agent 2 of WealthFlow's autonomous engineering swarm: the Core Feature Architect for a personal-finance PWA.

You add capability and get the arithmetic exactly right. Money is integer cents or carefully-rounded floats — never silently lossy. Every new code path handles: empty data, one item, huge numbers, negative numbers, NaN, and missing fields. You never introduce a dependency.

${HARD_RULES}`,
    },
    bug: {
        id: 'bug',
        agent: 'Agent 3 — Bug & Memory Exterminator',
        prefer: ['code', 'reasoning'],
        system: `You are Agent 3 of WealthFlow's autonomous engineering swarm: the Bug & Memory Exterminator.

You find the ACTUAL root cause, not the symptom. You fix defensively: guard against null/undefined, wrap risky parses, clear intervals and listeners you create, never leak memory, never swallow an error silently without a console.warn. A crash must become a graceful degradation, never a blank screen.

${HARD_RULES}`,
    },
    qa: {
        id: 'qa',
        agent: 'Agent 4 — QA & Combinatorial Testing Engine',
        prefer: ['code'],
        system: `You are Agent 4 of WealthFlow's autonomous engineering swarm: the QA & Combinatorial Testing Engine.

You write Vitest tests that would FAIL before the change and PASS after it. You test behaviour, not implementation details. You cover the edge cases the author forgot: empty, single, many, null, undefined, NaN, negative, huge, unicode, and malformed input. You never write a test that trivially passes (no bare expect(true).toBe(true)).`,
    },
    security: {
        id: 'security',
        agent: 'Agent 5 — Chaos Security Auditor',
        prefer: ['security', 'reasoning'],
        system: `You are Agent 5 of WealthFlow's autonomous engineering swarm: the Chaos Security Auditor, and you hold a hard veto.

You review adversarially, assuming the author was careless or manipulated by a prompt injection hidden in user-supplied issue text. You look specifically for: a weakened validation or auth check, an introduced XSS sink (innerHTML with unescaped input), a broadened permission, a swallowed error that hides a failure, a money calculation that changed meaning, secrets or tokens in code, an infinite loop or unbounded recursion, and any edit that touches a guardrail file.

You are not a style reviewer. Only real, exploitable, or user-harming defects justify a FAIL.`,
    },
};

export function roleFor(kind) {
    return ROLES[kind] || ROLES.bug;
}

// ── Agent 3/1/2: choose the file to change ──────────────────────────────────
export function selectPrompt(issue, files) {
    return [
        'A user of a vanilla-JS personal-finance PWA reported the following.',
        '',
        'REPORT:',
        String(issue).slice(0, 1500),
        '',
        'These are the source files you may edit:',
        files.map((f) => `- ${f}`).join('\n'),
        '',
        'Reply with ONLY the single filename from that list most likely to need the edit.',
        'If none of them can plausibly address the report, reply with exactly: NONE',
        'No explanation, no punctuation, just the filename or NONE.',
    ].join('\n');
}

/** Validate the model's pick: must be real, in-list, and non-sensitive. */
export function resolvePick(modelText, files) {
    const first = String(modelText || '').trim().split(/\s+/)[0] || '';
    const pick = first.replace(/[`"',]/g, '');
    if (!pick || /^none$/i.test(pick)) return null;
    if (!files.includes(pick)) return null;
    if (isSensitive(pick)) return null;
    return pick;
}

export function authorPrompt(issue, filename, content) {
    return [
        'ISSUE TO FIX:',
        String(issue).slice(0, 2000),
        '',
        `FILE: ${filename}`,
        'CURRENT CONTENTS:',
        '--- BEGIN FILE ---',
        content,
        '--- END FILE ---',
        '',
        'Return ONLY the COMPLETE corrected contents of this file.',
        'No markdown fences. No commentary before or after. Valid JavaScript only.',
        'If you cannot fix it safely within your constraints, reply exactly: CANNOT_FIX_SAFELY <reason>',
    ].join('\n');
}

// ── proving that the proving test proves anything ───────────────────────────
/*
 * THE DEFECT THIS SECTION EXISTS TO KILL
 *
 * Agent 4's output used to be accepted on three regexes: does it mention
 * vitest, does the string `expect(` appear, does it parse. A file that imports
 * a package this repo does not have and throws on its first line satisfies all
 * three. Five PRs (#67, #72, #73, #75, #76) shipped roughly a thousand lines of
 * generated tests on that basis. Not one assertion ever executed.
 *
 * That is this project's recurring failure in its purest form: something
 * produces an output and nothing consumes it. The check inspected the SHAPE of
 * the artifact instead of its BEHAVIOUR.
 *
 * A test is only evidence if it moves. Passing after the fix proves nothing on
 * its own — a test that asserts 1 + 1 === 2 also passes. Failing before and
 * passing after is the only transition that ties the test to the change, and it
 * is the definition Agent 4 has always been given and was never held to.
 */

/**
 * Decide whether verification may be skipped for this run.
 *
 * Agent 5 flagged the `verifyTest` parameter as a bypass. It is not reachable
 * by the swarm — the only caller is autonomous-fix-agent.js, which never passes
 * it, and that file plus .github/ are both off-limits to the agent — but a gate
 * with a silent off-switch is one careless refactor away from being off. So the
 * off-switch is refused outright where it would matter, and its own decision is
 * a pure function rather than a condition buried in a 200-line orchestrator,
 * because a guard nobody can test is a guard nobody has tested.
 */
export function verificationPlan({ verifyTest = true, ci = false } = {}) {
    if (!verifyTest && ci) {
        return { allowed: false, verify: true, reason: 'test verification cannot be disabled in CI' };
    }
    return { allowed: true, verify: Boolean(verifyTest) };
}

/**
 * Run one test file through Vitest. Returns, never throws.
 *
 * Split out from verifyTestProves() so the verifier can be driven with a stub —
 * a verifier that has only ever been exercised against real Vitest has not been
 * shown to reject anything.
 */
export function runVitestFile(testPath, { repoDir = process.cwd(), timeoutMs = 120_000 } = {}) {
    try {
        execFileSync('npx', ['vitest', 'run', testPath, '--reporter=dot'], {
            cwd: repoDir, stdio: 'pipe', timeout: timeoutMs,
            env: { ...process.env, CI: '1' },
        });
        return { passed: true, output: '' };
    } catch (e) {
        const out = [e?.stdout, e?.stderr].map((b) => (b ? String(b) : '')).join('\n').trim();
        return { passed: false, output: (out || String(e?.message || 'vitest failed')).slice(-2000) };
    }
}

/**
 * Execute Agent 4's candidate test against the file BEFORE and AFTER the fix.
 *
 * The working tree is mutated and restored: `before` is written back in a
 * `finally`, because runSwarm() returns the new code for its caller to apply
 * and must not leave a half-applied change behind if anything throws.
 *
 * @returns {{ok:boolean, reason?:string, beforeFailed:boolean|null,
 *            afterPassed:boolean|null, output?:string}}
 */
export function verifyTestProves({
    repoDir = process.cwd(),
    targetFile, before, after, testFile, testSource,
    run = runVitestFile,
    log = () => {},
} = {}) {
    if (!targetFile || !testFile || !testSource) {
        return { ok: false, reason: 'nothing to verify', beforeFailed: null, afterPassed: null };
    }
    const target = path.join(repoDir, targetFile);
    const tPath = path.join(repoDir, testFile);
    let wroteTest = false;

    try {
        fs.mkdirSync(path.dirname(tPath), { recursive: true });
        fs.writeFileSync(tPath, testSource);
        wroteTest = true;

        // 1. Against the ORIGINAL file it must FAIL. A test that already passes
        //    is describing behaviour the fix did not introduce — it is decorative.
        fs.writeFileSync(target, before);
        const pre = run(testFile, { repoDir });
        if (pre.passed) {
            return {
                ok: false, beforeFailed: false, afterPassed: null,
                reason: 'the test passes against the UNFIXED file, so it does not exercise the fix',
            };
        }
        log('[swarm] Agent 4 test fails before the fix ✓');

        // 2. Against the FIXED file it must PASS. Failing both ways means the
        //    test is broken, the fix is wrong, or — the actual history here —
        //    the test imports something this repository does not have.
        fs.writeFileSync(target, after);
        const post = run(testFile, { repoDir });
        if (!post.passed) {
            return {
                ok: false, beforeFailed: true, afterPassed: false, output: post.output,
                reason: 'the test still fails against the FIXED file, so it is broken or the fix is wrong',
            };
        }
        log('[swarm] Agent 4 test passes after the fix ✓');

        return { ok: true, beforeFailed: true, afterPassed: true };
    } catch (e) {
        return {
            ok: false, beforeFailed: null, afterPassed: null,
            reason: `could not verify the test: ${e?.message || e}`,
        };
    } finally {
        // Always hand the tree back exactly as it was found.
        try { fs.writeFileSync(target, before); } catch { /* nothing better to do */ }
        if (wroteTest) { try { fs.unlinkSync(tPath); } catch { /* ditto */ } }
    }
}

export function testPrompt(issue, filename, before, after) {
    return [
        'A fix was just made to a vanilla-JS PWA module. Write a Vitest test proving it.',
        '',
        'ISSUE THAT WAS FIXED:',
        String(issue).slice(0, 1200),
        '',
        `FILE CHANGED: ${filename}`,
        '',
        'THE ENVIRONMENT YOUR TEST WILL RUN IN — these are facts, not preferences:',
        "  · vitest.config.js sets `environment: 'node'`. There is NO `document`,",
        '    NO `window`, and NO DOM. Referencing them throws ReferenceError.',
        '  · `jsdom` is NOT installed and you may not add it. Importing it fails.',
        '  · The ONLY packages available are the ones already in package.json.',
        '    `vitest` and `fast-check` are available. Nothing else is.',
        `  · ${filename} is a browser IIFE. It has NO \`export\` statement of any`,
        '    kind, so `await import(...)` gives you a namespace with no `default`.',
        '    `module.default.anything` is undefined and will throw.',
        '',
        'HOW TO LOAD IT — the pattern that works in this repository:',
        '  Read the source with `fs.readFileSync` and evaluate it with `new Function`,',
        '  passing a hand-built fake `window`/`localStorage`, then assert against the',
        '  API the module attached to that fake window. `test/update_ui_truth_test.js`',
        '  does exactly this and is the worked example to follow. (`new Function` also',
        '  gives each test a fresh module — an ESM `import` is cached, so one test',
        '  would leak state into the next.)',
        '  If the changed logic is pure, testing it directly is fine too — but the',
        '  assertions must be meaningful, never tautological.',
        '',
        'RELEVANT PART OF THE NEW CODE:',
        '--- BEGIN ---',
        String(after).slice(0, 6000),
        '--- END ---',
        '',
        'Return ONLY the complete test file contents (ESM, `import { describe, it, expect } from "vitest"`).',
        'No markdown fences. No network, no browser.',
        '',
        'YOUR TEST WILL BE EXECUTED TWICE BEFORE IT IS ACCEPTED: once against the',
        'ORIGINAL file, where it MUST FAIL, and once against the fixed file, where it',
        'MUST PASS. A test that passes both ways is not evidence and will be rejected,',
        'and so will one that fails both ways. Target the specific behaviour the fix',
        'changed — not the module in general.',
    ].join('\n');
}

export function reviewPrompt(issue, filename, before, after) {
    return [
        'Adversarially review this autonomous code change to a personal-finance app.',
        '',
        'ISSUE IT CLAIMS TO FIX:',
        String(issue).slice(0, 1200),
        '',
        `FILE: ${filename}`,
        '',
        'BEFORE (excerpt):',
        String(before).slice(0, 5000),
        '',
        'AFTER (excerpt):',
        String(after).slice(0, 5000),
        '',
        'Reply with a single JSON object and nothing else:',
        '{"verdict":"PASS"|"FAIL","severity":"none|low|medium|high|critical","findings":["..."],"reason":"one sentence"}',
        'Use FAIL only for a real defect: weakened validation/auth, an XSS sink, changed money semantics,',
        'a swallowed failure, an unbounded loop, a leaked secret, or an edit to a guardrail file.',
    ].join('\n');
}

// ── local, non-negotiable validators ────────────────────────────────────────

/** Does this parse as JavaScript? Runs the real Node parser, not a regex. */
export function isValidJs(code, { tmpDir = process.env.RUNNER_TEMP || '/tmp' } = {}) {
    const tmp = path.join(tmpDir, `_wf_candidate_${process.pid}_${Date.now()}.mjs`);
    try {
        fs.writeFileSync(tmp, code);
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
}

/**
 * Structural sanity checks that catch the ways a free-tier model most often
 * mangles a whole-file rewrite. Cheap, deterministic, and they run before we
 * ever spend CI minutes on the change.
 */
export function structuralCheck(before, after) {
    const problems = [];
    const b = String(before || ''), a = String(after || '');
    if (!a.trim()) problems.push('empty output');
    if (a.length < b.length * 0.5) problems.push(`output lost ${Math.round((1 - a.length / b.length) * 100)}% of the file — likely truncated`);
    if (a.length > b.length * 3) problems.push('output is >3x the original — likely hallucinated bulk');
    if (/^```/m.test(a)) problems.push('markdown fence survived into the code');
    if (/\b(TODO|FIXME|\.\.\.|<your code here>)\b/.test(a) && !/\b(TODO|FIXME)\b/.test(b)) {
        problems.push('introduced a placeholder/TODO instead of real code');
    }
    // A browser module gaining Node imports means the model forgot the platform.
    if (!/^\s*import\s/m.test(b) && /^\s*import\s+.*from\s+['"]node:/m.test(a)) {
        problems.push('introduced a node: import into a browser module');
    }
    if (/\beval\s*\(/.test(a) && !/\beval\s*\(/.test(b)) problems.push('introduced eval()');
    if (/innerHTML\s*=/.test(a) && !/innerHTML\s*=/.test(b)) problems.push('introduced an innerHTML sink — review for XSS');
    // Balanced braces is a weak but useful truncation signal beyond --check.
    const count = (s, ch) => (s.match(new RegExp(`\\${ch}`, 'g')) || []).length;
    if (count(a, '{') !== count(a, '}')) problems.push('unbalanced braces');
    return { ok: problems.length === 0, problems };
}

/** Parse Agent 5's JSON verdict defensively — an unparseable review is a FAIL. */
export function parseVerdict(text) {
    const j = extractJson(text);
    if (j && typeof j.verdict === 'string') {
        const verdict = /^pass$/i.test(j.verdict.trim()) ? 'PASS' : 'FAIL';
        return {
            verdict,
            severity: String(j.severity || 'none').toLowerCase(),
            findings: Array.isArray(j.findings) ? j.findings.map(String).slice(0, 10) : [],
            reason: String(j.reason || '').slice(0, 400),
        };
    }
    // No parseable JSON — fall back to a keyword read, then fail closed.
    const t = String(text || '').toUpperCase();
    if (/\bPASS\b/.test(t) && !/\bFAIL\b/.test(t)) {
        return { verdict: 'PASS', severity: 'none', findings: [], reason: 'unstructured PASS' };
    }
    return { verdict: 'FAIL', severity: 'unknown', findings: ['reviewer returned no parseable verdict'], reason: 'fail-closed' };
}

// ── the orchestrated run ────────────────────────────────────────────────────

/**
 * Take one issue from queue to validated candidate change.
 *
 * @returns {Promise<{ok:boolean, stage:string, reason?:string, file?:string,
 *                     code?:string, test?:string, testFile?:string,
 *                     role?:string, review?:object, providers?:object}>}
 */
export async function runSwarm({
    issue,                       // { title, body, number, kind }
    repoDir = process.cwd(),
    env = process.env,
    writeTest = true,
    verifyTest = true,           // execute Agent 4's test red→green before accepting it
    log = console.log,
} = {}) {
    const issueText = `${issue?.title || ''}\n\n${issue?.body || ''}`.trim();
    if (!issueText) return { ok: false, stage: 'input', reason: 'empty issue' };

    const role = roleFor(issue?.kind);
    const providers = {};
    log(`[swarm] ${role.agent} taking issue #${issue?.number ?? '—'}`);

    // ── stage 1: which file? ────────────────────────────────────────────────
    const files = candidateFiles(fs.readdirSync(repoDir), { repoDir });
    if (!files.length) return { ok: false, stage: 'select', reason: 'no editable module files' };

    const picked = await chat({
        system: role.system, prompt: selectPrompt(issueText, files),
        prefer: role.prefer, maxTokens: 64, temperature: 0, env,
    });
    providers.select = picked.provider;
    const file = resolvePick(picked.text, files);
    if (!file) {
        return { ok: false, stage: 'select', reason: `no safe editable file matches this issue (model said: ${picked.text.trim().slice(0, 80)})`, providers };
    }
    log(`[swarm] target file: ${file} (via ${picked.provider})`);

    // ── stage 2: author the fix ─────────────────────────────────────────────
    const full = path.join(repoDir, file);
    const before = fs.readFileSync(full, 'utf8');

    const authored = await chat({
        system: role.system, prompt: authorPrompt(issueText, file, before),
        prefer: role.prefer, maxTokens: 16_000, temperature: 0.1, env,
    });
    providers.author = authored.provider;

    if (/^CANNOT_FIX_SAFELY/i.test(authored.text.trim())) {
        return { ok: false, stage: 'author', reason: authored.text.trim().slice(0, 300), file, providers };
    }
    const code = stripFences(authored.text);
    if (!code || code.trim() === before.trim()) {
        return { ok: false, stage: 'author', reason: 'model returned no change', file, providers };
    }

    // ── stage 3: mechanical gates (free, instant, no CI minutes) ────────────
    const struct = structuralCheck(before, code);
    if (!struct.ok) {
        return { ok: false, stage: 'structure', reason: struct.problems.join('; '), file, providers };
    }
    if (!isValidJs(code)) {
        return { ok: false, stage: 'syntax', reason: 'output is not parseable JavaScript', file, providers };
    }
    log(`[swarm] mechanical gates passed (via ${authored.provider})`);

    // ── stage 4: Agent 5 security veto — on a DIFFERENT provider ───────────
    const reviewed = await chat({
        system: ROLES.security.system, prompt: reviewPrompt(issueText, file, before, code),
        prefer: ROLES.security.prefer,
        exclude: [authored.provider],        // never let the author review itself
        maxTokens: 1500, temperature: 0, env,
    }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
    providers.security = reviewed.provider;

    const review = reviewed.text
        ? parseVerdict(reviewed.text)
        : { verdict: 'PASS', severity: 'none', findings: [], reason: 'no independent reviewer available — deferring to CI gates' };

    if (review.verdict === 'FAIL') {
        return { ok: false, stage: 'security', reason: `Agent 5 veto (${review.severity}): ${review.reason}`, review, file, providers };
    }
    log(`[swarm] Agent 5 verdict: PASS (via ${reviewed.provider})`);

    // ── stage 5: Agent 4 writes the proving test, and it is EXECUTED ────────
    let test = null, testFile = null, testProof = null;
    if (writeTest) {
        const t = await chat({
            system: ROLES.qa.system, prompt: testPrompt(issueText, file, before, code),
            prefer: ROLES.qa.prefer, exclude: [authored.provider],
            maxTokens: 4000, temperature: 0.1, env,
        }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
        providers.qa = t.provider;
        const candidate = stripFences(t.text);

        // Cheap shape checks first — they cost nothing and skip a Vitest run
        // that could not possibly succeed. They are a filter, NOT the gate.
        if (!candidate || !/from\s+['"]vitest['"]/.test(candidate) || !/expect\s*\(/.test(candidate) || !isValidJs(candidate)) {
            return {
                ok: false, stage: 'test', file, code, providers, review,
                reason: 'Agent 4 produced nothing that is even shaped like a test',
            };
        }

        const tf = path.join('test', `auto-${file.replace(/\.js$/i, '')}-${issue?.number || 'x'}.test.js`);

        const plan = verificationPlan({ verifyTest, ci: Boolean(env.CI) });
        if (!plan.allowed) {
            return { ok: false, stage: 'proof', file, code, providers, review, reason: plan.reason };
        }

        testProof = plan.verify
            ? verifyTestProves({ repoDir, targetFile: file, before, after: code, testFile: tf, testSource: candidate, log })
            : { ok: true, skipped: true, beforeFailed: null, afterPassed: null };

        // A change whose test does not move from red to green is not a proven
        // change, and shipping it would only re-create the situation this gate
        // was built for: a PR that looks tested and is not. Fail the run and say
        // why, rather than open a PR that rego RULE 3 would refuse anyway.
        if (!testProof.ok) {
            log(`[swarm] Agent 4's test does not prove the fix: ${testProof.reason}`);
            return {
                ok: false, stage: 'proof', file, code, providers, review, testProof,
                reason: `the proving test did not prove anything — ${testProof.reason}`,
            };
        }

        test = candidate;
        testFile = tf;
        log(`[swarm] Agent 4 wrote ${testFile}, verified red→green (via ${t.provider})`);
    }

    // `verified` is stated separately from testProof so a skipped verification
    // can never be read downstream as a passed one — the distinction that
    // decides whether this PR's evidence means anything.
    const verified = Boolean(testProof && testProof.ok && !testProof.skipped);
    return { ok: true, stage: 'ready', file, code, test, testFile, testProof, verified, role: role.id, review, providers };
}
