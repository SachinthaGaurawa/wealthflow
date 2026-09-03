/* =============================================================================
 * wealthflow-mail-intake.js — the device side of the mail statement pipeline
 * -----------------------------------------------------------------------------
 * A bank emails a password-protected statement. A server-side hook stores the
 * ENCRYPTED bytes, and nothing else, into this device's inbox. This module is
 * what happens when the app next opens: reassemble, unlock with the local vault,
 * parse, route, and refuse to guess.
 *
 * ── THE ONE RULE THAT DECIDES THE WHOLE DESIGN ──────────────────────────────
 *
 * The statement passwords never leave the device. That is why the server stores
 * ciphertext it cannot read, and why every step below runs here. It has a cost,
 * and the cost should be stated rather than glossed: a statement that arrives
 * while no device is open sits encrypted until one is. "Real time" describes
 * when the payload lands, not when the transactions appear. Moving the parse to
 * the server would fix that and would put the mailbox token and the statement
 * passwords in the same place, which is the trade that was refused.
 *
 * Nothing here logs, returns, or transmits a password. `unlock()` reports WHICH
 * candidate worked only as an index, never the value, and reports failure
 * without naming what was tried — test/mail_intake_test.js asserts that against
 * the actual returned objects rather than trusting the code to be careful.
 *
 * ── WHY THE CROSS-CHECK IS NOT THREE MODELS AGREEING ────────────────────────
 *
 * The requirement is that an expense is never filed as income. Three language
 * models agreeing is weak evidence for that: they share training data, they
 * share failure modes, and their agreement is correlated in exactly the cases
 * that are hard. So the check here uses two sources that are genuinely
 * independent of each other:
 *
 *   the PARSER decides credit vs debit from the bank's own running balance
 *   the ROUTER decides income vs expense from the description
 *
 * One is arithmetic printed by the bank. The other is language. When they
 * disagree, something is wrong and neither is trusted — the row is quarantined
 * with both readings attached. That is a real contradiction, not a vote.
 *
 * wealthflow-statement-parser.js publishes `directionSource`, which grades its
 * own evidence: `balance` means the bank's running total confirmed it, while
 * `assumed` and `keyword` mean it inferred from wording. The check is strict
 * where the evidence is strong and refuses outright where it is weak, rather
 * than applying one threshold to both.
 *
 * ── NOTHING IS EVER FILED ON A GUESS ────────────────────────────────────────
 *
 * Every rejection path ends in the same place: a quarantine entry naming a
 * reason from QUARANTINE, carrying enough detail to act on and no more. There
 * is no branch that writes a transaction it is unsure about.
 *
 * Pure and injectable: no DOM, no network, no clock, no PDF.js. Everything that
 * touches the outside world arrives through `deps`, so the tests exercise this
 * logic rather than a mock of it.
 * ===========================================================================*/

/** Why a statement or a row did not make it through. */
export const QUARANTINE = {
    CHUNKS_MISSING: 'chunks-missing',
    PASSWORD_FAILED: 'password-failed',
    NO_VAULT_KEYS: 'no-vault-keys',
    NO_TEXT_LAYER: 'no-text-layer',
    UNPARSEABLE: 'unparseable',
    /* UNPARSEABLE used to mean all three of these at once, and the three want
     * three different things from the owner: one is a layout to teach, one is
     * nothing at all, and one is a number to check. Collapsing them is why a
     * statement from an unknown bank was reported the same way as a month with
     * no spending on it — and then dropped. */
    LAYOUT_UNKNOWN: 'layout-unknown',
    NO_TRANSACTIONS: 'no-transactions',
    BALANCE_MISMATCH: 'balance-mismatch',
    DIRECTION_UNRESOLVED: 'direction-unresolved',
    ROUTING_CONFLICT: 'routing-conflict',
    LOW_CONFIDENCE: 'low-confidence',
};

/** Human sentences for the notification. Keyed so the UI cannot invent its own. */
export const QUARANTINE_TEXT = {
    [QUARANTINE.CHUNKS_MISSING]: 'the statement did not arrive complete',
    [QUARANTINE.PASSWORD_FAILED]: 'none of your saved vault keys opened it',
    [QUARANTINE.NO_VAULT_KEYS]: 'it is password-protected and your vault is empty',
    [QUARANTINE.NO_TEXT_LAYER]: 'the pages are images, so there is no text to read',
    [QUARANTINE.UNPARSEABLE]: 'the layout did not yield any transaction rows',
    [QUARANTINE.LAYOUT_UNKNOWN]: 'this bank lays its statement out in a way WealthFlow has not seen before — confirm the rows once and it will read the next one on its own',
    [QUARANTINE.NO_TRANSACTIONS]: 'the statement is readable and has no transactions on it',
    [QUARANTINE.BALANCE_MISMATCH]: 'the rows were read, but the opening and closing balances do not add up',
    [QUARANTINE.DIRECTION_UNRESOLVED]: 'the statement does not say whether this was money in or out',
    [QUARANTINE.ROUTING_CONFLICT]: 'the bank’s own figures and the description disagree about the direction',
    [QUARANTINE.LOW_CONFIDENCE]: 'the category could not be decided confidently',
};

/* The parser grades its own evidence for a row's direction. Only the first is
 * the bank's arithmetic; the rest are inference of decreasing strength. */
export const PROVEN_SOURCES = new Set(['balance', 'marker', 'column', 'sign']);

const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── 1. reassemble ────────────────────────────────────────────────────────── */

/**
 * Put a chunked payload back together.
 *
 * The writer stores parts first and the manifest LAST, so a manifest naming N
 * parts is the proof that all N landed. This still verifies the count rather
 * than trusting it: a partial read (a dropped connection mid-pull, which is the
 * common case on a phone) produces fewer parts than the manifest promised, and
 * a statement assembled from a hole in the middle would decrypt to garbage or,
 * worse, to a shorter but still-valid PDF missing pages of transactions.
 *
 * @param {{parts:number}} manifest
 * @param {Array<{i:number,d:string}>} parts  base64 slices, any order
 * @returns {{ok:true, base64:string} | {ok:false, reason:string, detail:object}}
 */
export function assemble(manifest, parts) {
    const want = Math.max(0, Math.round(num(manifest && manifest.parts)));
    const got = arr(parts);

    if (!want) {
        // Not chunked: the manifest carries the payload itself.
        const d = manifest && typeof manifest.d === 'string' ? manifest.d : '';
        if (!d) return { ok: false, reason: QUARANTINE.CHUNKS_MISSING, detail: { want: 1, got: 0 } };
        return { ok: true, base64: d };
    }

    const byIndex = new Map();
    for (const p of got) {
        if (!p || typeof p.d !== 'string') continue;
        const i = Math.round(num(p.i));
        if (i < 0 || i >= want) continue;          // an index outside the manifest is not ours
        byIndex.set(i, p.d);
    }
    if (byIndex.size !== want) {
        const missing = [];
        for (let i = 0; i < want; i++) if (!byIndex.has(i)) missing.push(i);
        return { ok: false, reason: QUARANTINE.CHUNKS_MISSING, detail: { want, got: byIndex.size, missing } };
    }

    let out = '';
    for (let i = 0; i < want; i++) out += byIndex.get(i);
    return { ok: true, base64: out };
}

/* ── 2. unlock ────────────────────────────────────────────────────────────── */

/**
 * Open the PDF, trying the local vault's candidates in order.
 *
 * `openPdf(bytes, password)` is injected — in the app it is PDF.js, in tests it
 * is a stub. It must resolve with a document or reject; a rejection is treated
 * as "that key was wrong", which is what PDF.js does.
 *
 * NOTHING IN THE RETURN VALUE CARRIES A PASSWORD, in either branch. On success
 * the caller learns `usedIndex` so it can promote a working key to the front of
 * the list next time; the value itself stays in the vault. On failure the
 * caller learns how many were tried, not what they were. An error object that
 * quotes the credential it failed on is the ordinary way secrets end up in a
 * log, and this module is the one place in the app that holds several at once.
 */
export async function unlock(bytes, candidates, openPdf) {
    if (typeof openPdf !== 'function') throw new TypeError('unlock(): openPdf must be injected');

    // An unencrypted statement needs no key at all, and must not consume one.
    try {
        const doc = await openPdf(bytes, null);
        if (doc) return { ok: true, doc, usedIndex: -1, encrypted: false };
    } catch (_) { /* encrypted, or unreadable — the loop below decides which */ }

    const keys = arr(candidates).filter((k) => typeof k === 'string' && k.length > 0);
    if (!keys.length) return { ok: false, reason: QUARANTINE.NO_VAULT_KEYS, detail: { tried: 0 } };

    for (let i = 0; i < keys.length; i++) {
        try {
            const doc = await openPdf(bytes, keys[i]);
            if (doc) return { ok: true, doc, usedIndex: i, encrypted: true };
        } catch (_) { /* wrong key; the next one */ }
    }
    return { ok: false, reason: QUARANTINE.PASSWORD_FAILED, detail: { tried: keys.length } };
}

/* ── 3. the cross-check ───────────────────────────────────────────────────── */

/** Which way the money moved, according to the module that routed it. */
export const MODULE_DIRECTION = {
    income: 'credit',
    cc_payment: 'credit',
    expenses: 'debit',
    subscriptions: 'debit',
    ccinstall: 'debit',
    cconetime: 'debit',
    // loans and goal_alloc are legitimately either: a loan row can be a
    // repayment out or a disbursement in, and a savings target can be funded or
    // drawn down. Asserting a direction for them would invent a constraint the
    // data does not have, so they are exempt from the contradiction test and
    // rely on the parser's own direction instead.
};

/**
 * Do the bank's arithmetic and the description agree about which way the money
 * went?
 *
 * @param row     a parsed row: { direction, directionSource, needsReview, ... }
 * @param routed  the router's answer: { module, confidence, needsReview, ... }
 * @param opts.minConfidence  category confidence below which nothing is filed
 * @returns {{ok:true} | {ok:false, reason:string, detail:object}}
 */
export function crossCheck(row, routed, opts = {}) {
    const minConfidence = typeof opts.minConfidence === 'number' ? opts.minConfidence : 0.75;
    const dir = row && row.direction;
    const src = String((row && row.directionSource) || '');

    // No direction at all, or one the parser reached by assumption. Either way
    // the bank did not tell us, and the whole guarantee rests on it having.
    if (!dir) {
        return { ok: false, reason: QUARANTINE.DIRECTION_UNRESOLVED, detail: { directionSource: src || 'none' } };
    }
    if (!PROVEN_SOURCES.has(src)) {
        return {
            ok: false,
            reason: QUARANTINE.DIRECTION_UNRESOLVED,
            detail: { directionSource: src || 'none', direction: dir,
                why: 'read from wording, not from the bank’s own figures' },
        };
    }

    const expected = MODULE_DIRECTION[routed && routed.module];
    if (expected && expected !== dir) {
        /* THE CONTRADICTION THIS MODULE EXISTS FOR.
         *
         * The description reads like income and the running balance says the
         * money left, or the reverse. One of the two is wrong and there is no
         * way here to tell which, so neither is used. */
        return {
            ok: false,
            reason: QUARANTINE.ROUTING_CONFLICT,
            detail: {
                bankSays: dir, descriptionSays: expected,
                module: routed.module, directionSource: src,
            },
        };
    }

    if (num(routed && routed.confidence) < minConfidence || (routed && routed.needsReview)) {
        return {
            ok: false,
            reason: QUARANTINE.LOW_CONFIDENCE,
            detail: { confidence: num(routed && routed.confidence), module: routed && routed.module },
        };
    }

    return { ok: true };
}

/* ── 4. the pipeline ──────────────────────────────────────────────────────── */

/** Let the browser paint. Injectable so tests do not wait on real timers. */
const defaultYield = () => new Promise((r) => setTimeout(r, 0));

/**
 * Run one statement through: assemble, unlock, extract, parse, route, verify.
 *
 * `deps` supplies everything external:
 *   openPdf(bytes, password)   -> doc | throws
 *   extractText(doc)           -> string
 *   parse(text)                -> { rows, ... }   (WFStatementParser.parseStatement)
 *   route(rows, ctx)           -> [{ ...routed }] (WFStatementRouter.classifyStatement)
 *   vaultKeys()                -> string[]
 *   yieldToUi()                -> Promise        (optional)
 *
 * ── WHY THE LOOP YIELDS ─────────────────────────────────────────────────────
 * A year of statements is a few thousand rows, and routing each one runs
 * regular expressions over its description. Done in one synchronous pass on the
 * device that is also drawing the dashboard, that is a visible freeze on a
 * phone. The row loop hands control back every BATCH rows so the interface stays
 * live while this runs; the work is the same, the blocking is not.
 */
export const BATCH = 25;

export async function intakeStatement(item, deps = {}, ctx = {}) {
    const { openPdf, extractText, parse, route, vaultKeys } = deps;
    const yieldToUi = deps.yieldToUi || defaultYield;
    for (const [n, f] of [['openPdf', openPdf], ['extractText', extractText], ['parse', parse], ['route', route]]) {
        if (typeof f !== 'function') throw new TypeError(`intakeStatement(): deps.${n} must be a function`);
    }

    const bank = String((item && item.bank) || 'Unknown bank');
    const id = item && item.id != null ? String(item.id) : null;
    const fail = (reason, detail) => ({
        id, bank, applied: [], quarantined: [{ scope: 'statement', reason, detail: detail || {}, bank, id }],
    });

    const asm = assemble(item && item.manifest, item && item.parts);
    if (!asm.ok) return fail(asm.reason, asm.detail);

    let bytes;
    try {
        bytes = deps.decodeBase64 ? deps.decodeBase64(asm.base64) : asm.base64;
    } catch (_) {
        return fail(QUARANTINE.CHUNKS_MISSING, { why: 'the reassembled payload was not readable base64' });
    }

    let keys = [];
    try { keys = arr(await (typeof vaultKeys === 'function' ? vaultKeys() : [])); } catch (_) { keys = []; }

    const opened = await unlock(bytes, keys, openPdf);
    if (!opened.ok) return fail(opened.reason, opened.detail);

    let text = '';
    try { text = String(await extractText(opened.doc) || ''); } catch (_) { text = ''; }
    if (text.trim().length < 40) return fail(QUARANTINE.NO_TEXT_LAYER, { chars: text.trim().length });

    let parsed;
    try { parsed = await parse(text); } catch (e) {
        return fail(QUARANTINE.UNPARSEABLE, { why: (e && e.message) ? String(e.message).slice(0, 120) : 'parser threw' });
    }
    const rows = arr(parsed && parsed.rows);
    if (!rows.length) {
        /* THE PARSER KNOWS WHY. It grades its own result — 'unreadable' for a
         * layout it has never seen, 'empty' for a statement with nothing on it,
         * 'no-text' for a scan. Re-deriving that here from `rows.length` is how
         * both became "unparseable" and were treated identically.
         *
         * `text` rides along ONLY on the teachable case, because the screen
         * that offers to learn the layout needs the page it failed on. It stays
         * on the device: this module has no network and its one caller hands it
         * to a local review screen. */
        const verdict = parsed && parsed.verdict;
        if (verdict === 'no-text') return fail(QUARANTINE.NO_TEXT_LAYER, { chars: text.trim().length });
        if (verdict === 'empty') return fail(QUARANTINE.NO_TRANSACTIONS, { rows: 0 });
        if (verdict === 'unreadable') {
            return {
                ...fail(QUARANTINE.LAYOUT_UNKNOWN, {
                    rows: 0,
                    moneyLines: num(parsed.moneyLines),
                    candidateRows: num(parsed.candidateRows),
                    teachable: true,
                }),
                text,
            };
        }
        return fail(QUARANTINE.UNPARSEABLE, { rows: 0 });
    }

    /* Readable but not trustworthy. The rows still go through — the owner
     * reviews every imported statement — but the statement carries a warning
     * beside them, because "opening + credits - debits does not reach closing"
     * means at least one row on this page was misread or missed entirely, and
     * that is not something to discover three months later. */
    const unbalanced = parsed && parsed.verdict === 'unverified';

    let routedRows = [];
    try { routedRows = arr(await route(rows, ctx)); } catch (e) {
        return fail(QUARANTINE.UNPARSEABLE, { why: 'routing threw: ' + String((e && e.message) || '').slice(0, 90) });
    }

    const applied = [];
    const quarantined = [];
    for (let i = 0; i < routedRows.length; i++) {
        if (i > 0 && i % BATCH === 0) await yieldToUi();
        const routed = routedRows[i] || {};
        if (routed.duplicate) continue;            // already in the ledger; not an issue to report
        const row = routed.row || rows[i] || {};
        const verdict = crossCheck(row, routed, ctx);
        if (verdict.ok) {
            applied.push(routed);
        } else {
            quarantined.push({
                scope: 'row', reason: verdict.reason, detail: verdict.detail, bank, id,
                /* The direction and the router's answer travel WITH the
                 * quarantine record, because both of the things that read it
                 * need them. The review card cannot say "money in" or "money
                 * out" without the first, and it cannot pre-select a best guess
                 * without the second — a one-tap confirmation with nothing
                 * pre-selected is just a form. Agent 2 needs the same two: it
                 * refuses to look up a row whose direction the bank did not
                 * prove, and it has nothing to upgrade without a routing. */
                row: {
                    date: row.date,
                    desc: row.narration || (routed.fields && routed.fields.desc) || '',
                    amount: num(row.amount),
                    direction: row.direction,
                    directionSource: row.directionSource,
                },
                routed: {
                    module: routed.module,
                    confidence: num(routed.confidence),
                    needsReview: !!routed.needsReview,
                },
            });
        }
    }

    if (unbalanced) {
        quarantined.push({
            scope: 'statement', reason: QUARANTINE.BALANCE_MISMATCH, bank, id,
            detail: {
                opening: num(parsed.reconciliation && parsed.reconciliation.opening),
                closing: num(parsed.reconciliation && parsed.reconciliation.closing),
                difference: num(parsed.reconciliation && parsed.reconciliation.difference),
                rows: rows.length,
            },
            /* Not a dead end: the rows ARE in `applied`. This says "check the
             * total", not "nothing was read". The one caller distinguishes them
             * by whether applied is empty, and so does intakeAll's failed count. */
            advisory: true,
        });
    }

    return {
        id, bank, applied, quarantined,
        usedVaultIndex: opened.usedIndex, encrypted: opened.encrypted,
        verdict: (parsed && parsed.verdict) || null,
        learnedLayout: (parsed && parsed.learnedLayout) || null,
    };
}

/** Every pending statement, oldest first, each isolated from the others. */
export async function intakeAll(items, deps = {}, ctx = {}) {
    const out = { applied: [], quarantined: [], statements: 0, failed: 0 };
    for (const item of arr(items)) {
        let r;
        try {
            r = await intakeStatement(item, deps, ctx);
        } catch (e) {
            /* One malformed statement must not stop the rest. It becomes a
             * quarantine entry like any other refusal, because a statement that
             * threw is exactly a statement nobody has checked. */
            r = {
                id: item && item.id != null ? String(item.id) : null,
                bank: String((item && item.bank) || 'Unknown bank'),
                applied: [],
                quarantined: [{ scope: 'statement', reason: QUARANTINE.UNPARSEABLE,
                    detail: { why: String((e && e.message) || 'threw').slice(0, 120) },
                    bank: String((item && item.bank) || 'Unknown bank') }],
            };
        }
        out.statements += 1;
        if (!r.applied.length && r.quarantined.some((q) => q.scope === 'statement' && !q.advisory)) out.failed += 1;
        out.applied.push(...r.applied);
        out.quarantined.push(...r.quarantined);
    }
    return out;
}

/* ── 5. what the user is told ─────────────────────────────────────────────── */

/**
 * One sentence per issue, in the shape the requirement asked for.
 *
 * Notification bodies are plain text — escaping them would print `&amp;` at a
 * payee with an ampersand — so the caller must not run this through the HTML
 * escaper. test/markup_escaping_test.js records that exemption by name.
 */
export function notificationFor(q) {
    if (!q) return null;
    const why = QUARANTINE_TEXT[q.reason] || 'it needs a look';
    const bank = q.bank || 'a bank';
    if (q.scope === 'statement') {
        return `Issue detected with ${bank} statement. Requires your manual review: ${why}.`;
    }
    const r = q.row || {};
    const amount = r.amount ? ` ${Math.round(r.amount).toLocaleString()}` : '';
    const desc = r.desc ? ` — ${String(r.desc).slice(0, 48)}` : '';
    const when = r.date ? ` on ${r.date}` : '';
    return `Issue detected with ${bank} statement. Requires your manual review for transaction${amount}${desc}${when}: ${why}.`;
}

/** Group quarantine entries so one statement with 40 bad rows is one message. */
export function summarise(result) {
    const q = arr(result && result.quarantined);
    const byReason = {};
    for (const x of q) byReason[x.reason] = (byReason[x.reason] || 0) + 1;
    const statementLevel = q.filter((x) => x.scope === 'statement');
    return {
        applied: arr(result && result.applied).length,
        quarantined: q.length,
        byReason,
        /* The statement-level refusals first: a statement that never opened is a
         * bigger problem than a row that needs a category, and burying it under
         * forty row messages is how the important one goes unread. */
        messages: [
            ...statementLevel.map(notificationFor),
            ...(q.length > statementLevel.length
                ? [`${q.length - statementLevel.length} transaction${q.length - statementLevel.length === 1 ? '' : 's'} need your review.`]
                : []),
        ],
    };
}

const API = {
    QUARANTINE, QUARANTINE_TEXT, BATCH,
    assemble, unlock, crossCheck, intakeStatement, intakeAll, notificationFor, summarise,
};

if (typeof window !== 'undefined') window.WFMailIntake = API;

export default API;
