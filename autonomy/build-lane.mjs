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
import { taskCard, cardPrompt } from './task-card.mjs';
import { fenceUntrusted } from './untrusted-text.mjs';
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

/**
 * THE NEW TAG IS NOT OPTIONAL FOR A NEW MODULE   (owner, 2026-11-19: "the system must show a NEW label for about a week from the person's first look")
 * MEASURED: nothing in the builder ever asked for it. The idea issue said "a new option shows a NEW tag", the build lane's author prompt did not mention it,
 * and no check looked for it, so a module that DID ship would have appeared with no label at all (the live app carries exactly one tagged element, from 2026-11-07).
 * wealthflow-new-badge.js starts the week when a person first sees an element marked data-wf-new="YYYY-MM-DD"; this makes the builder mark the module's
 * container. The date must be today's: an older date could predate the person's first day and an invented later one would hide the label.
 */
export const NEW_TAG_RE = /['"]data-wf-new['"]\s*,\s*['"](\d{4}-\d{2}-\d{2})['"]/;
// the same attribute written through the DOM property: el.dataset.wfNew = '2026-11-19' (the browser makes it data-wf-new)
const NEW_TAG_DATASET_RE = /\.dataset\.wfNew\s*=\s*['"](\d{4}-\d{2}-\d{2})['"]/;
/**
 * THE TAG IS WRITTEN BY THE PROGRAM WHEN THE MODEL LEAVES IT OUT   (measured 2026-11-19, dry run on #635)
 * Both author tries wrote a working module and were refused only for the missing tag, with the exact line to add quoted back to the model both times.
 * A free-tier model that ignores a quoted instruction twice should not cost the owner the whole report. The tag is one attribute on the container the
 * module mounts, and the module names that container itself (the prompt requires a stable id), so the program can add the line next to it. Only when
 * no such place is found does the refusal stand. A wrong date is corrected the same way (an older date could predate the person's first look).
 */
export function ensureNewTag(code, today) {
    const src = String(code || '');
    if (!/\bcreateElement\s*\(/.test(src) || !/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return src;
    const found = NEW_TAG_RE.exec(src) || NEW_TAG_DATASET_RE.exec(src);
    if (found) return found[1] === today ? src : src.replace(found[0], found[0].replace(found[1], today));
    // the tag is there but its date is a variable (seen on #635: setAttribute('data-wf-new', NEW_DATE)): a machine cannot check a name, so write the date itself
    const viaName = /(\.setAttribute\(\s*['"]data-wf-new['"]\s*,\s*)([A-Za-z_$][\w$.]*)(\s*\))/.exec(src) || /(\.dataset\.wfNew\s*=\s*)([A-Za-z_$][\w$.]*)(\s*;)/.exec(src);
    if (viaName) return src.replace(viaName[0], `${viaName[1]}'${today}'${viaName[3]}`);
    // anchor: the line that gives the mounted container its id
    const anchor = /^([ \t]*)(\w+)\.id\s*=\s*['"][\w-]+['"]\s*;[ \t]*$/m.exec(src)
        || /^([ \t]*)(\w+)\.setAttribute\(\s*['"]id['"]\s*,\s*['"][\w-]+['"]\s*\)\s*;[ \t]*$/m.exec(src);
    if (!anchor) return src;
    const end = anchor.index + anchor[0].length;
    return `${src.slice(0, end)}\n${anchor[1]}${anchor[2]}.setAttribute('data-wf-new', '${today}');${src.slice(end)}`;
}
export function newTagProblems(code, today) {
    if (!/\bcreateElement\s*\(/.test(String(code || ''))) return [];       // a module that shows nothing has nothing to label
    const m = NEW_TAG_RE.exec(code) || NEW_TAG_DATASET_RE.exec(code);
    if (!m) return [`the container it shows does not carry the NEW tag: add container.setAttribute('data-wf-new', '${today}')`];
    if (m[1] !== today) return [`the NEW tag date must be today, ${today}; it says ${m[1]}`];
    return [];
}

/** Does this report ask for something NEW, which no existing module can be edited to provide? */
export function buildLaneFor(issue) {
    // An idea the system thought of itself says in its own "Likely scope" whether it is a NEW module (autonomy/propose.mjs asks it to). That is a statement of
    // what to build, not a report of a fault, so the defect words below (an idea's "risks" section often says "error") must not turn it away.
    const raw = String(issue?.body || '');
    if (/<!--\s*wf-proposal\s*-->/.test(raw) && /###\s*Likely scope[\s\S]{0,500}?\bnew\b[^.\n]{0,40}\b(?:module|file)\b/i.test(raw)) {
        return { applies: true, why: 'the idea names a new module as its scope' };
    }
    const t = `${issue?.title || ''}\n${issue?.body || ''}`.toLowerCase();
    // a defect that happens to mention "new page" is a defect, not a request for something new
    if (/\b(crash\w*|freez\w*|white screen|blank screen|overlap\w*|wrong (?:total|amount|number|value)|not working|doesn'?t work|broken|error|bug)\b/.test(t)) return { applies: false, why: '' };
    if (/\b(integrat\w*|connect(?:ion)? (?:to|with)|webhook|new (?:page|screen|module|widget|tool|calculator|report|section|tab|dashboard)|add an? (?:new )?(?:calculator|widget|tool|report|page|screen|dashboard|tracker|planner|simulator|checker))\b/.test(t)) {
        return { applies: true, why: 'asks for something new' };
    }
    return { applies: false, why: '' };
}

export function planPrompt(issueText, existing, facts = '') {
    return [
        'WealthFlow is a vanilla-JS personal-finance PWA (no build step). A report asks for something NEW.',
        'Decide the one new browser module that provides it.',
        '',
        'REPORT:', fenceUntrusted('report', issueText, 1800), '',
        ...(facts ? ['WHERE THE SCREEN IS DRAWN (read from the code by a program):', fenceUntrusted('screen code', facts, 900), ''] : []),
        'Modules that already exist (do not reuse a name):', existing.slice(0, 120).join(', '), '',
        'Reply with ONE JSON object and nothing else:',
        '{"name":"wealthflow-<2-5 lowercase words joined by ->.js","api":"WF<PascalCase>","summary":"one sentence","feasible":true|false,"why_not":"only when feasible is false"}',
        'feasible is false when the report needs a secret, an account sign-in, a server endpoint, or changing existing records.',
    ].join('\n');
}

export function authorPrompt(issueText, plan, today = new Date().toISOString().slice(0, 10), facts = '') {
    return [
        `Write the COMPLETE file ${plan.name} for WealthFlow, a vanilla-JS personal-finance PWA. Reply with the file contents only, no fences.`,
        '',
        'REPORT:', fenceUntrusted('report', issueText, 2000), '',
        ...(facts ? [
            'THE SCREEN THE REPORT IS ABOUT (the real code that draws it, read by a program; use its ids, classes and tags exactly, never invent a selector):',
            fenceUntrusted('screen code', facts, 7600),
            'Attach to that screen from OUTSIDE: one delegated listener on the element the code fills (not on each row), find the record the person tapped from the text the code prints, and show it from root.DB.get(...) as a read-only sheet. Keep the pure part (record in, lines to show out) separate from the part that touches the page, and expose the pure part on the API so a test needs no browser.', '',
        ] : []),
        `PURPOSE: ${plan.summary}`, '',
        'RULES (a machine checks the first group; a reviewer checks the rest):',
        `  · One IIFE: (function (root) { 'use strict'; ... })(typeof window !== 'undefined' ? window : globalThis);`,
        `  · Attach the public API to root.${plan.api}. Keep the code under ${MAX_MODULE_CHARS} characters.`,
        '  · No eval, new Function, document.write, dynamic import(), script injection, Firebase calls, or secrets.',
        '  · Read the books with root.DB.get("expenses") style calls only. Never DB.set / DB.remove. Never touch localStorage keys you did not create (prefix yours "wf_<slug>_"; a module that uses localStorage counts as reading storage).',
        '  · Build the screen with createElement and textContent only. NEVER assign innerHTML, outerHTML or insertAdjacentHTML (a machine refuses it).\n  · A module may READ the books (root.DB.get) or use the network (fetch to a public https API), NEVER both (a machine refuses it): a calculator shows the numbers the owner recorded and has no network; an integration shows public data and cannot see what the owner recorded.',
        '  · Everything is guarded: no DOM, no DB, empty lists, NaN, negative and huge numbers must not throw.',
        '  · If it shows UI, mount ONE container with a stable id the first time the page is ready (DOMContentLoaded or immediately), inside document.body, and never replace existing elements. Respect prefers-reduced-motion. Hit targets at least 44px.',
        `  · THE NEW TAG (a machine checks it): the ONE container you mount carries container.setAttribute('data-wf-new', '${today}') with exactly that date. The app then shows a NEW label for 7 days from the day the person first sees it, and removes it by itself.`,
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

/** Every check the author's file must pass, in one place so a revised file is held to exactly the same rules as the first. */
function moduleProblems(c, plan, today) {
    return !c ? ['no code came back'] : [
        ...(c.length > MAX_MODULE_CHARS ? [`longer than ${MAX_MODULE_CHARS} characters`] : []),
        ...(c.includes(`root.${plan.api}`) || c.includes(`window.${plan.api}`) || c.includes(`.${plan.api} =`) ? [] : [`does not attach ${plan.api}`]),
        ...structuralCheck('', c).problems.filter((x) => !/original/.test(x)),
        ...forbiddenIn(c),
        ...newTagProblems(c, today),
        ...(isValidJs(c) ? [] : ['not parseable JavaScript']),
    ];
}

export async function runBuildLane({ issue, facts = '', repoDir = process.cwd(), env = process.env, log = console.log, runTest = null, verifyTest = true } = {}) {
    const issueText = `${issue?.title || ''}\n\n${issue?.body || ''}`.trim();
    if (!issueText) return { ok: false, stage: 'input', reason: 'empty issue' };
    const providers = {};
    const role = ROLES.feature;
    const cardText = cardPrompt(taskCard({ issue, role: 'feature', lane: 'build', text: issueText }));
    const withCard = (system) => `${system}\n\n${cardText}`;
    const existing = fs.readdirSync(repoDir).filter((f) => /^wealthflow-.*\.js$/.test(f));

    // 1. plan
    const p = await chat({ system: withCard(role.system), prompt: planPrompt(issueText, existing, facts), prefer: role.prefer, maxTokens: 400, temperature: 0, env });
    providers.plan = p.provider;
    const parsed = parsePlan(p.text, { existing, repoDir });
    if (!parsed.ok) return { ok: false, stage: 'plan', providers, reason: parsed.reason };
    const { plan } = parsed;
    log(`[build] plan: ${plan.name} (${plan.api}) — ${plan.summary}`);

    // 2. author the whole module
    let code = '', authored = null, why = '';
    for (let attempt = 0; attempt < 2 && !code; attempt++) {
        const today = new Date().toISOString().slice(0, 10);
        const a = await chat({ system: withCard(role.system), prompt: authorPrompt(issueText, plan, today, facts) + (why ? `\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED: ${why}. Fix exactly that.` : ''), prefer: role.prefer, maxTokens: 9_000, temperature: attempt ? 0.2 : 0.1, env });
        providers.author = a.provider;
        const c = ensureNewTag(stripFences(a.text || ''), today);
        const bad = moduleProblems(c, plan, today);
        if (bad.length) { why = bad.join('; ').slice(0, 300); log(`[build] attempt ${attempt + 1} refused: ${why}`); if (/NEW tag/.test(why)) log(`[build] (tag lines seen: ${(c.match(/^.*(?:wf-new|wfNew|\\.id\\s*=|createElement).*$/gm) || []).slice(0, 4).map((x) => x.trim().slice(0, 90)).join(' | ')})`); continue; }
        code = c; authored = a;
    }
    if (!code) return { ok: false, stage: 'author', file: plan.name, providers, reason: `no acceptable module after 2 tries: ${why}` };
    log(`[build] module written (${code.length} chars, via ${authored.provider})`);

    // 3. independent review of the WHOLE new file, on a different provider.
    // A reviewer's low or medium finding (for example "an empty catch swallows an error", seen on #635) is a thing the author can fix: the author gets the
    // finding once and the fixed file is reviewed again, on a provider that did not write it. High and critical findings, and a second refusal, end the try as before.
    let r = null, review = null;
    for (let round = 1; round <= 2; round++) {
        if (!reviewSeesWholeChange('', code)) return { ok: false, stage: 'review_too_large', file: plan.name, providers, reason: 'the module is larger than the independent review can read in full' };
        r = await chat({ system: withCard(ROLES.security.system), prompt: reviewPrompt(issueText, plan.name, '', code), prefer: ROLES.security.prefer, exclude: [authored.provider], maxTokens: 1500, temperature: 0, env })
            .catch((e) => ({ text: '', provider: 'none', _error: e.message }));
        providers.security = r.provider;
        if (!r.text) return { ok: false, stage: 'security_unavailable', file: plan.name, providers, reason: 'no independent security reviewer was available' };
        review = parseVerdict(r.text);
        if (review.verdict !== 'FAIL') break;
        const fixable = review.severity === 'low' || review.severity === 'medium';
        const veto = { ok: false, stage: 'security', file: plan.name, providers, review, reason: `Agent 5 veto (${review.severity}): ${review.reason}` };
        if (!fixable || round === 2) return veto;
        const today = new Date().toISOString().slice(0, 10);
        const note = [review.reason, ...(Array.isArray(review.findings) ? review.findings : [])].filter(Boolean).join('; ').slice(0, 600);
        log(`[build] reviewer refused (${review.severity}): ${note.slice(0, 200)} — the author gets one revision`);
        const rev = await chat({ system: withCard(role.system), prompt: authorPrompt(issueText, plan, today, facts)
            + `\n\nTHE FIRST VERSION OF THE FILE (an independent reviewer refused it):\n-----\n${code}\n-----\nREVIEWER: ${note}\nReturn the COMPLETE corrected file, changing only what the reviewer named. Every rule above still holds.`,
            prefer: role.prefer, maxTokens: 9_000, temperature: 0.1, env }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
        const c2 = ensureNewTag(stripFences(rev.text || ''), today);
        const bad2 = moduleProblems(c2, plan, today);
        if (bad2.length) { log(`[build] the revision was refused: ${bad2.join('; ').slice(0, 200)}`); return veto; }
        code = c2; authored = rev; providers.author = rev.provider;
        log(`[build] revised module (${code.length} chars, via ${rev.provider})`);
    }
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
                system: withCard(ROLES.qa.system),
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
