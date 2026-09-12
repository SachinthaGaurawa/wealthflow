import { createHash } from 'node:crypto';
import { isStrictCalendarDate } from './otp-recovery.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const modules = { expenses: 'expenses', income: 'incomeRecv', incomeRecv: 'incomeRecv', cconetime: 'cconetime', cc_payment: 'ccPayments', ccPayments: 'ccPayments', subscription: 'subscriptions', subscriptions: 'subscriptions' };

export function amountCents(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    const cents = Math.round(value * 100);
    return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000001 ? cents : null;
}

export function rowIdentity(row, { bank = '', last4 = '' } = {}) {
    return [row.date, amountCents(row.amount), norm(row.description || row.narration || row.desc || row.name),
        norm(row.bank || row._bank || bank), String(row.card_last4 || row._ccLast4 || last4),
        norm(row.ref), row.direction || ''];
}

export function sourceOccurrenceId(sourcePath, absoluteIndex) {
    return hash(['statement-occurrence-v1', sourcePath, absoluteIndex]);
}

export function validateSettlementRow(row, decision, { statementType = '' } = {}) {
    if (!row || !isStrictCalendarDate(row.date) || !amountCents(row.amount) || !norm(row.description || row.narration)) return 'invalid-transaction';
    if (row.needsReview !== false || row.valid === false || !['balance', 'marker', 'column', 'sign'].includes(row.directionSource) || !['debit', 'credit'].includes(row.direction)) return 'unproven-direction';
    if (!decision || decision.verified !== true || !modules[decision.module] || !norm(decision.category)) return decision?.reason || 'unanimous-decision-required';
    const module = modules[decision.module];
    const card = /credit.?card|amex|card/i.test(statementType);
    if (module === 'incomeRecv' && (row.direction !== 'credit' || card)) return 'income-direction-conflict';
    if (module === 'ccPayments' && (row.direction !== 'credit' || !card)) return 'card-payment-context-required';
    if (['expenses', 'cconetime', 'subscriptions'].includes(module) && row.direction !== 'debit') return 'expense-direction-conflict';
    if (module === 'cconetime' && !card) return 'card-charge-context-required';
    return null;
}

// Cross-source equivalence is deliberately conservative. No narration-only fuzzy
// match may erase two legitimate purchases made on the same day.
export function crossSourceMatches(records, row, context) {
    const wanted = rowIdentity(row, context);
    return records.filter(record => {
        const actual = rowIdentity({ ...record, amount: record.amount, description: record.desc || record.name || record.description, direction: record.direction || row.direction }, {});
        return wanted.slice(0, 6).every((value, index) => value === actual[index]);
    });
}

function makeRecord(row, decision, context, id, now) {
    const desc = String(row.description || row.narration).trim();
    const provenance = { statementKey: context.sourcePath, statementRow: context.index, bank: context.bank || '', card_last4: context.last4 || '', ref: String(row.ref || ''), direction: row.direction };
    const base = { id, ...provenance, amount: row.amount, date: row.date, source: 'statement', createdAt: new Date(now).toISOString(), _ut: now, notes: '' };
    const module = modules[decision.module];
    if (module === 'expenses') return { ...base, desc, cat: decision.category, month: row.date.slice(0, 7), recurring: false, recurringType: '0', completed: true };
    if (module === 'incomeRecv') return { ...base, name: desc, type: decision.category, month: row.date.slice(0, 7), received: true };
    if (module === 'ccPayments') return { ...base, desc };
    const deadline = new Date(row.date + 'T00:00:00Z'); deadline.setUTCDate(deadline.getUTCDate() + 50);
    return { ...base, desc, type: row.type || 'purchase', serviceFee: 0, feeMeta: { source: 'statement' }, combinedTotal: row.amount, deadline: deadline.toISOString().slice(0, 10), paid: false };
}

/** All reads precede writes; Firestore retries serialize concurrent settlement. */
export async function settleStatement({ db, uid, sourceRef, leaseToken, rows, decisions, now = Date.now(), cursor = 0, totalRows, bank = '', last4 = '', statementType = '' }) {
    if (!db || !uid || !sourceRef?.path || !leaseToken || !Array.isArray(rows) || rows.length > 30 || !rows.length || !Array.isArray(decisions) || decisions.length !== rows.length || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(totalRows) || totalRows < cursor + rows.length || !Number.isSafeInteger(now)) throw new Error('invalid-settlement-request');
    const userRef = db.collection('users').doc(uid);
    const ledgerRefs = rows.map((_, index) => userRef.collection('statementLedger').doc(sourceOccurrenceId(sourceRef.path, cursor + index)));
    const reviewRefs = ledgerRefs.map(ref => userRef.collection('statementReview').doc(ref.id));
    return db.runTransaction(async tx => {
        const sourceSnap = await tx.get(sourceRef);
        const source = sourceSnap.data() || {};
        if (!sourceSnap.exists || source.uid !== uid || source.leaseToken !== leaseToken || !Number.isFinite(source.leaseUntil) || source.leaseUntil <= now || (source.cursor || 0) !== cursor) throw new Error('statement-lease-lost');
        const userSnap = await tx.get(userRef);
        const ledgerSnaps = [];
        for (const ref of ledgerRefs) ledgerSnaps.push(await tx.get(ref));
        const user = structuredClone(userSnap.data() || {});
        const changes = {};
        const allRecords = ['expenses', 'incomeRecv', 'cconetime', 'ccPayments'].flatMap(key => Array.isArray(user[key]) ? user[key] : []);
        const outcome = { filed: 0, duplicates: 0, review: 0, cursor: cursor + rows.length };
        const writes = [];
        rows.forEach((row, offset) => {
            if (ledgerSnaps[offset].exists) { outcome.duplicates++; return; }
            const index = cursor + offset, id = ledgerRefs[offset].id;
            const context = { bank, last4, statementType, sourcePath: sourceRef.path, index };
            let reason = validateSettlementRow(row, decisions[offset], context);
            const decision = decisions[offset] || {};
            const module = modules[decision.module];
            const matching = reason ? [] : crossSourceMatches(allRecords, row, context).filter(record => record.statementKey !== sourceRef.path || record.statementRow === index);
            // Existing exact occurrence from manual statement filing is safe to
            // acknowledge; different occurrences and missing refs are ambiguous.
            const exact = matching.filter(record => record.statementKey === sourceRef.path && record.statementRow === index && record.direction === row.direction);
            // Even a matching bank ref can recur (batch/payment references). A
            // cross-source alias needs occurrence mapping by the review user.
            if (exact.length === 1 && matching.length === 1) {
                writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'duplicate', matchedId: String(exact[0].id || ''), settledAt: now }]);
                outcome.duplicates++; return;
            }
            if (matching.length) reason = 'ambiguous-cross-source-match';
            if (!reason && module === 'subscriptions') {
                const subs = user.subscriptions;
                const subMatches = Array.isArray(subs) ? subs.filter(sub => sub.id === decision.allocationId) : [];
                if (subMatches.length !== 1) reason = 'subscription-allocation-required';
                else {
                    const sub = subMatches[0];
                    if (sub.history != null && !Array.isArray(sub.history)) reason = 'invalid-subscription-schema';
                    else if ((sub.history || []).some(payment => payment.date === row.date && amountCents(payment.amount) === amountCents(row.amount))) reason = 'ambiguous-subscription-payment';
                    else {
                        const month = row.date.slice(0, 7);
                        sub.history = sub.history || [];
                        sub.history.push({ month, amount: row.amount, date: row.date, source: 'statement', statementKey: sourceRef.path, statementRow: index, ref: String(row.ref || ''), bank, card_last4: last4 });
                        sub.monthOverrides = { ...(sub.monthOverrides || {}), [month]: row.amount };
                        sub.amount = row.amount;
                        sub._ut = now;
                        changes.subscriptions = subs;
                    }
                }
            } else if (!reason) {
                if (user[module] != null && !Array.isArray(user[module])) reason = 'invalid-ledger-schema';
                else {
                    user[module] = user[module] || [];
                    const record = makeRecord(row, decision, context, id, now);
                    user[module].push(record); allRecords.push(record); changes[module] = user[module];
                }
            }
            if (reason) {
                outcome.review++;
                writes.push([reviewRefs[offset], { uid, sourcePath: sourceRef.path, index, status: 'pending', reason, row: JSON.parse(JSON.stringify(row)), decision: JSON.parse(JSON.stringify(decision)), createdAt: now }]);
            } else outcome.filed++;
            writes.push([ledgerRefs[offset], { uid, sourcePath: sourceRef.path, index, status: reason ? 'review' : 'filed', module: module || '', fingerprint: hash(rowIdentity(row, context)), settledAt: now }]);
        });
        const hasReview = source.hasReview === true || outcome.review > 0;
        const final = outcome.cursor === totalRows;
        if (Object.keys(changes).length) tx.set(userRef, { ...changes, _lastModified: new Date(now) }, { merge: true });
        for (const [ref, data] of writes) tx.set(ref, data);
        tx.set(sourceRef, { cursor: outcome.cursor, totalRows, hasReview, bank, last4, statementType, filed: final && !hasReview, status: final ? (hasReview ? 'needs_review' : 'filed') : 'pending', leaseToken: '', leaseUntil: 0, updatedAt: now }, { merge: true });
        return { ...outcome, status: final ? (hasReview ? 'needs_review' : 'filed') : 'pending' };
    });
}

/** Authenticated owner action only; the caller must verify Firebase identity. */
export async function resolveReview({ db, uid, id, decision, row, now = Date.now() }) {
    if (!uid || !/^[a-f\d]{64}$/.test(id || '') || !decision || !Number.isSafeInteger(now)) throw new Error('invalid-review-request');
    const userRef = db.collection('users').doc(uid), reviewRef = userRef.collection('statementReview').doc(id), ledgerRef = userRef.collection('statementLedger').doc(id);
    return db.runTransaction(async tx => {
        const reviewSnap = await tx.get(reviewRef), review = reviewSnap.data();
        if (!reviewSnap.exists || review.uid !== uid) throw new Error('review-not-found');
        if (review.status !== 'pending') return { ok: true, resolved: true, alreadyResolved: true };
        if (!/^wf-mail\/[a-z0-9_]+\/items\/[\w-]+$/.test(review.sourcePath || '')) throw new Error('invalid-review-source');
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
            const context = { bank: source.bank || review.row?.bank || '', last4: source.last4 || review.row?.card_last4 || review.row?._ccLast4 || '', statementType: source.statementType || '' , sourcePath: review.sourcePath, index: review.index };
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
                sub.monthOverrides = { ...(sub.monthOverrides || {}), [month]: corrected.amount }; sub.amount = corrected.amount; sub._ut = now;
                changes.subscriptions = subs;
            } else changes[module] = [...(user[module] || []), makeRecord(corrected, verified, context, id, now)];
        }
        const unresolved = siblings.docs.some(doc => doc.id !== id && doc.data().status === 'pending');
        const complete = Number.isSafeInteger(source.totalRows) && source.cursor === source.totalRows;
        if (Object.keys(changes).length) tx.set(userRef, { ...changes, _lastModified: new Date(now) }, { merge: true });
        tx.set(reviewRef, { status: dismissed ? 'dismissed' : 'resolved', resolvedAt: now, resolvedBy: uid }, { merge: true });
        if (ledgerSnap.exists) tx.set(ledgerRef, { status: dismissed ? 'dismissed' : 'filed', resolvedAt: now, resolvedBy: uid }, { merge: true });
        if (complete && !unresolved) tx.set(sourceRef, { status: 'filed', filed: true, hasReview: false, updatedAt: now }, { merge: true });
        else if (dismissed && review.index < 0 && !unresolved) tx.set(sourceRef, { status: 'dismissed', filed: false, hasReview: false, updatedAt: now }, { merge: true });
        return { ok: true, resolved: true, dismissed, filed: complete && !unresolved };
    });
}
