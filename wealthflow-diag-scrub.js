/* =============================================================================
 *  WealthFlow — what a system diagnosis may say      ·      window.WFDiagScrub
 *
 *  The "Send system diagnosis" tick promises: "Never includes any financial data". The tick attaches error messages, stack
 *  traces, the app's own detected problems, statement-review reasons and a health snapshot, and the server writes them into
 *  a GitHub issue of a PUBLIC repository. Before this file, nothing checked that promise: whatever an error message held
 *  went out as it was. An error is written by code that was handling a record, so it can quote that record
 *  ("Invalid amount 4,820.50 for KEELLS SUPER NUGEGODA", "cannot read statement HNB_4532XXXXXXXX1234.pdf"). The promise was
 *  kept by luck, not by a rule.
 *
 *  This is the rule, one file used in both places so the two cannot drift: the device scrubs before it sends, and the
 *  server scrubs again before it writes (a stale cached app, or any other client, cannot get past it). Pure and
 *  dependency-free; ESM so Node can import it, and it puts itself on `window` when there is one.
 *
 *  WHAT IS KEPT, ON PURPOSE: what a person fixing the fault needs and nobody needs hidden: file:line:column of a stack frame,
 *  version numbers, the words of an error, counts, reason codes, bank names, device facts, the parity checksums that let two
 *  reports be compared. WHAT IS REMOVED: e-mail addresses, links' queries, long numbers (cards, accounts, phones, references),
 *  amounts of money, long quoted strings (record text), tokens, and every field whose NAME says it holds a person's money or
 *  identity. A statement's file name is reduced to its extension: the bank and the reason already say which one is stuck.
 *
 *  scrubText / scrubDiagnostics are idempotent (scrubbing a scrubbed value changes nothing) and never throw.
 * ========================================================================== */

const PLACE_OPEN = '\u0001';
const PLACE_CLOSE = '\u0002';

/** Fields whose value is a fact about the device or the build, not about a person; they are only length-capped. A reason, a bank,
 *  a state or a source can quote a record, so those go through the text rules like everything else. */
const SAFE_KEYS = new Set(['ua', 'screen', 'viewport', 'lang', 'tz', 'dpr', 'ver', 'version', 'page', 'activePage', 'recentPages', 'build', 'at', 't', 'tLocal', 'first', 'last', 'parity', 'deviceId', 'severity', 'area', 'id', 'mem', 'connection']);

/** A field with one of these names is dropped whatever it holds. */
const PRIVATE_KEYS = /^(amount|balance|total|narration|description|merchant|payee|payer|beneficiary|account|accountno|accountnumber|cardnumber|card|iban|pin|password|passcode|secret|token|apikey|authorization|email|phone|mobile|name|fullname|address|note|notes|memo)$/i;

/** A NUMBER under one of these names is a sum of money and goes too; a number under `total`, `count` and the like is a count and stays. */
const MONEY_KEYS = /^(amount|balance|pin|passcode|cardnumber|accountno|accountnumber|phone|mobile)$/i;

const FILE_KEYS = /^(filename|fileName|file|attachment)$/;

/** Parts of a text that must survive the number and amount rules. Each is stashed behind a placeholder and put back. */
const KEEP = [
    // a stack frame position and a position in a source: index.html:31443:17, file.js:12
    /:\d{1,7}(?::\d{1,5})?(?=[\s)\]},;'"`]|$)/g,
    // an ISO timestamp the app itself wrote
    /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g,
    // 7.69.94, 7.69.94.1
    /\b\d+\.\d+\.\d+(?:\.\d+)?\b/g,
    // "position 4821", "line 12", "status 429", "HTTP 402", "length 2000": a measurement of the text, not a value in it
    /\b(?:position|line|column|col|index|length|size|bytes?|status|code|http|chars?|offset|attempt|retry|count)\b\s*[:=]?\s*\d+/gi,
];

/** Capitalised words an error message or an HTTP status line uses: never a merchant. */
const CAPS_OK = new Set(['HTTP', 'HTTPS', 'ERROR', 'ERR', 'NOT', 'FOUND', 'TIMEOUT', 'TIMED', 'OUT', 'FAILED', 'FAIL', 'INVALID', 'NETWORK', 'ABORT', 'ABORTED', 'QUOTA', 'EXCEEDED', 'UNAUTHORIZED', 'FORBIDDEN', 'BAD', 'REQUEST', 'GATEWAY', 'SERVICE', 'UNAVAILABLE', 'INTERNAL', 'SERVER', 'TOO', 'MANY', 'REQUESTS', 'PDF', 'OCR', 'JSON', 'CORS', 'DOM', 'API', 'GET', 'POST', 'PUT', 'DELETE', 'NULL', 'UNDEFINED', 'NAN', 'OK', 'UTF', 'SSL', 'TLS', 'DNS', 'URL', 'CSP', 'XHR', 'SDK', 'PIN', 'AES', 'GCM']);

const RULES = [
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
    // a link keeps its host and path; a query or fragment (tokens, ids, search text) goes
    [/\b((?:https?:\/\/|www\.)[^\s?#'"`)<>]+)[?#][^\s'"`)<>]*/gi, '$1'],
    // a long run of letters and digits is a key or token
    [/\b[A-Za-z0-9_-]{28,}\b/g, '[token]'],
    // money: a currency word or sign then a number
    [/(?:\bRs\.?|\bLKR|\bUSD|\bEUR|\bGBP|₨|\$|£|€)\s*\d[\d,]*(?:\.\d+)?/gi, '[amount]'],
    // a number written as an amount: comma groups, or exactly two decimals
    [/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, '[amount]'],
    [/\b\d+\.\d{2}\b/g, '[amount]'],
    // a phone or account number written with spaces, dashes, dots or a leading +
    [/\+?\d[\d\s().-]{6,}\d/g, '[number]'],
    // any run of four or more digits (card, account, reference, OTP)
    [/\d{4,}/g, '[number]'],
    // record text that is not quoted: a bank statement writes a merchant in capitals ("KEELLS SUPER NUGEGODA"), so two or more
    // capitalised words in a row are masked, unless every word is one an error message uses
    [/\b[A-Z]{3,}(?:[ \t]+[A-Z][A-Z0-9]{1,})+\b/g, (m) => (m.split(/[ \t]+/).every((w) => CAPS_OK.has(w)) ? m : '[text]')],
    // record text quoted in a message: a long quoted string
    [/(["'`])(?:(?!\1)[^\n]){25,}\1/g, '$1[text]$1'],
];

const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);

/** `text` with what must not leave removed. Never throws; always returns a string. */
export function scrubText(text, max = 2000) {
    try {
        let s = cap(String(text == null ? '' : text), Math.max(1, max));
        const kept = [];
        for (const re of KEEP) {
            s = s.replace(re, (m) => { kept.push(m); return PLACE_OPEN + (kept.length - 1) + PLACE_CLOSE; });
        }
        for (const [re, to] of RULES) s = s.replace(re, to);
        return s.replace(/\u0001(\d+)\u0002/g, (_, i) => kept[Number(i)] ?? '');
    } catch (_) { return ''; }
}

/** A statement's file name reduced to its extension: "HNB_5412….pdf" -> "[file].pdf". */
export function scrubFileName(name) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(name == null ? '' : name).trim());
    return '[file]' + (m ? '.' + m[1].toLowerCase() : '');
}

/**
 * The diagnostics object as it may be sent or written: a deep copy with every string scrubbed, every private field dropped,
 * file names reduced, depth and size bounded. Numbers and booleans are kept (they are counts and flags).
 * @param {*} d
 * @returns {*} a new value; the input is never changed
 */
export function scrubDiagnostics(d) {
    const walk = (v, key, depth) => {
        if (depth > 7) return undefined;
        if (v == null) return v;
        if (typeof v === 'string') {
            if (FILE_KEYS.test(key || '')) return scrubFileName(v);
            if (SAFE_KEYS.has(key || '')) return cap(v, 600);
            return scrubText(v, 1500);
        }
        if (typeof v === 'number') return Number.isFinite(v) ? v : null;
        if (typeof v === 'boolean') return v;
        if (Array.isArray(v)) {
            // an array under a safe key (recentPages) is a list of short facts
            return v.slice(0, 60).map((x) => walk(x, key, depth + 1)).filter((x) => x !== undefined);
        }
        if (typeof v === 'object') {
            const out = {};
            let n = 0;
            for (const k of Object.keys(v)) {
                if (n++ >= 80) break;
                // a private NAME drops a text, a list or (for money names) a number; an object under it is walked, so `account: { signedIn, email }`
                // keeps the fact and loses only the inner e-mail
                const inner = v[k];
                if (PRIVATE_KEYS.test(k) && (typeof inner === 'string' || Array.isArray(inner) || (typeof inner === 'number' && MONEY_KEYS.test(k)))) { out[k] = '[removed]'; continue; }
                const w = walk(inner, PRIVATE_KEYS.test(k) ? '' : k, depth + 1);
                if (w !== undefined) out[scrubText(k, 60)] = w;
            }
            return out;
        }
        return undefined;   // functions, symbols, bigints
    };
    try { return walk(d, '', 0); } catch (_) { return null; }
}

/**
 * The recorded errors as a person fixing them wants to read them: the same fault repeated forty times is ONE line with a count,
 * when it first and last happened, and where; newest group first. Before this the last eight raw entries were sent, so one
 * noisy fault pushed every other fault out of the report.
 * @param {object[]} log   the device's crash log, oldest first
 * @param {{max?:number, build?:string}} [o]
 * @returns {object[]} groups, each {msg, stack, page, ver, at, first, last, count, src, where, mem, dom, thisBuild}
 */
export function groupErrors(log, o = {}) {
    try {
        const max = Math.max(1, o.max || 8);
        const by = new Map();
        for (const e of Array.isArray(log) ? log : []) {
            if (!e || typeof e !== 'object') continue;
            const msg = String(e.msg || '').slice(0, 400);
            const stack = String(e.stack || '');
            const frame = (/\bat\s[^\n]*?([\w.\-/]+:\d+:\d+)/.exec(stack) || [])[1] || '';
            const key = scrubText(msg, 160) + '|' + frame;
            const t = e.t || e.when || null;
            let g = by.get(key);
            if (!g) {
                g = { msg, stack: stack.slice(0, 900), page: e.page || null, ver: e.ver || null, at: t, first: t, last: t, count: 0, src: e.src || null, where: null, mem: null, dom: null, thisBuild: !!(o.build && e.ver === o.build) };
                by.set(key, g);
            }
            g.count += 1;
            g.last = t || g.last; g.at = g.last;
            g.page = e.page || g.page; g.ver = e.ver || g.ver;
            if (typeof e.extra === 'string' && e.extra) g.where = e.extra.slice(0, 160);
            else if (e.extra && typeof e.extra === 'object') { try { g.where = JSON.stringify(e.extra).slice(0, 160); } catch (_) { /* optional */ } }
            if (e.mem != null) g.mem = e.mem;
            if (typeof e.dom === 'number') g.dom = e.dom;
        }
        return Array.from(by.values()).sort((a, b) => String(b.last || '').localeCompare(String(a.last || ''))).slice(0, max);
    } catch (_) { return []; }
}

// the device uses the same rule through window.WFDiagScrub
try { if (typeof window !== 'undefined') window.WFDiagScrub = { scrubText, scrubFileName, scrubDiagnostics, groupErrors }; } catch (_) { /* optional */ }
