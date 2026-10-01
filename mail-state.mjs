/* =============================================================================
 * mail-state.mjs — the Email Processing State Table
 * -----------------------------------------------------------------------------
 * One small document per mailbox message, kept at wf-mail/{mailbox}/emails/{messageId}, recording where that message
 * is on its way from "found in the inbox" to "its transactions are in the ledger". It is written BEFORE anything is
 * fetched or read, so a message that is found can never be forgotten by a crash, a timeout or a lock half-way through:
 * the record outlives the attempt, and whatever is not finished is picked up again from the record.
 *
 *   PENDING              found; logged before any attachment is fetched or any byte read.
 *   PROCESSED            accepted by the intake rules and its attachment durably stored; waiting to be read.
 *   REVIEW               read, but it could not be reconciled yet; it is in the review queue, not lost.
 *   INGESTED             every attachment read and committed to the ledger. Set ONLY by reconcile(), from the items
 *                        themselves — nothing else can say a message is done.
 *   FAILED_VERIFICATION  SPF / DKIM / DMARC said it is not from who it claims: a security event, never ingested.
 *   REFUSED              the rules refused it (not a statement, no attachment, too large …), with the reason.
 *   HELD                 from a sender the owner has not decided about yet; one tap releases it.
 *
 * A state only ever moves FORWARD (PENDING → PROCESSED → REVIEW → INGESTED); the refusals are sideways and are
 * overwritten by the latest judgement, including by a later acceptance. Nothing overwrites PROCESSED/REVIEW/INGESTED
 * with a refusal — a message whose statement is already stored is not un-stored by a stricter rule.
 *
 * Pure where it can be, and every function tolerates a missing or malformed document: this table is evidence, and
 * failing to write it must never stop mail from arriving (the durable cursor and the item manifests are the authority).
 * ===========================================================================*/

export const MAIL_STATE = Object.freeze({
    PENDING: 'PENDING', PROCESSED: 'PROCESSED', REVIEW: 'REVIEW', INGESTED: 'INGESTED',
    FAILED_VERIFICATION: 'FAILED_VERIFICATION', REFUSED: 'REFUSED', HELD: 'HELD',
});
const RANK = { PENDING: 0, REFUSED: 1, HELD: 1, FAILED_VERIFICATION: 1, PROCESSED: 2, REVIEW: 3, INGESTED: 4 };
export const STATES = Object.keys(MAIL_STATE);

/** A PENDING record this old with nothing stored for it is an attempt that died: it is queued again. */
export const PENDING_STALE_MS = 10 * 60 * 1000;
/** After this many dead attempts it is still retried, but the owner is told it is stuck. */
export const STUCK_ATTEMPTS = 5;
export const EMAILS = 'emails';
const MAX_READ = 20000;

export const docIdOf = (messageId) => String(messageId == null ? '' : messageId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
const clean = (s, n) => String(s == null ? '' : s).slice(0, n);

/** The state a plan puts a message in, before anything is stored. */
export function stateForPlan(plan) {
    if (!plan) return null;
    if (plan.ok) return { state: MAIL_STATE.PROCESSED, reason: '' };
    if (plan.security === true) return { state: MAIL_STATE.FAILED_VERIFICATION, reason: clean(plan.reason, 80) };
    if (plan.reason === 'sender-not-on-your-list' || plan.reason === 'a-new-address-at-a-bank-you-approved') return { state: MAIL_STATE.HELD, reason: clean(plan.reason, 80) };
    return { state: MAIL_STATE.REFUSED, reason: clean(plan.reason, 80) };
}

/** May `next` replace `prev`? Forward only; the refusals are sideways; PENDING never replaces anything. */
export function mayReplace(prev, next) {
    const a = RANK[prev && prev.state], b = RANK[next && next.state];
    if (b === undefined) return false;
    if (a === undefined) return true;
    if (next.state === MAIL_STATE.PENDING) return prev.state === MAIL_STATE.PENDING;   // a retry is counted; nothing else is undone by one
    if (a >= RANK.PROCESSED && b <= RANK.HELD) return false;     // a stored statement is not un-stored by a stricter rule
    if (b > a) return true;
    if (b === a) return prev.state !== next.state || prev.reason !== next.reason || (Number(next.v) || 0) > (Number(prev.v) || 0) || next.force === true;
    return false;
}

/** The document kept for one message. `attempts` counts how many times it was found and not finished. */
export function entryOf(input, prev, now) {
    const p = prev && typeof prev === 'object' ? prev : {};
    const out = {
        messageId: clean(input.messageId, 128),
        state: input.state,
        reason: clean(input.reason, 80),
        from: clean(input.from, 160),
        subject: clean(input.subject, 160),
        receivedMs: Number(input.receivedMs) > 0 ? Number(input.receivedMs) : (Number(p.receivedMs) || null),
        v: Number(input.v) || Number(p.v) || 0,
        firstSeenMs: Number(p.firstSeenMs) || now,
        updatedMs: now,
        attempts: Number(p.attempts) || 0,
    };
    if (input.state === MAIL_STATE.PENDING) out.attempts += 1;
    const items = Array.isArray(input.items) ? input.items : p.items;
    if (Array.isArray(items) && items.length) out.items = items.map((k) => clean(k, 200)).slice(0, 16);
    const sha = Array.isArray(input.sha) ? input.sha : p.sha;
    if (Array.isArray(sha) && sha.length) out.sha = sha.map((h) => clean(h, 64)).slice(0, 16);
    const via = input.via || p.via;
    if (via) out.via = clean(via, 16);
    return out;
}

/**
 * Log a batch of states in ONE transaction: read every document first, then write only what may change.
 * Returns { written, skipped }. Throws nothing the caller needs to care about — it is advice that reports failure.
 */
export async function logStates(db, mailRef, inputs, { now = Date.now() } = {}) {
    const list = (Array.isArray(inputs) ? inputs : []).filter((i) => i && i.messageId && MAIL_STATE[i.state]);
    if (!list.length) return { written: 0, skipped: 0, ok: true };
    try {
        let written = 0, fresh = [];
        await db.runTransaction(async (tx) => {
            written = 0; fresh = [];
            const refs = list.map((i) => mailRef.collection(EMAILS).doc(docIdOf(i.messageId)));
            const snaps = [];
            for (const ref of refs) snaps.push(await tx.get(ref));
            list.forEach((input, n) => {
                const prev = snaps[n].exists ? snaps[n].data() : null;
                // never on record before this: the first time this MESSAGE has been found (a sender's count is of messages, not of scans)
                if (!prev) fresh.push(String(input.messageId));
                if (prev && !mayReplace(prev, input)) return;
                tx.set(refs[n], entryOf(input, prev, now), { merge: false });
                written += 1;
            });
        });
        return { written, skipped: list.length - written, ok: true, fresh };
    } catch (error) {
        return { written: 0, skipped: list.length, ok: false, error: clean(error && error.message, 120) };
    }
}

/** Which of these message ids already have a settled record under the current rules? (PENDING does not count.) */
export async function settledIds(mailRef, ids, { version = 0, concurrency = 40 } = {}) {
    const out = new Set();
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    for (let at = 0; at < list.length; at += concurrency) {
        const chunk = list.slice(at, at + concurrency);
        const docs = await Promise.all(chunk.map((id) => mailRef.collection(EMAILS).doc(docIdOf(id)).get().catch(() => null)));
        docs.forEach((doc, n) => {
            const d = doc && doc.exists ? doc.data() : null;
            // HELD waits on a decision about the SENDER, and a mail refused because the sender was blocked is refused only
            // until the owner unblocks it: neither is "judged for good", so both come back to the audit.
            const reopenable = d && (d.state === MAIL_STATE.HELD || d.reason === 'you-blocked-this-sender');
            if (d && d.state !== MAIL_STATE.PENDING && !reopenable && (Number(d.v) || 0) >= version) out.add(chunk[n]);
        });
    }
    return out;
}

/** Every record, for reconcile and the summary. Bounded: a table this large is summarised, not loaded whole. */
export async function readTable(mailRef) {
    let query = mailRef.collection(EMAILS);
    if (typeof query.limit === 'function') query = query.limit(MAX_READ);
    return (await query.get()).docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** What the ITEMS say about each message: the only thing allowed to decide INGESTED. */
export function rollupItems(items) {
    const by = new Map();
    for (const item of Array.isArray(items) ? items : []) {
        const id = String(item && item.messageId || '').trim();
        if (!id) continue;
        if (!by.has(id)) by.set(id, []);
        by.get(id).push(item);
    }
    const out = new Map();
    for (const [id, list] of by) {
        const settledItem = (i) => i.filed === true || i.emptyStatement === true;
        /* RETIRED is an outcome too. An item retired as not a statement, retired because its sender is no longer approved, or dismissed by the owner is DONE: left
         * as "stored, waiting to be read" it made a sender's line say "4 waiting" for ever (HNB, 2026-10-02) when nothing at all was waiting. */
        const retiredItem = (i) => i.status === 'rejected_non_statement' || i.status === 'rejected_unapproved_sender' || i.status === 'dismissed';
        const settled = list.every(settledItem);
        const closed = list.every((i) => settledItem(i) || retiredItem(i));
        const rejected = list.every(retiredItem);
        const review = list.some((i) => i.status === 'needs_review' || i.status === 'dead_letter' || i.hasReview === true);
        let state = MAIL_STATE.PROCESSED, reason = '';
        if (settled || (closed && list.some(settledItem))) state = MAIL_STATE.INGESTED;       // what it carried that is a statement is in; the rest was retired
        else if (rejected) {
            state = MAIL_STATE.REFUSED;
            reason = list.every((i) => i.status === 'dismissed') ? 'dismissed-by-the-owner' : list.some((i) => i.status === 'rejected_unapproved_sender') ? 'the-sender-is-no-longer-approved' : 'the-document-is-not-a-bank-statement';
        }
        else if (review) { state = MAIL_STATE.REVIEW; reason = clean(list.find((i) => i.reviewReason)?.reviewReason || (list.some((i) => i.status === 'dead_letter') ? 'retrying-after-repeated-failures' : 'needs-review'), 80); }
        out.set(id, { state, reason, items: list.map((i) => String(i.id || '')).filter(Boolean), sha: list.map((i) => String(i.contentSha256 || '')).filter(Boolean), from: list[0].from, receivedMs: list[0].receivedMs });
    }
    return out;
}

/**
 * Bring the table in line with the items and find what is stuck.
 *
 *   · a message with items gets the state its items prove (INGESTED only if every one is filed);
 *   · PENDING with nothing stored, older than PENDING_STALE_MS, is requeued — the attempt died;
 *   · PROCESSED with no item at all (the manifest never landed) is requeued too;
 *   · an item that has no record (stored before this table existed) gets one.
 *
 * Pure: returns what to write and what to requeue.
 */
export function reconcile({ table, items, now = Date.now() }) {
    const rolled = rollupItems(items);
    const rows = new Map((Array.isArray(table) ? table : []).map((r) => [String(r.messageId || ''), r]));
    const writes = [], requeue = [];
    for (const [id, r] of rolled) {
        const prev = rows.get(id);
        const next = { messageId: id, state: r.state, reason: r.reason, items: r.items, sha: r.sha, from: r.from, receivedMs: r.receivedMs, force: true };
        if (!prev || prev.state !== r.state || prev.reason !== r.reason) writes.push(next);
    }
    for (const r of rows.values()) {
        const id = String(r.messageId || '');
        if (rolled.has(id)) continue;
        const age = now - (Number(r.updatedMs) || 0);
        if (r.state === MAIL_STATE.PENDING && age >= PENDING_STALE_MS) requeue.push(id);
        else if (r.state === MAIL_STATE.PROCESSED && age >= PENDING_STALE_MS) requeue.push(id);
    }
    return { writes, requeue: [...new Set(requeue)].slice(0, 200) };
}

/** The table as the screen shows it: counts per state, and what is stuck (never the whole list). */
export function summarize(table, { now = Date.now() } = {}) {
    const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
    const stuck = [];
    for (const r of Array.isArray(table) ? table : []) {
        if (!MAIL_STATE[r.state]) continue;
        counts[r.state] += 1;
        const age = now - (Number(r.updatedMs) || 0);
        const dead = (r.state === MAIL_STATE.PENDING && age >= PENDING_STALE_MS) || (r.state === MAIL_STATE.PROCESSED && age >= 6 * 3600 * 1000) || r.state === MAIL_STATE.REVIEW;
        if (dead) stuck.push({ messageId: String(r.messageId || ''), state: r.state, reason: clean(r.reason, 80), from: clean(r.from, 120), subject: clean(r.subject, 100), attempts: Number(r.attempts) || 0, ageMs: Math.max(0, age) });
    }
    stuck.sort((a, b) => b.ageMs - a.ageMs);
    // PER SENDER ADDRESS: where each bank's mail actually is. A bank whose mail sits in HELD or REFUSED is a bank whose
    // statements are not arriving, and this is the line that says so.
    const addr = (from) => { const m = /<([^<>]+@[^<>]+)>|([^\s<>"]+@[^\s<>"]+)/.exec(String(from || '').replace(/"(?:[^"\\]|\\.)*"/g, ' ')); return String((m && (m[1] || m[2])) || '').toLowerCase().slice(0, 120); };
    const bySender = new Map();
    for (const r of Array.isArray(table) ? table : []) {
        if (!MAIL_STATE[r.state]) continue;
        const key = addr(r.from) || '(unknown)';
        if (!bySender.has(key)) bySender.set(key, { address: key, total: 0, ...Object.fromEntries(STATES.map((st) => [st, 0])) });
        const row = bySender.get(key); row.total += 1; row[r.state] += 1;
    }
    const senders = [...bySender.values()].sort((a, b) => b.total - a.total).slice(0, 30);
    return { total: Object.values(counts).reduce((a, b) => a + b, 0), counts, senders, stuck: stuck.slice(0, 20), stuckCount: stuck.length };
}

/** Write what reconcile() found. The items are the evidence, so these bypass the forward-only rule on purpose. */
export async function applyReconcile(mailRef, writes, tableRows, { now = Date.now(), concurrency = 25 } = {}) {
    const prevById = new Map((Array.isArray(tableRows) ? tableRows : []).map((r) => [String(r.messageId || ''), r]));
    let done = 0;
    for (let at = 0; at < writes.length; at += concurrency) {
        const chunk = writes.slice(at, at + concurrency);
        await Promise.all(chunk.map(async (w) => {
            const { id: _drop, ...prev } = prevById.get(w.messageId) || {};
            await mailRef.collection(EMAILS).doc(docIdOf(w.messageId)).set(entryOf(w, prev, now), { merge: false });
            done += 1;
        }));
    }
    return done;
}

/**
 * The first `want` ids, in order, that are NOT settled — looking up only as many as it takes, so a mailbox with tens of
 * thousands of listed messages costs a bounded number of reads per run, not one per message.
 */
export async function firstUnsettled(mailRef, ids, want, { version = 0, chunk = 200 } = {}) {
    const out = [];
    let settledSeen = 0;
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
    for (let at = 0; at < list.length && out.length < want; at += chunk) {
        const slice = list.slice(at, at + chunk);
        const settled = await settledIds(mailRef, slice, { version });
        for (const id of slice) { if (!settled.has(id)) { out.push(id); if (out.length >= want) break; } else settledSeen += 1; }
    }
    out.settledSeen = settledSeen;
    return out;
}
