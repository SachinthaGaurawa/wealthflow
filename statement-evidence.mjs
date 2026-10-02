/* =============================================================================
 * statement-evidence.mjs — what a mail from an unlisted address says about itself (it is never taken on that)
 * -----------------------------------------------------------------------------
 * THE RULE IS THE OWNER'S: only the addresses on the Senders list bring anything in. This file used to release a statement from an address nobody listed when the mail said statement,
 * named one of the owner's banks in its own domain and the document proved it; the owner reported a bank staff member's address (the interim statement they had asked the bank for) being taken,
 * and its rows reaching the books. Nothing is released now. What is left is the LABEL on a refusal, so the refusal is handled the right way:
 *
 *   evidence.ok === false   the mail does not even say it is a statement of one of the owner's banks (a newsletter, a course notice): refused, never held, never asked about;
 *   evidence.ok === true    it could be one: held — a reference only, nothing downloaded — so the sender can be added with one tap. The tap is the owner's.
 *
 * The same evidence is used to judge a document once the sender IS listed (`documentProof`, `knownLast4`).
 *
 * Server only: nothing here is shipped to the browser.
 * ===========================================================================*/

import { institutionFor } from './wealthflow-institutions.js';
import { planMessage, selectAttachments, bodyTextOf, domainOf, addressOf, REJECT } from './wealthflow-mail-ingest.mjs';
import { normalizeList } from './wealthflow-mail-senders.mjs';
import { intentVerdict } from './wealthflow-statement-identity.js';
import { createHash } from 'node:crypto';

const lower = (v) => String(v == null ? '' : v).toLowerCase();
/** Words of a text as the matcher sees them: letters and digits, single-spaced, padded so ' hnb ' only ever matches the word. */
export const hayOf = (text) => ' ' + lower(text).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const wordsIn = (hay, words) => words.filter((w) => hay.includes(' ' + w + ' '));

const GENERIC = new Set(['bank', 'banks', 'plc', 'ltd', 'limited', 'the', 'of', 'and', 'finance', 'card', 'credit', 'account']);

/** The words a bank is called by: the registry's tokens when it knows the bank, else the significant words of the name the owner gave it. */
export function bankWords(name) {
    const inst = institutionFor(name);
    const raw = inst ? inst.tokens : String(name || '').split(/[^A-Za-z0-9]+/).filter((w) => w.length >= 3 && !GENERIC.has(lower(w)));
    return [...new Set(raw.map((t) => lower(t).replace(/[^a-z0-9]+/g, ' ').trim()).filter((t) => t.length >= 3))];
}

/** One entry per bank the owner approved an address (or a whole domain) of: { name, approvedAddress, words }. */
export function ownerBanks(list) {
    const out = [];
    for (const e of normalizeList(list)) {
        if (e.status !== 'approved' || (e.kind !== 'address' && e.kind !== 'domain') || !e.id) continue;
        const words = bankWords(e.name);
        if (!words.length) continue;
        const key = (institutionFor(e.name) || {}).mailName || (institutionFor(e.name) || {}).id || lower(e.name);
        const same = out.find((b) => b.key === key);
        if (same) { same.words = [...new Set([...same.words, ...words])]; continue; }
        out.push({ key, name: e.name, approvedAddress: e.id, words });
    }
    return out;
}

/** `ownerEmail`: the address of the mailbox itself, so a statement the owner sent THEMSELVES (downloaded from the bank's portal and emailed to their own inbox, in bulk) is a source. */
export const evidenceContext = (list, ownerEmail = '') => ({ banks: ownerBanks(list), ownerEmail: lower(ownerEmail).trim() });

/** What the owner has approved, as one short key: a message dropped for naming none of their banks is judged again when this changes. */
export const approvalKey = (list) => createHash('sha256').update(normalizeList(list).filter((e) => e.status === 'approved').map((e) => `${e.kind}:${e.id || e.domain}`).sort().join('|')).digest('hex').slice(0, 12);

/**
 * Does this message say it is a statement of exactly one of the owner's banks? The mail has already passed the signature checks (the caller
 * only asks about a refusal that comes after them), so this decides on what it SAYS.
 * @returns {{ok:true, bank:string, approvedAddress:string, hits:object} | {ok:false, why:string}}
 */
export function evidenceVerdict(message, plan, ctx) {
    const banks = ctx && Array.isArray(ctx.banks) ? ctx.banks : [];
    if (!banks.length) return { ok: false, why: 'no-bank-approved' };
    const payload = message && message.payload;
    const headers = {};
    for (const h of (payload && payload.headers) || []) if (h && h.name) headers[lower(h.name)] = h.value;
    const files = (selectAttachments(payload).take || []).map((a) => a.filename).filter(Boolean);
    const subject = String(headers.subject || plan.subject || '');
    const intent = intentVerdict({ subject, filenames: files });
    if (intent.intent !== 'stated') return { ok: false, why: 'the-subject-and-file-names-do-not-say-statement' };
    /* A STATEMENT THE OWNER SENT TO THEMSELVES. Years of statements sit in the bank's portal, not the mailbox: the owner downloads them and mails them to their own address, one message or
     * fifty. The sender is then the mailbox's own address — authenticated by Google like any other (planCore has already refused a forgery before anything here runs: no one else can sign
     * for it) — and it carries no bank name, so the bank is the one named in the subject, the file names or the body, exactly one of the owner's, and the DOCUMENT must name that bank,
     * show one of the owner's accounts there and reconcile to the cent before a row is filed (documentProof, the worker). */
    const sender = lower(addressOf(headers.from || plan.from || '')).trim();
    const self = !!ctx.ownerEmail && sender === ctx.ownerEmail;
    // the bank's name in the sender's own domain: "hnbmail.example" carries "hnb" (compared without dots and dashes, so "nations-trust" is "nationstrust")
    const domain = lower(domainOf(headers.from || plan.from || '')).replace(/[^a-z0-9]+/g, '');
    const inDomain = self ? banks : banks.filter((b) => b.words.some((w) => domain.includes(w.replace(/ /g, ''))));
    if (!inDomain.length) return { ok: false, why: 'no-bank-name-in-the-sender-domain' };
    const primary = hayOf([subject, ...files].join(' ')), secondary = hayOf(bodyTextOf(payload).slice(0, 4000));
    const said = (hay) => inDomain.filter((b) => wordsIn(hay, b.words).length);
    let hit = said(primary), where = 'subject-or-file';
    if (!hit.length) { hit = said(secondary); where = 'body'; }
    if (!hit.length) return { ok: false, why: self ? 'the-mail-does-not-name-a-bank' : 'the-mail-does-not-name-the-bank-of-its-domain' };
    if (hit.length > 1) return { ok: false, why: 'more-than-one-bank-is-named' };
    // a mail that names a DIFFERENT bank of the owner's in its subject or file is not what its domain says it is
    const others = banks.filter((b) => b !== hit[0] && wordsIn(primary, b.words).length);
    if (others.length) return { ok: false, why: 'another-bank-is-named-in-the-subject' };
    return { ok: true, bank: hit[0].name, approvedAddress: hit[0].approvedAddress, hits: { statement: intent.hits.slice(0, 3), where, ...(self ? { self: true } : {}) } };
}

/**
 * planMessage, plus what the evidence says about a refusal. NOTHING IS RELEASED: an address that is not on the owner's Senders list brings nothing in, however well the mail and the document
 * say statement (the owner's rule, after a bank staff member's own address was taken on a subject that said so). The verdict only labels the refusal — `evidence.ok === false` is a mail that
 * does not even say it is a statement of one of the owner's banks, which is not held for a tap at all; `evidence.ok === true` is one that could be, and is held so the sender can be added.
 */
export function planWithEvidence(message, policy, ctx) {
    const plan = planMessage(message, policy);
    if (plan.ok || (plan.reason !== REJECT.NOT_ON_YOUR_LIST && plan.reason !== REJECT.SENDER_SIBLING) || !ctx || !ctx.banks || !ctx.banks.length) return plan;
    const verdict = evidenceVerdict(message, plan, ctx);
    if (!verdict.ok) return { ...plan, evidence: { ok: false, why: verdict.why } };
    return { ...plan, evidence: { ok: true, bank: verdict.bank, ...verdict.hits } };
}

/** The same bank under two labels? ("DFCC Bank" the owner wrote, "Dfccbank" a domain gave): a shared word, or one label containing the other's word. */
export function sameBank(a, b) {
    const x = bankWords(a), y = bankWords(b), la = lower(a), lb = lower(b);
    return x.some((w) => y.includes(w) || lb.includes(w)) || y.some((w) => la.includes(w));
}

/** Is the bank this evidence named still one the owner approves an address of? Revoke the bank and what was taken on its evidence is retired. */
export function bankStillOwned(list, bankName) {
    return ownerBanks(list).some((b) => sameBank(b.name, bankName));
}

/**
 * The DOCUMENT's own proof of what the mail claimed: it names the bank, and — when the owner already holds statements from that bank — one of
 * their accounts appears in it. A bank the owner has no filed statement from yet is proven by the first test and the reconciliation that follows.
 */
export function documentProof({ text, bank, known = [] }) {
    const hay = hayOf(String(text || '').slice(0, 60000));
    const words = bankWords(bank);
    if (!words.length || !wordsIn(hay, words).length) return { ok: false, reason: 'the document does not name the bank the mail said it came from' };
    const last4 = [...new Set((Array.isArray(known) ? known : []).map((v) => String(v || '').replace(/\D/g, '').slice(-4)).filter((v) => v.length === 4))];
    if (last4.length) {
        const flat = String(text || '');
        if (!last4.some((l) => new RegExp(l + '(?![0-9])').test(flat))) return { ok: false, reason: 'none of your accounts at this bank appears in the document' };
    }
    return { ok: true };
}

/** The account tails already filed from this bank, newest knowledge first, for `documentProof`. */
export function knownLast4(items, bankName) {
    const out = new Set();
    for (const item of Array.isArray(items) ? items : []) {
        if (!item || !(item.filed === true || item.status === 'filed') || !item.last4) continue;
        if (sameBank(item.bank, bankName)) out.add(String(item.last4).replace(/\D/g, '').slice(-4));
    }
    return [...out].filter((v) => v.length === 4);
}

export default { bankWords, ownerBanks, evidenceContext, approvalKey, evidenceVerdict, planWithEvidence, sameBank, bankStillOwned, documentProof, knownLast4 };
