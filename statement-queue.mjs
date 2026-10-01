/* =============================================================================
 * statement-queue.mjs — which statement is worked on next, and what happens when one keeps failing
 * -----------------------------------------------------------------------------
 * The queue is the `items` collection itself (one document per stored statement, status pending → processing → filed). What
 * was missing was the discipline around it:
 *
 *   ORDER       Work is claimed in a fixed order, not in whatever order the database lists it:
 *                 1. a statement already part-way through (cursor > 0) — finish what was started;
 *                 2. one that has never failed, before one that has;
 *                 3. the NEWEST first (the owner looks at this month, not at 2019);
 *               and fairly ACROSS BANKS — one from each bank in turn, the starting bank moving on every few seconds — so a
 *               bank with two hundred old statements can never keep another bank's latest one waiting.
 *
 *   ATTEMPTS    Every failed attempt is counted on the statement itself (`retryCount`) before anything else happens, so a
 *               run that is killed by the platform's 60 s limit still counts. After MAX_ATTEMPTS (5) in a row the statement
 *               is not hammered any more: it moves to `dead_letter`, with everything needed to resume it exactly where it
 *               stopped — the row offset (`cursor`), the password offset, the row-set hash — and the reason it failed.
 *
 *   RE-DRIVE    A dead-lettered statement is never dropped. It is put back in the queue automatically after 15 minutes, then
 *               1 hour, 6 hours and 24 hours (a provider outage, a locked database or a bad deploy mends itself), resuming
 *               from the frozen offset — nothing is read twice, nothing is skipped. Only after all four rounds (25 attempts,
 *               a day and a half) does it become one clear question for the owner (`needs_review`), still holding its place.
 *
 *   AI HEALTH   A model provider that is down costs ten seconds to find out. That is paid once, not once per statement:
 *               after a failure the AI is not asked again for a few minutes (the state is kept on the mailbox, so the next
 *               invocation does not pay either), and none is asked when too little of the 60-second invocation is left.
 *
 * Pure where it can be; the two Firestore helpers take the database handle and return plain objects.
 * ===========================================================================*/

export const MAX_ATTEMPTS = 5;
/** Wait before the n-th re-drive (0-based). After the last, the statement goes to the owner. */
export const REDRIVE_AFTER_MS = Object.freeze([15 * 60 * 1000, 60 * 60 * 1000, 6 * 3600 * 1000, 24 * 3600 * 1000]);
/** How many pending statements are looked at when choosing the next: enough for a whole mailbox, read as small records. */
export const CLAIM_WINDOW = 1000;
export const AI_BREAK_MS = 3 * 60 * 1000;
export const ROTATE_EVERY_MS = 20 * 1000;
export const DEAD_LETTER = 'dead_letter';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const data = (doc) => ((doc && typeof doc.data === 'function' ? doc.data() : doc) || {});

/** Is this statement free to be worked on right now (not backing off, not leased to a live worker)? */
export const isReady = (x, now) => num(x.retryAt) <= now && num(x.leaseUntil) <= now;

/**
 * The claim order. `docs` are query documents (or plain objects with an `id`); returns the ready ones, best first.
 * Within a bank: part-way first, never-failed before failed, newest first, then by id (so the order is total and stable).
 * Across banks: round-robin, starting at a bank that rotates with the clock.
 */
export function claimOrder(docs, { now = Date.now(), rotate = Math.floor(num(now) / ROTATE_EVERY_MS) } = {}) {
    const rows = (Array.isArray(docs) ? docs : []).map((doc) => ({ doc, x: data(doc) })).filter(({ x }) => isReady(x, now));
    const better = (a, b) =>
        (num(b.x.cursor) > 0) - (num(a.x.cursor) > 0)
        || (num(a.x.retryCount) > 0) - (num(b.x.retryCount) > 0)
        || num(b.x.receivedMs) - num(a.x.receivedMs)
        || String(a.doc.id || '').localeCompare(String(b.doc.id || ''));
    const byBank = new Map();
    for (const row of rows) {
        const bank = String(row.x.bank || '').trim().toLowerCase();
        if (!byBank.has(bank)) byBank.set(bank, []);
        byBank.get(bank).push(row);
    }
    const lists = [...byBank.keys()].sort().map((bank) => byBank.get(bank).sort(better));
    const out = [];
    // the starting bank is `rotate` (by default the clock, so it moves from one invocation to the next); a caller that takes several
    // statements in a row passes clock + the number already taken, FIXED for the invocation — the order below is a full round-robin,
    // but only its first entry is claimed at a time, so without this the same bank always went first, and a clock tick in the
    // middle of an invocation must not skip one
    const offset = lists.length ? Math.max(0, Math.floor(num(rotate))) % lists.length : 0;
    for (let depth = 0; out.length < rows.length; depth++) {
        for (let k = 0; k < lists.length; k++) {
            const list = lists[(k + offset) % lists.length];
            if (depth < list.length) out.push(list[depth].doc);
        }
    }
    return out;
}

/**
 * What to write on a statement whose attempt just failed (the failure is not permanent: it may well work later).
 *   { patch, outcome }   outcome is 'retry' (backs off), 'dead-letter' (parked, will be re-driven) or 'escalate' (every
 *                        round used: the caller turns it into a question for the owner).
 */
export function failurePatch({ source, error, now = Date.now(), retryMaxMs = 180000 }) {
    const retryCount = Math.max(0, num(source && source.retryCount)) + 1;
    const reason = String((error && error.message) || 'statement-worker-retry-required').slice(0, 120);
    const passwordOffset = Number.isSafeInteger(error && error.passwordOffset) ? error.passwordOffset : (Number.isSafeInteger(source && source.passwordOffset) ? source.passwordOffset : undefined);
    if (retryCount < MAX_ATTEMPTS) {
        const retryAfterMs = Math.min(retryMaxMs, 1000 * (2 ** Math.min(retryCount - 1, 8)));
        return { outcome: 'retry', retryAfterMs, patch: { status: 'pending', leaseToken: '', leaseUntil: 0, retryAt: now + retryAfterMs,
            ...(passwordOffset !== undefined ? { passwordOffset } : {}), retryCount, lastRetryReason: reason, updatedAt: now } };
    }
    const earlier = (source && source.deadLetter) || {};
    const cycles = Math.max(0, num(earlier.cycles));
    const attemptsTotal = Math.max(0, num(earlier.attemptsTotal)) + retryCount;
    // frozen, serialised: where it stopped and why — everything a later attempt needs to resume at the same place
    const frozen = { at: now, reason, attempts: retryCount, attemptsTotal, cycles, cursor: Math.max(0, num(source && source.cursor)),
        totalRows: source && source.totalRows != null ? source.totalRows : null, rowSetHash: String((source && source.rowSetHash) || ''),
        ...(passwordOffset !== undefined ? { passwordOffset } : {}), firstFailedAt: num(earlier.firstFailedAt) || now };
    if (cycles >= REDRIVE_AFTER_MS.length) return { outcome: 'escalate', retryAfterMs: 0, patch: { retryCount, lastRetryReason: reason, deadLetter: { ...frozen, redriveAt: 0, escalatedAt: now }, updatedAt: now } };
    return { outcome: 'dead-letter', retryAfterMs: REDRIVE_AFTER_MS[cycles], patch: { status: DEAD_LETTER, leaseToken: '', leaseUntil: 0, retryAt: 0, retryCount, lastRetryReason: reason,
        ...(passwordOffset !== undefined ? { passwordOffset } : {}), deadLetter: { ...frozen, redriveAt: now + REDRIVE_AFTER_MS[cycles] }, updatedAt: now } };
}

/**
 * Put every dead-lettered statement whose wait is over back in the queue, from exactly where it stopped. The cursor, the
 * row-set hash and the password offset are not touched. Returns { redriven, waiting, nextAt }.
 */
export async function redriveDeadLetters({ db, mailRef, now = Date.now(), limit = 25 }) {
    let snap;
    try { snap = await mailRef.collection('items').where('status', '==', DEAD_LETTER).limit(200).get(); }
    catch (_) { return { redriven: 0, waiting: 0, nextAt: 0, error: true }; }
    let redriven = 0, waiting = 0, nextAt = 0;
    for (const doc of snap.docs) {
        const dl = data(doc).deadLetter || {};
        const due = num(dl.redriveAt);
        if (due > now || due === 0) { waiting += 1; if (due > 0 && (!nextAt || due < nextAt)) nextAt = due; continue; }
        if (redriven >= limit) { waiting += 1; continue; }
        const done = await db.runTransaction(async (tx) => {
            const current = await tx.get(doc.ref), x = current.data();
            if (!current.exists || x.status !== DEAD_LETTER || num(x.deadLetter && x.deadLetter.redriveAt) > now) return false;
            tx.set(doc.ref, { status: 'pending', retryCount: 0, retryAt: 0, leaseToken: '', leaseUntil: 0,
                deadLetter: { ...x.deadLetter, cycles: Math.max(0, num(x.deadLetter.cycles)) + 1, redriveAt: 0, lastRedriveAt: now }, updatedAt: now }, { merge: true });
            return true;
        });
        if (done) redriven += 1;
    }
    return { redriven, waiting, nextAt };
}

/**
 * A model provider's health, remembered across invocations. `state` is the plain object kept on the mailbox document
 * ({ board: { downUntil, at, reason }, extract: {…} }); `save(state)` persists it (advice: failing to save costs nothing).
 *
 * guard(kind, fn, { minRoomMs }) → a function with fn's signature that
 *   · throws `unavailable` at once while the provider is marked down, or when less than minRoomMs of the invocation is left;
 *   · marks it down (for AI_BREAK_MS) when fn fails, and clears the mark when fn succeeds.
 */
export function aiBreaker({ state = {}, now = Date.now, save = async () => {}, deadlineAt = Infinity, breakMs = AI_BREAK_MS } = {}) {
    const health = state && typeof state === 'object' ? { ...state } : {};
    const persist = async () => { try { await save(health); } catch (_) { /* advice only */ } };
    const guard = (kind, fn, { minRoomMs = 0, unavailable = 'ai-unavailable' } = {}) => async (...args) => {
        const t = now();
        if (num(health[kind] && health[kind].downUntil) > t) throw new Error(unavailable);
        if (deadlineAt - t < minRoomMs) throw new Error(unavailable);
        try {
            const result = await fn(...args);
            if (health[kind] && health[kind].downUntil) { health[kind] = { downUntil: 0, recoveredAt: t }; await persist(); }
            return result;
        } catch (error) {
            if (error && error.outage === false) throw error;      // the providers answered (and disagreed): not an outage
            health[kind] = { downUntil: now() + breakMs, at: now(), reason: String((error && error.message) || 'failed').slice(0, 80) };
            await persist();
            throw error;
        }
    };
    return { guard, health };
}
