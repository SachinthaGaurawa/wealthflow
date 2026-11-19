/* =============================================================================
 * autonomy/symptom-home.mjs — where is the thing the report is about actually drawn?
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (measured, 2026-11-19, issue #635 — the owner's own report)
 *   "CC Instalments: no way to see which products are in it, tapping a row opens nothing, on a phone."
 *   The agent tried twice and did NOTHING either time, for one reason that no earlier fix addressed:
 *     1. The screen is drawn by `renderCCI` inside index.html. No lane may edit index.html (the swarm edits one plain root module,
 *        the CSS lane edits CSS only). Nothing in the agent knew that, so it ranked modules by shared words and picked
 *        `wealthflow-card-plans.js`, a statement-table parser that draws nothing.
 *     2. The author model, handed a file that cannot contain the fix, returned the file with a comment shortened and the last newline
 *        removed. That "change" went all the way to the independent reviewer, which refused it, and the SAME file was chosen again
 *        on the next try (the earlier tries were only described in a prompt, never excluded).
 *
 * WHAT IS HERE (no network, no model)
 *   codeOnly / isCosmeticChange  a change that touches only comments and whitespace is not a fix; say so before anyone reviews it
 *   visibleStrings               the words a person can read on the screen, taken from the screenshot reading
 *   findHome                     which files in the repository contain those words (the screen's real home)
 *   functionAround               the function that draws them, cut out of the file, so an author is shown real code
 *   reachabilityGap              the report says something cannot be seen, opened or tapped
 *   homeFacts                    the text an author is shown: where the screen is drawn, the books it reads, the code itself
 *
 * HONESTY
 *   A home is "found" only when two or more distinct strings from the screen sit in the same file. One shared word proves nothing.
 *   Nothing here edits anything; it only says where to look, and which files cannot be the answer.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

/**
 * The code with comments removed and whitespace outside strings collapsed. Strings and template literals are kept verbatim, so a
 * change inside text always shows. A regex literal that contains a quote can confuse the scanner; the failure direction is "treat more
 * as string", which only makes a change look MORE real, never less.
 */
export function codeOnly(src) {
    const s = String(src || '');
    let out = '';
    for (let i = 0; i < s.length;) {
        const c = s[i], d = s[i + 1];
        if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; if (!out.endsWith(' ')) out += ' '; continue; }
        if (c === '"' || c === "'" || c === '`') {
            let j = i + 1;
            while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; if (c !== '`' && s[j] === '\n') break; j++; }
            out += s.slice(i, j + 1); i = j + 1; continue;
        }
        if (/\s/.test(c)) { if (!out.endsWith(' ')) out += ' '; } else out += c;
        i++;
    }
    return out.trim();
}

/** True when `after` differs from `before` only in comments and whitespace: nothing a person or a test could observe changes. */
export function isCosmeticChange(before, after) {
    if (!String(before || '').trim() || !String(after || '').trim()) return false;
    return codeOnly(before) === codeOnly(after);
}

const GENERIC = new Set(['home', 'income', 'spending', 'loans', 'more', 'history', 'all', 'actions', 'product', 'monthly', 'date', 'settings',
    'dashboard', 'save', 'cancel', 'close', 'edit', 'delete', 'add', 'search', 'back', 'next', 'done', 'active', 'completed', 'total']);

/**
 * The words a person can read on the screen. Taken from the screenshot reading's TRANSCRIPT block when there is one, and from text in
 * "quotation marks" in the report otherwise. Lines that are only numbers, times or one everyday word are dropped: they say nothing
 * about WHICH screen it is.
 */
export function visibleStrings(text, { max = 30 } = {}) {
    const t = String(text || '');
    const own = t.split(/\n#{2,3}\s*System diagnosis/i)[0];   // the diagnosis table and mailbox JSON are not on the screen
    const block = (t.match(/TRANSCRIPT:\s*\n([\s\S]*?)(?:\n\s*\n|\nSCREEN:|$)/) || [])[1] || '';
    const lines = block.split('\n').map((x) => x.trim().replace(/[…]+$/, '').replace(/\.{3}$/, '').trim());
    const quoted = [...own.matchAll(/["“]([^"”\n]{6,60})["”]/g)].map((m) => m[1].trim());
    const out = [];
    for (const l of [...lines, ...quoted]) {
        if (l.length < 6 || l.length > 60) continue;
        if (!/[A-Za-z]{3}/.test(l)) continue;
        if (!/\s/.test(l) && !/^[A-Z]/.test(l)) continue;           // one lower-case token is a field name, not a label
        if (/^[\d\s:.,/+%-]+$/.test(l)) continue;
        if (GENERIC.has(l.toLowerCase())) continue;
        if (!out.includes(l)) out.push(l);
        if (out.length >= max) break;
    }
    return out;
}

const SOURCE_RE = /\.(?:html|js|mjs|css)$/i;

/**
 * Which files draw this screen? A file counts only when at least `min` DISTINCT strings from the screen are in it, so a single shared
 * word cannot name a home. Returns files best-first with the strings each holds.
 */
export function findHome(strings, { repoDir = process.cwd(), min = 2, files = null } = {}) {
    const list = files || fs.readdirSync(repoDir).filter((f) => SOURCE_RE.test(f) && !/^(autonom|sw\.js$|service-worker)/i.test(f));
    const found = [];
    for (const f of list) {
        let src = '';
        try { const st = fs.statSync(path.join(repoDir, f)); if (!st.isFile() || st.size > 8_000_000) continue; src = fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { continue; }
        const hits = strings.filter((x) => src.includes(x));
        if (hits.length >= min) found.push({ file: f, hits });
    }
    return found.sort((a, b) => b.hits.length - a.hits.length || a.file.localeCompare(b.file));
}

/**
 * The function whose body holds `needle`: the nearest line above it that starts a function (at any indent), through its closing brace.
 * Braces are counted outside strings and comments. Capped, centred on the needle, so a very long function is cut honestly.
 */
export function functionAround(src, needle, { maxChars = 6500, at: atGiven = -1 } = {}) {
    const s = String(src || '');
    const at = atGiven >= 0 ? atGiven : s.indexOf(needle);
    if (at < 0) return null;
    const head = s.slice(0, at);
    const decl = /^[ \t]*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;
    let m, last = null;
    while ((m = decl.exec(head))) last = m;
    if (!last) return null;
    const start = last.index;
    let depth = 0, i = s.indexOf('{', start), end = -1;
    if (i < 0) return null;
    for (; i < s.length; i++) {
        const c = s[i], d = s[i + 1];
        if (c === '/' && d === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 1; continue; }
        if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c && s[j] !== '\n') { if (s[j] === '\\') j++; j++; } i = j; continue; }
        if (c === '`') { let j = i + 1; while (j < s.length && s[j] !== '`') { if (s[j] === '\\') j++; j++; } i = j; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) { end = i + 1; break; }
        if (i - start > 60_000) break;
    }
    if (end < 0) return null;
    let body = s.slice(start, end);
    const name = last[1];
    if (body.length > maxChars) {
        const rel = Math.max(0, at - start);
        const from = Math.max(0, Math.min(rel - Math.floor(maxChars / 3), body.length - maxChars));
        body = (from > 0 ? '/* … earlier lines left out … */\n' : '') + body.slice(from, from + maxChars) + '\n/* … later lines left out … */';
    }
    return { name, code: body, line: s.slice(0, start).split('\n').length };
}

/**
 * The function that holds the MOST of the screen's words, not the one nearest the first word: a title that also appears in a comment,
 * a menu and a sister screen must not name the sister screen's function (measured: "CC Instalments" first sits beside CC One-Time).
 */
export function bestFunction(src, strings, { maxChars = 6500, perString = 8 } = {}) {
    const s = String(src || '');
    const tally = new Map();
    for (const str of strings) {
        const seen = new Set();
        for (let from = 0, n = 0; n < perString; n++) {
            const at = s.indexOf(str, from);
            if (at < 0) break;
            from = at + str.length;
            const fn = functionAround(s, str, { maxChars: 1, at });
            if (fn && !seen.has(fn.name + ':' + fn.line)) {
                seen.add(fn.name + ':' + fn.line);
                const key = fn.name + ':' + fn.line;
                const e = tally.get(key) || { name: fn.name, line: fn.line, strs: new Set(), needle: str, at };
                e.strs.add(str); tally.set(key, e);
            }
        }
    }
    let best = null;
    for (const e of tally.values()) if (!best || e.strs.size > best.strs.size) best = e;
    if (!best) return null;
    const fn = functionAround(s, best.needle, { maxChars, at: best.at });
    return fn ? { ...fn, held: [...best.strs] } : null;
}

/** The books a piece of code reads: DB.get('key') calls. */
export function booksRead(code) {
    return [...new Set([...String(code || '').matchAll(/\bDB\s*\.\s*get\(\s*['"]([A-Za-z0-9_-]{2,40})['"]/g)].map((m) => m[1]))];
}

/**
 * The report says something cannot be seen, opened, read or tapped (as opposed to being wrong or broken). Works on English: a Sinhala
 * report is translated when it is filed (autonomy/feedback-language.mjs).
 */
export function reachabilityGap(text) {
    const t = String(text || '').toLowerCase();
    return /\b(no|not any|without a?)\s+(way|option|button|link|view|screen|page)\b[^.\n]{0,50}\b(see|view|open|read|check|find|tap|click|navigate|access|expand|details?)\b/.test(t)
        || /\b(can(?:'|’)?t|cannot|can not|unable to|not able to|isn(?:'|’)?t possible to|impossible to)\s+(?:\w+\s+){0,2}(see|view|open|read|tap|click|navigate|access|expand|reach)\b/.test(t)
        || /\b(click(?:ing)?|tap(?:ping)?|press(?:ing)?)\b[^.\n]{0,50}\b(does not|doesn(?:'|’)?t|do not|don(?:'|’)?t|nothing|no)\b[^.\n]{0,30}\b(open|navigate|go|work|respond|happen|show)/.test(t)
        || /\b(does not|doesn(?:'|’)?t|won(?:'|’)?t)\s+(open|navigate|respond|expand|show (?:any|the) detail)/.test(t)
        || /\b(tap(?:ping)?|click(?:ing)?|press(?:ing)?)\b[^.\n]{0,40}\b(?:does|do|did)\s+nothing\b|\bnothing happens\b/.test(t)
        || /\bnot\s+(clickable|tappable|viewable|visible|readable|reachable)\b/.test(t)
        || /\b(cut off|truncated|clipped|hidden)\b[^.\n]{0,40}\b(no way|cannot|can(?:'|’)?t|unable)\b/.test(t);
}

/**
 * Where the screen in a report is drawn, and whether the one-file swarm may open that file.
 * @param {string}  text      the report (title + body, screenshot reading included)
 * @param {object}  o
 * @param {string}  o.repoDir
 * @param {(file:string)=>boolean} o.mayEdit   true when a lane may edit that file
 * @returns {{found:boolean, file?:string, mayEdit?:boolean, hits?:string[], fn?:string, line?:number, code?:string, books?:string[], others?:string[], why:string}}
 */
export function symptomHome(text, { repoDir = process.cwd(), mayEdit = () => false } = {}) {
    const strings = visibleStrings(text);
    if (strings.length < 2) return { found: false, why: 'the report shows fewer than two readable words from the screen' };
    const homes = findHome(strings, { repoDir });
    if (!homes.length) return { found: false, why: 'no file holds two of the words shown on the screen' };
    // The file that holds the most of the screen's words and draws them (a function around one of them) is the home.
    // A module that only repeats a title (an update note, a changelog) will not hold a drawing function around the words.
    for (const h of homes) {
        let src = '';
        try { src = fs.readFileSync(path.join(repoDir, h.file), 'utf8'); } catch { continue; }
        const fn = bestFunction(src, h.hits);
        if (!fn || fn.held.length < 2 || !/(?:innerHTML|createElement|textContent|<tr|<div|<td)/.test(fn.code)) continue;
        return {
            found: true, file: h.file, mayEdit: !!mayEdit(h.file), hits: fn.held.slice(0, 6), fn: fn.name, line: fn.line, code: fn.code,
            books: booksRead(fn.code), others: homes.filter((x) => x.file !== h.file).map((x) => x.file).slice(0, 4),
            why: `${fn.held.length} of the words on the screen are drawn by ${fn.name}() in ${h.file}`,
        };
    }
    return { found: false, why: 'files hold the words but none draws them', others: homes.map((x) => x.file).slice(0, 4) };
}

/** What an author is shown about the screen: real code, read from the repository, so nothing about the page is guessed. */
export function homeFacts(home) {
    if (!home || !home.found) return '';
    return [
        '',
        '',
        '### Facts about this screen (read from the code by a program, not guessed)',
        `The words the person sees are drawn by \`${home.fn}()\` in \`${home.file}\`${home.mayEdit ? '' : ', a file that NO lane may edit'}.`,
        home.books.length ? `It reads these books: ${home.books.map((b) => `\`DB.get('${b}')\``).join(', ')}.` : '',
        home.mayEdit ? '' : 'So the fix cannot be made inside that function. Add a NEW read-only module that attaches to what the page already draws (use the ids, classes and tags in the code below, exactly as written) and may read the books named above; it must not write anything.',
        '```js',
        String(home.code || '').replace(/`{3,}/g, "'''"),
        '```',
        '',
    ].filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n');
}
