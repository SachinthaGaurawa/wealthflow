/* =============================================================================
 * autonomy/acceptance.mjs — RUN the change like the owner would, then judge what appeared   (owner, 2026-11-20)
 * -----------------------------------------------------------------------------
 * WHY. Issue #635 (CC Instalments, "I cannot tap a row to see which products"): every gate said yes (tests green, security review, board of three models, CI,
 * the NEW-tag check) and the sheet that shipped still contradicted the table next to it ("paid 0 of 12" under a row that said 3 of 12), never said which
 * products, and had never been looked at on a phone by anything. The gates read the DIFF; the recipe test only asks that an element exists. Nothing ran the
 * change in a browser the way the owner uses it and compared what appeared with what the owner asked for. The owner's words: "did you test it? run it, look at
 * the result, check whether there are more problems, discuss it with the other AI models."
 *
 * WHAT IT DOES (nothing here edits the repository; the new file is served from memory):
 *   1. a TESTER model reads the owner's report and writes a short script of allowed steps (open a page, call a render function, tap, wait, shot) and the books to seed;
 *   2. the app boots in real Chromium at the owner's phone size, the new module is served beside it, the steps run, and every step records WHAT APPEARED
 *      (the visible lines that were not there before, the text of any sheet that opened) plus screenshots;
 *   3. a program adds measures no model can argue with: script errors, a tap that changed nothing, sideways scrolling, hit targets under 36px, clipped text;
 *   4. TWO JUDGE models on different providers read the owner's words next to that evidence and list defects, each with a VERBATIM QUOTE;
 *   5. a program throws away every finding whose quote is not really in the evidence (so a model cannot invent a defect) and marks the ones both judges raised.
 * The caller (the build lane) hands the surviving findings to the author, who revises, and the run is repeated; a change is not offered as a pull request
 * until it passes or the revision budget is spent, and whatever is left is written into the pull request as "known issues", never hidden.
 *
 * HONESTY. If Chromium cannot start the result is `skipped` with the reason (never a silent pass). A tap the tester got wrong (the selector is not on the page) is
 * `inconclusive`, not a defect of the module.
 * ===========================================================================*/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat, extractJson } from './llm-router.mjs';
import { fenceUntrusted } from './untrusted-text.mjs';
import { readRecipe, parseBooks } from './recipe-test.mjs';

export const PHONE = { width: 430, height: 932 };
const KINDS = new Set(['contradiction', 'missing', 'unclear', 'wrong', 'ugly']);
const SEVERITIES = new Set(['high', 'medium', 'low']);
const MAX_STEPS = 12;
const MAX_BOOK_ITEMS = 24;
const MAX_BOOKS_CHARS = 24_000;
const SELECTOR_RE = /^[\w\s#.\[\]="'\-:>+~*,()^$|]{1,160}$/;
const SCRIPT_ANCHOR = '<script src="wealthflow-update-system.js" defer></script>';

/* ------------------------------------------------------------------ pure parts */

/** Lowercase, one space between words, so a quote survives line breaks and double spaces in the evidence. */
export const norm = (s) => String(s == null ? '' : s).replace(/[ \s]+/g, ' ').trim().toLowerCase();

/** Is `quote` really somewhere in `haystack`? A quote under 6 characters proves nothing and is refused. */
export function quoteFound(quote, haystack) {
    const q = norm(quote);
    if (q.length < 6) return false;
    return norm(haystack).includes(q);
}

/** Lines that are on screen after but were not before (a screen is a list of visible text lines). */
export function newLines(before, after) {
    const had = new Map();
    for (const l of before || []) had.set(l, (had.get(l) || 0) + 1);
    const out = [];
    for (const l of after || []) {
        const n = had.get(l) || 0;
        if (n > 0) had.set(l, n - 1); else out.push(l);
    }
    return out;
}

/**
 * The tester's plan, made safe. Nothing the model wrote is ever run as code: a step is one of five fixed verbs with a checked argument.
 * @returns {{ ok:boolean, plan?:{criteria:string[], books:object, steps:object[]}, why?:string }}
 */
export function validatePlan(raw) {
    const j = raw && typeof raw === 'object' ? raw : null;
    if (!j) return { ok: false, why: 'the tester returned no plan' };
    const criteria = (Array.isArray(j.criteria) ? j.criteria : []).map((c) => String(c).replace(/\s+/g, ' ').trim().slice(0, 240)).filter(Boolean).slice(0, 8);
    const books = {};
    let chars = 0;
    for (const [k, v] of Object.entries(j.books && typeof j.books === 'object' ? j.books : {})) {
        if (!/^[a-z][a-z0-9_]{1,30}$/i.test(k) || !Array.isArray(v)) continue;
        const arr = v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).slice(0, MAX_BOOK_ITEMS);
        chars += JSON.stringify(arr).length;
        if (chars > MAX_BOOKS_CHARS) break;
        books[k] = arr;
    }
    const steps = [];
    for (const s of (Array.isArray(j.steps) ? j.steps : []).slice(0, MAX_STEPS)) {
        if (!s || typeof s !== 'object') continue;
        const d = String(s.do || '').toLowerCase();
        if (d === 'page' && /^[a-z0-9_-]{1,40}$/i.test(String(s.name || ''))) steps.push({ do: 'page', name: String(s.name) });
        else if (d === 'render' && /^render[A-Za-z0-9_]{0,40}$/.test(String(s.fn || ''))) steps.push({ do: 'render', fn: String(s.fn) });
        else if (d === 'tap' && typeof s.selector === 'string' && SELECTOR_RE.test(s.selector) && !/javascript:/i.test(s.selector)) steps.push({ do: 'tap', selector: s.selector.trim(), expectChange: s.expectChange !== false });
        else if (d === 'tap' && typeof s.text === 'string' && s.text.trim().length >= 2) steps.push({ do: 'tap', text: s.text.trim().slice(0, 80), expectChange: s.expectChange !== false });
        else if (d === 'wait') steps.push({ do: 'wait', ms: Math.max(50, Math.min(3000, Number(s.ms) || 400)) });
        else if (d === 'shot') steps.push({ do: 'shot', label: String(s.label || 'shot').replace(/[^\w -]/g, '').slice(0, 40) || 'shot' });
    }
    if (!steps.some((s) => s.do === 'tap' || s.do === 'page' || s.do === 'render')) return { ok: false, why: 'the plan has no step that opens or taps anything' };
    return { ok: true, plan: { criteria, books, steps } };
}

/** The recipe books of a module (the author's own example records), used when the tester seeds none. */
export function recipeBooks(code) {
    const rec = readRecipe(code);
    return (rec && parseBooks(rec.books)) || {};
}

const words = (s) => new Set(norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));

/** Do two quotes point at the same thing? (one holds the other, or they share most of their words) */
export function sameFinding(a, b) {
    if (!a || !b) return false;
    const qa = norm(a.quote), qb = norm(b.quote);
    if (qa && qb && (qa.includes(qb) || qb.includes(qa))) return true;
    const wa = words(qa), wb = words(qb);
    if (!wa.size || !wb.size) return false;
    let n = 0;
    for (const w of wa) if (wb.has(w)) n++;
    return n / Math.min(wa.size, wb.size) >= 0.6;
}

/**
 * One judge's reply, cleaned: only the five kinds, only real severities, and only findings whose quote is in the evidence.
 * @returns {{ kept:object[], dropped:object[] }}
 */
export function verifyFindings(list, evidenceText) {
    const kept = [], dropped = [];
    for (const f of Array.isArray(list) ? list : []) {
        if (!f || typeof f !== 'object') continue;
        const item = {
            kind: KINDS.has(String(f.kind || '').toLowerCase()) ? String(f.kind).toLowerCase() : 'wrong',
            severity: SEVERITIES.has(String(f.severity || '').toLowerCase()) ? String(f.severity).toLowerCase() : 'medium',
            quote: String(f.quote || '').replace(/\s+/g, ' ').trim().slice(0, 240),
            quote2: String(f.quote2 || '').replace(/\s+/g, ' ').trim().slice(0, 240),
            why: String(f.why || '').replace(/\s+/g, ' ').trim().slice(0, 400),
            fix: String(f.fix || '').replace(/\s+/g, ' ').trim().slice(0, 300),
        };
        if (!item.why) { dropped.push({ ...item, dropReason: 'no explanation' }); continue; }
        if (!quoteFound(item.quote, evidenceText)) { dropped.push({ ...item, dropReason: 'the quote is not in the evidence' }); continue; }
        if (item.quote2 && !quoteFound(item.quote2, evidenceText)) item.quote2 = '';
        kept.push(item);
    }
    return { kept, dropped };
}

/**
 * Two judges' verified findings as one list. A finding both raised is `agreed`. Blocking: a deterministic problem always; a model finding when
 * both judges raised it, or one judge raised it as high or medium. A single judge's low finding is a note.
 */
export function mergeFindings(a, b, hard = []) {
    const out = hard.map((h) => ({ ...h, agreed: true, blocking: h.severity !== 'low', source: 'measured' }));
    const used = new Set();
    for (const f of a) {
        const j = b.findIndex((g, i) => !used.has(i) && sameFinding(f, g));
        if (j >= 0) { used.add(j); out.push({ ...f, severity: [f.severity, b[j].severity].includes('high') ? 'high' : f.severity, agreed: true, blocking: true, source: 'both judges' }); }
        else out.push({ ...f, agreed: false, blocking: f.severity !== 'low', source: 'one judge' });
    }
    b.forEach((g, i) => { if (!used.has(i)) out.push({ ...g, agreed: false, blocking: g.severity !== 'low', source: 'one judge' }); });
    return out;
}

/** The findings as the author sees them when it revises. */
export function findingsBrief(findings) {
    return (findings || []).filter((f) => f.blocking).slice(0, 8).map((f, i) =>
        `${i + 1}. [${f.kind}${f.source === 'measured' ? ', measured by a program' : f.agreed ? ', both judges' : ''}] ${f.why}${f.quote ? ` — on screen: "${f.quote}"` : ''}${f.quote2 ? ` and "${f.quote2}"` : ''}${f.fix ? ` — fix: ${f.fix}` : ''}`).join('\n');
}

/* ------------------------------------------------------------------ the prompts */

export function testerPrompt({ issueText, api = '', surface = [], facts = '', code = '', found = null, edit = false }) {
    const rec = readRecipe(code);
    return [
        edit
            ? 'You are the TESTER. An existing screen of WealthFlow, a personal-finance PWA, was just EDITED (its text, markup and styling) to fix what the owner reported. You will NOT see it run; write the script a person would follow on their PHONE to see for themselves whether the edited screen now does what the OWNER asked.'
            : 'You are the TESTER. A new read-only module was just written for WealthFlow, a personal-finance PWA. You will NOT see the module run; write the script a person would follow on their PHONE to see for themselves whether the change does what the OWNER asked.',
        '',
        "THE OWNER'S REPORT:", fenceUntrusted('report', issueText, 2400), '',
        ...(facts ? ['THE REAL CODE OF THE SCREEN THE REPORT IS ABOUT (use its ids, classes and function names exactly):', fenceUntrusted('screen code', facts, 3200), ''] : []),
        ...(api ? [`THE NEW MODULE: window.${api}${surface.length ? `, exposes ${surface.slice(0, 16).join(', ')}` : ''}.`, ''] : []),
        ...(rec ? ['THE AUTHOR\'S OWN RECIPE (an example of data and calls; the books there are real field names):', JSON.stringify(rec).slice(0, 1800), ''] : []),
        ...(found ? ['WHAT A FIRST RUN COULD NOT DO (fix your script; these are the visible, tappable things that DO exist on the page):', JSON.stringify(found).slice(0, 1800), ''] : []),
        'Reply with ONE JSON object and nothing else:',
        '{"criteria":["2 to 6 short checks, each one a thing the owner would look at to say yes this is what I asked, written from THEIR words"],',
        ' "books":{"<DB key>":[ {a complete record with the real field names}, ... ]},   // 2 to 4 records per key, realistic, with different values so a wrong number cannot hide',
        ' "steps":[ {"do":"page","name":"<the page id passed to showPage>"}, {"do":"render","fn":"<a global render function with no arguments>"}, {"do":"tap","selector":"<css selector of what the person taps>"} or {"do":"tap","text":"<visible words>"}, {"do":"wait","ms":400}, {"do":"shot","label":"after tapping the first row"} ]}',
        'Rules: at most 12 steps. Follow the owner\'s own words (open the screen, tap the thing they said they could not tap). After every tap that should show something, add a shot. Put DIFFERENT numbers in the seeded records (different totals, durations, dates) so that two places showing the same fact can be compared. Never invent a selector that is not in the code you were shown.',
    ].join('\n');
}

export function judgePrompt({ issueText, criteria = [], evidence = '', role = 'A' }) {
    return [
        `You are JUDGE ${role}. A feature was built from the owner's report below, then RUN on a phone in a real browser. You are shown what was on the screen at each step. Decide whether a person who filed this report would say "yes, this is what I asked", and list every defect you can PROVE from the evidence.`,
        '',
        "THE OWNER'S REPORT:", fenceUntrusted('report', issueText, 2400), '',
        ...(criteria.length ? ['WHAT THE OWNER WOULD CHECK:', ...criteria.map((c, i) => `${i + 1}. ${c}`), ''] : []),
        'EVIDENCE (the words that appeared on screen; a program recorded them, nobody summarised):', fenceUntrusted('evidence', evidence, 9000), '',
        'What counts as a defect:',
        '  · contradiction: the same quantity or state is shown twice and the two do not agree (two different counts, a total that does not match its parts, a table row and the sheet it opened). THIS IS THE MOST COMMON AND MOST DAMAGING FAULT: look for it first. Put both texts in "quote" and "quote2".',
        '  · missing: the owner asked for something (for example WHICH products) and no text on screen answers it. Quote the owner\'s words that ask for it.',
        '  · unclear: a label, unit or number a person cannot understand without guessing (a figure with no unit, an abbreviation, "N/A" with no reason).',
        '  · wrong: text that is false given the data seeded (a wrong date, a wrong sum, a state that does not follow).',
        '  · ugly: only what the evidence shows (cut-off text, a target too small, content that does not fit a phone). Do not guess at colours or fonts.',
        'RULES: every finding MUST carry "quote": a piece of the evidence or of the owner\'s report copied EXACTLY (at least 6 characters). A finding whose quote is not found in the text above is thrown away by a program. Do not invent defects to look thorough; an empty list is a valid answer when the screen is right. Be concrete: say what the person would see and what is wrong with it.',
        'Reply with ONE JSON object and nothing else:',
        '{"verdict":"ok"|"problems","findings":[{"kind":"contradiction|missing|unclear|wrong|ugly","severity":"high|medium|low","quote":"...","quote2":"(optional, the second place)","why":"one sentence","fix":"one sentence"}]}',
    ].join('\n');
}

/* ------------------------------------------------------------------ the browser run */

/** The hit targets and clipped text inside the sheets that are open. Runs in the page. */
const MEASURE_IN_PAGE = () => {
    const vw = innerWidth, vh = innerHeight;
    const sheets = [];
    for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vw * vh * 0.18 || r.bottom <= 0 || r.top >= vh) continue;
        const text = (el.innerText || '').replace(/[ \t]+/g, ' ').trim();
        if (text) sheets.push({ el, id: el.id || '', text });
    }
    // an element inside a bigger sheet is not a sheet of its own
    const tops = sheets.filter((s) => !sheets.some((o) => o !== s && o.el.contains(s.el)));
    const small = [], clipped = [];
    for (const s of tops) {
        for (const n of s.el.querySelectorAll('button, a, [role="button"], input, select, summary')) {
            const r = n.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.height < 36) small.push(((n.innerText || n.getAttribute('aria-label') || n.tagName) + '').trim().slice(0, 40) + ` (${Math.round(r.height)}px tall)`);
        }
        for (const n of s.el.querySelectorAll('*')) {
            const cs = getComputedStyle(n);
            if (!(n.innerText || '').trim()) continue;
            if ((cs.overflowX === 'hidden' || cs.overflowX === 'clip') && n.scrollWidth > n.clientWidth + 2 && cs.textOverflow !== 'ellipsis') clipped.push((n.innerText || '').trim().slice(0, 50));
        }
    }
    return {
        sheets: tops.map((s) => ({ id: s.id, text: s.text.slice(0, 2500) })).slice(-3),
        small: [...new Set(small)].slice(0, 6),
        clipped: [...new Set(clipped)].slice(0, 6),
        overflowX: document.documentElement.scrollWidth - innerWidth,
    };
};

// The app's own toasts (.notif: a greeting, "Synced") come and go by themselves and are not an answer to a tap, so they are left out of what is read.
const SNAP = () => {
    const toasts = [...document.querySelectorAll('.notif')];
    const was = toasts.map((e) => e.style.visibility);
    toasts.forEach((e) => { e.style.visibility = 'hidden'; });
    const t = (document.body.innerText || '').split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    toasts.forEach((e, i) => { e.style.visibility = was[i]; });
    return t;
};

/**
 * Carry out the plan on a Playwright page and record what appeared. Pure with respect to the repository.
 * @returns {Promise<{ steps:object[], hard:object[], shots:string[], missed:object[] }>}
 */
export async function collectEvidence(page, plan, { outDir, seeds = {}, pageErrors = [], log = () => {} } = {}) {
    const steps = [], hard = [], shots = [], missed = [];
    fs.mkdirSync(outDir, { recursive: true });
    if (Object.keys(seeds).length) {
        await page.evaluate((b) => { for (const [k, v] of Object.entries(b)) { try { DB.set(k, v, true); } catch (_) { /* a book the app does not know */ } } }, seeds);
    }
    let shotN = 0;
    const take = async (label) => { const f = path.join(outDir, `${String(++shotN).padStart(2, '0')}-${label.replace(/[^\w-]+/g, '-')}.png`); await page.screenshot({ path: f }).catch(() => {}); if (fs.existsSync(f)) shots.push(f); return f; };
    let before = await page.evaluate(SNAP);
    let base = await page.evaluate(MEASURE_IN_PAGE);
    let baseOverflow = base.overflowX;
    // a sheet that was already open before the step (the side menu, a bottom bar) is part of the page, not something the step opened
    const fresh = (m, was) => m.sheets.filter((sh) => !was.sheets.some((w) => (w.id && w.id === sh.id) || w.text.slice(0, 80) === sh.text.slice(0, 80)));
    for (const [i, s] of plan.steps.entries()) {
        const rec = { n: i + 1, step: s, ok: true, note: '', lines: [], sheets: [] };
        try {
            if (s.do === 'page') {
                const ok = await page.evaluate((n) => { if (typeof showPage !== 'function') return false; showPage(n); return true; }, s.name);
                if (!ok) { rec.ok = false; rec.note = 'showPage is not a function in this app'; }
                await page.waitForTimeout(450);
            } else if (s.do === 'render') {
                const ok = await page.evaluate((fn) => { if (typeof window[fn] !== 'function') return false; window[fn](); return true; }, s.fn);
                if (!ok) { rec.ok = false; rec.note = `${s.fn} is not a function on the page`; }
                await page.waitForTimeout(350);
            } else if (s.do === 'wait') {
                await page.waitForTimeout(s.ms);
            } else if (s.do === 'shot') {
                await take(s.label);
            } else if (s.do === 'tap') {
                const loc = s.selector ? page.locator(s.selector).first() : page.getByText(s.text, { exact: false }).first();
                const count = s.selector ? await page.locator(s.selector).count() : await page.getByText(s.text, { exact: false }).count();
                if (!count) { rec.ok = false; rec.note = `nothing on the page matches ${s.selector || `"${s.text}"`}`; missed.push({ step: i + 1, target: s.selector || s.text }); }
                else {
                    await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
                    // what was on screen just before the tap (the page may still have been drawing something of its own after the last step)
                    // wait until the screen has stopped changing by itself (at most ~4 seconds), so a late line the app draws on its own is not credited to the tap
                    let prev = JSON.stringify(await page.evaluate(SNAP));
                    for (let k = 0; k < 10; k++) { await page.waitForTimeout(400); const now = JSON.stringify(await page.evaluate(SNAP)); if (now === prev) break; prev = now; }
                    before = await page.evaluate(SNAP); base = await page.evaluate(MEASURE_IN_PAGE);
                    const urlBefore = page.url();
                    await loc.click({ timeout: 3000 });
                    await page.waitForTimeout(500);
                    const after = await page.evaluate(SNAP);
                    const m = await page.evaluate(MEASURE_IN_PAGE);
                    rec.lines = newLines(before, after).slice(0, 80);
                    rec.sheets = fresh(m, base);
                    rec.measures = { small: m.small, clipped: m.clipped, overflowX: m.overflowX };
                    await take(`tap-${i + 1}`);
                    if (s.expectChange !== false && !rec.lines.length && !rec.sheets.length && page.url() === urlBefore) {
                        hard.push({ measure: 'dead_tap', kind: 'wrong', severity: 'high', quote: String(s.selector || s.text), why: `Tapping ${s.selector || `"${s.text}"`} changed nothing on the screen: no new text and no sheet opened.`, fix: 'Make the tap open or show what the owner asked for.' });
                    }
                    if (m.overflowX > baseOverflow + 2) hard.push({ measure: 'overflow', kind: 'ugly', severity: 'medium', quote: `sideways scroll ${m.overflowX}px`, why: `After step ${i + 1} the page scrolls sideways by ${m.overflowX}px on a ${PHONE.width}px phone.`, fix: 'Make the new content fit the phone width.' });
                    if (m.small.length) hard.push({ measure: 'small_target', kind: 'ugly', severity: 'low', quote: m.small[0], why: `Hit targets under 36px inside the sheet: ${m.small.join('; ')}.`, fix: 'Make tappable things at least 44px tall.' });
                    if (m.clipped.length) hard.push({ measure: 'clipped', kind: 'ugly', severity: 'medium', quote: m.clipped[0], why: `Text is cut off inside the sheet: ${m.clipped.join('; ')}.`, fix: 'Let the text wrap instead of clipping it.' });
                    before = after; base = m;
                }
            }
        } catch (e) { rec.ok = false; rec.note = String(e && e.message || e).split('\n')[0].slice(0, 160); }
        if (s.do !== 'tap' && s.do !== 'wait' && s.do !== 'shot') {
            const after = await page.evaluate(SNAP).catch(() => before);
            rec.lines = newLines(before, after).slice(0, 80);
            before = after;
        }
        steps.push(rec);
    }
    if (pageErrors.length) hard.push({ measure: 'error', kind: 'wrong', severity: 'high', quote: String(pageErrors[0]).slice(0, 120), why: `The page threw ${pageErrors.length} script error${pageErrors.length === 1 ? '' : 's'} while the test ran: ${pageErrors.slice(0, 3).join(' | ').slice(0, 300)}`, fix: 'Guard the code so it never throws.' });
    log(`[acceptance] ${steps.length} steps, ${steps.filter((s) => !s.ok).length} could not run, ${hard.length} measured problem(s)`);
    return { steps, hard, shots, missed };
}

/** The evidence as text the judges read (and the quotes are checked against). */
export function evidenceText({ steps, hard = [], vision = '', viewport = PHONE, seeds = {} }) {
    const out = [`A phone, ${viewport.width}x${viewport.height}px. Seeded books: ${Object.entries(seeds).map(([k, v]) => `${k} (${v.length} records)`).join(', ') || 'none'}.`, ''];
    for (const s of steps) {
        const what = s.step.do === 'tap' ? `tap ${s.step.selector || `"${s.step.text}"`}` : s.step.do === 'page' ? `open page ${s.step.name}` : s.step.do === 'render' ? `call ${s.step.fn}()` : s.step.do === 'shot' ? `screenshot "${s.step.label}"` : `wait ${s.step.ms}ms`;
        out.push(`--- Step ${s.n}: ${what}${s.ok ? '' : `  [COULD NOT RUN: ${s.note}]`}`);
        if (s.lines && s.lines.length) { out.push('Text that appeared on screen:'); for (const l of s.lines.slice(0, 60)) out.push(`  ${l}`); }
        for (const sh of s.sheets || []) out.push(`A sheet is open${sh.id ? ` (#${sh.id})` : ''}, its text: ${sh.text.replace(/\s+/g, ' ').slice(0, 1800)}`);
    }
    if (hard.length) { out.push('', 'MEASURED BY A PROGRAM:'); for (const h of hard) out.push(`  · ${h.why}`); }
    if (vision) out.push('', 'WHAT A VISION MODEL SAW IN THE FINAL SCREENSHOT (a machine reading, can be wrong):', vision.replace(/\s+/g, ' ').slice(0, 1600));
    return out.join('\n');
}

/* ------------------------------------------------------------------ the whole run */

/**
 * Run a change on a phone and judge it.
 * @param {object} o
 * @param {{title?:string, body?:string}} o.issue
 * @param {{name:string, api?:string, code:string, overlay?:object}} o.module  the new (or revised) module, served from memory; with `overlay` ({file: text}) the page's own files are served changed instead (an edit, autonomy/edit-lane.mjs) and `code` is just the text the tester reads
 * @param {string} [o.facts]    the real code of the screen the report is about
 * @param {string[]} [o.surface] names the module exposes
 * @param {object} [o.deps]     { chat, boot, describe } for tests
 * @returns {Promise<{ status:'passed'|'problems'|'inconclusive'|'skipped', findings:object[], blocking:object[], notes:object[], criteria:string[], shots:string[], judges:string[], reason?:string, evidence?:string }>}
 */
export async function runAcceptance({ issue = {}, module: mod, facts = '', surface = [], repoDir = process.cwd(), env = process.env, log = () => {}, deps = {}, outDir = '', viewport = PHONE } = {}) {
    const ask = deps.chat || chat;
    const issueText = `${issue.title || ''}\n\n${issue.body || ''}`.trim();
    const skipped = (reason) => ({ status: 'skipped', findings: [], blocking: [], notes: [], criteria: [], shots: [], judges: [], reason });
    if (!mod || !mod.name || !mod.code) return skipped('no module to run');
    if (!issueText) return skipped('no report to compare with');
    const dir = outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wf-acceptance-'));

    // 1. the tester's script (asked again once if the first one tapped things that are not there)
    const askPlan = async (found = null) => {
        const t = await ask({ system: 'You write precise, minimal browser test scripts for a phone UI. You output JSON only.', prompt: testerPrompt({ issueText, api: mod.api, surface, facts, code: mod.code, found, edit: Boolean(mod.overlay) }), prefer: ['reasoning', 'strongest'], maxTokens: 2200, temperature: 0.2, env }).catch((e) => ({ text: '', _error: e.message }));
        let json = null; try { json = t.text ? extractJson(t.text) : null; } catch (_) { json = null; }
        return { ...validatePlan(json), provider: t.provider };
    };
    let tp = await askPlan();
    if (!tp.ok) tp = await askPlan();
    if (!tp.ok) return { ...skipped(`no usable test script: ${tp.why}`), status: 'inconclusive' };
    let plan = tp.plan;
    plan.books = { ...recipeBooks(mod.code), ...plan.books };
    log(`[acceptance] script by ${tp.provider}: ${plan.steps.length} steps, books ${Object.keys(plan.books).join(', ') || 'none'}`);

    // 2. the browser
    const boot = deps.boot || (async (o) => (await import('../test/e2e/harness.mjs')).bootApp(o));
    const run = async (p) => {
        const app = await boot({
            repoDir, mobile: true, viewport,
            // a NEW module is served beside the page and put on it; an EDIT of the page itself (autonomy/edit-lane.mjs) serves the changed files as they are
            overlay: mod.overlay || { [mod.name]: mod.code },
            htmlTransform: mod.overlay ? undefined : (html) => (html.includes(`src="${mod.name}"`) ? html : html.includes(SCRIPT_ANCHOR) ? html.replace(SCRIPT_ANCHOR, `<script src="${mod.name}" defer></script>\n    ${SCRIPT_ANCHOR}`) : html.replace('</body>', `<script src="${mod.name}" defer></script></body>`)),
        });
        try {
            const note = app.page.locator('#wfPostUpdate');
            if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});
            await app.page.waitForFunction((api) => !api || !!window[api], mod.api || '', { timeout: 15000 }).catch(() => {});
            const errorsBefore = app.pageErrors.length;
            const ev = await collectEvidence(app.page, p, { outDir: dir, seeds: p.books, pageErrors: app.pageErrors.slice(errorsBefore), log });
            // ONE advisory look at the last screenshot by a vision model (a second pair of eyes for the judges; never a gate by itself)
            let vision = '';
            const last = ev.shots[ev.shots.length - 1];
            if (last) {
                try {
                    const describe = deps.describe || (await import('../wf-screenshot-reader.mjs')).describeScreenshot;
                    const d = await Promise.race([
                        describe({ dataUrl: 'data:image/png;base64,' + fs.readFileSync(last).toString('base64'), title: issue.title || '', text: 'This is the screen of a finance app on a phone after the person tapped. Read every label and number exactly.', verify: false, env, log }),
                        new Promise((r) => setTimeout(() => r({ ok: false }), 40_000)),
                    ]);
                    if (d && d.ok) vision = d.text;
                } catch (_) { /* advisory only */ }
            }
            return { ...ev, vision };
        } finally { await app.close().catch(() => {}); }
    };
    let ev;
    try { ev = await run(plan); } catch (e) { return skipped(`the browser could not run the change: ${String(e && e.message || e).split('\n')[0].slice(0, 200)}`); }
    if (ev.missed.length) {
        const found = { missedTargets: ev.missed, note: 'these selectors matched nothing; use ones that exist in the code shown' };
        const again = await askPlan(found);
        if (again.ok) {
            again.plan.books = { ...plan.books, ...again.plan.books };
            try { const ev2 = await run(again.plan); if (ev2.missed.length <= ev.missed.length) { ev = ev2; plan = again.plan; } } catch (_) { /* keep the first run */ }
        }
    }

    // 3. two judges on different providers
    const seeds = plan.books;
    const text = evidenceText({ steps: ev.steps, hard: ev.hard, vision: ev.vision, viewport, seeds });
    const haystack = `${text}\n${issueText}`;
    const j1 = await ask({ system: 'You are a meticulous product tester. You output JSON only.', prompt: judgePrompt({ issueText, criteria: plan.criteria, evidence: text, role: 'A' }), prefer: ['reasoning', 'strongest'], maxTokens: 1800, temperature: 0, env }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
    const j2 = await ask({ system: 'You are a meticulous product tester. You output JSON only.', prompt: judgePrompt({ issueText, criteria: plan.criteria, evidence: text, role: 'B' }), prefer: ['reasoning', 'strongest'], exclude: j1.provider && j1.provider !== 'none' ? [j1.provider] : [], maxTokens: 1800, temperature: 0, env }).catch((e) => ({ text: '', provider: 'none', _error: e.message }));
    const parse = (r) => { try { return r.text ? extractJson(r.text) : null; } catch (_) { return null; } };
    const p1 = parse(j1), p2 = parse(j2);
    const v1 = verifyFindings(p1 && p1.findings, haystack), v2 = verifyFindings(p2 && p2.findings, haystack);
    const judges = [j1.provider, j2.provider].filter((x) => x && x !== 'none');
    log(`[acceptance] judges: ${judges.join(' + ') || 'none answered'}; kept ${v1.kept.length}+${v2.kept.length}, dropped (quote not in evidence) ${v1.dropped.length}+${v2.dropped.length}`);
    const findings = mergeFindings(v1.kept, v2.kept, ev.hard);
    const blocking = findings.filter((f) => f.blocking);
    const notes = findings.filter((f) => !f.blocking);
    const answered = Boolean(p1) + Boolean(p2);
    let status = blocking.length ? 'problems' : (answered === 0 ? 'inconclusive' : 'passed');
    if (status === 'passed' && ev.missed.length && ev.steps.every((s) => !s.ok || s.step.do !== 'tap')) status = 'inconclusive';
    return {
        status, findings, blocking, notes, criteria: plan.criteria, shots: ev.shots, judges, evidence: text,
        dropped: [...v1.dropped, ...v2.dropped].length,
        ...(status === 'inconclusive' ? { reason: answered === 0 ? 'no judge answered' : 'the script could not reach what it was meant to tap' } : {}),
    };
}

/** One paragraph for a pull request body or a comment. */
export function acceptanceSummary(r) {
    if (!r) return '';
    const head = { passed: '**Acceptance run: PASSED.**', problems: '**Acceptance run: problems remain** (listed below).', inconclusive: '**Acceptance run: inconclusive**', skipped: '**Acceptance run: not run**' }[r.status] || '';
    const lines = [head, `The change was run in real Chromium on a ${PHONE.width}x${PHONE.height} phone screen, with invented books, by a script a model wrote from the report; ${r.judges && r.judges.length ? `then judged by ${r.judges.join(' and ')}` : 'no judge answered'}. Every finding below quotes the screen; a finding whose quote is not on the screen is thrown away by a program.`];
    if (r.reason) lines.push(`Reason: ${r.reason}.`);
    if (r.criteria && r.criteria.length) lines.push('', 'What the owner would check:', ...r.criteria.map((c) => `- ${c}`));
    const show = (list, title) => { if (list && list.length) { lines.push('', title); for (const f of list) lines.push(`- **${f.kind}** (${f.severity}${f.agreed && f.source !== 'measured' ? ', both judges' : f.source === 'measured' ? ', measured' : ''}): ${f.why}${f.quote ? ` — "${f.quote}"` : ''}`); } };
    show(r.blocking, 'Known issues:');
    show(r.notes, 'Notes:');
    return lines.join('\n');
}
