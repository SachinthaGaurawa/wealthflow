/* WHICH OF THE OWNER'S ACCOUNTS IS THIS STATEMENT? — Settings > Cards and accounts is the answer (settings.cardRegistry, keyed by the last four digits).
 *
 * A statement that arrives by email says what it is in two ways: its own words (the reader recognises a card statement from the header) and the last four digits it names. The first is
 * not always there (a layout with no header words reads as no type at all), and then the whole statement was filed by the router's guesses — a card's purchases refused with
 * "routed as a card charge, but the statement does not support that" because the registry's bank ("HNB") and the mailbox's label ("Hnb Cards") were compared letter for letter.
 *
 * This looks the statement's account up in Cards and accounts ONCE, before a row is read, and says what it found — in a word the log can carry and no figure:
 *   registered     the digits are in Cards and accounts and the bank agrees (as an institution, not as a spelling) -> the registry's type is the statement's type when the reader gave none
 *   other-bank     the digits are registered, but to another bank: a different card that ends the same; the registry says nothing about this statement
 *   unregistered   the digits are not in Cards and accounts: the statement is filed by what its own words say, and the owner can add the card
 *   no-digits      the statement names no account: nothing to look up
 * Pure: no clock, no network, no storage. */
import { bankAgrees, textNamesBank } from './wealthflow-institutions.js';

const TYPES = new Set(['credit_card', 'bank_account']);
const typeOf = value => {
    const t = String(value ?? '').toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '');
    if (t === 'credit_card' || t === 'creditcard') return 'credit_card';
    if (t === 'bank_account' || t === 'savings' || t === 'current' || t === 'bank') return 'bank_account';
    return '';
};

/**
 * @param registry  settings.cardRegistry  { [last4]: { type, bank, name } }
 * @param last4     the statement's own account digits ('' when it names none)
 * @param bank      the label the statement carries (the approved sender's name, or one made from its domain)
 * @param text      the statement's text (only its opening is read, to see whether it names the registered bank itself)
 * @param parsedType  what the reader concluded from the document's own words ('credit-card', '' …)
 * @returns {{ state: 'registered'|'other-bank'|'unregistered'|'no-digits', statementType: string, entry: object|null, via: string, conflict: boolean }}
 */
export function identifyAccount({ registry, last4, bank, text, parsedType } = {}) {
    const given = String(parsedType ?? '').trim(), read = typeOf(given);
    const tail = /^\d{4}$/.test(String(last4 || '')) ? String(last4) : '';
    const keep = (state, entry, extra = {}) => ({ state, entry, statementType: given, via: given ? 'document' : '', conflict: false, ...extra });
    if (!tail) return keep('no-digits', null);
    const reg = registry && typeof registry === 'object' ? registry : {};
    const entry = Object.prototype.hasOwnProperty.call(reg, tail) && reg[tail] && typeof reg[tail] === 'object' ? reg[tail] : null;
    if (!entry) return keep('unregistered', null);
    if (!bankAgrees(entry.bank, bank) && !textNamesBank(text, entry.bank)) return keep('other-bank', entry);
    const kind = TYPES.has(entry.type) ? entry.type : typeOf(entry.type);
    if (!kind) return keep('registered', entry);
    // the document's own words win over a registry entry when they disagree (the reader saw the header), but the disagreement is said
    return given ? keep('registered', entry, { conflict: !!read && read !== kind }) : { state: 'registered', entry, statementType: kind, via: 'registry', conflict: false };
}
