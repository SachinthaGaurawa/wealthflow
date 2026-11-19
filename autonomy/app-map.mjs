/* =============================================================================
 * autonomy/app-map.mjs — what the app ALREADY DOES, read from the code, so the idea engine does not propose what exists   (2026-11-19)
 * -----------------------------------------------------------------------------
 * MEASURED, 2026-11-19. The owner said the self-ideation "does not work". Reading its live results:
 *   · idea #607 "Display build ID next to version in Software Update" was approved and given to the builder; the build ID next to the version
 *     had shipped weeks before (PR #511). The engine knew only the titles of the last 12 merged pull requests.
 *   · both ideas it ever approved were cosmetic touches to ONE screen (the update card), because the only evidence it was given that was about the
 *     app itself was a list of module NAMES ("advisor-research, ai-v6 ...") and a list of screen ids.
 * So a model asked "what is missing?" could not tell what was there. This module gives it, from the repository itself and with no model:
 *   1. moduleSummaries  — one line per module, taken from the module's own header comment (what the module says it is).
 *   2. capabilityGaps   — a short list of things people expect from a personal-finance app, each with a word search over the code; those whose
 *                         words appear NOWHERE are offered as gaps. A word search is evidence, not proof: it is labelled that way, and the idea
 *                         must still say what to check first.
 *   3. closestExisting  — for one idea, the modules whose own summary shares the most words with it, so the board is told "this may already exist:".
 * Pure except for the two readers (`readModules`, `readCapabilityText`), which take a directory.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** The first comment block of a source file, as plain lines (no stars, rulers or the file's own name line). */
export function headerLines(src) {
    const m = /^\s*(?:\/\*+([\s\S]*?)\*\/)/.exec(String(src || '').replace(/^﻿/, ''));
    if (!m) return [];
    return m[1].split('\n')
        .map((l) => l.replace(/^\s*\*+\s?/, '').trim())
        .filter((l) => l && !/^[=\-_~*#\s]+$/.test(l));
}

/**
 * One sentence saying what a module is. The header's first line usually reads "wealthflow-x.js — the thing", so the part after the dash is
 * preferred; a header with no usable line gives ''. Never throws.
 */
export function summaryOf(src, file = '') {
    const lines = headerLines(src);
    const stem = path.basename(String(file)).replace(/\.[a-z]+$/i, '');
    for (const raw of lines.slice(0, 6)) {
        let l = raw.replace(/^[A-Za-z0-9_.\/-]+\.(?:js|mjs|cjs)\s*[—–:-]+\s*/, '');
        if (l === raw && stem && raw.toLowerCase().startsWith(stem.toLowerCase())) l = raw.slice(stem.length).replace(/^[\s.:—–-]+/, '');
        l = l.replace(/^(WHAT THIS IS|WHAT IT IS|PURPOSE)[.:]?\s*/i, '');
        if (/^[a-z]{2,}[\s.]*$/i.test(l) || l.length < 24) continue;
        if (/^(WHY|PROBLEM|CHANGE|NOTE|MEASURED|OWNER)\b/.test(l)) continue;
        return clip(l, 130);
    }
    return '';
}

/** [{ name, summary }] for every root `wealthflow-*.js` that has a usable header. `name` has no prefix or extension. */
export function readModules(repoDir = process.cwd()) {
    let names = [];
    try { names = fs.readdirSync(repoDir).filter((f) => /^wealthflow-[a-z0-9-]+\.js$/.test(f)).sort(); } catch { return []; }
    const out = [];
    for (const f of names) {
        let src = '';
        try { src = fs.readFileSync(path.join(repoDir, f), 'utf8').slice(0, 6000); } catch { continue; }
        const summary = summaryOf(src, f);
        if (summary) out.push({ name: f.replace(/^wealthflow-|\.js$/g, ''), summary });
    }
    return out;
}

/** The module list as the model sees it, within `maxChars` (the free-tier providers have small windows). */
export function renderModules(mods, maxChars = 7000) {
    let used = 0;
    const lines = [];
    for (const m of mods || []) {
        const l = `${m.name}: ${clip(m.summary, 110)}`;
        if (used + l.length + 2 > maxChars) break;
        lines.push(l); used += l.length + 2;
    }
    return lines.join('; ');
}

/**
 * Things people expect from a personal-finance app, with the words that would appear in the code if the app had them.
 * A gap is listed only when NONE of the words appear anywhere in index.html or the modules. Honest limits: a word search can miss a feature written
 * with other words, and finding words does not prove the feature is complete. It is a list of places to LOOK FIRST, never a verdict.
 */
export const CAPABILITIES = Object.freeze([
    { id: 'text-size', label: 'a text-size setting (larger text for tired eyes or small phones)', words: [/text size/i, /font.?scale/i, /larger text/i, /fontSizePref/i] },
    { id: 'shortcuts-help', label: 'a list of keyboard shortcuts on desktop', words: [/keyboard shortcuts?/i, /shortcut help/i] },
    { id: 'net-worth-trend', label: 'net worth shown over time, not only today', words: [/net.?worth.{0,60}(history|trend|over time|timeline|month)/i] },
    { id: 'weekly-digest', label: 'a short weekly summary of what changed and what is due', words: [/weekly (digest|summary|review)/i] },
    { id: 'first-run-tour', label: 'a short guided first-run tour for a new person', words: [/guided tour/i, /first.?run (tour|checklist)/i, /getting started/i] },
    { id: 'debt-free-date', label: 'the date the person becomes debt-free, and what an extra payment would change', words: [/debt.?free (date|on|by)/i] },
    { id: 'record-notes', label: 'a free-text note on a record (loan, cheque, expense)', words: [/add a note/i, /record note/i, /notes? field/i, /\bnote\b.{0,30}placeholder/i] },
]);

/** The capabilities none of whose words appear in `text`. `text` is index.html and the modules joined. */
export function capabilityGaps(text) {
    const hay = String(text || '');
    return CAPABILITIES.filter((c) => !c.words.some((re) => re.test(hay)));
}

export function readCapabilityText(repoDir = process.cwd()) {
    let parts = [];
    try {
        const names = fs.readdirSync(repoDir).filter((f) => f === 'index.html' || /^wealthflow-[a-z0-9-]+\.js$/.test(f));
        parts = names.map((f) => { try { return fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { return ''; } });
    } catch { /* not a checkout */ }
    return parts.join('\n');
}

// ── is this idea something the app already has? ──────────────────────────────────────────────────

const STOP = new Set(('the a an and or of to in on for with from by is are be it its this that when then if one each every more new show shows showing add adds make makes let lets use used using app screen page card button option feature line text small first simple easy plain read only already instead without under next after before into over than your you their they them can will not no yes all any per just also').split(' '));
export const wordsOf = (t) => [...new Set(String(t || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')))];

/**
 * The modules whose own summary (and name) share the most words with an idea's title and proposal. Returns [{ name, summary, shared }], best first,
 * only when at least `min` distinctive words are shared, so the board is shown a short list and an empty one means "nothing looks like it".
 */
export function closestExisting(idea, mods, { k = 3, min = 2 } = {}) {
    const want = new Set(wordsOf(`${idea?.title || ''} ${idea?.title || ''} ${idea?.proposal || ''}`));
    if (!want.size) return [];
    const scored = [];
    for (const m of mods || []) {
        const have = wordsOf(`${m.name.replace(/-/g, ' ')} ${m.summary}`);
        const shared = have.filter((w) => want.has(w));
        if (shared.length >= min) scored.push({ name: m.name, summary: m.summary, shared: shared.slice(0, 6), n: shared.length });
    }
    return scored.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, k).map(({ n, ...x }) => x);
}
