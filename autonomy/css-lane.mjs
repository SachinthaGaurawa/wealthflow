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
import { taskCard, cardPrompt } from './task-card.mjs';
import { fenceUntrusted } from './untrusted-text.mjs';
import { layoutAllowed } from './route.mjs';
import { ROLES, reviewPrompt, parseVerdict, reviewSeesWholeChange } from './agent-swarm.mjs';
import { probeLayout, describeProbe, sweepScreens, anyScreenFor, screenFromReading, screenKeyOfPage, screenDef, WIDTHS } from './layout-probe.mjs';

import { LANE_FILE, MAX_CSS_CHARS, MAX_DECLARATIONS, MAX_ROUNDS, ALLOWED_PROPERTIES, stripComments, splitTop, readBlocks, validateCss, validateLaneFile, appendFix } from './css-rules.mjs';
export { LANE_FILE, MAX_CSS_CHARS, MAX_DECLARATIONS, MAX_ROUNDS, ALLOWED_PROPERTIES, stripComments, splitTop, readBlocks, validateCss, validateLaneFile, appendFix } from './css-rules.mjs';

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
    // 0. A finding the system filed itself (autonomy/discover.mjs layoutFindings) names the screen it MEASURED. Its text quotes
    // the words on that screen ("Card Installments" on the Dashboard), and words alone would route it to the wrong page: #547
    // was sent to CC Instalments, measured clean there, and the agent stopped with "nothing to prove a change against".
    const marked = String((issue && issue.body) || '').match(/<!--\s*wf-layout-screen:\s*([a-z0-9-]+)\s*(?:width=(\d+))?\s*-->/i);
    if (marked && screenDef(marked[1].toLowerCase())) {
        return { applies: true, marked: true, screen: marked[1].toLowerCase(), why: `layout finding the system measured on ${marked[1].toLowerCase()}`, width: marked[2] ? Number(marked[2]) : 0 };
    }
    // A report a program filed (the statement reader, the discovery scan) reaches this lane only through the marker above: its
    // wording is a template's, and one word of it ("the layout convention was closed", #559) spent three tries measuring pages.
    const allowed = layoutAllowed(issue);
    if (!allowed.ok) return { applies: false, screen: '', why: allowed.why };
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

/** Rules back to CSS text: consecutive rules in the same @media share one block, order kept. */
export function serializeRules(rules) {
    const out = [];
    let openMedia = null, buf = [];
    const flush = () => { if (openMedia) out.push(`${openMedia} {\n${buf.join('\n')}\n}`); else out.push(...buf); buf = []; };
    for (const r of rules) {
        const m = r.media || null;
        if (m !== openMedia) { flush(); openMedia = m; }
        buf.push(`${m ? '  ' : ''}${r.selector.trim()} { ${r.body.trim().replace(/;?\s*$/, ';')} }`);
    }
    flush();
    return out.join('\n');
}

/**
 * Keep only the rules the measurement needs (attempt 3 on #524: the author's stat-card rule fixed the measured problem, but it also
 * re-declared table rules that undid block 514, and the reviewer rightly vetoed the whole block).
 * Each rule is dropped in turn and the screen measured again; the rule stays only if its removal makes the verdict worse. What is left
 * is the smallest set of rules the browser itself says is needed, so nothing the measurement does not ask for can undo another fix.
 */
export async function pruneToWhatMatters({ css, scope, before, after: after0, judged, probeImpl, screen, repoDir, widths, maxProbes = 8, log = () => {} }) {
    const problems = [];
    let rules = readBlocks(stripComments(css).trim(), problems);
    const kept = { css, judged, after: after0, dropped: 0, probes: 0 };
    if (problems.length || rules.length < 2) return kept;
    let best = { judged, after: after0 };
    for (let i = rules.length - 1; i >= 0 && kept.probes < maxProbes; i--) {
        if (rules.length < 2) break;
        const candidate = serializeRules(rules.filter((_, k) => k !== i));
        if (!validateCss(candidate, { scope }).ok) continue;
        kept.probes++;
        let after;
        try { after = await probeImpl({ screen, repoDir, extraCss: candidate, widths }); } catch { break; }
        const j = judgeLayout(before, after);
        const needed = !j.ok || after.problems > best.after.problems;   // never accept a worse screen than the one already proven
        if (needed) continue;
        log(`[lane] dropped a rule the measurement does not need: ${rules[i].selector.slice(0, 80)}`);
        rules = rules.filter((_, k) => k !== i);
        best = { judged: j, after };
        kept.dropped++;
    }
    if (!kept.dropped) return kept;
    return { ...kept, css: serializeRules(rules), judged: best.judged, after: best.after };
}

// ── what the author is shown ─────────────────────────────────────────────────────────────────────
function styleBlocks(html) { return [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'); }

function rulesMentioning(css, tokens, max) {
    // Rank before cutting: the rule that causes a phone-width problem is usually a media rule naming several of the tokens, and a plain
    // first-come cut let ten unrelated rules of another screen (#dashStats) use the whole budget before it was reached.
    const found = [];
    String(css).split('}').forEach((chunk, i) => {
        const rule = chunk.trim() + '}';
        if (rule.length < 6 || rule.length > 900) return;
        const hits = tokens.filter((t) => rule.includes(t)).length;
        if (!hits) return;
        found.push({ i, rule: rule.replace(/\s+/g, ' '), score: hits * 2 + (/@media/.test(rule) ? 3 : 0) + (/#dash/.test(rule) ? -4 : 0) });
    });
    const picked = [];
    let used = 0;
    for (const f of [...found].sort((a, b) => b.score - a.score || a.i - b.i)) {
        if (used + f.rule.length > max) continue;
        picked.push(f); used += f.rule.length;
    }
    return picked.sort((a, b) => a.i - b.i).map((f) => f.rule).join('\n');
}

/** The screen's markup, the CSS that already styles it, and what is already in the lane file. */
export function cssContext({ screen, repoDir = process.cwd(), sample = '', measured = '' } = {}) {
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
    // The elements the measurement NAMES come first: attempt 2 on #524 was told "div.stat-label overlaps div.stat-val", was shown only
    // table rules (the table was the only markup in view), and wrote table CSS for a problem in the stat cards above it.
    const focus = focusClasses(measured);
    const builds = buildersOf(html, markup, focus);
    // the card that holds a named label is named in the script that builds it, and its rules (a grid at phone width) are the cause
    const builtClasses = [...builds.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => c.length > 2);
    const focusTokens = [...new Set([...focus, ...builtClasses])].slice(0, 14).map((c) => '.' + c);
    const css = (focusTokens.length ? rulesMentioning(ui, focusTokens, 3200) + '\n' + rulesMentioning(styleBlocks(html), focusTokens, 1500) + '\n' : '')
        + rulesMentioning(ui, tokens, 2600) + '\n' + rulesMentioning(styleBlocks(html), tokens, 2200);
    const unique = [...new Set(css.split('\n').map((l) => l.trim()).filter(Boolean))].join('\n');
    return { markup, css: unique, lane: lane.slice(-1500), focus, builds };
}

/** Class names the measurement names, e.g. "div.stat-label overlaps div.stat-val" gives stat-label, stat-val. */
export function focusClasses(measured) {
    const out = [];
    for (const m of String(measured || '').matchAll(/\b(?:div|span|td|th|tr|button|a|p|h[1-6]|li|label|input|select|table|section)\.([A-Za-z][\w-]{2,})/g)) if (!out.includes(m[1])) out.push(m[1]);
    return out.slice(0, 8);
}

/** The script that fills the page's containers: a stat row or a list is built in JavaScript, so its markup is not in the page source. */
function buildersOf(html, markup, focus) {
    const ids = [...String(markup).matchAll(/\bid="([A-Za-z][\w-]{2,})"/g)].map((m) => m[1]);
    const out = [];
    for (const id of ids) {
        const re = new RegExp(`[$(]['"]${id}['"]\\)?\\.innerHTML|getElementById\\(['"]${id}['"]\\)\\.innerHTML`);
        const m = re.exec(html);
        if (!m) continue;
        const chunk = html.slice(m.index, m.index + 900).replace(/\s+/g, ' ');
        if (focus.length && !focus.some((c) => chunk.includes(c))) continue;
        out.push(`#${id} is filled by: ${chunk}`);
        if (out.length >= 3) break;
    }
    return out.join('\n');
}

export function layoutPrompt({ issueText, screen, scope, measured, ctx, sample, previousCss = '', remaining = '' }) {
    return [
        'A person using a personal-finance web app on a phone reported a LAYOUT problem. You fix it with CSS only.',
        '',
        'REPORT (their words):', fenceUntrusted('report', issueText, 4000),
        '',
        `SCREEN: ${screen} (its container is ${scope})`,
        '',
        'MEASURED IN A REAL BROWSER BEFORE ANY FIX (this is the problem; invented data, not the owner\'s books):',
        measured,
        '',
        'THE SCREEN\'S MARKUP (trimmed):', ctx.markup || '(not found)',
        '',
        ctx.builds ? 'HOW THE ELEMENTS IN THE MEASUREMENT ARE BUILT (JavaScript fills them, so they are not in the markup above):\n' + ctx.builds + '\n' : '',
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
        '  7. FIX WHAT THE MEASUREMENT NAMES, nothing else. If it names a stat card, a label or a figure (for example stat-label over stat-val), change THAT: for instance stop the card being a two-column grid at that width and give the figure its own row, with a selector under ' + scope + ' that is more specific than the rule that causes it (the CSS above shows which rule). If the measurement says text is SQUEEZED into a narrow column (it names a grid-template-columns with a track under 48px), change that GRID or flex layout so the text gets the width (for example grid-template-columns: 1fr on the card, then grid-column: 1; grid-row: auto; text-align: left on the figure so it sits on its own row). NEVER fix it with overflow-wrap: anywhere or word-break: the validator rejects it and the program measures broken words as a problem. Do not touch the table, and do not repeat or override rules the screen already has for other elements (a reviewer rejects a block that undoes an earlier fix). Only if the measurement names table cells use the table toolkit: (a) give the table\'s wrapper overflow-x:auto so it scrolls sideways instead of overlapping (the wrapper must be named under ' + scope + '); (b) NEVER un-pin the last (actions) column of a table that holds Edit/Delete buttons: test/e2e/ui-toolbars.mjs requires it to stay position:sticky and in view, and un-pinning it (as #519 did) put the buttons off-screen and turned the shell check red; instead give the neighbouring cells room; (c) give cells a sensible min-width and smaller padding; (d) at narrow widths shrink font-size a little. Use @media (max-width: 768px) so desktop is untouched.',
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
    const per = (r) => new Map(r.widths.map((w) => [w.width, (w.overflowPx > 2 ? 1 : 0) + w.overlaps.length + w.clipped.length + (w.misaligned || []).length + (w.spilled || []).length + (w.squeezed || []).length]));
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

    const measured = describeProbe(before);
    const ctx = cssContext({ screen, repoDir, sample: before.sample, measured });
    const lanePath = path.join(repoDir, LANE_FILE);
    const existing = fs.existsSync(lanePath) ? fs.readFileSync(lanePath, 'utf8') : '';

    let css = '', after = null, judged = null, authored = null, remaining = '', tried = [];
    for (let round = 1; round <= MAX_ROUNDS; round++) {
        const a = await chatImpl({
            system: role.system.replace(/ABSOLUTE CONSTRAINTS[\s\S]*$/, '').trim() + '\nYou write CSS only.\n\n' + cardPrompt(taskCard({ issue, role: 'ui', lane: 'layout', file: `${screen} screen`, text: issueText })),
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

    // Only what the browser says is needed goes to the reviewer: a rule the measurement did not ask for cannot undo another fix.
    const pruned = await pruneToWhatMatters({ css, scope, before, after, judged, probeImpl, screen, repoDir, widths, log });
    if (pruned.dropped) { css = pruned.css; judged = pruned.judged; after = pruned.after; log(`[lane] kept only the rules the measurement needs (${pruned.dropped} dropped, ${pruned.probes} measurements)`); }

    const code = appendFix(existing, css, { issue: issue.number, scope, title: issue.title });
    const lf = validateLaneFile(code);
    if (!lf.ok) return { ok: false, stage: 'syntax', file: LANE_FILE, providers, reason: 'the lane file would not pass its own validation: ' + lf.problems.join('; ').slice(0, 300) };

    // An independent reviewer reads the CSS on a different provider; absence of a reviewer is not approval.
    if (!reviewSeesWholeChange(existing, code)) return { ok: false, stage: 'review_too_large', file: LANE_FILE, providers, reason: 'the change is larger than the reviewer can read in full' };
    const r = await chatImpl({
        system: ROLES.security.system,
        // The reviewer reads a diff, not a browser. Say what the program measured, so "no evidence it fixes the overlap" is not a finding.
        prompt: reviewPrompt(issueText + `\n\nMEASURED BY THE PROGRAM IN A REAL BROWSER (invented data): before this CSS, ${before.problems} layout problem(s):\n${measured.slice(0, 700)}\nWith this CSS applied: ${judged ? judged.reason : 'not measured'} (verdict: ${judged ? judged.verdict : 'none'}). ${pruned.probes ? `The program tested the rules by removing them one at a time and measuring again (${pruned.dropped} the measurement did not need were already removed; the rest made the result worse when removed). ` : ''}The block is judged on whether it changes layout only and does not undo another rule's fix.`, LANE_FILE, existing, code),
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
