/* =============================================================================
 * bank-reach.mjs — the other registered domains of a bank the owner approved an address of (recognised, never taken)
 * -----------------------------------------------------------------------------
 * A bank is the owner's when they approved an address of it. The institutions registry (wealthflow-institutions.js) holds every domain the bank writes from; mail from one of them is
 * RECOGNISED as that bank writing from another desk — so the owner is asked the right question (a new address at a bank you approved: add it?) — but NOTHING is taken on it. Only an exact
 * address on the owner's Senders list brings a statement in (the owner's rule, after a bank staff member's address was taken on the strength of a subject): the history audit therefore
 * lists the approved addresses' domains only, and the other registered domains are not searched at all.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

import { institutionFor, BANK_DOMAINS } from './wealthflow-institutions.js';
import { addressOf, domainOf, isUnder } from './wealthflow-mail-ingest.mjs';
import { normalizeList, policyFrom, approvedDomainClauses } from './wealthflow-mail-senders.mjs';
import { bankNamesMatch } from './wealthflow-accounts.js';

const lower = (v) => String(v == null ? '' : v).toLowerCase().trim();
const approvedAddresses = (list) => normalizeList(list).filter((e) => e.status === 'approved' && e.kind === 'address' && e.id);

/** The same bank? By the registry's own identity first (so "HNB" is "Hatton National Bank (HNB)"), by the name matcher after. */
function sameBank(a, b) {
    const x = institutionFor(a), y = institutionFor(b);
    return x && y ? x.id === y.id || (x.mailName && x.mailName === y.mailName) : bankNamesMatch(a, b);
}

/** The registry domains of every bank the owner has an approved address for, minus the domains already searched. */
export function reachDomains(entries) {
    const searched = new Set(approvedAddresses(entries).map((e) => lower(e.domain)).filter(Boolean));
    const out = new Set();
    for (const e of approvedAddresses(entries)) {
        for (const b of BANK_DOMAINS) if (sameBank(e.name, b.name) && !searched.has(b.domain)) out.add(b.domain);
    }
    return [...out].sort();
}
export const reachClauses = (entries) => reachDomains(entries).map((d) => `from:${d}`);

/** `from` is a registered domain of a bank the owner approved an address for: that bank, writing from another of its desks. Otherwise null. */
export function institutionRelation(entries, from) {
    const domain = domainOf(from), address = addressOf(from);
    if (!domain) return null;
    const bank = BANK_DOMAINS.find((b) => isUnder(domain, b.domain));
    if (!bank) return null;
    for (const e of approvedAddresses(entries)) {
        if (e.id !== address && sameBank(e.name, bank.name)) return { approvedAddress: e.id, domain, name: e.name || bank.name, address, via: 'institution' };
    }
    return null;
}

/** The intake policy, with the same bank's other registered domains recognised as that bank's other desks. */
export function policyWithReach(list) {
    const policy = policyFrom(list), entries = normalizeList(list);
    return { ...policy, related: (from) => policy.related(from) || institutionRelation(entries, from) };
}
/** What the history audit asks Gmail for: the domains of the addresses the owner approved. The same banks' other registered domains are not searched: nothing from them would be taken. */
export function auditQuery(list) {
    return [...new Set(approvedDomainClauses(list))].sort();
}

export default { reachDomains, reachClauses, institutionRelation, policyWithReach, auditQuery };
