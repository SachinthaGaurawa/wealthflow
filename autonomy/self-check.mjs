#!/usr/bin/env node
/* =============================================================================
 * autonomy/self-check.mjs — does the autonomous system actually work?
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE MOST IMPORTANT FILE HERE
 *   Every workflow in this repo reported ✅ success while the autonomous update
 *   system did nothing at all, for months. The agent crashed in 40ms and the run
 *   was green. The test suite ran zero assertions and the check was green. The
 *   consensus reviewer pointed at a filename that did not exist. The version
 *   number climbed on merchant-data commits so the app kept announcing updates
 *   that contained nothing.
 *
 *   Fixing those individually is not enough, because the real defect is that the
 *   system could not tell the difference between working and not working. This
 *   file is that missing sense. It answers one question honestly:
 *
 *       "If a bug were reported right now, would anything actually happen?"
 *
 *   It is deliberately pessimistic. Every check must prove itself; nothing is
 *   assumed healthy because it did not throw.
 *
 * USAGE
 *   node autonomy/self-check.mjs            human-readable report
 *   node autonomy/self-check.mjs --json     machine-readable (used by the API)
 *   node autonomy/self-check.mjs --strict   exit 1 if the pipeline is broken
 *
 * EXIT: 0 healthy (or degraded) · 1 broken, with --strict
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// substantive.cjs is CommonJS (release.cjs must be able to require it), so this
// ESM module needs a real require to self-test it.
const require = createRequire(import.meta.url);

import { describeAvailability, PROVIDERS } from './llm-router.mjs';
import { isSensitive } from './agent-swarm.mjs';
import { tokenFrom, repoFrom } from './work-queue.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const OK = 'ok', WARN = 'warn', BROKEN = 'broken';

function git(args, fallback = '') {
    try {
        return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return fallback; }
}
function exists(p) { try { fs.accessSync(path.join(REPO, p)); return true; } catch { return false; } }
function read(p) { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } }

// ── 1. can the system think? ─────────────────────────────────────────────────
function checkModels() {
    const a = describeAvailability();
    if (!a.healthy) {
        return {
            id: 'models', status: BROKEN,
            summary: 'No LLM provider configured — nothing can author or review a fix.',
            detail: `Set any ONE of: ${PROVIDERS.map((p) => p.keys[0]).join(', ')}.`,
            data: { count: 0 },
        };
    }
    // One provider works, but a single provider means the security reviewer has to
    // share a model with the author, which defeats the point of an independent veto.
    const status = a.count >= 2 ? OK : WARN;
    return {
        id: 'models', status,
        summary: `${a.count} model provider(s) available: ${a.providers.map((p) => p.id).join(', ')}.`,
        detail: status === WARN
            ? 'With only one provider, the security reviewer cannot run on a different model than the author. Add a second key for a genuinely independent veto.'
            : 'Author and reviewer can be pinned to different providers.',
        data: { count: a.count, providers: a.providers.map((p) => ({ id: p.id, via: p.via, model: p.model })) },
    };
}

// ── 2. can the system see its work? ──────────────────────────────────────────
function checkQueue() {
    const token = tokenFrom(), repo = repoFrom();
    if (!token || !repo) {
        return {
            id: 'queue', status: BROKEN,
            summary: 'No GitHub token or repository — the agent cannot read its work queue.',
            detail: 'GITHUB_TOKEN and GITHUB_REPOSITORY are provided automatically inside Actions. Outside Actions, set GH_PAT.',
            data: { token: !!token, repo: repo || null },
        };
    }
    return {
        id: 'queue', status: OK,
        summary: `Work queue reachable (${repo}).`,
        detail: 'GitHub Issues is the queue. Firebase is optional enrichment and can no longer stall the pipeline.',
        data: { repo },
    };
}

// ── 3. does the safety harness actually test anything? ───────────────────────
function checkTests() {
    const cfg = ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.ts'].find(exists);
    if (!cfg) {
        return {
            id: 'tests', status: BROKEN,
            summary: 'No vitest config Vitest will load — the safety harness is inert.',
            detail: 'This is the original defect: the file was named vitest_config.js, which Vitest ignores.',
            data: {},
        };
    }
    // Count the test files the config's globs will actually match.
    let files = [];
    for (const dir of ['test', 'tests', 'autonomy']) {
        if (!exists(dir)) continue;
        for (const f of fs.readdirSync(path.join(REPO, dir))) {
            if (/[._]test\.[cm]?js$/.test(f) || /\.spec\.[cm]?js$/.test(f)) files.push(`${dir}/${f}`);
        }
    }
    if (!files.length) {
        return {
            id: 'tests', status: BROKEN,
            summary: 'Zero test files match the configured globs — every AI change would ship unverified.',
            detail: 'A green "tests passed" check that ran nothing is worse than a red one.',
            data: { config: cfg, files: [] },
        };
    }
    const pkg = (() => { try { return JSON.parse(read('package.json')); } catch { return {}; } })();
    const script = pkg?.scripts?.test || '';
    const lenient = /--passWithNoTests/.test(script);
    return {
        id: 'tests', status: lenient ? WARN : OK,
        summary: `${files.length} test file(s) will run.`,
        detail: lenient
            ? 'npm test still carries --passWithNoTests, so an empty suite would report success. Remove it.'
            : 'An empty or unmatched suite now fails instead of passing.',
        data: { config: cfg, files, script },
    };
}

// ── 4. can a workflow still call a file that does not exist? ─────────────────
/**
 * Generic guard for the class of bug that broke the consensus reviewer:
 * consensus-review.yml ran `node consensus-review.mjs` while the file on disk was
 * consensus-review.js, and the required check failed on every PR for months. Any
 * `node <file>` in any workflow is now verified to point at something real.
 */
function checkWorkflowScripts() {
    const dir = '.github/workflows';
    if (!exists(dir)) {
        return { id: 'workflow-scripts', status: WARN, summary: 'No workflows directory.', detail: '', data: {} };
    }
    const missing = [];
    const checked = [];
    for (const wf of fs.readdirSync(path.join(REPO, dir))) {
        if (!/\.ya?ml$/.test(wf)) continue;
        const body = read(`${dir}/${wf}`);
        // `node foo.js`, `node ./foo.mjs`, `node autonomy/bar.cjs` — skip `node -e/-p`
        const re = /\bnode\s+(?!-)([A-Za-z0-9._\-/]+\.[cm]?js)\b/g;
        let m;
        while ((m = re.exec(body))) {
            const target = m[1].replace(/^\.\//, '');
            checked.push({ workflow: wf, target });
            if (!exists(target)) missing.push(`${wf} → node ${target} (file does not exist)`);
        }
    }
    return {
        id: 'workflow-scripts',
        status: missing.length ? BROKEN : OK,
        summary: missing.length
            ? `${missing.length} workflow(s) invoke a script that does not exist.`
            : `All ${checked.length} script invocation(s) in workflows resolve to real files.`,
        detail: missing.length
            ? missing.join('; ')
            : 'Guards against the consensus-review.mjs/.js mismatch that blocked every PR.',
        data: { checked: checked.length, missing },
    };
}

// ── 5. is the fake-release gate armed and correct? ───────────────────────────
function checkReleaseGate() {
    if (!exists('autonomy/substantive.cjs')) {
        return {
            id: 'release-gate', status: BROKEN,
            summary: 'The fake-release gate is missing — version numbers could climb with no real change.',
            detail: '', data: {},
        };
    }
    const wf = read('.github/workflows/auto-release.yml');
    const wired = /substantive\.cjs/.test(wf);

    // Self-test the gate on a known fixture rather than trusting its presence.
    let selfTest = 'unknown';
    try {
        const { classifyDiff } = require('./substantive.cjs');
        const fake = [
            'diff --git a/merchants.json b/merchants.json',
            '--- a/merchants.json', '+++ b/merchants.json', '@@ -1 +1 @@', '-{"a":1}', '+{"a":2}',
            'diff --git a/sw.js b/sw.js', '--- a/sw.js', '+++ b/sw.js', '@@ -9 +9 @@',
            "-const CACHE_NAME = 'wealthflow-v1.0.0';", "+const CACHE_NAME = 'wealthflow-v1.0.1';",
        ].join('\n');
        const real = [
            'diff --git a/wealthflow-icons.js b/wealthflow-icons.js',
            '--- a/wealthflow-icons.js', '+++ b/wealthflow-icons.js', '@@ -1 +1,2 @@',
            '-return x;', '+if (!x) return null;', '+return x;',
        ].join('\n');
        const fakeOk = classifyDiff(fake).substantive === false;
        const realOk = classifyDiff(real).substantive === true;
        selfTest = fakeOk && realOk ? 'pass' : `FAIL (fake→${!fakeOk ? 'wrong' : 'ok'}, real→${!realOk ? 'wrong' : 'ok'})`;
    } catch (e) {
        selfTest = 'error: ' + e.message;
    }

    const broken = !wired || selfTest !== 'pass';
    return {
        id: 'release-gate',
        status: broken ? BROKEN : OK,
        summary: broken
            ? `Fake-release gate not trustworthy (wired: ${wired}, self-test: ${selfTest}).`
            : 'Fake-release gate armed and self-test passing.',
        detail: wired
            ? 'auto-release.yml consults the gate before bumping the version.'
            : 'auto-release.yml does NOT reference substantive.cjs — it can still cut fake releases.',
        data: { wired, selfTest },
    };
}

// ── 6. when did the app last genuinely change? ───────────────────────────────
function checkLastRealChange() {
    const version = (() => { try { return JSON.parse(read('version.json')).latest; } catch { return 'unknown'; } })();
    const lastTag = git(['describe', '--tags', '--abbrev=0']);

    // Walk recent history for a commit that changed something behavioural.
    const log = git(['log', '-60', '--format=%H|%ct|%s']);
    let lastReal = null, fakeReleases = 0;
    for (const line of log.split('\n').filter(Boolean)) {
        const [sha, ct, ...rest] = line.split('|');
        const subject = rest.join('|');
        const files = git(['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
        const meaningful = files.filter((f) =>
            /\.(js|mjs|cjs|html|rules)$/.test(f) &&
            !/^merchants\.json$/.test(f) &&
            !/^autonomy\/state\//.test(f));
        if (/^release: /.test(subject)) {
            // A release whose only content is version strings is a fake one.
            const nonVersion = meaningful.filter((f) => !/^(sw\.js|index\.html|wealthflow-update-system\.js)$/.test(f));
            if (!nonVersion.length) fakeReleases++;
            continue;
        }
        if (/^chore\(merchants\)/.test(subject)) continue;
        if (meaningful.length && !lastReal) {
            lastReal = { sha: sha.slice(0, 8), subject: subject.slice(0, 90), at: new Date(Number(ct) * 1000).toISOString(), files: meaningful.slice(0, 5) };
        }
    }

    const days = lastReal ? Math.floor((Date.now() - Date.parse(lastReal.at)) / 86_400_000) : null;
    const status = days === null ? WARN : days > 21 ? WARN : OK;
    return {
        id: 'last-real-change',
        status,
        summary: lastReal
            ? `Last genuine code change: ${days} day(s) ago — "${lastReal.subject}".`
            : 'No genuine code change found in the last 60 commits.',
        detail: fakeReleases
            ? `${fakeReleases} version bump(s) in recent history contained no functional change. That is the bug the release gate now prevents.`
            : 'No fake releases detected in recent history.',
        data: { version, lastTag, lastReal, fakeReleasesInRecentHistory: fakeReleases, daysSinceRealChange: days },
    };
}

// ── 7. are the guardrails still guarding? ────────────────────────────────────
function checkGuardrails() {
    const problems = [];
    for (const f of ['index.html', 'sw.js', 'firestore.rules', 'package.json',
        '.github/workflows/auto-release.yml', 'policy/wealthflow.rego',
        'autonomy/llm-router.mjs', 'autonomous-fix-agent.js']) {
        if (!isSensitive(f)) problems.push(`${f} is NOT protected by the sensitive-path gate`);
    }
    if (isSensitive('wealthflow-icons.js')) {
        problems.push('wealthflow-icons.js is wrongly protected — the agent would have nothing it may edit');
    }
    const rego = read('policy/wealthflow.rego');
    if (!/import rego\.v1|import future\.keywords/.test(rego)) problems.push('policy/wealthflow.rego is missing its keyword imports and will not compile');
    if (!/sw\.js/.test(rego)) problems.push('policy does not specifically protect the service worker');

    return {
        id: 'guardrails',
        status: problems.length ? BROKEN : OK,
        summary: problems.length ? `${problems.length} guardrail problem(s).` : 'Sensitive-path gate and policy are intact.',
        detail: problems.join('; ') || 'The agent cannot edit money, auth, crypto, rules, the service worker, CI, policy, or its own engine.',
        data: { problems },
    };
}

// ── report ───────────────────────────────────────────────────────────────────
export function runChecks() {
    const checks = [
        checkModels(), checkQueue(), checkTests(), checkWorkflowScripts(),
        checkReleaseGate(), checkLastRealChange(), checkGuardrails(),
    ];
    const broken = checks.filter((c) => c.status === BROKEN);
    const warn = checks.filter((c) => c.status === WARN);
    const overall = broken.length ? BROKEN : warn.length ? 'degraded' : 'healthy';

    return {
        overall,
        canActuallyFixBugs: !broken.length,
        checkedAt: new Date().toISOString(),
        counts: { ok: checks.length - broken.length - warn.length, warn: warn.length, broken: broken.length },
        checks,
        verdict: broken.length
            ? `BROKEN — ${broken.length} link(s) in the chain are dead: ${broken.map((b) => b.id).join(', ')}. If a bug were reported right now, nothing would happen.`
            : warn.length
                ? `DEGRADED — the loop works, but ${warn.length} thing(s) are weaker than they should be: ${warn.map((w) => w.id).join(', ')}.`
                : 'HEALTHY — a bug reported right now would be triaged, fixed, reviewed, tested, and shipped without a human.',
    };
}

const ICON = { ok: '✅', warn: '⚠️ ', broken: '❌' };

function human(r) {
    const lines = [
        '',
        '  WealthFlow — autonomous update system self-check',
        '  ' + '─'.repeat(62),
        '',
    ];
    for (const c of r.checks) {
        lines.push(`  ${ICON[c.status]} ${c.id.padEnd(18)} ${c.summary}`);
        if (c.detail) lines.push(`     ${' '.repeat(18)} ${c.detail}`);
        lines.push('');
    }
    lines.push('  ' + '─'.repeat(62));
    lines.push(`  ${r.overall.toUpperCase()}: ${r.verdict}`);
    lines.push('');
    return lines.join('\n');
}

export function markdown(r) {
    const rows = r.checks.map((c) => `| ${ICON[c.status]} | \`${c.id}\` | ${c.summary} |`).join('\n');
    return [
        `### Autonomous system self-check — ${r.overall.toUpperCase()}`,
        '',
        '| | Check | Result |',
        '|---|---|---|',
        rows,
        '',
        `**${r.verdict}**`,
        '',
        ...r.checks.filter((c) => c.status !== OK && c.detail).map((c) => `- **${c.id}:** ${c.detail}`),
    ].join('\n');
}

const invokedDirectly = (() => {
    try { return (process.argv[1] || '').endsWith('self-check.mjs'); } catch { return false; }
})();

if (invokedDirectly) {
    const r = runChecks();
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else console.log(human(r));

    if (process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(r) + '\n'); } catch { /* ignore */ }
    }
    if (process.env.GITHUB_OUTPUT) {
        try {
            fs.appendFileSync(process.env.GITHUB_OUTPUT,
                `overall=${r.overall}\nbroken=${r.counts.broken}\nverdict=${r.verdict.replace(/\n/g, ' ').slice(0, 900)}\n`);
        } catch { /* ignore */ }
    }
    if (process.argv.includes('--strict') && r.overall === BROKEN) process.exit(1);
    process.exit(0);
}
