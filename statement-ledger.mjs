import { isPhantomRow } from './statement-emptiness.mjs';
import { createHash } from 'node:crypto';
import { isStrictCalendarDate } from './otp-recovery.mjs';
import { isCreditCardRow } from './wealthflow-statement-router.js';
import { canonicalBank } from './wealthflow-institutions.js';
import { matchLoanForDebit, linkExpenseToLoan } from './loan-link.mjs';
import { manualTwin, markTwin, matchSubscriptionForDebit, matchChequeForDebit, cardSettlementDebit, matchInstallmentPlan, applyPlanPayment } from './statement-links.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const modules = { expenses: 'expenses', income: 'incomeRecv', incomeRecv: 'incomeRecv', cconetime: 'cconetime', ccinstall: 'ccinstall', cc_payment: 'ccPayments', ccPayments: 'ccPayments', subscription: 'subscriptions', subscriptions: 'subscriptions', skip: 'skip' };

export const transferEvidence = row => /\b(?:inward|outward)?\s*(?:ceft\s+)?transfer\b|\btransfer\s+credit[-\s]*mobilebanking\b/i
    .test(String(row?.description || row?.narration || row?.desc || row?.name || ''));

export function amountCents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000001 ? cents : null;
}

// Exactly zero and otherwise a real row: a misread amount is NaN, negative or missing, never a clean 0.
export const isZeroAmountLine = row => !!row && typeof row.amount === 'number' && row.amount === 0
    && isStrictCalendarDate(row.date) && !!norm(row.description || row.narration);

export function rowIdentity(row, { bank = '', last4 = '' } = {}) {
    return [row.date, amountCents(row.amount), norm(row.description || row.narration || row.desc || row.name),
        norm(canonicalBank(row.bank || row._bank || bank)), String(row.card_last4 || row._ccLast4 || last4),
        norm(row.ref), row.direction || ''];
}

export function sourceOccurrenceId(sourcePath, absoluteIndex) {
    return hash(['statement-occurrence-v1', sourcePath, absoluteIndex]);
}

export function validateSettlementRow(row, decision, ctx = {}) {
    if (!row || !isStrictCalendarDate(row.date) || !amountCents(row.amount) || !norm(row.description || row.narration)) return 'invalid-transaction';
    if (row.needsReview !== false || row.valid === false || !['balance', 'marker', 'column', 'sign'].includes(row.directionSource) || !['debit', 'credit'].includes(row.direction)) return 'unproven-direction';
    if (!decision || decision.verified !== true || !modules[decision.module] || !norm(decision.category)) return decision?.reason || 'unanimous-decision-required';
    
    const module = modules[decision.module];
    const card = isCreditCardRow(row, ctx);
    
    // Strict Routing Logical Exceptions injected for flawless allocation
    if (transferEvidence(row)) return module === 'skip' ? null : 'transfer-route-conflict';
    if (module === 'skip') return 'skip-requires-transfer-evidence';
    if (module === 'incomeRecv' && (row.direction !== 'credit' || card)) return 'income-direction-conflict';
    if (module === 'ccPayments' && (row.direction !== 'credit' || !card)) return 'card-payment-context-required';
    if (['expenses', 'cconetime', 'subscriptions'].includes(module) && row.direction !== 'debit') return 'expense-direction-conflict';
    
    // Strict Matrix Enforcements - ZERO Tolerance for misrouting
    if (module === 'cconetime' && !card) return 'card-charge-context-required';
    if (module === 'ccinstall' && (row.direction !== 'debit' || !card)) return 'card-installment-context-required';
    if (card && !['cconetime', 'ccinstall', 'ccPayments', 'skip'].includes(module)) return 'credit-card-route-conflict';
    
    return null;
}

export function crossSourceMatches(records, row, context) {
    const wanted = rowIdentity(row, context);
    return records.filter(record => {
        const actual = rowIdentity({ ...record, amount: record.amount, description: record.desc || record.name || record.description, direction: record.direction || row.direction }, {});
        return wanted.slice(0, 6).every((value, index) => value === actual[index]);
    });
}

/* A bank debit that IS a loan installment is linked to that loan's month (loan-link.mjs), so the installment is counted once: by the
 * debit, not again by the loan's schedule. Evidence only; anything the rules cannot tie to one loan is an ordinary expense. `loans` is the working copy. */
function linkInstallment(loans, expenses, record, now) {
    if (!Array.isArray(loans) || !loans.length || record.direction !== 'debit') return false;
    const hit = matchLoanForDebit({ description: record.desc, amount: record.amount, date: record.date }, loans);
    if (!hit) return false;
    linkExpenseToLoan({ expenses }, record, hit.loan, hit.month, now);
    return true;
}

/* THE PAYMENT IS ALREADY IN THE BOOKS UNDER ANOTHER NAME (statement-links.mjs). A row that the owner typed in by hand, tracks as a subscription, wrote as
 * an issued cheque, or that is the bank settling a card whose purchases are already counted, is not filed as a second expense or income. Evidence only;
 * no counterpart found means the row is filed exactly as before. */
function findCounterpart({ row, module, user, cards, cardRegistry }) {
    const records = module === 'expenses' ? user.expenses : module === 'incomeRecv' ? user.incomeRecv : module === 'cconetime' ? user.cconetime : null;
    if (Array.isArray(records)) { const twin = manualTwin(records, row); if (twin) return { kind: 'twin', twin }; }
    if (module === 'expenses' && row.direction === 'debit') {
        const cheque = matchChequeForDebit(row, user.cheques);
        if (cheque) return { kind: 'cheque', cheque };
        if (cardSettlementDebit(row, { cardRegistry, cards })) return { kind: 'card-settlement' };
    }
    if (module === 'ccinstall') { const plan = matchInstallmentPlan(row, user.ccinstall); if (plan) return { kind: 'plan', plan }; }
    if (module === 'expenses' || module === 'cconetime') { const sub = matchSubscriptionForDebit(row, user.subscriptions); if (sub) return { kind: 'subscription', sub }; }
    return null;
}
/* One statement debit as a payment of a subscription the owner tracks: the subscription's month says what was really charged. */
function applySubscriptionPayment(sub, row, sourcePath, index, bank, last4, now) {
    if (sub.history != null && !Array.isArray(sub.history)) return 'invalid-subscription-schema';
    if ((sub.history || []).some(payment => payment.date === row.date && amountCents(payment.amount) === amountCents(row.amount))) return 'ambiguous-subscription-payment';
    const month = row.date.slice(0, 7);
    sub.history = sub.history || [];
    sub.history.push({ month, amount: row.amount, date: row.date, source: 'statement', statementKey: sourcePath, statementRow: index, ref: String(row.ref || ''), bank, card_last4: last4 });
    sub.monthOverrides = { ...(sub.monthOverrides || {}), [month]: row.amount };
    sub.amount = row.amount; sub._ut = now;
    return '';
}

function makeRecord(row, decision, context, id, now) {
    const desc = String(row.description || row.narration).trim();
    const provenance = { statementKey: context.sourcePath, statementRow: context.index, bank: canonicalBank(context.bank || ''), card_last4: context.last4 || '', ref: String(row.ref || ''), direction: row.direction };
    // a row the AI board could not refine is filed with the rules' own answer and says so, so it can be found and changed
    const base = { id, ...provenance, amount: row.amount, date: row.date, source: 'statement', createdAt: new Date(now).toISOString(), _ut: now,
        notes: decision.autoDecided ? 'Filed automatically; the AI could not pick a more specific category. Change it if it is wrong.' : '', ...(decision.autoDecided ? { autoDecided: String(decision.autoDecided) } : {}) };
    const module = modules[decision.module];
    if (module === 'expenses') return { ...base, desc, cat: decision.category, month: row.date.slice(0, 7), recurring: false, recurringType: '0', completed: true };
    if (module === 'incomeRecv') return { ...base, name: desc, type: decision.category, month: row.date.slice(0, 7), received: true };
    if (module === 'ccPayments') return { ...base, desc };
    const deadline = new Date(row.date + 'T00:00:00Z'); deadline.setUTCDate(deadline.getUTCDate() + 50);
    /* A card installment charge is a one-month plan, in the plan shape the totals and the Installments tab read (product, bank, duration, date): in the worker's own
     * shape (description, startDate) it was invisible to both, and a real card charge was missing from the month. Its `date` is the month's first day: the totals
     * count a plan from the month after a mid-month date, which would put this charge a month late. */
    if (module === 'ccinstall') return { ...base, desc, product: desc.slice(0, 60), bank: canonicalBank(context.bank || ''), buyer: 'Self', rate: 0, duration: 1, date: `${row.date.slice(0, 7)}-01`, completed: false, skipped: [], notes: `Card installment charge of ${row.date}`,
        total: row.amount, monthly: row.amount, months: 1, remaining: 1, paid: 0, startDate: row.date, category: decision.category };
    return { ...base, desc, type: row.type || 'purchase', category: decision.category, serviceFee: 0, feeMeta: { source: 'statement' }, combinedTotal: row.amount, deadline: deadline.toISOString().slice(0, 10), paid: false };
}

/* A ROW THE LEDGER ALREADY HOLDS IS THE SAME TRANSACTION IF THE MONEY IS THE SAME. A statement that stopped part-way was filed by an earlier
 * reading; a later one (a better reader, a different account-number guess, a description cleaned up) words some rows differently, and a
 * fingerprint over the words alone called that "the statement changed" and refused to go on — for ever, since the rows already filed
 * could never be re-read the old way. What a filed row IS is its date, its amount and its direction (what the owner's books carry); when
 * those agree at the same place in the same statement it is the same transaction, counted as the duplicate it is, and nothing is
 * filed twice. When they do not agree, the statement really changed and is still refused — now with the reason named. */
export const LOST_ROW_WINDOW_MS = 45 * 86400000;
const ROW_MODULES = ['expenses', 'incomeRecv', 'cconetime', 'ccinstall', 'ccPayments'];
const outsideWindow = (entry, user, now) => { const settled = Number(entry.settledAt) || 0, wiped = Number(user?._wipedAt) || 0; return !settled || settled <= wiped || now - settled > LOST_ROW_WINDOW_MS; };
const tombstoned = (user, module, id) => Boolean(user?._tomb && typeof user._tomb === 'object' && user._tomb[module]?.[id] != null);
/* ROWS THE LEDGER CALLS FILED THAT THE OWNER'S DATA NO LONGER HOLDS, and nobody deleted: a device that had not yet seen them pushed its own copy of
 * the list over them. (A row the owner deleted has a tombstone; rows filed before a factory reset, or older than the tombstones' life, cannot be told
 * from a loss and are left alone.) A statement being replayed files these again — it is how "AMEX: ledger says filed, the app shows nothing" ends. */
export function lostFiledRows({ user, entries, now = Date.now() }) {
    const have = {}, lost = [];
    for (const entry of entries) {
        if (entry.status !== 'filed' || !ROW_MODULES.includes(entry.module) || outsideWindow(entry, user, now)) continue;
        have[entry.module] ||= new Set((Array.isArray(user?.[entry.module]) ? user[entry.module] : []).map(record => record && record.id));
        if (have[entry.module].has(entry.id) || tombstoned(user, entry.module, entry.id)) continue;
        lost.push(entry.id);
    }
    return lost;
}
const moneyOf = item => (item ? { date: String(item.date || ''), cents: amountCents(Number(item.amount)), direction: String(item.direction || '') } : null);
function compareMoney(was, now) {
    if (!was || was.cents == null || !was.date) return 'no-record';
    const differs = [was.date !== now.date && 'date', was.cents !== now.cents && 'amount', was.direction && now.direction && was.direction !== now.direction && 'direction'].filter(Boolean);
    return differs.length ? differs.join('+') : 'same';     // 'date' alone: see settleStatement
}
function filedRecord(user, sourcePath, index, id, matchedId) {
    for (const key of ['expenses', 'incomeRecv', 'cconetime', 'ccinstall', 'ccPayments']) {
        const hit = (Array.isArray(user[key]) ? user[key] : []).find(record => record && (record.id === id || (matchedId && record.id === matchedId)));
        if (hit) return hit;
    }
    for (const sub of Array.isArray(user.subscriptions) ? user.subscriptions : []) {
        const hit = (Array.isArray(sub?.history) ? sub.history : []).find(entry => entry && entry.statementKey === sourcePath && entry.statementRow === index);
        if (hit) return { ...hit, direction: 'debit' };
    }
    return null;
}
async function settledRowVerdict({ entry, row, user, sourcePath, index, id, readReview, at = Date.now() }) {
    const now = { date: String(row?.date || ''), cents: amountCents(row?.amount), direction: String(row?.direction || '') };
    if (entry.status === 'filed' || entry.status === 'duplicate') {
        const found = filedRecord(user, sourcePath, index, id, entry.matchedId);
        // no record to compare: the owner deleted it (a tombstone), or it is too old to tell a deletion from a loss — it stays as the ledger has it
        if (!found) return entry.status === 'filed' && (tombstoned(user, entry.module, id) || outsideWindow(entry, user, at)) ? 'same' : 'no-record';
        return compareMoney(moneyOf(found), now);
    }
    if (entry.status === 'skipped') return isPhantomRow(row) || isZeroAmountLine(row) || transferEvidence(row) ? 'same' : 'skipped-then-a-transaction';
    if (entry.status === 'review') return compareMoney(moneyOf((await readReview())?.row), now);
    return 'unknown-status';
}

export async function settleStatement({ db, uid, sourceRef, leaseToken, rows, decisions, now = Date.now(), cursor = 0, totalRows, bank = '', last4 = '', statementType = '', cardRegistry = {}, mailRef = null, vaultRef = null, vaultSavedAt = 0, vaultExpected = false }) {
    if (!db || !uid || !sourceRef?.path || !leaseToken || !Array.isArray(rows) || rows.length > 30 || !rows.length || !Array.isArray(decisions) || decisions.length !== rows.length || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(totalRows) || totalRows < cursor + rows.length || !Number.isSafeInteger(now)) throw new Error('invalid-settlement-request');
    const userRef = db.collection('users').doc(uid);
    const ledgerRefs = rows.map((_, index) => userRef.collection('statementLedger').doc(sourceOccurrenceId(sourceRef.path, cursor + index)));
    const reviewRefs = ledgerRefs.map(ref => userRef.collection('statementReview').doc(ref.id));
    
    return db.runTransaction(async tx => {
        const sourceSnap = await tx.get(sourceRef);
        const source = sourceSnap.data() || {};
        if (!sourceSnap.exists || source.uid !== uid || source.leaseToken !== leaseToken || !Number.isFinite(source.leaseUntil) || source.leaseUntil <= now || (source.cursor || 0) !== cursor) throw new Error('statement-lease-lost');
        if (mailRef) {
            const mailSnap = await tx.get(mailRef), mail = mailSnap.data() || {};
            if (!mailSnap.exists || mail.uid !== uid || mail.autonomous !== true) throw new Error('autonomous-mailbox-disabled-during-processing');
        }
        if (vaultRef) {
            const vaultSnap = await tx.get(vaultRef);
            const currentSavedAt = vaultSnap.exists ? Number(vaultSnap.data()?.savedAt) || 0 : 0;
            if (vaultSnap.exists !== vaultExpected || currentSavedAt !== vaultSavedAt) throw new Error('statement-vault-changed-during-processing');
        }
        
        const userSnap = await tx.get(userRef);
        const ledgerSnaps = [];
        for (const ref of ledgerRefs) ledgerSnaps.push(await tx.get(ref));
        const user = structuredClone(userSnap.data() || {});
        const changes = {};
        const allRecords = ['expenses', 'incomeRecv', 'cconetime', 'ccinstall', 'ccPayments'].flatMap(key => Array.isArray(user[key]) ? user[key] : []);
        const cards = [...(Array.isArray(user.cconetime) ? user.cconetime : []), ...(Array.isArray(user.ccPayments) ? user.ccPayments : [])].filter(record => record && (record.card_last4 || record.bank));
        const outcome = { filed: 0, duplicates: 0, skipped: 0, review: 0, dateShifted: 0, cursor: cursor + rows.length };
        const writes = [];
        
        for (let offset = 0; offset < rows.length; offset++) {
            const row = rows[offset];
            const index = cursor + offset, id = ledgerRefs[offset].id;
            // A consolidated statement carries several accounts: a row knows which one it belongs to.
            const rowLast4 = String(row?.card_last4 || last4 || '');
            const context = { bank, last4: rowLast4, card_last4: rowLast4, statementType, cardRegistry, sourcePath: sourceRef.path, index };
            const fingerprint = hash(rowIdentity(row, context));
            if (ledgerSnaps[offset].exists && ledgerSnaps[offset].data()?.status !== 'superseded_by_layout') {
                const entry = ledgerSnaps[offset].data() || {};
                if (entry.fingerprint !== fingerprint) {
                    const verdict = await settledRowVerdict({ entry, row, user, sourcePath: sourceRef.path, index, id, at: now, readReview: async () => (await tx.get(reviewRefs[offset])).data() });
                    /* THE SAME AMOUNT, THE SAME WAY, AT THE SAME PLACE, ON ANOTHER DATE is the same row read with a different date (NTB, 2026-10-01: row 54 of 56,
                     * the only difference between two readings of one statement whose books balance to the cent). It is not filed a second time and the owner's
                     * record is not rewritten; it is counted so the log shows it. A different amount or direction is still a statement that changed. */
                    if (verdict === 'date') outcome.dateShifted++;
                    else if (verdict !== 'same') throw Object.assign(new Error('statement-cursor-or-content-changed'), { detail: { index, ledger: String(entry.status || ''), differs: verdict } });
                }
                outcome.duplicates++; continue;
            }
            // A row with no money AND no words (a month-end date and nothing else) is not on the statement at
            // all. It keeps its place in the statement's row numbering, so a replay lines up, and raises nothing.
            // Whether a statement made of nothing else is really empty is decided before it gets here.
            if (isPhantomRow(row)) {
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'skipped', module: '', reason: 'empty-line', fingerprint, settledAt: now }]);
                outcome.skipped++; continue;
            }
            // A line that moves no money ("Int.Pd 0.00") is not a transaction to file
            // or to ask the owner about: it is recorded as skipped and nothing else.
            if (isZeroAmountLine(row)) {
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'skipped', module: '', reason: 'zero-amount', fingerprint, settledAt: now }]);
                outcome.skipped++; continue;
            }
            let reason = validateSettlementRow(row, decisions[offset], context);
            let decision = decisions[offset] || {};
            let module = modules[decision.module];
            const matching = reason ? [] : crossSourceMatches(allRecords, row, context).filter(record => record.statementKey !== sourceRef.path || record.statementRow === index);
            const exact = matching.filter(record => record.statementKey === sourceRef.path && record.statementRow === index && record.direction === row.direction);
            
            if (exact.length === 1 && matching.length === 1) {
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'duplicate', fingerprint, matchedId: String(exact[0].id || ''), settledAt: now }]);
                outcome.duplicates++; continue;
            }
            if (matching.length) reason = 'ambiguous-cross-source-match';
            
            const counterpart = reason ? null : findCounterpart({ row, module, user, cards, cardRegistry });
            let subscriptionOfCard = null;
            if (counterpart && counterpart.kind === 'twin') {
                markTwin(counterpart.twin, row.date.slice(0, 7), sourceRef.path, index, now); changes[module] = user[module];
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'duplicate', module, reason: 'entered-by-hand', fingerprint, matchedId: String(counterpart.twin.r.id || ''), settledAt: now }]);
                outcome.duplicates++; continue;
            }
            if (counterpart && counterpart.kind === 'cheque') {
                counterpart.cheque.status = 'cleared'; counterpart.cheque.clearedDate = row.date; counterpart.cheque.statementKey = sourceRef.path; counterpart.cheque.statementRow = index; counterpart.cheque._ut = now;
                changes.cheques = user.cheques;
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'filed', module: 'cheque', reason: 'clears-an-issued-cheque', fingerprint, settledAt: now }]);
                outcome.filed++; continue;
            }
            if (counterpart && counterpart.kind === 'plan') {
                applyPlanPayment(counterpart.plan, row, sourceRef.path, index, now); changes.ccinstall = user.ccinstall;
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'duplicate', module: 'ccinstall', reason: 'counted-by-installment-plan', fingerprint, matchedId: String(counterpart.plan.id || ''), settledAt: now }]);
                outcome.duplicates++; continue;
            }
            if (counterpart && counterpart.kind === 'card-settlement') { module = 'skip'; decision = { ...decision, module: 'skip', category: 'Card Payment' }; }
            if (counterpart && counterpart.kind === 'subscription') {
                if (module === 'expenses') { module = 'subscriptions'; decision = { ...decision, module: 'subscriptions', allocationId: counterpart.sub.id }; }
                else subscriptionOfCard = counterpart.sub;
            }
            
            if (!reason && module === 'skip') {
                outcome.skipped++;
            } else if (!reason && module === 'subscriptions') {
                const subs = user.subscriptions;
                const subMatches = Array.isArray(subs) ? subs.filter(sub => sub.id === decision.allocationId) : [];
                if (subMatches.length !== 1) reason = 'subscription-allocation-required';
                else {
                    reason = applySubscriptionPayment(subMatches[0], row, sourceRef.path, index, bank, last4, now);
                    if (!reason) changes.subscriptions = subs;
                }
            } else if (!reason) {
                if (user[module] != null && !Array.isArray(user[module])) reason = 'invalid-ledger-schema';
                else {
                    user[module] = user[module] || [];
                    const record = makeRecord(row, decision, context, id, now);
                    user[module].push(record); allRecords.push(record); changes[module] = user[module];
                    if (module === 'expenses' && linkInstallment(user.loans, user.expenses, record, now)) changes.loans = user.loans;
                    // a card charge for a subscription the owner tracks stays a card charge (what is owed to the card), and says which subscription counts it
                    if (subscriptionOfCard && module === 'cconetime' && !applySubscriptionPayment(subscriptionOfCard, row, sourceRef.path, index, bank, last4, now)) { record.subscriptionLink = subscriptionOfCard.id; changes.subscriptions = user.subscriptions; }
                }
            }
            if (reason) {
                outcome.review++;
                writes.push([reviewRefs[offset], {
                    uid, sourcePath: sourceRef.path, index, status: 'pending', reason,
                    row: JSON.parse(JSON.stringify(row)), decision: JSON.parse(JSON.stringify(decision)),
                    bank: String(bank || source.bank || ''), filename: String(source.filename || ''),
                    subject: String(source.subject || ''), receivedMs: Number(source.receivedMs) || 0,
                    from: String(source.from || ''), last4: String(last4 || source.last4 || ''), createdAt: now,
                }]);
            } else if (module !== 'skip') outcome.filed++;
            
            writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: reason ? 'review' : module === 'skip' ? 'skipped' : 'filed', module: module || '', fingerprint: hash(rowIdentity(row, context)), settledAt: now }]);
        }
        
        const hasReview = source.hasReview === true || outcome.review > 0;
        const final = outcome.cursor === totalRows;
        
        if (Object.keys(changes).length) tx.set(userRef, {
            ...changes,
            _lastModified: new Date(now),
            _lastModifiedBy: 'statement-worker',
            _writeDeviceId: 'statement-worker',
            _writeTs: now,
        }, { merge: true });
        
        for (const [ref, data] of writes) tx.set(ref, data);
        tx.set(sourceRef, { cursor: outcome.cursor, totalRows, hasReview, bank, last4, statementType, filed: final && !hasReview, status: final ? (hasReview ? 'needs_review' : 'filed') : 'pending', leaseToken: '', leaseUntil: 0,
            // A slice that settled is progress, and "five failures IN A ROW" (statement-queue.mjs) means in a row: failures were counted on the
            // statement for its whole life, so a long statement (ten slices, a provider hiccup in each of five of them) was parked as
            // dead-letter and then put in front of the owner as "retries exhausted" though it had been filing all along.
            retryCount: 0, retryAt: 0, updatedAt: now }, { merge: true });
        
        return { ...outcome, status: final ? (hasReview ? 'needs_review' : 'filed') : 'pending' };
    });
}

export async function resolveReview({ db, uid, id, decision, row, now = Date.now() }) {
    if (!uid || !/^[a-f\d]{64}$/.test(id || '') || !decision || !Number.isSafeInteger(now)) throw new Error('invalid-review-request');
    const userRef = db.collection('users').doc(uid), reviewRef = userRef.collection('statementReview').doc(id), ledgerRef = userRef.collection('statementLedger').doc(id);
    return db.runTransaction(async tx => {
        const reviewSnap = await tx.get(reviewRef), review = reviewSnap.data();
        if (!reviewSnap.exists || review.uid !== uid) throw new Error('review-not-found');
        if (review.status !== 'pending') return { ok: true, resolved: true, alreadyResolved: true };
        if (!/^wf-mail\/[a-z0-9_]+\/items\/[A-Za-z0-9._-]+$/.test(review.sourcePath || '')) throw new Error('invalid-review-source');
        const sourceRef = db.doc(review.sourcePath);
        const sourceSnap = await tx.get(sourceRef), source = sourceSnap.data();
        if (!sourceSnap.exists || source.uid !== uid) throw new Error('review-source-owner-mismatch');
        const userSnap = await tx.get(userRef);
        const ledgerSnap = await tx.get(ledgerRef);
        const siblings = await tx.get(userRef.collection('statementReview').where('sourcePath', '==', review.sourcePath));
        const dismissed = decision.module === 'skip';
        const changes = {};
        if (!dismissed) {
            if (review.index < 0 || !ledgerSnap.exists || ledgerSnap.data().status !== 'review') throw new Error('whole-statement-review-requires-layout');
            const corrected = { ...review.row, ...row, description: row?.description || review.row?.description || review.row?.narration, directionSource: 'marker', needsReview: false, valid: true };
            const verified = { ...decision, verified: true };
            const resolvedLast4 = source.last4 || review.row?.card_last4 || review.row?._ccLast4 || '';
            const context = { bank: source.bank || review.row?.bank || '', last4: resolvedLast4, card_last4: resolvedLast4, statementType: source.statementType || '', cardRegistry: (userSnap.data() || {}).settings?.cardRegistry || {}, sourcePath: review.sourcePath, index: review.index };
            const reason = validateSettlementRow(corrected, verified, context);
            if (reason) throw new Error(reason);
            const module = modules[decision.module];
            const user = userSnap.data() || {};
            const records = ['expenses', 'incomeRecv', 'cconetime', 'ccPayments'].flatMap(key => Array.isArray(user[key]) ? user[key] : []);
            if (crossSourceMatches(records, corrected, context).length) throw new Error('matching-existing-entry-dismiss-or-edit');
            if (user[module] != null && !Array.isArray(user[module])) throw new Error('invalid-ledger-schema');
            if (module === 'subscriptions') {
                const subs = structuredClone(user.subscriptions || []);
                const candidates = subs.filter(sub => sub.id === decision.allocationId);
                if (candidates.length !== 1 || (candidates[0].history != null && !Array.isArray(candidates[0].history))) throw new Error('subscription-review-allocation-required');
                const sub = candidates[0], month = corrected.date.slice(0, 7);
                if ((sub.history || []).some(payment => payment.date === corrected.date && amountCents(payment.amount) === amountCents(corrected.amount))) throw new Error('matching-existing-entry-dismiss-or-edit');
                sub.history = [...(sub.history || []), { date: corrected.date, month, amount: corrected.amount, source: 'statement', statementKey: context.sourcePath, statementRow: context.index, bank: context.bank, card_last4: context.last4, ref: String(corrected.ref || '') }];
                sub.monthOverrides = { ...(sub.monthOverrides || {}), [month]: corrected.amount }; sub.amount = corrected.amount; sub._ut = now; changes.subscriptions = subs;
            } else {
                const record = makeRecord(corrected, verified, context, id, now);
                changes[module] = [...(user[module] || []), record];
                if (module === 'expenses' && Array.isArray(user.loans)) { const loans = structuredClone(user.loans); if (linkInstallment(loans, changes.expenses, record, now)) changes.loans = loans; }
            }
        }
        const unresolved = siblings.docs.some(doc => doc.id !== id && doc.data().status === 'pending');
        const complete = Number.isSafeInteger(source.totalRows) && source.cursor === source.totalRows;
        if (Object.keys(changes).length) tx.set(userRef, {
            ...changes,
            _lastModified: new Date(now),
            _lastModifiedBy: 'statement-worker',
            _writeDeviceId: 'statement-worker',
            _writeTs: now,
        }, { merge: true });
        tx.set(reviewRef, { status: dismissed ? 'dismissed' : 'resolved', reason: '', resolvedAt: now, resolvedBy: uid }, { merge: true });
        if (ledgerSnap.exists) tx.set(ledgerRef, { status: dismissed ? 'dismissed' : 'filed', resolvedAt: now, resolvedBy: uid }, { merge: true });
        if (complete && !unresolved) tx.set(sourceRef, { status: 'filed', filed: true, hasReview: false, updatedAt: now }, { merge: true });
        else if (dismissed && review.index < 0 && !unresolved) tx.set(sourceRef, { status: 'dismissed', filed: false, hasReview: false, updatedAt: now }, { merge: true });
        return { ok: true, resolved: true, dismissed, filed: complete && !unresolved };
    });
}
