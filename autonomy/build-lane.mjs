/* =============================================================================
 * autonomy/build-lane.mjs — the lane that can ADD something new   (owner, 2026-11-04 18:20Z)
 * -----------------------------------------------------------------------------
 * WHY (owner): "feedback එකෙන් ... bugs, new integrations, new ideas, ... fully automatically." The swarm can
 * only rewrite ONE existing root module, so "add a loan-affordability calculator" or "integrate X" always ended
 * "no safe editable file matches this issue". This lane builds the missing thing as a NEW self-contained module.
 *
 * WHAT IT MAKES for one issue (nothing else is touched):
 *   1. a new root file  wealthflow-<slug>.js  (browser IIFE, attaches window.WF<Name>, mounts itself safely)
 *   2. its proving test  test/auto-<slug>-<issue>.test.js, run red (module absent) then green (module present)
 *   3. ONE <script defer> line in index.html and the payload ceilings in autonomy/perf-budget.mjs raised to the
 *      measured value (see wireModule). Both are mechanical edits, never model-written, and both are named in
 *      the pull request so the person who applies `human-approved` sees exactly what moved.
 *
 * WHAT IT WILL NOT DO (on purpose, enforced by code, not by the prompt):
 *   · edit any existing file other than index.html (one added line) and perf-budget.mjs (numbers);
 *   · write the books: DB.set / DB.remove, localStorage.clear, indexedDB deletes, Firestore or Firebase calls;
 *   · eval, new Function, document.write, dynamic import(), script injection, or a literal secret.
 * A new module may READ the books (DB.get) and show or compute from them. Changing existing records is the
 * single-file swarm's job, with its review, because that is where money semantics can break.
 *
 * Every gate the swarm has still applies: structural check, real parser, an independent reviewer on a DIFFERENT
 * provider with a veto, a test that must fail before and pass after, then CI, the board and `human-approved`.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { chat, stripFences, extractJson } from './llm-router.mjs';
import {
    isSensitive, structuralCheck, isValidJs, reviewPrompt, parseVerdict, reviewSeesWholeChange,
    testPrompt, verifyTestProves, verificationPlan, TEST_ROUNDS, ROLES,
} from './agent-swarm.mjs';
import { measure, BUDGETS } from './perf-budget.mjs';

export const NAME_RE = /^wealthflow-[a-z0-9]+(?:-[a-z0-9]+){0,4}\.js$/;
export const API_RE = /^WF[A-Z][A-Za-z0-9]{2,30}$/;
export const MAX_MODULE_CHARS = 24_000;
const SCRIPT_ANCHOR = '<script src="wealthflow-update-system.js" defer></script>';

/** Lines of text that make a module unacceptable no matter what it is for. Each has a plain reason. */
const FORBIDDEN = [
    [/\beval\s*\(/, 'uses eval()'],
    [/\bnew\s+Function\s*\(/, 'uses new Function()'],
    [/\bdocument\.write(?:ln)?\s*\(/, 'uses document.write()'],
    [/\bimport\s*\(/, 'uses dynamic import()'],
    [/\bimportScripts\s*\(/, 'uses importScripts()'],
    [/createElement\(\s*['"](?:script|iframe|embed|object)['"]\s*\)/, 'creates a script, iframe, embed or object element'],
    [/\bDB\s*\.\s*(set|remove|delete|clear|replace)\s*\(/, 'writes the books through DB (a new module may only read them)'],
    [/localStorage\s*\.\s*clear\s*\(/, 'clears localStorage'],
    [/indexedDB\s*\.\s*deleteDatabase/, 'deletes an IndexedDB database'],
    [/\bfirebase\b|\bfirestore\b|getFirestore|initializeApp/i, 'talks to Firebase directly'],
    [/\b(sk|pk|ghp|gho|xox[bp]|AKIA|AIza)[-_A-Za-z0-9]{16,}/, 'contains something that looks like a secret'],
    // No HTML strings at all: a heuristic that only catches template literals is not a gate (a reviewer found `innerHTML = userVar` passes it).
    [/\.\s*(?:inner|outer)HTML\s*(?:[+]?=|\+=)|insertAdjacentHTML\s*\(|\bsrcdoc\s*=/, 'builds HTML from strings (use createElement and textContent)'],
];

/**
 * A module may READ the books or TALK to the network, never both. A module that can do both can send the owner's
 * records anywhere, however innocent its stated purpose, and a model-written "read-only" label is not a control.
 * So a calculator or a card that shows the books has no network at all, and an integration that fetches public data
 * has no way to read what the person has recorded.
 */
const NETWORK = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b|\bnew\s+Image\s*\(|\bnavigator\s*\.\s*serviceWorker\b|\bWorker\s*\(|\bpostMessage\s*\(|\.\s*(?:src|href)\s*=\s*[^;]*(?:https?:)?\/\//;
const PRIVATE_READ = /\bDB\s*\.\s*(?:get|all|keys|read)\b|\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bdocument\s*\.\s*cookie\b|\bcaches\b/;

export function forbiddenIn(code) {
    const out = FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why);
    if (NETWORK.test(code) && PRIVATE_READ.test(code)) out.push('both reads the books or storage and uses the network (it must do one or the other)');
    return out;
}

/** Does this report ask for something NEW, which no existing module can be edited to provide? */
export function buildLaneFor(issue) {
    const t = `${issue?.title || ''}\n${issue?.body || ''}`.toLowerCase();
    // a defect that happens to mention "new page" is a defect, not a request for something new
    if (/\b(crash\w*|freez\w*|white screen|blank screen|overlap\w*|wrong (?:total|amount|number|value)|not working|doesn'?t work|broken|error|bug)\b/.test(t)) return { applies: false, why: '' };
    if (/\b(integrat\w*|connect(?:ion)? (?:to|with)|webhook|new (?:page|screen|module|widget|tool|calculator|report|section|tab|dashboard)|add an? (?:new )?(?:calculator|widget|tool|report|page|screen|dashboard|tracker|planner|simulator|checker))\b/.test(t)) {
        return { applies: true, why: 'asks for something new' };
    }
    return { applies: false, why: '' };
}

export function planPrompt(issueText, existing) {
    return [
        'WealthFlow is a vanilla-JS personal-finance PWA (no build step). A report asks for something NEW.',
        'Decide the one new browser module that provides it.',
        '',
        'REPORT:', String(issueText).slice(0, 1800), '',
        'Modules that already exist (do not reuse a name):', existing.slice(0, 120).join(', '), '',
        'Reply with ONE JSON object and nothing else:',
        '{"name":"wealthflow-<2-5 lowercase words joined by ->.js","api":"WF<PascalCase>","summary":"one sentence","feasible":true|false,"why_not":"only when feasible is false"}',
        'feasible is false when the report needs a secret, an account sign-in, a server endpoint, or changing existing records.',
    ].join('\n');
}

export function authorPrompt(issueText, plan) {
    return [
        `Write the COMPLETE file ${plan.name} for WealthFlow, a vanilla-JS personal-finance PWA. Reply with the file contents only, no fences.`,
        '',
        'REPORT:', String(issueText).slice(0, 2000), '',
        `PURPOSE: ${plan.summary}`, '',
        'RULES (a machine checks the first group; a reviewer checks the rest):',
        `  · One IIFE: (function (root) { 'use strict'; ... })(typeof window !== 'undefined' ? window : globalThis);`,
        `  · Attach the public API to root.${plan.api}. Keep the code under ${MAX_MODULE_CHARS} characters.`,
        '  · No eval, new Function, document.write, dynamic import(), script injection, Firebase calls, or secrets.',
        '  · Read the books with root.DB.get("expenses") style calls only. Never DB.set / DB.remove. Never touch localStorage keys you did not create (prefix yours "wf_<slug>_"; a module that uses localStorage counts as reading storage).',
        '  · Build the screen with createElement and textContent only. NEVER assign innerHTML, outerHTML or insertAdjacentHTML (a machine refuses it).\n  · A module may READ the books (root.DB.get) or use the network (fetch to a public https API), NEVER both (a machine refuses it): a calculator shows the numbers the owner recorded and has no network; an integration shows public data and cannot see what the owner recorded.',
        '  · Everything is guarded: no DOM, no DB, empty lists, NaN, negative and huge numbers must not throw.',
        '  · If it shows UI, mount ONE container with a stable id the first time the page is ready (DOMContentLoaded or immediately), inside document.body, and never replace existing elements. Respect prefers-reduced-motion. Hit targets at least 44px.',
        '  · Money: LKR, two decimals, toLocaleString("en-LK"). Do arithmetic in whole cents.',
        '  · Expose pure functions on the API (for example compute(input)) so they can be tested without a DOM.',
    ].join('\n');
}

/**
 * Put the module on the page and keep the payload ceilings honest. MECHANICAL: nothing here is model-written.
 * @returns {{ok:boolean, files:string[], reason?:string, raised:string[]}}
 */
export function wireModule({ repoDir = process.cwd(), name, issue = '', now = new Date() } = {}) {
    if (!NAME_RE.test(name || '')) return { ok: false, files: [], raised: [], reason: 'not a valid module name' };
    const htmlPath = path.join(repoDir, 'index.html');
    const budgetPath = path.join(repoDir, 'autonomy', 'perf-budget.mjs');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const tag = `<script src="${name}" defer></script>`;
    if (html.includes(tag)) return { ok: false, files: [], raised: [], reason: 'already on the page' };
    const at = html.indexOf(SCRIPT_ANCHOR);
    if (at < 0 || html.indexOf(SCRIPT_ANCHOR, at + 1) >= 0) return { ok: false, files: [], raised: [], reason: 'could not find exactly one anchor line in index.html' };
    const stamp = now.toISOString().slice(0, 10);
    const nextHtml = html.slice(0, at) + `<!-- ${stamp}: ${name}, added by the build lane${issue ? ` for #${issue}` : ''} -->\n    ` + tag + '\n    ' + html.slice(at);

    // Everything is worked out in memory first and written together: a half-wired tree (a script tag with no
    // matching ceiling) is what a failure here must never leave behind.
    const m = measureWith({ repoDir, name, nextHtml });
    let src = fs.readFileSync(budgetPath, 'utf8');
    const raised = [];
    for (const key of ['htmlBytes', 'totalJsBytes', 'moduleCount', 'scriptTags', 'largestModuleBytes']) {
        const limit = BUDGETS[key];
        if (typeof limit !== 'number' || typeof m[key] !== 'number' || m[key] <= limit) continue;
        // counts move to the measured value; byte ceilings keep 0.25% headroom, so the ratchet stays tight
        const to = /Bytes$/.test(key) ? Math.ceil(m[key] * 1.0025 / 500) * 500 : m[key];
        const re = new RegExp(`(^\\s*${key}:\\s*)[0-9_]+(,)([^\\n]*)$`, 'm');
        if (!re.test(src)) return { ok: false, files: [], raised: [], reason: `could not find ${key} in perf-budget.mjs` };
        src = src.replace(re, (_, a2, b2) => `${a2}${String(to).replace(/\B(?=(\d{3})+(?!\d))/g, '_')}${b2} // ${stamp}: raised from ${limit} for ${name} (build lane${issue ? `, #${issue}` : ''}); measured ${m[key]}`);
        raised.push(`${key} ${limit} -> ${to}`);
    }
    fs.writeFileSync(htmlPath, nextHtml);
    if (raised.length) fs.writeFileSync(budgetPath, src);
    return { ok: true, files: raised.length ? ['index.html', 'autonomy/perf-budget.mjs'] : ['index.html'], raised };
}

/** The payload as it WILL be once the tag is on the page, measured without touching the tree. */
function measureWith({ repoDir, name, nextHtml }) {
    const m = measure({ repoDir });
    const htmlBytes = Buffer.byteLength(nextHtml);
    const tags = (nextHtml.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length;
    // the module is already on disk when this runs (the agent writes it first); count it only if measure() did not
    const counted = m.modules.some((x) => x.file === name);
    const bytes = counted ? 0 : (() => { try { return fs.statSync(path.join(repoDir, name)).size; } catch { return 0; } })();
    const modules = counted ? m.modules : [...m.modules, { file: name, bytes }].sort((x, y) => y.bytes - x.bytes);
    return { ...m, htmlBytes, scriptTags: tags, moduleCount: modules.length, totalJsBytes: modules.reduce((t, x) => t + x.bytes, 0), largestModuleBytes: modules[0] ? modules[0].bytes : 0 };
}

/** Bring wiring back to how it was (used when the dry run only wanted the measurement). */
export function parsePlan(text, { existing = [], repoDir = process.cwd() } = {}) {
    const j = extractJson(String(text || ''));
    if (!j || typeof j !== 'object') return { ok: false, reason: 'the plan was not JSON' };
    if (j.feasible === false) return { ok: false, reason: `not buildable as a new module: ${String(j.why_not || 'no reason given').slice(0, 200)}` };
    const name = String(j.name || '').trim(), api = String(j.api || '').trim();
    if (!NAME_RE.test(name)) return { ok: false, reason: `unusable module name "${name.slice(0, 60)}"` };
    if (!API_RE.test(api)) return { ok: false, reason: `unusable API name "${api.slice(0, 40)}"` };
    if (isSensitive(name)) return { ok: false, reason: 'that name falls under a guarded path' };
    if (existing.includes(name) || fs.existsSync(path.join(repoDir, name))) return { ok: false, reason: 'a module with that name already exists' };
    return { ok: true, plan: { name, api, summary: String(j.summary || '').slice(0, 300) } };
}

export async function runBuildLane({ issue, repoDir = process.cwd(), env = process.env, log = console.log, runTest = null, verifyTest = true } = {}) {
    const issueText = `${issue?.title || ''}\n\n${issue?.body || ''}`.trim();
    if (!issueText) return { ok: false, stage: 'input', reason: 'empty issue' };
    const providers = {};
    const role = ROLES.feature;
    const existing = fs.readdirSync(repoDir).filter((f) => /^wealthflow-.*\.js$/.test(f));

    // 1. plan
    const p = await chat({ system: role.system, prompt: planPrompt(issueText, existing), prefer: role.prefer, maxTokens: 400, temperature: 0, env });
    providers.plan = p.provider;
    const parsed = parsePlan(p.text, { existing, repoDir });
    if (!parsed.ok) return { ok: false, stage: 'plan', providers, reason: parsed.reason };
    const { plan } = parsed;
    log(`[build] plan: ${plan.name} (${plan.api}) — ${plan.summary}`);

    // 2. author the whole module
    let code = '', authored = null, why = '';
    for (let attempt = 0; attempt < 2 && !code; attempt++) {
        const a = await chat({ system: role.system, prompt: authorPrompt(issueText, plan) + (why ? `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${why}. Fix exactly that.` : ''), prefer: role.prefer, maxTokens: 9_000, temperature: attempt ? 0.2 : 0.1, env });
        providers.author = a.provider;
        const c = stripFences(a.text || '');
        const bad = !c ? ['no code came back'] : [
            ...(c.length > MAX_MODULE_CHARS ? [`longer than ${MAX_MODULE_CHARS} characters`] : []),
            ...(c.includes(`root.${plan.api}`) || c.includes(`window.${plan.api}`) || c.includes(`.${plan.api} =`) ? [] : [`does not attach ${plan.api}`]),
            ...structuralCheck('', c).problems.filter((x) => !/original/.test(x)),
            ...forbiddenIn(c),
            ...(isValidJs(c) ? [] : ['not parseable JavaScript']),
        ];
        if (bad.length) { why = bad.join('; ').slice(0, 300); log(`[build] attempt ${attempt + 1} refused: ${why}`); continue; }
        code = c; authored = a;
    }
    if (!code) return { ok: false, stage: 'author', file: plan.name, providers, reason: `no acceptable module after 2 tries: ${why}` };
    log(`[build] module written (${code.length} chars, via ${authored.provider})`);

    // 3. independent review of the WHOLE new file, on a different provider
    if (!reviewSeesWholeChange('', code)) return { ok: false, stage: 'review_too_large', file: plan.name, providers, reason: 'the module is larger than the independent review can read in full' };
    const r = await chat({ system: ROLES.security.system, prompt: reviewPrompt(issueText, plan.name, '', code), prefer: ROLES.security.prefer, exclude: [authored.provider], maxTokens: 1500, temperature: 0, env })
        .catch((e) => ({ text: '', provider: 'none', _error: e.message }));
    providers.security = r.provider;
    if (!r.text) return { ok: false, stage: 'security_unavailable', file: plan.name, providers, reason: 'no independent security reviewer was available' };
    const review = parseVerdict(r.text);
    if (review.verdict === 'FAIL') return { ok: false, stage: 'security', file: plan.name, providers, review, reason: `Agent 5 veto (${review.severity}): ${review.reason}` };
    log(`[build] Agent 5 verdict: PASS (via ${r.provider})`);

    // 4. the proving test, red (module absent) then green
    const tf = path.join('test', `auto-${plan.name.replace(/\.js$/, '')}-${issue?.number || 'x'}.test.js`);
    const target = path.join(repoDir, plan.name);
    const existed = fs.existsSync(target);
    const planV = verificationPlan({ verifyTest, ci: Boolean(env.CI) });
    if (!planV.allowed) return { ok: false, stage: 'proof', file: plan.name, providers, review, reason: planV.reason };
    const runner = (runTest && !env.CI) ? runTest : undefined;
    let test = null, proof = null, candidate = '', previous = null;
    const rounds = [];
    try {
        for (let round = 1; round <= TEST_ROUNDS; round++) {
            const t = await chat({
                system: ROLES.qa.system,
                prompt: testPrompt(issueText, plan.name, '', code, `The module is NEW: before the change the file does not exist, so the test must fail then. It attaches window.${plan.api}.`)
                    + (previous ? `\n\nYOUR PREVIOUS TEST WAS REJECTED: ${previous.reason}\n${String(previous.output || '').slice(-1200)}` : ''),
                prefer: ROLES.qa.prefer, exclude: [authored.provider, r.provider], maxTokens: 4000, temperature: round === 1 ? 0.1 : 0.2, env,
            }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
            providers.qa = t.provider;
            candidate = stripFences(t.text || '');
            if (!candidate || !/from\s+['"]vitest['"]/.test(candidate) || !/expect\s*\(/.test(candidate) || !isValidJs(candidate)) {
                previous = { reason: 'not a runnable Vitest file', output: t._error || '' }; rounds.push({ round, reason: previous.reason }); continue;
            }
            proof = planV.verify
                ? verifyTestProves({ repoDir, targetFile: plan.name, before: '', after: code, testFile: tf, testSource: candidate, log, ...(runner ? { run: runner } : {}) })
                : { ok: true, skipped: true };
            if (proof.ok) { test = candidate; break; }
            rounds.push({ round, reason: proof.reason }); previous = proof;
            log(`[build] test round ${round}/${TEST_ROUNDS}: ${proof.reason}`);
        }
    } finally {
        if (!existed) { try { fs.unlinkSync(target); } catch { /* it was never left behind */ } }
    }
    if (!test) {
        const last = rounds[rounds.length - 1] || {};
        return { ok: false, stage: 'proof', file: plan.name, code, providers, review, testRounds: rounds, reason: `the proving test did not prove anything after ${TEST_ROUNDS} tries — ${last.reason || 'no usable test'}` };
    }
    log(`[build] test verified red→green (via ${providers.qa})`);

    return {
        ok: true, stage: 'ready', lane: 'build', role: 'feature', file: plan.name, code, test, testFile: tf, testProof: proof,
        verified: Boolean(proof && proof.ok && !proof.skipped), review, providers, wire: { name: plan.name },
        change: `new module ${plan.name} (${code.length} chars): ${plan.summary}`, observation: '',
    };
}
