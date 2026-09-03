/* =============================================================================
 * test/institutions_test.js — one list of the banks, at last
 * -----------------------------------------------------------------------------
 * There were two lists of Sri Lankan banks in this repository, written by
 * different hands for different jobs, and nothing compared them:
 *
 *   index.html                    the picker every card charge is filed under.
 *                                 Fourteen institutions.
 *   wealthflow-mail-ingest.mjs    the domains a statement may arrive from. Four.
 *
 * test/bank_coverage_test.js pinned the size of that gap. Pinning a gap is not
 * closing it. wealthflow-institutions.js closes it: the picker, the mail
 * allowlist and the words a mailbox is searched for are all derived from one
 * description of each bank.
 *
 * These tests hold the derivation honest — and, most of all, hold the picker's
 * exact strings still, because CC_CASH_ADVANCE_FEES is keyed on them and a
 * character changed here silently changes a fee.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    INSTITUTIONS, PICKER, BANK_DOMAINS,
    institutionFor, tokensFor, domainsFor, institutionForSender,
} from '../wealthflow-institutions.js';
import { BANKS as MAIL_BANKS, CONSUMER_MAIL } from '../wealthflow-mail-ingest.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const pickerInHtml = () => {
    const m = HTML.match(/const BANKS = \[([^\]]*)\];/);
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
};

describe('the picker is byte-for-byte what it was', () => {
    it('index.html offers exactly the strings this module names', () => {
        // THE ONE THAT MUST NEVER GO RED QUIETLY. Every stored card charge
        // carries one of these strings and CC_CASH_ADVANCE_FEES is keyed on
        // them, so a rename here does not break a lookup loudly — it changes a
        // fee, on a screen that keeps working.
        expect(pickerInHtml()).toEqual(PICKER);
    });

    it('found the picker at all (guards a vacuous pass)', () => {
        expect(pickerInHtml().length).toBeGreaterThan(10);
    });

    it('the fee table still names every institution the picker offers', () => {
        const fees = HTML.slice(HTML.indexOf('const CC_CASH_ADVANCE_FEES'));
        for (const name of PICKER) {
            expect(fees.includes(`'${name}'`), `no cash-advance fee for ${name}`).toBe(true);
        }
    });

    it('"Other" is last and is not an institution', () => {
        // It has no name to search for and no domain to trust. Giving it either
        // would make every unmatched thing look like a bank.
        expect(PICKER[PICKER.length - 1]).toBe('Other');
        expect(INSTITUTIONS.some((i) => i.name === 'Other')).toBe(false);
    });
});

describe('the mail allowlist is DERIVED, not a second list', () => {
    it('every allowlisted domain comes from an institution', () => {
        for (const b of MAIL_BANKS) {
            const inst = INSTITUTIONS.find((i) => i.domains.includes(b.domain));
            expect(inst, `${b.domain} is allowlisted by nobody`).toBeTruthy();
        }
    });

    it('one entry per domain — two institutions can share a mailbox', () => {
        // NTB issues both AMEX and Visa/Mastercard from one address, and the
        // picker lists them separately because their fees differ. A domain
        // listed twice would be an allowlist that disagrees with itself about
        // who a sender is.
        const ds = MAIL_BANKS.map((b) => b.domain);
        expect(new Set(ds).size).toBe(ds.length);
        expect(MAIL_BANKS.find((b) => b.domain === 'nationstrust.com').name)
            .toBe('Nations Trust Bank (NTB)');
    });

    it('labels mail with the picker form, not a nickname', () => {
        // 'HNB' had to be reconciled with 'Hatton National Bank (HNB)' by
        // substring matching on every account lookup. A nickname that only
        // almost matches the stored form is how a statement is filed against
        // no account at all.
        expect(MAIL_BANKS.find((b) => b.domain === 'hnb.lk').name).toBe('Hatton National Bank (HNB)');
    });

    it('no consumer mailbox is ever a bank domain', () => {
        for (const b of BANK_DOMAINS) expect(CONSUMER_MAIL.has(b.domain)).toBe(false);
    });

    it('every domain is a real registrable domain, lowercased', () => {
        for (const b of BANK_DOMAINS) {
            expect(b.domain).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
            expect(b.domain).toBe(b.domain.toLowerCase());
        }
    });

    it('an unverified domain stays EMPTY rather than being guessed', () => {
        // This list is a trust allowlist for financial documents: a domain on
        // it is a domain whose DKIM-signed mail is filed as the owner's bank
        // statement. Nine plausible guesses would be nine entries nobody
        // checked, and one wrong guess allowlists a stranger.
        const sampath = INSTITUTIONS.find((i) => i.id === 'sampath');
        expect(sampath.domains).toEqual([]);
        expect(MAIL_BANKS.some((b) => b.domain.includes('sampath'))).toBe(false);
    });
});

describe('the words a mailbox is searched for', () => {
    it('every institution has at least one, or it can never be hunted', () => {
        for (const i of INSTITUTIONS) {
            expect(i.tokens.length, `${i.name} has nothing to search for`).toBeGreaterThan(0);
            for (const t of i.tokens) expect(t.trim().length).toBeGreaterThan(1);
        }
    });

    it('resolves picker names to tokens, longest first', () => {
        expect(tokensFor(['Hatton National Bank (HNB)'])).toEqual(['hatton national', 'hnb']);
        expect(tokensFor('Sampath Bank')).toEqual(['sampath']);
    });

    it('de-duplicates institutions that share a name', () => {
        // NTB is two picker entries and one mailbox. Searching for it twice
        // costs a clause and finds the same mail.
        const t = tokensFor(['Nations Trust Bank (NTB) — AMEX', 'Nations Trust Bank (NTB) — Visa/Mastercard']);
        expect(t).toEqual(['nations trust', 'ntb']);
    });

    it('a name that is not an institution contributes NOTHING', () => {
        // The injection guard. These tokens end up inside a Gmail query built
        // on a credential that can read an entire mailbox, so an unknown name
        // must produce no clause rather than its own text.
        expect(tokensFor(['from:evil.example OR anything'])).toEqual([]);
        expect(tokensFor(['"] OR from:x'])).toEqual([]);
        expect(tokensFor([null, undefined, '', 0, {}])).toEqual([]);
        expect(tokensFor('Other')).toEqual([]);
    });

    it('finds an institution by its short name as well as its picker name', () => {
        expect(institutionFor('HNB').id).toBe('hnb');
        expect(institutionFor('Hatton National Bank (HNB)').id).toBe('hnb');
        expect(institutionFor('sampath').id).toBe('sampath');
        expect(institutionFor('nothing at all')).toBeNull();
        expect(institutionFor('')).toBeNull();
    });

    it('domainsFor answers only where a domain is verified', () => {
        expect(domainsFor('Hatton National Bank (HNB)')).toEqual(['hnb.lk']);
        expect(domainsFor('Sampath Bank')).toEqual([]);
    });
});

describe('attributing a sender to a bank', () => {
    it('reads the domain', () => {
        expect(institutionForSender({ domain: 'sampath.lk' }).id).toBe('sampath');
        expect(institutionForSender({ domain: 'estatements.seylan.lk' }).id).toBe('seylan');
    });

    it('reads the DISPLAY NAME, which is how a bank on a third-party sender is still itself', () => {
        // "Seylan Bank" <noreply@mailer.example> — the domain says nothing and
        // the name says everything.
        expect(institutionForSender({ domain: 'mailer.example', displayName: 'Seylan Bank' }).id).toBe('seylan');
    });

    it('prefers the LONGER match when two could fit', () => {
        expect(institutionForSender({ domain: 'x.lk', displayName: 'Bank of Ceylon' }).id).toBe('boc');
    });

    it('returns null rather than guessing', () => {
        // One tap on this screen files money under the answer. "I do not know
        // which bank this is" is a better answer than the wrong bank.
        expect(institutionForSender({ domain: 'printshop.lk', displayName: 'Kamal' })).toBeNull();
        expect(institutionForSender({})).toBeNull();
        expect(institutionForSender()).toBeNull();
    });
});
