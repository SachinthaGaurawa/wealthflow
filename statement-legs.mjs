/* =============================================================================
 * statement-legs.mjs — the other leg of a payment between the owner's own accounts is not spending
 * -----------------------------------------------------------------------------
 * Production, 2026-10-02 (`statement-twins` `legs`): two pairs a statement of one bank filed as spending (or income) and a statement of another bank filed on its other side — NTB>DFCC and
 * DFCC>AMEX. The owner's own money moving between the owner's own accounts is counted twice: once leaving one account and once arriving in the other, or, for a credit card, once as the bank
 * debit and again as the purchases the card statement already counts. The rules that catch it at filing time need the narration to say so (the card's masked number, "own account", the owner's
 * name); a transfer worded "CEFT TRANSFER 0741234567" says nothing, and was filed as an expense (statement-transfers.mjs: only the masked shape counts as a number).
 *
 * What the OTHER statement says is the evidence the narration lacks. Two cases, both on the books' own records and nothing else:
 *   card   a debit worded as a transfer, in the books as spending, and a credit on one of the owner's CARD statements for exactly the same amount to the cent, from a day before to four days
 *          after it (a card posts a payment after the bank debits it). The card statement says the money arrived; the bank debit is where it came from. The debit goes; the card's payment stays.
 *   bank   a debit worded as a transfer and a credit worded as a transfer, for exactly the same amount to the cent, within two days, on statements of two DIFFERENT banks. Both legs go.
 * Never on a coincidence: a debit or credit that more than one record could be the other leg of is left alone, a refund / reversal on a card is not a payment, a record the owner has touched, one
 * tied to a loan or a subscription, and one that did not come from a statement are never taken out, and two legs on one bank (the same consolidated statement is pairedTransfers' business) are left.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { transferEvidence } from './statement-ledger.mjs';
import { bankKeyOf } from './statement-coverage.mjs';
import { touched } from './statement-copies.mjs';

/** A card posts the owner's payment from a day before (a date read the other way round) to four days after the bank debited it (a weekend and a bank holiday); two banks settle a transfer within two. */
export const CARD_BEFORE_DAYS = 1, CARD_AFTER_DAYS = 4, BANK_DAYS = 2;

const cents = value => Math.round(Math.abs(Number(value)) * 100);
const textOf = record => String((record && (record.desc || record.name)) || '');
const dayOf = date => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : NaN; };
/** A credit on a card that is money coming BACK from a shop, not the owner paying the card. */
const GIVEN_BACK = /\b(?:refund(?:ed)?|revers(?:al|ed)|return(?:ed)?|cash\s*back|rebate|waiver|adjust(?:ment)?|reward|charge\s*back)\b/i;

/** A record the statement worker filed, that nothing ties to a loan or a subscription and the owner has not edited. */
const system = record => !!record && record.source === 'statement' && !!record.statementKey && Number(record.amount) > 0 && !record.loanLink && !record.subscriptionLink && !touched(record);
const asTransfer = record => transferEvidence({ description: textOf(record) });

/**
 * @param {object} user the owner's document
 * @returns {{remove: {store:string, record:object, partner:object, kind:'card'|'bank'}[], pairs:number, left:number}} `left`: debits with more than one possible other leg, or a leg two debits claim
 */
export function ownMoneyLegs(user) {
    const list = key => (Array.isArray(user && user[key]) ? user[key] : []);
    const debits = list('expenses').filter(record => system(record) && record.direction !== 'credit' && asTransfer(record));
    const cardCredits = list('ccPayments').filter(record => system(record) && !GIVEN_BACK.test(textOf(record)));
    const bankCredits = list('incomeRecv').filter(record => system(record) && asTransfer(record));
    const fits = [];                                                                       // every (debit, credit) that could be one payment
    for (const debit of debits) {
        const at = dayOf(debit.date);
        if (!Number.isFinite(at)) continue;
        for (const credit of cardCredits) {
            const gap = dayOf(credit.date) - at;
            if (credit.statementKey === debit.statementKey || cents(credit.amount) !== cents(debit.amount) || !(gap >= -CARD_BEFORE_DAYS && gap <= CARD_AFTER_DAYS)) continue;
            if (debit.card_last4 && credit.card_last4 && String(debit.card_last4) === String(credit.card_last4)) continue;      // the card's own account is not the account that paid it
            fits.push({ debit, credit, kind: 'card', store: 'ccPayments' });
        }
        for (const credit of bankCredits) {
            const gap = Math.abs(dayOf(credit.date) - at);
            if (credit.statementKey === debit.statementKey || cents(credit.amount) !== cents(debit.amount) || !(gap <= BANK_DAYS)) continue;
            if (!bankKeyOf(debit.bank) || !bankKeyOf(credit.bank) || bankKeyOf(debit.bank) === bankKeyOf(credit.bank)) continue;   // two banks, or it is not this rule's business
            fits.push({ debit, credit, kind: 'bank', store: 'incomeRecv' });
        }
    }
    const byDebit = new Map(), byCredit = new Map();
    for (const fit of fits) {
        byDebit.set(fit.debit, [...(byDebit.get(fit.debit) || []), fit]);
        byCredit.set(fit.credit, [...(byCredit.get(fit.credit) || []), fit]);
    }
    const remove = []; let pairs = 0, left = 0;
    for (const [debit, mine] of byDebit) {
        if (mine.length !== 1 || byCredit.get(mine[0].credit).length !== 1) { left += 1; continue; }
        const { credit, kind, store } = mine[0];
        pairs += 1;
        remove.push({ store: 'expenses', record: debit, partner: credit, kind });
        if (kind === 'bank') remove.push({ store, record: credit, partner: debit, kind });
    }
    return { remove, pairs, left };
}

/**
 * WHY EACH LOOSE PAIR IS NOT TAKEN OUT, in counts only. `statement-twins` counts a debit and a credit of the same amount within three days on two statements, one worded as a transfer
 * (statement-transfers.mjs `legs`); the strict rule above takes out fewer. Production 2026-10-02: 2 loose pairs, 0 planned. Each loose pair is given the FIRST thing the strict rule needs that it
 * lacks, so the next step is decided from the facts: a store other than expenses for the debit, a debit not worded as a transfer, a credit not worded as one, one bank, one account, a refund, an
 * edit by the owner, a loan or subscription tie, a day outside the window (signed: credit minus debit), another record that could be the leg ('ambiguous'), or 'would-take-out'.
 * @returns {{pairs:number, reasons:Object<string,number>}}
 */
export function looseLegsWhy(user) {
    const list = key => (Array.isArray(user && user[key]) ? user[key] : []).filter(record => record && record.statementKey && Number(record.amount) > 0);
    const debits = [...list('expenses').map(record => ({ record, store: 'expenses' })), ...list('cconetime').map(record => ({ record, store: 'cconetime' }))].filter(({ record }) => record.direction !== 'credit');
    const credits = [...list('incomeRecv').map(record => ({ record, store: 'incomeRecv' })), ...list('ccPayments').map(record => ({ record, store: 'ccPayments' }))];
    const strict = ownMoneyLegs(user), planned = new Set(strict.remove.map(entry => entry.record));
    const reasons = {}; let pairs = 0;
    for (const out of debits) {
        for (const into of credits) {
            const gap = dayOf(into.record.date) - dayOf(out.record.date);
            if (into.record.statementKey === out.record.statementKey || cents(into.record.amount) !== cents(out.record.amount) || !(Math.abs(gap) <= 3)) continue;
            if (!asTransfer(out.record) && !asTransfer(into.record)) continue;                      // not a loose pair at all
            pairs += 1;
            const card = into.store === 'ccPayments', limit = card ? [-CARD_BEFORE_DAYS, CARD_AFTER_DAYS] : [-BANK_DAYS, BANK_DAYS];
            let why = 'would-take-out';
            if (out.store !== 'expenses') why = `debit-in-${out.store}`;
            else if (!asTransfer(out.record)) why = 'debit-not-worded-as-transfer';
            else if (!card && !asTransfer(into.record)) why = 'credit-not-worded-as-transfer';
            else if (card && GIVEN_BACK.test(textOf(into.record))) why = 'card-credit-is-a-refund';
            else if (!card && (!bankKeyOf(out.record.bank) || bankKeyOf(out.record.bank) === bankKeyOf(into.record.bank))) why = 'same-bank-or-unknown';
            else if (out.record.card_last4 && into.record.card_last4 && String(out.record.card_last4) === String(into.record.card_last4)) why = 'same-account';
            else if (out.record.source !== 'statement' || into.record.source !== 'statement') why = 'not-from-a-statement';
            else if (touched(out.record) || touched(into.record)) why = 'edited-by-the-owner';
            else if (out.record.loanLink || out.record.subscriptionLink || into.record.loanLink || into.record.subscriptionLink) why = 'tied-to-a-loan-or-subscription';
            else if (!(gap >= limit[0] && gap <= limit[1])) why = `day-gap-${gap > 0 ? '+' : ''}${gap}`;
            else if (!planned.has(out.record)) why = 'ambiguous';
            const key = `${card ? 'card' : 'bank'}:${why}`;
            reasons[key] = (reasons[key] || 0) + 1;
        }
    }
    return { pairs, reasons };
}

export default { ownMoneyLegs, looseLegsWhy, CARD_BEFORE_DAYS, CARD_AFTER_DAYS, BANK_DAYS };
