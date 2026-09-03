/* =============================================================================
 * test/bank_coverage_test.js — the app offers fourteen banks; the fetcher knows four
 * -----------------------------------------------------------------------------
 * THE REPORT WAS: "over 10 bank accounts, only 3 or 4 syncing."
 *
 * There are two lists of Sri Lankan banks in this repository, written by
 * different hands for different purposes, and nothing has ever compared them:
 *
 *   index.html                    `BANKS` — the picker the owner chooses from
 *                                 when saving a card charge. FOURTEEN real
 *                                 institutions, plus "Other".
 *
 *   wealthflow-mail-ingest.mjs    `BANKS` — the domains a statement may arrive
 *                                 from. FOUR institutions.
 *
 * So the owner can tell the app they bank with Sampath, Seylan, BOC, Commercial,
 * NDB, Standard Chartered, People's, Pan Asia or Union — and the mail pipeline
 * has never heard of any of them. Their statements are not recognised by
 * default. Three or four sync; the rest do not, and nothing anywhere says why.
 *
 * That is the same defect this codebase keeps producing: TWO COPIES OF ONE FACT,
 * one of them incomplete, and no check between them. policy/critical-paths.regex
 * exists because the identical thing happened to the policy gate — a pattern
 * inlined in a workflow AND listed in the rego, drifted apart, and deadlocked a
 * pull request. Its header says it plainly: two copies of a classifier is one
 * more than can be kept in step.
 *
 * ── WHAT THIS FILE DOES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────
 *
 * It makes the gap VISIBLE and FIXED IN SIZE. Every institution the picker
 * offers is either covered by a default sending domain, or named below in
 * NO_DEFAULT_DOMAIN with the reason. Adding a bank to the picker without
 * deciding which side it falls on now fails a test instead of quietly
 * shipping an account that cannot sync.
 *
 * It does NOT invent the missing domains. A domain in that list is a domain the
 * pipeline will accept DKIM-signed mail from and file as the owner's bank
 * statement — it is a trust allowlist for financial documents. Nine plausible
 * guesses would be nine entries nobody verified, and one of them being wrong
 * means allowlisting a stranger. The correct sources are the owner (who can
 * read the sender address off a statement they already have) and the discovery
 * flow that already exists, which offers an unrecognised sender for approval
 * rather than accepting it. Both are safe; guessing is not.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BANKS as MAIL_BANKS, CONSUMER_MAIL } from '../wealthflow-mail-ingest.mjs';
import { senderCoverage } from '../wealthflow-mail-senders.mjs';
import { bankNamesMatch } from '../wealthflow-accounts.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** The picker list, read from the app rather than copied into this file. */
function pickerBanks() {
    const m = HTML.match(/const BANKS = \[([^\]]*)\];/);
    if (!m) return [];
    return [...m[1].matchAll(/'([^']+)'/g)]
        .map((x) => x[1])
        .filter((n) => n !== 'Other');
}

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Does the mail pipeline know a sending domain for this picker entry? */
function coveredBy(pickerName, mailBanks) {
    const p = norm(pickerName);
    return mailBanks.some((b) => {
        const n = norm(b.name);
        return n && (p.includes(n) || n.includes(p));
    });
}

/* THE GAP, PINNED. Every name here is an institution the app offers and the
 * mail pipeline has no default sending domain for. Closing one means adding a
 * VERIFIED domain to wealthflow-mail-ingest.mjs and deleting the line here.
 *
 * Until then these are not unreachable: the owner can approve the sender the
 * first time a statement from it is seen, and the approved sender is then
 * filed under the name they gave it. What they lose is the default — the bank
 * working on day one without being told about it. */
const NO_DEFAULT_DOMAIN = [
    'Bank of Ceylon (BOC)',
    'Commercial Bank',
    'National Development Bank (NDB)',
    'Pan Asia Bank',
    'Peoples Bank',
    'Sampath Bank',
    'Seylan Bank',
    'Standard Chartered',
    'Union Bank',
];

describe('the two bank lists are compared, at last', () => {
    it('finds both lists (guards against a vacuous pass)', () => {
        // A regex that stopped matching would make every assertion below pass
        // against an empty array — the silent-green failure this repo keeps
        // producing, reproduced inside the test written to prevent it.
        expect(pickerBanks().length).toBeGreaterThan(10);
        expect(MAIL_BANKS.length).toBeGreaterThan(3);
        expect(MAIL_BANKS.every((b) => b.domain && b.name)).toBe(true);
    });

    it('every bank the app offers is either covered or named as uncovered', () => {
        const picker = pickerBanks();
        const unaccounted = picker.filter((n) => !coveredBy(n, MAIL_BANKS) && !NO_DEFAULT_DOMAIN.includes(n));
        expect(
            unaccounted,
            `these banks are in the picker, have no default sending domain, and are not listed in `
            + `NO_DEFAULT_DOMAIN — a card saved against one of them will never sync by default:\n  `
            + unaccounted.join('\n  '),
        ).toEqual([]);
    });

    it('nothing is listed as uncovered that is actually covered', () => {
        // The other direction. A stale entry here would hide a bank that has
        // since been given a domain, and the list would slowly become fiction.
        const stale = NO_DEFAULT_DOMAIN.filter((n) => coveredBy(n, MAIL_BANKS));
        expect(stale, `covered now — remove from NO_DEFAULT_DOMAIN: ${stale.join(', ')}`).toEqual([]);
    });

    it('nothing is listed as uncovered that the picker does not offer', () => {
        const picker = pickerBanks();
        const ghosts = NO_DEFAULT_DOMAIN.filter((n) => !picker.includes(n));
        expect(ghosts, `not in the picker — remove from NO_DEFAULT_DOMAIN: ${ghosts.join(', ')}`).toEqual([]);
    });

    it('records the size of the gap, so shrinking it is visible in a diff', () => {
        // Not a target and not a ceiling — a measurement. When a verified domain
        // is added this number goes down and the change says so out loud.
        expect(NO_DEFAULT_DOMAIN).toHaveLength(9);
        expect(pickerBanks()).toHaveLength(14);
    });
});

describe('the default domain list stays a trust allowlist, not a wish list', () => {
    it('no consumer mailbox is ever a default bank domain', () => {
        // Anyone with a Gmail account gets a valid DKIM signature for gmail.com.
        // One of these slipping into the list would let any stranger file a
        // statement into the owner's ledger.
        for (const b of MAIL_BANKS) {
            expect(CONSUMER_MAIL.has(String(b.domain).toLowerCase()), `${b.domain} is a consumer mailbox`).toBe(false);
        }
    });

    it('every default domain is a real registrable domain, not a bare name', () => {
        for (const b of MAIL_BANKS) {
            expect(b.domain, `${b.domain} has no dot in it`).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
            expect(b.domain).toBe(b.domain.toLowerCase());
        }
    });

    it('no two entries claim the same domain', () => {
        const ds = MAIL_BANKS.map((b) => b.domain);
        expect(new Set(ds).size, `duplicate domain in the allowlist: ${ds.join(', ')}`).toBe(ds.length);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE REPORT THE OWNER ACTUALLY SEES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('senderCoverage: naming the banks that cannot deliver', () => {
    it('marks a built-in bank as covered without any approval', () => {
        const c = senderCoverage(['Hatton National Bank (HNB)'], []);
        expect(c.rows[0].covered).toBe(true);
        expect(c.rows[0].source).toBe('built-in');
        expect(c.rows[0].via).toBe('hnb.lk');
        expect(c.complete).toBe(true);
    });

    it('NAMES the banks with no way in — the whole point', () => {
        const c = senderCoverage([
            'Hatton National Bank (HNB)',
            'Sampath Bank',
            'Seylan Bank',
            'Bank of Ceylon (BOC)',
        ], []);
        expect(c.covered).toBe(1);
        expect(c.of).toBe(4);
        expect(c.uncovered).toEqual(['Sampath Bank', 'Seylan Bank', 'Bank of Ceylon (BOC)']);
        expect(c.complete).toBe(false);
    });

    it('an approved sender the owner named closes the gap', () => {
        const list = [{ id: 'estatement@sampath.lk', name: 'Sampath Bank', status: 'approved', source: 'manual' }];
        const c = senderCoverage(['Sampath Bank'], list);
        expect(c.rows[0].covered).toBe(true);
        expect(c.rows[0].source).toBe('approved');
        expect(c.rows[0].via).toBe('estatement@sampath.lk');
    });

    it('a BLOCKED sender does not count as coverage', () => {
        const list = [{ id: 'promo@sampath.lk', name: 'Sampath Bank', status: 'blocked', source: 'manual' }];
        expect(senderCoverage(['Sampath Bank'], list).uncovered).toEqual(['Sampath Bank']);
    });

    it('an UNDECIDED sighting does not count as coverage either', () => {
        // A sender sitting in the discovery queue is a question, not an answer.
        const list = [{ id: 'noreply@sampath.lk', name: 'Sampath Bank', status: 'new', source: 'discovered' }];
        expect(senderCoverage(['Sampath Bank'], list).uncovered).toEqual(['Sampath Bank']);
    });

    it('matches the picker long form against a short approved name', () => {
        // The picker stores 'Hatton National Bank (HNB)'; the owner types 'HNB'.
        const list = [{ id: 'hnb.lk', name: 'HNB', status: 'approved', source: 'manual' }];
        const c = senderCoverage(['Hatton National Bank (HNB)'], list);
        expect(c.rows[0].covered).toBe(true);
    });

    it('does not report the same bank twice', () => {
        const c = senderCoverage(['Sampath Bank', 'sampath bank', 'Sampath Bank'], []);
        expect(c.of).toBe(1);
    });

    it('ignores blanks rather than reporting an empty bank as uncovered', () => {
        const c = senderCoverage(['', null, undefined, '   ', 'Seylan Bank'], []);
        expect(c.of).toBe(1);
        expect(c.uncovered).toEqual(['Seylan Bank']);
    });

    it('is honest about knowing nothing when the owner has no accounts yet', () => {
        // `complete` must not read as "all your banks are covered" when there
        // are no banks. An empty ledger is not a healthy one, it is an unknown.
        const c = senderCoverage([], []);
        expect(c.of).toBe(0);
        expect(c.complete).toBe(false);
    });

    it('never throws on a malformed sender list read back from storage', () => {
        for (const junk of [null, undefined, 'nonsense', [0], [{}], [{ id: 5 }]]) {
            expect(() => senderCoverage(['Seylan Bank'], junk)).not.toThrow();
            expect(senderCoverage(['Seylan Bank'], junk).uncovered).toEqual(['Seylan Bank']);
        }
    });

    it('THE REPORTED CASE, end to end', () => {
        // Eleven institutions from the picker; four have built-in domains, and
        // one more the owner approved by hand. Five of eleven — which is what
        // "only 3 or 4 syncing" looks like once something finally counts it.
        const owned = [
            'Hatton National Bank (HNB)', 'DFCC Bank', 'Nations Trust Bank (NTB) — AMEX',
            'American Express (AMEX)', 'Sampath Bank', 'Seylan Bank', 'Bank of Ceylon (BOC)',
            'Commercial Bank', 'Peoples Bank', 'Union Bank', 'Standard Chartered',
        ];
        const list = [{ id: 'estatements@sampath.lk', name: 'Sampath Bank', status: 'approved', source: 'manual' }];
        const c = senderCoverage(owned, list);
        expect(c.of).toBe(11);
        expect(c.covered).toBe(5);
        expect(c.uncovered).toHaveLength(6);
        expect(c.uncovered).toContain('Bank of Ceylon (BOC)');
        expect(c.uncovered).not.toContain('Sampath Bank');
    });
});

describe('one matching rule, not three copies of one', () => {
    it('bankNamesMatch connects the picker form and the short form', () => {
        expect(bankNamesMatch('Hatton National Bank (HNB)', 'HNB')).toBe(true);
        expect(bankNamesMatch('HNB', 'Hatton National Bank (HNB)')).toBe(true);
        expect(bankNamesMatch('Nations Trust Bank (NTB) — AMEX', 'Nations Trust')).toBe(true);
        expect(bankNamesMatch('Sampath Bank', 'Seylan Bank')).toBe(false);
    });

    it('an empty name matches nothing — never everything', () => {
        // Containment with the empty string is true for every string, which
        // would make one blank bank name cover the entire picker.
        expect(bankNamesMatch('', 'HNB')).toBe(false);
        expect(bankNamesMatch('HNB', '')).toBe(false);
        expect(bankNamesMatch(null, undefined)).toBe(false);
        expect(senderCoverage(['Seylan Bank'], [{ id: 'x.lk', name: '', status: 'approved' }]).uncovered)
            .toEqual(['Seylan Bank']);
    });
});
