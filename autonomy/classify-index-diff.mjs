#!/usr/bin/env node
/* =============================================================================
 * autonomy/classify-index-diff.mjs
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * `index.html` is 27,000 lines and 1.5 MB. It holds the money math, the auth
 * flow, the CRDT sync merge, the vault, the decoy mode — and every stylesheet,
 * every section of markup, and every chart-rendering helper in the product.
 *
 * Every gate in this repository treats it as ONE unit. So changing a border
 * radius requires the same human approval as changing `_wfApplyCloudData`.
 * That is not a strict gate; it is an UNINFORMATIVE one, and an uninformative
 * gate is dangerous in a specific way: when approval is demanded for everything,
 * approval stops being read. The owner's words: "DO NOT harass me with constant
 * requests for the human-approved label for every minor change."
 *
 * This module answers a narrower question than "did index.html change": it asks
 * WHICH PARTS changed, and whether every one of them is in a part that cannot
 * carry money, identity, or data-destruction logic.
 *
 * -----------------------------------------------------------------------------
 * THE DIRECTION OF EVERY DECISION HERE
 *
 * policy/wealthflow.rego RULE 2 says the pipeline may not weaken its own
 * guardrails, "because the most attractive fix for any failing check is to
 * delete the check". This file IS a weakening of a guardrail in the literal
 * sense — it creates a path by which index.html can merge without a human. So
 * it is built as an ALLOWLIST that fails closed, not a denylist that fails open:
 *
 *   • `sensitive` is the default. `safe` is returned only when every changed
 *     line has been positively identified as belonging to a class that cannot
 *     execute privileged logic.
 *   • Anything unrecognised — a line the parser cannot place, a region boundary
 *     that moved, a brace count that did not come back to zero — is sensitive.
 *   • If this file itself is in the changed set, it does not run. A pull request
 *     cannot edit the classifier and be judged by the edited version.
 *   • Any thrown error anywhere is caught at the top level and becomes
 *     `sensitive`. There is no code path that returns `safe` by accident.
 *
 * A false `sensitive` costs one label. A false `safe` merges money code with
 * nobody watching. The asymmetry is the whole design.
 *
 * -----------------------------------------------------------------------------
 * HOW IT DECIDES
 *
 * 1.  REGIONS. The file is scanned into `markup`, `style`, `script`, and
 *     `boundary` lines. Inside a script body only `</script` can end it — which
 *     is what a browser does, and it is why the literal text "<script>" sitting
 *     inside a JS comment at index.html:6967 does not confuse this.
 *
 * 2.  BRACE DEPTH. Each script region is tokenised (strings, template literals
 *     with `${}` nesting, line and block comments, regex literals) to get the
 *     brace depth at the start of every line. The tokeniser then CHECKS ITSELF:
 *     the depth must return to exactly 0 at the end of each region, must never
 *     go negative, and the region must end in normal code state. If any of those
 *     fail, the tokeniser got lost somewhere in 27,000 lines and the whole file
 *     is sensitive. This is the load-bearing safety property — a confused parser
 *     cannot produce a `safe` verdict, it produces a refusal.
 *
 * 3.  ATTRIBUTION. Every top-level declaration (depth 0, normal state) is
 *     recorded. Each changed script line is attributed to the declaration whose
 *     line range contains it. A changed line before the FIRST declaration in a
 *     region — the preamble, where IIFEs and bare statements live — is
 *     sensitive, because there is no name to judge.
 *
 * 4.  NAMES. A declaration is sensitive if any camelCase/underscore segment of
 *     its name is a known privileged word, or if the whole name contains one of
 *     a shorter high-signal list. `_wfApplyCloudData` -> [wf, apply, cloud,
 *     data] -> `cloud` -> sensitive. `renderSparkline` -> safe.
 *
 * 5.  CONTENT. Independently of region, every ADDED line is swept for things
 *     that execute or persist regardless of where they sit: event-handler
 *     attributes, `<script`, `eval(`, `innerHTML`, `localStorage`, `fetch(`,
 *     `firebase`, `postMessage`, `serviceWorker`, and the CSS escape hatches.
 *
 * 6.  CAPS. Past a size, "which functions did you touch" stops being a useful
 *     summary and the change deserves a human's eyes on principle.
 *
 * All five filters must agree on `safe`. Any one of them says sensitive, the
 * verdict is sensitive.
 *
 * -----------------------------------------------------------------------------
 * USAGE
 *   node autonomy/classify-index-diff.mjs --base <sha> --head <sha> \
 *        [--file index.html] [--changed-files <path>] [--repo <dir>]
 *
 * Prints JSON to stdout. Exit status is 0 for a completed classification and 2
 * for a usage error; the VERDICT is the `verdict` field, never the exit code,
 * so a workflow cannot mistake "the tool crashed" for "the change is safe".
 * ===========================================================================*/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/** This file's own repo-relative path. If it is in the diff, it does not judge. */
export const SELF_PATH = 'autonomy/classify-index-diff.mjs';

/** Past this many changed lines, a per-function summary is no longer a review. */
export const MAX_CHANGED_LINES = 1200;
/** Past this many touched declarations, likewise. */
export const MAX_TOUCHED_DECLS = 40;

/* ── 1. Region scanning ──────────────────────────────────────────────────────
 * Returns one entry per line: 'markup' | 'style' | 'script' | 'boundary'.
 * A line on which any region tag opens or closes is 'boundary' and is ALWAYS
 * sensitive when changed — moving a </script> earlier turns markup into code.
 */
export function scanRegions(lines) {
    const out = new Array(lines.length);
    let state = 'markup';                       // markup | style | script
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const low = line.toLowerCase();
        let touched = false;
        let pos = 0;
        while (pos < low.length) {
            if (state === 'script') {
                // Inside a script body ONLY `</script` ends it. This is what the
                // HTML parser does, and it is why `// ... <script> tags above`
                // in a comment is not a boundary.
                const j = low.indexOf('</script', pos);
                if (j === -1) break;
                state = 'markup'; touched = true; pos = j + 8;
            } else if (state === 'style') {
                const j = low.indexOf('</style', pos);
                if (j === -1) break;
                state = 'markup'; touched = true; pos = j + 7;
            } else {
                const a = low.indexOf('<script', pos);
                const b = low.indexOf('<style', pos);
                if (a === -1 && b === -1) break;
                const first = (a === -1) ? b : (b === -1 ? a : Math.min(a, b));
                // `<script src="..."></script>` on one line: the close is found
                // on the next loop pass, so the line is a boundary either way.
                const close = low.indexOf('>', first);
                if (close === -1) {                 // tag spans lines — refuse
                    state = (first === a) ? 'script' : 'style';
                    touched = true; pos = low.length;
                } else {
                    state = (first === a) ? 'script' : 'style';
                    touched = true; pos = close + 1;
                }
            }
        }
        // The state AFTER processing the line is what the NEXT line inherits;
        // the line itself is classified by whether it carried a tag.
        out[i] = touched ? 'boundary' : state;
    }
    return out;
}

/* ── 2. Tokeniser ────────────────────────────────────────────────────────────
 * Walks a script region and reports the brace depth and code-state at the start
 * of every line. Handles '..' ".." `..${ }..` // .. and regex literals.
 *
 * It is not a JavaScript parser and does not need to be. It needs exactly one
 * property: if it loses track, it must SAY SO rather than report a plausible
 * depth. `ok:false` propagates to a sensitive verdict for the whole file.
 */
const REGEX_PRECEDERS = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
    '%', '~', '^', '<', '>', '\n', '',
]);
const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await',
]);

export function tokenizeRegion(text) {
    const lineDepth = [0];              // depth at the start of line index 0
    const lineNormal = [true];          // is line-start in ordinary code?
    let depth = 0;
    let mode = 'code';                  // code | sq | dq | tpl | line | block | regex | class
    const tplStack = [];                // depths at which `${` opened
    let lastTok = '';                   // last significant char
    let word = '';                      // trailing identifier, for `return /re/`
    let ok = true;
    let reason = '';

    const fail = (why) => { if (ok) { ok = false; reason = why; } };

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const n = text[i + 1];

        if (c === '\n') {
            if (mode === 'line') mode = 'code';
            // A newline inside a string literal or an unterminated regex means
            // the tokeniser's model of the file is wrong. Refuse.
            if (mode === 'sq' || mode === 'dq' || mode === 'regex' || mode === 'class') {
                fail(`unterminated ${mode} literal`);
            }
            lineDepth.push(depth);
            lineNormal.push(mode === 'code');
            continue;
        }

        switch (mode) {
            case 'line':
                break;
            case 'block':
                if (c === '*' && n === '/') { mode = 'code'; i++; }
                break;
            case 'sq':
                if (c === '\\') i++;
                else if (c === "'") { mode = 'code'; lastTok = "'"; word = ''; }
                break;
            case 'dq':
                if (c === '\\') i++;
                else if (c === '"') { mode = 'code'; lastTok = '"'; word = ''; }
                break;
            case 'tpl':
                if (c === '\\') i++;
                else if (c === '`') { mode = 'code'; lastTok = '`'; word = ''; }
                else if (c === '$' && n === '{') {
                    // `${` re-enters code. Remember the depth so the matching `}`
                    // is recognised as closing the substitution, not a block.
                    tplStack.push(depth);
                    depth++; mode = 'code'; lastTok = '{'; word = ''; i++;
                }
                break;
            case 'regex':
                if (c === '\\') i++;
                else if (c === '[') mode = 'class';
                else if (c === '/') { mode = 'code'; lastTok = '/'; word = ''; }
                break;
            case 'class':                       // inside a regex character class
                if (c === '\\') i++;
                else if (c === ']') mode = 'regex';
                break;
            case 'code':
                if (c === '/' && n === '/') { mode = 'line'; i++; }
                else if (c === '/' && n === '*') { mode = 'block'; i++; }
                else if (c === '/') {
                    const w = word;
                    if (REGEX_PRECEDERS.has(lastTok) || REGEX_KEYWORDS.has(w)) mode = 'regex';
                    else { lastTok = '/'; }
                    word = '';
                }
                else if (c === "'") { mode = 'sq'; word = ''; }
                else if (c === '"') { mode = 'dq'; word = ''; }
                else if (c === '`') { mode = 'tpl'; word = ''; }
                else if (c === '{') { depth++; lastTok = '{'; word = ''; }
                else if (c === '}') {
                    depth--;
                    if (depth < 0) { fail('brace depth went negative'); depth = 0; }
                    // Closing a `${` substitution returns to the template.
                    if (tplStack.length && depth === tplStack[tplStack.length - 1]) {
                        tplStack.pop(); mode = 'tpl';
                    }
                    lastTok = '}'; word = '';
                }
                else if (/\s/.test(c)) { /* whitespace keeps lastTok and word */ }
                else if (/[A-Za-z0-9_$]/.test(c)) { word += c; lastTok = c; }
                else { lastTok = c; word = ''; }
                break;
        }
    }

    if (mode !== 'code' && mode !== 'line') fail(`region ended in ${mode} state`);
    if (depth !== 0) fail(`region ended at brace depth ${depth}`);
    if (tplStack.length) fail('unclosed template substitution');

    return { ok, reason, lineDepth, lineNormal };
}

/* ── 3. Top-level declarations ───────────────────────────────────────────────
 * Only lines that begin at brace depth 0 in ordinary code state are considered,
 * so a `const x = {` inside a function body can never masquerade as one.
 */
const DECL_PATTERNS = [
    /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=;]/,
    /^\s*(?:window|globalThis|self|document)\.([A-Za-z_$][\w$]*)\s*=/,
];

export function findDeclarations(lines, startLine, tok) {
    const decls = [];
    for (let i = 0; i < lines.length; i++) {
        if (tok.lineDepth[i] !== 0 || !tok.lineNormal[i]) continue;
        for (const re of DECL_PATTERNS) {
            const m = re.exec(lines[i]);
            if (m) { decls.push({ name: m[1], line: startLine + i }); break; }
        }
    }
    return decls;
}

/* ── 4. WHICH SYMBOLS MAY CHANGE UNATTENDED ──────────────────────────────────
 *
 * THE MISTAKE THIS SECTION REPLACES, WRITTEN DOWN SO IT IS NOT REPEATED
 *
 * The first version of this file judged a function by its NAME against a list
 * of privileged-looking words — auth, sync, vault, balance, and so on — and
 * called anything else safe. Run against index.html's 735 top-level
 * declarations it pronounced 442 of them "free". Among those 442:
 *
 *     signInWithGoogle        the Google sign-in flow
 *     appData                 the entire application state object
 *     _wfDedupRecordIds       CRDT record de-duplication
 *     _wfExpectBulkRemoval    the mass-tombstone circuit breaker
 *     _wfRehydrateFromDisk    the decoy-mode exit path
 *     _WF_KUT_EXEMPT          the sync clock exemption list
 *     _computeCashAdvanceFee  money math
 *     _computeFuelFee         money math
 *     onmousemove/onkeypress  the inactivity auto-lock
 *
 * `signInWithGoogle` splits into [sign, in, with, google] and the list held
 * "signin", so it missed. That is not a tuning problem. A list of dangerous
 * names is a DENYLIST, and a denylist fails open on everything nobody thought
 * of — which is the exact defect family this repository has spent its whole
 * history removing. It had no business being the load-bearing check in a file
 * whose entire stated design is "allowlist, fails closed".
 *
 * So the polarity is inverted. There is now an explicit list of symbols that
 * may change without a human, and everything not on it is sensitive. The list
 * lives in `autonomy/`, which is itself a guardrail path — growing it costs one
 * human approval, deliberately. That is the correct price: a symbol joins this
 * list once, after somebody looked at it, and then it can be iterated on freely
 * forever.
 *
 * Membership is necessary but NOT sufficient. Every listed symbol's whole body
 * is swept for capability on both sides of the diff (section 7), so a listed
 * formatter that grows a `fetch(` or a `localStorage` write stops being safe the
 * moment it does, with no list edit required.
 */
export const UNATTENDED_SYMBOLS = new Set([
    // Pure formatting and constants. No I/O, no state, no DOM writes; each one
    // was read before being listed, and the body sweep re-checks it every run.
    'p2', 'fmtN', 'fmt', 'fmtS', 'fmtDatePretty', 'monthStrFmt',
    'MONTHS', 'MONTHS_S', 'sleep', 'today',
    'WF_VOICE_MAP', 'WF_LANG_NAMES',
]);

/* The old denylist survives for ONE job: a test asserts that nothing on the
 * allowlist above looks privileged. If the two ever disagree, the allowlist has
 * gained an entry it should not have, and the suite says so. It is deliberately
 * not consulted when forming a verdict — a leaky denylist must never be what
 * stands between a diff and an unattended merge. */
const PRIV_SEGMENTS = new Set([
    'auth', 'login', 'logout', 'signin', 'sign', 'signup', 'pin', 'otp',
    'passcode', 'password', 'credential', 'credentials', 'token', 'tokens',
    'secret', 'secrets', 'session', 'vault', 'encrypt', 'decrypt', 'crypto',
    'cipher', 'hash', 'salt', 'pbkdf', 'pbkdf2', 'aes', 'decoy', 'panic',
    'duress', 'lock', 'unlock', 'biometric', 'user', 'account', 'accounts',
    'owner', 'admin', 'permission', 'permissions', 'role',
    'sync', 'cloud', 'firebase', 'firestore', 'remote', 'upload', 'download',
    'push', 'pull', 'merge', 'tomb', 'tombstone', 'wipe', 'reset', 'restore',
    'backup', 'migrate', 'migration', 'storage', 'localstorage', 'persist',
    'save', 'write', 'commit', 'db', 'database', 'delete', 'remove', 'purge',
    'destroy', 'clear', 'drop', 'import', 'export', 'ingest', 'dedup', 'rec',
    'app', 'data', 'dirty', 'bulk', 'rehydrate', 'disk', 'exempt', 'kut',
    'balance', 'total', 'totals', 'amount', 'money', 'currency', 'fx', 'rate',
    'rates', 'interest', 'apr', 'emi', 'loan', 'loans', 'debt', 'principal',
    'payment', 'payout', 'allocate', 'allocator', 'allocation', 'fifo',
    'reconcile', 'tax', 'zakat', 'profit', 'invest', 'investment', 'portfolio',
    'budget', 'ledger', 'transaction', 'transactions', 'txn', 'fee', 'fees',
    'cash', 'advance', 'fuel', 'compute', 'calc', 'recalc',
    'eval', 'exec', 'fetch', 'xhr', 'api', 'endpoint', 'redirect', 'origin',
    'cors', 'csp', 'sanitize', 'sanitise', 'escape', 'worker', 'serviceworker',
    'update', 'version', 'release', 'install', 'uid', 'key', 'keys',
    'onmousemove', 'onkeypress', 'onclick', 'inactivity',
]);
const PRIV_SUBSTRINGS = [
    'auth', 'login', 'otp', 'vault', 'crypt', 'decoy', 'panic', 'firebase',
    'firestore', 'sync', 'cloud', 'tomb', 'wipe', 'merge', 'balance', 'allocat',
    'fifo', 'reconcil', 'zakat', 'token', 'secret', 'password', 'passcode',
    'storage', 'delete', 'purge', 'ledger', 'appdata',
];

export function nameSegments(name) {
    return String(name)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((s) => s.toLowerCase());
}

/** Advisory only — see the note above. Never consulted by `classify`. */
export function looksPrivileged(name) {
    const low = String(name).toLowerCase();
    for (const s of PRIV_SUBSTRINGS) if (low.includes(s)) return true;
    for (const seg of nameSegments(name)) if (PRIV_SEGMENTS.has(seg)) return true;
    return false;
}

/* ── 5. Content sweeps ───────────────────────────────────────────────────────
 * Applied to ADDED lines regardless of which region they landed in. A line that
 * can execute, persist, or reach the network is sensitive wherever it sits.
 */
export const HTML_INJECTION = 'HTML injection into the DOM';

export const EXEC_PATTERNS = [
    [/<\s*script/i, 'a script tag'],
    // `<input` and `<button` are deliberately NOT here. They are inert markup:
    // a field nobody reads changes nothing, and the JavaScript that would read
    // it is gated separately by the attribution rules above. `<form>` IS here,
    // because a form can navigate and submit without any script at all.
    [/<\s*(iframe|object|embed|base|meta|link|form)\b/i, 'an embedding or form element'],
    [/\bformaction\s*=/i, 'formaction'],
    [/\son[a-z]+\s*=/i, 'an inline event-handler attribute'],
    [/javascript\s*:/i, 'a javascript: URL'],
    [/srcdoc\s*=/i, 'srcdoc'],
    [/data\s*:\s*text\/html/i, 'a data:text/html URL'],
    [/\beval\s*\(/, 'eval('],
    [/new\s+Function\s*\(/, 'new Function('],
    [/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/, HTML_INJECTION],
    [/document\s*\.\s*write/, 'document.write'],
    [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b/, 'browser storage'],
    [/\bfetch\s*\(|XMLHttpRequest|\bnavigator\s*\.\s*sendBeacon/, 'a network call'],
    [/\bpostMessage\b|\bserviceWorker\b|\bWorker\s*\(/, 'cross-context messaging or a worker'],
    [/\bfirebase\b|\bfirestore\b|\bgetAuth\b|\bsignIn/i, 'the Firebase surface'],
    [/\bcrypto\s*\.\s*subtle|\batob\s*\(|\bbtoa\s*\(/, 'crypto or base64'],
    [/-moz-binding|behavior\s*:|expression\s*\(/i, 'a legacy CSS execution vector'],
    [/@import\b/i, 'a CSS @import'],
];

/* WHY THERE IS NO "CLOSING TAG" SWEEP
 *
 * The first version of this file rejected any added line containing `</`, on the
 * theory that a closing tag inside a <style> or <script> body could end the block
 * early. Two facts killed it. First, `scanRegions` ALREADY models that exactly —
 * a line carrying `</script` is a boundary line and boundary lines are always
 * sensitive, which is the same rule a browser's parser applies. Second, this app
 * builds its entire UI from HTML template literals inside one 20,540-line script
 * block, so `</div>` appears on a large share of every UI diff. A sweep that
 * rejects `</div>` rejects the product. It was caught rejecting a plain version
 * string bump in the settings panel.
 *
 * ALLOWED-BY-EXCEPTION: `el.innerHTML = ''`.
 * innerHTML is otherwise gated because interpolating untrusted text into it is
 * exactly the defect #126 shipped. Assigning an EMPTY or wholly literal string
 * cannot inject anything — there is nothing to interpolate — and clearing a
 * container is the first line of most render functions. The exception is written
 * to require the statement to END there, so `innerHTML = '' + x` does not slip
 * through on a prefix match. */
const INNER_HTML_CLEAR = /\.(?:inner|outer)HTML\s*=\s*(?:''|""|`[^`$\\]*`)\s*;?\s*$/;

export function sweepLine(line, region) {
    const inertClear = INNER_HTML_CLEAR.test(line);
    for (const [re, why] of EXEC_PATTERNS) {
        if (!re.test(line)) continue;
        if (inertClear && why === HTML_INJECTION) continue;   // provably nothing to inject
        return why;
    }
    return null;
}

/* ── 6. Diff parsing ─────────────────────────────────────────────────────────
 * `git diff --unified=0` gives exact line numbers on both sides.
 */
export function parseUnifiedDiff(diff) {
    const removed = [];     // { line, text } against the BASE file
    const added = [];       // { line, text } against the HEAD file
    let oldLine = 0, newLine = 0, inHunk = false;
    for (const raw of String(diff).split('\n')) {
        const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
        if (h) {
            oldLine = parseInt(h[1], 10);
            newLine = parseInt(h[3], 10);
            inHunk = true;
            continue;
        }
        if (!inHunk) continue;
        if (raw.startsWith('---') || raw.startsWith('+++')) continue;
        if (raw.startsWith('-')) { removed.push({ line: oldLine++, text: raw.slice(1) }); }
        else if (raw.startsWith('+')) { added.push({ line: newLine++, text: raw.slice(1) }); }
        else if (raw.startsWith('\\')) { /* \ No newline at end of file */ }
        else { oldLine++; newLine++; }
    }
    return { removed, added };
}

/* ── 7. The classification itself ────────────────────────────────────────────
 * `baseText` / `headText` are the whole file on each side; `diff` is
 * `git diff --unified=0` between them for that one path.
 */
export function classify({ baseText, headText, diff, changedFiles = [] }) {
    const notes = [];
    const sensitive = (reason, extra = {}) => ({ verdict: 'sensitive', reason, notes, ...extra });

    if (changedFiles.includes(SELF_PATH)) {
        return sensitive(
            'the classifier itself is in this diff — it does not judge a change to itself',
        );
    }
    if (typeof baseText !== 'string' || typeof headText !== 'string') {
        return sensitive('the file is missing on one side of the diff');
    }

    const { removed, added } = parseUnifiedDiff(diff);
    const changedCount = removed.length + added.length;
    if (changedCount === 0) return sensitive('no changed lines were parsed out of the diff');
    if (changedCount > MAX_CHANGED_LINES) {
        return sensitive(
            `${changedCount} changed lines exceeds the ${MAX_CHANGED_LINES}-line cap for an ` +
            'unattended change — a diff this size deserves a look on principle',
        );
    }

    // --- both sides must parse -----------------------------------------------
    const sides = {};
    for (const [side, text] of [['base', baseText], ['head', headText]]) {
        const lines = text.split('\n');
        const regions = scanRegions(lines);
        const blocks = [];                  // contiguous script regions
        let start = -1;
        for (let i = 0; i <= regions.length; i++) {
            if (i < regions.length && regions[i] === 'script') { if (start < 0) start = i; }
            else if (start >= 0) { blocks.push([start, i - 1]); start = -1; }
        }
        const decls = [];
        for (const [a, b] of blocks) {
            const body = lines.slice(a, b + 1);
            const tok = tokenizeRegion(body.join('\n'));
            if (!tok.ok) {
                return sensitive(
                    `the ${side} file could not be parsed with confidence ` +
                    `(script block at line ${a + 1}: ${tok.reason}) — refusing to classify`,
                );
            }
            // Each declaration owns the lines from its own start up to the line
            // before the next depth-0 declaration; the last one owns the rest of
            // the block. That extent is what the capability sweep runs over.
            const found = findDeclarations(body, a, tok);
            for (let k = 0; k < found.length; k++) {
                decls.push({
                    name: found[k].name,
                    line: found[k].line,
                    end: (k + 1 < found.length) ? found[k + 1].line - 1 : b,
                });
            }
        }
        sides[side] = { lines, regions, blocks, decls };
    }

    // The file must LOOK like the application on both sides. Found by the
    // fail-closed test: with an empty base and an empty head, every changed line
    // lands in the default `markup` region, passes the sweep, and the verdict
    // came back `safe`. That shape is a file being created or deleted outright —
    // the largest possible change to index.html — arriving as the smallest
    // possible one. A shell with no script block is not this application.
    for (const side of ['base', 'head']) {
        if (sides[side].blocks.length === 0) {
            return sensitive(
                `the ${side} file contains no script block, so it is not the ` +
                'application shell — a file being created or removed is never unattended',
            );
        }
    }

    // --- content sweep --------------------------------------------------------
    // Independent of attribution and run first, so a line that can execute is
    // rejected even if it sits inside a function with an innocent name.
    for (const { line, text } of added) {
        const why = sweepLine(text, sides.head.regions[line - 1]);
        if (why) return sensitive(`added line ${line} contains ${why}`);
    }

    // --- attribute every changed line ----------------------------------------
    const touched = new Set();
    const declFor = (side, idx) =>
        sides[side].decls.find((d) => idx >= d.line && idx <= d.end) || null;

    /* A symbol on the allowlist is only safe while its body STAYS inert. Sweep
     * the whole declaration on the side being examined; if anything in it can
     * execute, persist, or reach the network, the symbol loses its exemption for
     * this diff — without anyone having to edit the list. */
    const bodySweep = (side, d) => {
        const { lines: L, regions: R } = sides[side];
        for (let i = d.line; i <= d.end && i < L.length; i++) {
            const why = sweepLine(L[i], R[i]);
            if (why) return { line: i + 1, why };
        }
        return null;
    };

    for (const [side, list] of [['base', removed], ['head', added]]) {
        const { regions } = sides[side];
        for (const { line } of list) {
            const idx = line - 1;
            const region = regions[idx];
            if (region === undefined) {
                return sensitive(`changed line ${line} is outside the ${side} file`);
            }
            if (region === 'boundary') {
                return sensitive(
                    `line ${line} carries a <script>/<style> boundary — moving one turns ` +
                    'markup into executable code',
                );
            }
            if (region === 'script') {
                const d = declFor(side, idx);
                if (!d) {
                    return sensitive(
                        `line ${line} sits in a script region before any top-level ` +
                        'declaration (the preamble), so there is no name to judge it by',
                    );
                }
                if (!UNATTENDED_SYMBOLS.has(d.name)) {
                    return sensitive(
                        `line ${line} is inside ${d.name}, which is not on the ` +
                        'unattended-symbol allowlist in autonomy/classify-index-diff.mjs',
                    );
                }
                const dirty = bodySweep(side, d);
                if (dirty) {
                    return sensitive(
                        `${d.name} is on the allowlist, but its ${side} body reaches ` +
                        `${dirty.why} at line ${dirty.line} — the exemption does not apply`,
                    );
                }
                touched.add(d.name);
            }
            // 'style' and 'markup' lines already passed the content sweep.
        }
    }

    if (touched.size > MAX_TOUCHED_DECLS) {
        return sensitive(
            `${touched.size} distinct functions touched, over the ${MAX_TOUCHED_DECLS} cap`,
        );
    }

    const regionsTouched = new Set();
    for (const [side, list] of [['base', removed], ['head', added]]) {
        for (const { line } of list) regionsTouched.add(sides[side].regions[line - 1]);
    }

    notes.push(`${changedCount} changed line(s) in ${[...regionsTouched].sort().join(', ')}`);
    if (touched.size) notes.push(`functions touched: ${[...touched].sort().join(', ')}`);

    return {
        verdict: 'safe',
        reason: 'every changed line is style, markup, or a non-privileged function body',
        functions: [...touched].sort(),
        regions: [...regionsTouched].sort(),
        changedLines: changedCount,
        notes,
    };
}

/* ── 8. CLI ──────────────────────────────────────────────────────────────────*/
function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function main(argv) {
    const arg = (k, d) => {
        const i = argv.indexOf(k);
        return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d;
    };
    const base = arg('--base');
    const head = arg('--head');
    const file = arg('--file', 'index.html');
    const repo = arg('--repo', process.cwd());
    const cfPath = arg('--changed-files');

    if (!base || !head) {
        process.stderr.write('usage: classify-index-diff.mjs --base <sha> --head <sha> [--file index.html]\n');
        process.exit(2);
    }

    let changedFiles = [];
    if (cfPath) {
        try {
            changedFiles = fs.readFileSync(cfPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
        } catch {
            // Cannot read the file list -> cannot prove the classifier is untouched.
            process.stdout.write(JSON.stringify({
                verdict: 'sensitive',
                reason: `the changed-file list at ${cfPath} could not be read`,
            }) + '\n');
            return;
        }
    }

    let result;
    try {
        const baseText = git(['show', `${base}:${file}`], repo);
        const headText = git(['show', `${head}:${file}`], repo);
        const diff = git(['diff', '--unified=0', '--no-color', base, head, '--', file], repo);
        result = classify({ baseText, headText, diff, changedFiles });
    } catch (e) {
        // EVERY failure lands here and every one of them is `sensitive`. There is
        // no path from an exception to a permissive verdict.
        result = { verdict: 'sensitive', reason: `classification failed: ${e && e.message}` };
    }
    result.file = file;
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
