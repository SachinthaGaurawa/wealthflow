/* =============================================================================
 * autonomy/css-lane.mjs — the fix agent's lane for reports about how a screen LOOKS
 * -----------------------------------------------------------------------------
 * THE GAP THIS CLOSES (issue #514, 2026-11-04: "CC Instalments overlaps on a smartphone")
 *   The agent could only change root-level .js modules and could only prove a change with a
 *   Vitest file. A layout report has no JavaScript in it: the cause is CSS, the CSS lives in the
 *   guarded index.html and wf-ui.css, and "the table overlaps" cannot be asserted in jsdom. So the
 *   report was handed to a text-only model, it changed nothing, and it stood down.
 *
 * WHAT THE LANE DOES
 *   1. measures the screen in real Chromium at phone/tablet/laptop widths (layout-probe.mjs): that
 *      is the "red" — it names which elements overlap and by how many pixels;
 *   2. shows the author the screen's markup, one rendered row and the CSS that already styles it;
 *   3. accepts ONLY new CSS rules appended to wf-agent-fixes.css (a file loaded after wf-ui.css),
 *      each scoped to that one screen, using layout properties only (validateCss);
 *   4. measures again with the new rules applied: that is the "green". It must be strictly better at
 *      every width, and it is reported as FIXED (nothing left) or IMPROVED (some left, said plainly);
 *   5. an independent reviewer on a different provider reads the CSS before a PR is drafted.
 *
 * BLAST RADIUS
 *   The author cannot touch index.html, wf-ui.css, any script or any other screen. A rule that does
 *   not name the screen's own id is refused. The file is validated again on every CI run
 *   (test/agent_fixes_css_test.js), so a hand edit cannot weaken the lane either.
 *
 * HONESTY
 *   The proof is a measurement of invented books on the screens and widths the probe knows. It is
 *   not a human looking at a phone, and the PR says so.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { chat, stripFences } from './llm-router.mjs';
import { ROLES, reviewPrompt, parseVerdict, reviewSeesWholeChange } from './agent-swarm.mjs';
import { probeLayout, describeProbe, sweepScreens, anyScreenFor, screenFromReading, screenKeyOfPage, screenDef, WIDTHS } from './layout-probe.mjs';

export const LANE_FILE = 'wf-agent-fixes.css';
export const MAX_CSS_CHARS = 3000;
export const MAX_DECLARATIONS = 40;
export const MAX_ROUNDS = 3;

/** Layout properties the author may set. Colours, content, fonts, URLs and animation are not here on purpose. */
export const ALLOWED_PROPERTIES = new Set([
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
    'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
    'grid', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-column', 'grid-row', 'grid-area', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
    'gap', 'row-gap', 'column-gap',
    'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self', 'place-items', 'place-content',
    'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'box-sizing',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'overflow', 'overflow-x', 'overflow-y', 'white-space', 'word-break', 'overflow-wrap', 'hyphens',
    'text-align', 'vertical-align', 'line-height', 'font-size',
    'table-layout', 'border-collapse', 'border-spacing',
    'box-shadow', 'background', 'background-color',
    '-webkit-overflow-scrolling', 'overscroll-behavior-x',
]);

/** The last compound of a selector is a table row, cell or heading: it must stay a table part. */
const TABLE_PART = /^(tr|td|th|thead|tbody|tfoot)(?![\w-])/i;
const TABLE_SAFE = new Set(['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'position', 'min-width', 'max-width', 'width', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'text-align', 'vertical-align', 'line-height', 'font-size', 'box-sizing', 'left', 'right', 'top', 'bottom', 'z-index', 'box-shadow', 'background', 'background-color']);

const SOMETHING_THAT_HIDES = [
    ['display', /^none\b/i], ['visibility', /^(hidden|collapse)\b/i], ['opacity', /^0(\.0+)?$/],
    ['font-size', /^0(px|em|rem|%)?$/i], ['width', /^0(px|em|rem|%)?$/i], ['height', /^0(px|em|rem|%)?$/i],
    ['max-width', /^0(px|em|rem|%)?$/i], ['max-height', /^0(px|em|rem|%)?$/i],
];

/** Words that make a report one about how a screen looks. */
const LAYOUT_WORDS = /\b(over+a?l+a+p+\w*|overlap(s|ped|ping)?|overlay(s|ed)?|cut\s*off|cropped|clipp?ed|misalign(ed)?|off[- ]?screen|too wide|horizontal scroll|resolutions?|responsive|compatib\w*|smart\s*phones?|phones?|mobile|tablet|layout|squash(ed)?|stack(ed|ing)? on top|on top of each other|screen size)\b/i;

/** Only what the person wrote: the diagnostics table and the screenshot reading do not decide the lane. */
function userWords(issue) {
    const body = String((issue && issue.body) || '');
    const m = body.match(/### User feedback\s*([\s\S]*?)(?:\n### |\n<!--|$)/);
    const quoted = (m ? m[1] : body).replace(/^>\s?/gm, '');
    return `${(issue && issue.title) || ''}\n${quoted}`.slice(0, 1800);
}

/** The English reading of a report written in another language (Sinhala, Tamil, ...), if the issue carries one. */
function englishReading(issue) {
    const body = String((issue && issue.body) || '');
    const m = body.match(/### English translation \(AI\)[\s\S]*?\n((?:>[^\n]*\n?)+)/);
    return m ? m[1].replace(/^>\s?/gm, '').trim().slice(0, 1200) : '';
}

/** What a vision model wrote about the screenshot (filing time or fix time), if anything. */
function screenshotReading(issue) {
    const body = String((issue && issue.body) || '');
    const m = body.match(/### What (?:the AI saw in the|the) screenshot(?: shows)?\s*\n([\s\S]*?)(?:\n### |$)/i);
    const t = m ? m[1].trim() : '';
    return /no vision model could read it|exceeds/i.test(t.slice(0, 200)) ? '' : t.slice(0, 3000);
}

/** The pages the app says were open just before the report, and the viewport width it was sent from. */
function deviceFacts(issue) {
    const body = String((issue && issue.body) || '');
    const row = (k) => ((body.match(new RegExp('\\|\\s*' + k + '[^|]*\\|\\s*([^|\\n]+?)\\s*\\|')) || [])[1] || '').trim();
    const trail = row('Pages open just before').split('>').map((x) => x.trim()).filter(Boolean);
    const vp = row('Viewport').match(/^(\d{3,4})x(\d{3,4})$/);
    return { trail, appPage: row('App page'), width: vp ? Number(vp[1]) : 0 };
}

/**
 * Does the lane apply? It needs a layout complaint. WHERE to look is found in this order, and every step is honest about what it used:
 *   1. a page the person named (in their own words or in the English reading of them);
 *   2. what a vision model read off the screenshot;
 *   3. the pages the app says were open just before the report (the feedback form lives in Settings, so "App page" alone is Settings);
 *   4. nothing named: the lane then measures EVERY page at the reported phone width and takes the broken one (`sweep`).
 * Without any measurement there is nothing to prove a CSS change against, so an unmeasured guess is never made.
 * @returns {{ applies:boolean, screen:string, why:string, sweep?:boolean, width?:number }}
 */
export function layoutLaneFor(issue) {
    const said = userWords(issue) + '\n' + englishReading(issue);
    const reading = screenshotReading(issue);
    const problemLine = (reading.match(/PROBLEM:\s*([^\n]+(?:\n(?![A-Z]+:)[^\n]+)*)/i) || [])[1] || '';
    const seen = /\b(overlap\w*|collid\w*|on top of|cut\s*off|clipp?ed|truncat\w*|overflow\w*|misalign\w*|squash\w*)\b/i.test(problemLine);
    if (!LAYOUT_WORDS.test(said) && !(seen && said.trim().length < 400)) return { applies: false, screen: '', why: 'the report does not describe a layout problem' };
    const facts = deviceFacts(issue);
    const named = anyScreenFor(said);
    if (named) return { applies: true, screen: named, why: `layout report about ${named} (named in the report)`, width: facts.width };
    const shown = screenFromReading(reading);
    if (shown) return { applies: true, screen: shown, why: `layout report; the screenshot shows ${shown}`, width: facts.width };
    for (const id of [...facts.trail].reverse()) {
        const key = id === 'settings' ? '' : screenKeyOfPage(id);
        if (key) return { applies: true, screen: key, why: `layout report; the page open just before it was sent was ${id}`, width: facts.width };
    }
    return { applies: true, screen: '', sweep: true, width: facts.width, why: 'layout report that names no page: every page is measured at the reported phone width' };
}

// ── a small, strict CSS reader (no dependency; refuses what it does not understand) ──────────────
function stripComments(css) { return String(css || '').replace(/\/\*[\s\S]*?\*\//g, ''); }

function splitTop(s, sep) {
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}

function readBlocks(css, problems, nested = false) {
    const rules = [];
    let i = 0;
    while (i < css.length) {
        while (i < css.length && /\s/.test(css[i])) i++;
        if (i >= css.length) break;
        const open = css.indexOf('{', i);
        if (open < 0) { problems.push('text outside any rule: "' + css.slice(i, i + 30).trim() + '"'); break; }
        const prelude = css.slice(i, open).trim();
        let depth = 1, j = open + 1;
        while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        if (depth !== 0) { problems.push('unbalanced braces'); break; }
        const inner = css.slice(open + 1, j - 1);
        i = j;
        if (prelude.startsWith('@')) {
            if (!/^@media\s/i.test(prelude) || nested) { problems.push('only one level of @media is allowed, not "' + prelude.slice(0, 30) + '"'); continue; }
            if (/[^\w\s():,.\-><=%/]/.test(prelude.slice(6))) problems.push('the @media condition has characters that are not allowed');
            rules.push(...readBlocks(inner, problems, true).map((r) => ({ ...r, media: prelude })));
        } else {
            if (inner.includes('{')) { problems.push('nested rules are not allowed'); continue; }
            rules.push({ selector: prelude, body: inner, media: '' });
        }
    }
    return rules;
}

/**
 * Is this CSS something the lane may append? Pure; returns every problem, not just the first.
 * @param {string} css
 * @param {{ scope:string }} opt  the screen's own id selector, e.g. "#page-ccinstall"
 */
export function validateCss(css, { scope } = {}) {
    const problems = [];
    const text = stripComments(css).trim();
    if (!text) return { ok: false, problems: ['no CSS'], rules: 0, declarations: 0 };
    if (text.length > MAX_CSS_CHARS) problems.push(`too long (${text.length} characters; the limit is ${MAX_CSS_CHARS})`);
    if (!scope || !/^#[\w-]+$/.test(scope)) problems.push('no screen scope was given');
    if (/["'`\\<]|@import|@font-face|@charset|\burl\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(text)) {
        problems.push('quotes, backslashes, url(), @import, @font-face, expression() and script-like text are not allowed');
    }
    const rules = readBlocks(text, problems);
    let declarations = 0;
    if (!rules.length && !problems.length) problems.push('no rules found');
    for (const r of rules) {
        const sels = splitTop(r.selector, ',');
        if (!sels.length) problems.push('a rule has no selector');
        for (const s of sels) {
            if (scope && !s.includes(scope)) problems.push(`selector "${s.slice(0, 60)}" does not name ${scope}`);
            if (/[{};]/.test(s)) problems.push('a selector contains a brace or semicolon');
        }
        const tableParts = sels.some((x) => TABLE_PART.test(x.replace(/\[[^\]]*\]|\([^)]*\)/g, '').split(/[\s>+~]+/).pop() || ''));
        for (const d of r.body.split(';').map((x) => x.trim()).filter(Boolean)) {
            declarations++;
            const k = d.indexOf(':');
            if (k < 1) { problems.push(`not a declaration: "${d.slice(0, 40)}"`); continue; }
            const prop = d.slice(0, k).trim().toLowerCase();
            const value = d.slice(k + 1).replace(/!important\s*$/i, '').trim();
            if (!ALLOWED_PROPERTIES.has(prop)) { problems.push(`property "${prop}" is not a layout property the lane may set`); continue; }
            if (!value) { problems.push(`"${prop}" has no value`); continue; }
            if (/^overflow(-x|-y)?$/.test(prop) && /\b(hidden|clip)\b/i.test(value)) problems.push(`"${prop}: ${value}" would cut content off; use auto or scroll so the person can still reach it`);
            if (tableParts && !TABLE_SAFE.has(prop)) problems.push(`"${prop}" may not be set on a table row, cell or heading: changing how table parts are laid out breaks the columns (a figure ends up under the wrong title)`);
            if (tableParts && prop === 'position' && !/^(static|relative)\b/i.test(value)) problems.push('a table cell may only be position: static or relative (use static to un-stick a column)');
            for (const [p, re] of SOMETHING_THAT_HIDES) {
                if (prop === p && re.test(value)) problems.push(`"${prop}: ${value}" would hide content instead of laying it out`);
            }
        }
    }
    if (declarations > MAX_DECLARATIONS) problems.push(`${declarations} declarations; the limit is ${MAX_DECLARATIONS}`);
    return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 12), rules: rules.length, declarations };
}

/** The whole lane file must pass on every CI run, however it was edited. Blocks are `/* #N … *​/` headed. */
export function validateLaneFile(content) {
    const problems = [];
    const blocks = String(content || '').split(/(?=\/\*\s*lane-block:)/).filter((b) => /^\/\*\s*lane-block:/.test(b));
    for (const b of blocks) {
        const head = b.match(/^\/\*\s*lane-block:\s*(\S+)\s+scope=(#[\w-]+)/);
        if (!head) { problems.push('a block has no "lane-block: <issue> scope=#id" header'); continue; }
        const v = validateCss(b.replace(/^\/\*[\s\S]*?\*\//, ''), { scope: head[2] });
        if (!v.ok) problems.push(`block ${head[1]}: ${v.problems.join('; ')}`);
    }
    const text = String(content || '');
    const first = text.search(/\/\*\s*lane-block:/);
    const before = (first < 0 ? text : text.slice(0, first)).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (before) problems.push('there is CSS before the first headed block');
    return { ok: problems.length === 0, problems, blocks: blocks.length };
}

/** The file after this fix is appended: a header the validator can read, then the CSS. */
export function appendFix(existing, css, { issue, scope, title = '' } = {}) {
    const base = String(existing || '').replace(/\s+$/, '');
    const head = `/* lane-block: ${issue} scope=${scope} — ${String(title).replace(/[*/\n]/g, ' ').slice(0, 70)} */`;
    return `${base}\n\n${head}\n${stripComments(css).trim()}\n`;
}

// ── what the author is shown ─────────────────────────────────────────────────────────────────────
function styleBlocks(html) { return [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'); }

function rulesMentioning(css, tokens, max) {
    const out = [];
    let used = 0;
    for (const chunk of String(css).split('}')) {
        const rule = chunk.trim() + '}';
        if (rule.length < 6 || rule.length > 900) continue;
        if (!tokens.some((t) => rule.includes(t))) continue;
        if (used + rule.length > max) break;
        out.push(rule.replace(/\s+/g, ' ')); used += rule.length;
    }
    return out.join('\n');
}

/** The screen's markup, the CSS that already styles it, and what is already in the lane file. */
export function cssContext({ screen, repoDir = process.cwd(), sample = '' } = {}) {
    const def = screenDef(screen);
    if (!def) return { markup: '', css: '', lane: '' };
    let html = '', ui = '', lane = '';
    try { html = fs.readFileSync(path.join(repoDir, 'index.html'), 'utf8'); } catch { /* none */ }
    try { ui = fs.readFileSync(path.join(repoDir, 'wf-ui.css'), 'utf8'); } catch { /* none */ }
    try { lane = fs.readFileSync(path.join(repoDir, LANE_FILE), 'utf8'); } catch { /* none */ }
    const id = def.box.replace(/^#/, '');
    const at = html.indexOf(`id="${id}"`);
    let markup = '';
    if (at >= 0) {
        const next = html.indexOf('<div class="page"', at + 10);
        markup = html.slice(at, next > 0 ? Math.min(next, at + 3500) : at + 3500).replace(/\s+/g, ' ');
    }
    const classes = [...new Set([...(markup + ' ' + sample).matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter((c) => c.length > 1).slice(0, 30);
    const tokens = [def.box, ...classes.map((c) => '.' + c)];
    const css = rulesMentioning(ui, tokens, 4500) + '\n' + rulesMentioning(styleBlocks(html), tokens, 3500);
    return { markup, css: css.trim(), lane: lane.slice(-1500) };
}

export function layoutPrompt({ issueText, screen, scope, measured, ctx, sample, previousCss = '', remaining = '' }) {
    return [
        'A person using a personal-finance web app on a phone reported a LAYOUT problem. You fix it with CSS only.',
        '',
        'REPORT (their words):', issueText,
        '',
        `SCREEN: ${screen} (its container is ${scope})`,
        '',
        'MEASURED IN A REAL BROWSER BEFORE ANY FIX (this is the problem; invented data, not the owner\'s books):',
        measured,
        '',
        'THE SCREEN\'S MARKUP (trimmed):', ctx.markup || '(not found)',
        '',
        'ONE ROW AS IT RENDERS:', sample || '(none)',
        '',
        'CSS THAT ALREADY STYLES THIS SCREEN (wf-ui.css and the page; later rules win at equal specificity, so be specific):',
        ctx.css || '(none found)',
        previousCss ? `\nYOUR PREVIOUS ATTEMPT (it was applied and measured again):\n${previousCss}\n\nWHAT IS STILL WRONG AFTER IT:\n${remaining}\n\nReturn the COMPLETE corrected CSS, not a patch.` : '',
        '',
        'WRITE NEW CSS that will be appended after wf-ui.css. Hard rules (anything else is rejected by a program, not a person):',
        `  1. EVERY selector must contain ${scope}. A rule that does not is rejected.`,
        '  2. Only layout properties: display, position, top/right/bottom/left, flex*, grid*, gap, align*/justify*, width/min/max, margin, padding, overflow (auto or scroll only, never hidden/clip), white-space, word-break, overflow-wrap, line-height, font-size, table-layout, box-shadow, background, background-color. No text-overflow. No colours of text, no content, no url(), no @import, no quotes.',
        '  3. Never hide anything (no display:none, no zero sizes). Every column, button and number must stay reachable. The edit/delete buttons must stay.',
        '  4. Works in dark and light themes: use var(--wf-card) style variables for backgrounds, never fixed colours.',
        '  5. At most 40 declarations, 3000 characters. @media (max-width: ...) is allowed, one level only.',
        '  6. THIS IS A FINANCE SCREEN: never truncate or hide a number, date or amount (no ellipsis, no overflow:hidden), and never set display/flex/grid/float on a table, tr, td or th (that breaks the columns and puts a figure under the wrong heading; a reviewer rejects it and the program measures it). On a table-part you may only change padding, min-width/max-width, white-space, font-size, line-height, text-align and position (static/relative).',
        '  7. THE SAFE TOOLKIT, in order: (a) give the table\'s wrapper overflow-x:auto so it scrolls sideways instead of overlapping (the wrapper must be named under ' + scope + '); (b) NEVER un-pin the last (actions) column of a table that holds Edit/Delete buttons: test/e2e/ui-toolbars.mjs requires it to stay position:sticky and in view, and un-pinning it (as #519 did) put the buttons off-screen and turned the shell check red; instead give the neighbouring cells room; (c) give cells a sensible min-width and smaller padding; (d) at narrow widths shrink font-size a little. Use @media (max-width: 768px) so desktop is untouched.',
        '  8. The smallest change that makes the measured problems disappear at EVERY width listed, on phones first. A sticky or absolutely positioned cell that sits on top of other cells is the usual cause: give the content room, or let the cell scroll with the row.',
        '',
        'Reply with ONLY the CSS, no fences, no commentary. If CSS alone cannot fix it, reply exactly: CANNOT_FIX_SAFELY <one sentence>.',
    ].filter((x) => x !== '').join('\n');
}

/** Is `after` a real improvement on `before`? Strictly better overall, and worse nowhere. */
export function judgeLayout(before, after) {
    if (!before || !before.ok) return { ok: false, verdict: 'unmeasured', reason: 'the screen could not be measured before the change' + (before && before.reason ? ` (${before.reason})` : '') };
    if (!after || !after.ok) return { ok: false, verdict: 'unmeasured', reason: 'the screen could not be measured after the change' + (after && after.reason ? ` (${after.reason})` : '') };
    if (before.problems === 0) return { ok: false, verdict: 'nothing-to-fix', reason: 'no overlap, overflow or cut-off text was found before the change, so there is nothing to prove against' };
    const per = (r) => new Map(r.widths.map((w) => [w.width, (w.overflowPx > 2 ? 1 : 0) + w.overlaps.length + w.clipped.length + (w.misaligned || []).length + (w.spilled || []).length]));
    const b = per(before), a = per(after);
    const worse = [...b].filter(([w, n]) => (a.get(w) ?? Infinity) > n).map(([w]) => w);
    if (worse.length) return { ok: false, verdict: 'worse', reason: `it made ${worse.join(', ')}px wide worse` };
    if (after.problems >= before.problems) return { ok: false, verdict: 'unchanged', reason: `the problems did not go down (${before.problems} before, ${after.problems} after)` };
    if (after.problems === 0) return { ok: true, verdict: 'fixed', reason: `${before.problems} problem(s) before, none after` };
    if (after.problems * 2 <= before.problems) return { ok: true, verdict: 'improved', reason: `${before.problems} problem(s) before, ${after.problems} after: partly fixed` };
    return { ok: false, verdict: 'barely', reason: `only ${before.problems - after.problems} of ${before.problems} problems went away` };
}

/**
 * Run the lane. Returns the same shape runSwarm does, so the agent writes the file and opens the PR the same way.
 * `chatImpl` and `probeImpl` exist so the unit tests need neither a model nor a browser.
 */
export async function runLayoutLane({
    issue, repoDir = process.cwd(), env = process.env, log = console.log,
    chatImpl = chat, probeImpl = probeLayout, sweepImpl = sweepScreens,
} = {}) {
    const lane = layoutLaneFor(issue);
    if (!lane.applies) return { ok: false, stage: 'lane', reason: lane.why };
    let { screen } = lane;
    const widths = lane.width && !WIDTHS.includes(lane.width) ? [...WIDTHS, lane.width].sort((a, b) => a - b) : WIDTHS;
    const providers = {};
    if (!screen) {
        // Nothing says which page: measure them all at the reported phone width, take the one that is really broken.
        const sw = await sweepImpl({ repoDir, width: lane.width || 390 });
        if (!sw.ok) return { ok: false, stage: 'measure', reason: 'no page was named and the pages could not be measured: ' + sw.reason, providers };
        if (!sw.ranked.length) return { ok: false, stage: 'measure', reason: `no page was named, and none of the pages shows an overlap, overflow or cut-off text at ${lane.width || 390}px wide with invented data, so there is nothing to prove a change against`, providers };
        screen = sw.ranked[0].screen;
        log(`[lane] no page named; the sweep found ${sw.ranked.slice(0, 3).map((r) => `${r.screen} (${r.problems})`).join(', ')} — taking ${screen}`);
    }
    const scope = screenDef(screen).box;
    const issueText = userWords(issue) + (englishReading(issue) ? '\n(In English: ' + englishReading(issue) + ')' : '');
    const role = ROLES.ui;

    log(`[lane] layout lane for #${issue.number} on ${screen}`);
    const before = await probeImpl({ screen, repoDir, widths });
    if (!before.ok) return { ok: false, stage: 'measure', reason: describeProbe(before), providers };
    log(`[lane] measured before: ${before.problems} problem(s)\n${describeProbe(before).slice(0, 1500)}`);
    if (before.problems === 0) return { ok: false, stage: 'measure', reason: describeProbe(before) + ' There is nothing to prove a CSS change against, so no change was made.', providers };

    const ctx = cssContext({ screen, repoDir, sample: before.sample });
    const lanePath = path.join(repoDir, LANE_FILE);
    const existing = fs.existsSync(lanePath) ? fs.readFileSync(lanePath, 'utf8') : '';
    const measured = describeProbe(before);

    let css = '', after = null, judged = null, authored = null, remaining = '', tried = [];
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const a = await chatImpl({
            system: role.system.replace(/ABSOLUTE CONSTRAINTS[\s\S]*$/, '').trim() + '\nYou write CSS only.',
            prompt: layoutPrompt({ issueText, screen, scope, measured, ctx, sample: before.sample, previousCss: css, remaining }),
            prefer: role.prefer, maxTokens: 2500, temperature: round === 1 ? 0.1 : 0.3, env,
        }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
        providers.author = a.provider;
        if (!a.text) { tried.push(`round ${round}: no reply (${a._error || 'empty'})`); break; }
        if (/^CANNOT_FIX_SAFELY/i.test(a.text.trim())) { tried.push(`round ${round}: ${a.text.trim().slice(0, 200)}`); break; }
        const candidate = stripComments(stripFences(a.text)).trim();
        const v = validateCss(candidate, { scope });
        if (!v.ok) { tried.push(`round ${round}: refused by the CSS gate: ${v.problems.join('; ').slice(0, 300)}`); remaining = 'Your CSS was refused: ' + v.problems.join('; '); css = candidate.slice(0, 1500); continue; }
        after = await probeImpl({ screen, repoDir, extraCss: candidate, widths });
        judged = judgeLayout(before, after);
        log(`[lane] round ${round}: ${judged.verdict} — ${judged.reason}`);
        css = candidate; authored = a;
        if (judged.ok) break;
        remaining = describeProbe(after);
        tried.push(`round ${round}: ${judged.reason}`);
    }
    if (!judged || !judged.ok) {
        return {
            ok: false, stage: 'proof', file: LANE_FILE, providers, before: describeProbe(before),
            reason: `the CSS did not measurably fix the layout after ${MAX_ROUNDS} tries — ${tried.slice(-2).join(' | ') || 'no usable CSS was produced'}`,
            observation: `Before: ${describeProbe(before)}\nAfter the last try: ${after ? describeProbe(after) : '(not measured)'}`,
            change: css,
        };
    }

    const code = appendFix(existing, css, { issue: issue.number, scope, title: issue.title });
    const lf = validateLaneFile(code);
    if (!lf.ok) return { ok: false, stage: 'syntax', file: LANE_FILE, providers, reason: 'the lane file would not pass its own validation: ' + lf.problems.join('; ').slice(0, 300) };

    // An independent reviewer reads the CSS on a different provider; absence of a reviewer is not approval.
    if (!reviewSeesWholeChange(existing, code)) return { ok: false, stage: 'review_too_large', file: LANE_FILE, providers, reason: 'the change is larger than the reviewer can read in full' };
    const r = await chatImpl({
        system: ROLES.security.system, prompt: reviewPrompt(issueText, LANE_FILE, existing, code),
        prefer: ROLES.security.prefer, exclude: [authored.provider], maxTokens: 1500, temperature: 0, env,
    }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
    providers.security = r.provider;
    if (!r.text) return { ok: false, stage: 'security_unavailable', file: LANE_FILE, providers, reason: 'no independent reviewer was available' };
    const review = parseVerdict(r.text);
    if (review.verdict === 'FAIL') return { ok: false, stage: 'security', file: LANE_FILE, providers, review, reason: `reviewer veto (${review.severity}): ${review.reason}` };

    const layout = { screen, verdict: judged.verdict, reason: judged.reason, before: describeProbe(before), after: describeProbe(after), widths: before.widths.map((w) => w.width) };
    return {
        ok: true, stage: 'ready', lane: 'layout', role: 'ui', file: LANE_FILE, code,
        test: null, testFile: null, verified: true, layout, review, providers,
        testProof: { ok: true, beforeFailed: true, afterPassed: judged.verdict === 'fixed', layout: true },
        change: css, observation: `Before: ${layout.before}\nAfter: ${layout.after}`,
    };
}
