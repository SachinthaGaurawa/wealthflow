/* =============================================================================
 * test/sender_discovery_test.js — finding the banks, instead of asking for them
 * -----------------------------------------------------------------------------
 * THE REQUEST: "I cannot find the statement emails for all my banks. Make
 * WealthFlow able to add those emails itself."
 *
 * The old discovery asked Gmail for
 *
 *     has:attachment filename:pdf … ("statement" OR "e-statement" OR …)
 *
 * and both of those gates are fatal AND invisible. A bank sending a
 * password-protected ZIP is not in `filename:pdf`. A subject reading "Monthly
 * Account Summary" matches none of the six phrases. Neither is ranked low —
 * both are ABSENT, and the screen reports the silence as "nothing found".
 *
 * These tests pin the new question and the evidence that narrows it, and they
 * pin the three cases that must NOT change: a curated owner still gets exactly
 * their own senders, a first-time owner still gets the vocabulary, and a
 * discovery run still stores nothing.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    SIGNAL, WEIGHT, SUBJECT_TERMS, LIKELY,
    wideQuery, looksAutomated, saysStatement, monthKey,
    scoreSender, rankCandidates, discoveryReport,
} from '../wealthflow-sender-discovery.js';
import { recordSighting, normalizeList } from '../wealthflow-mail-senders.mjs';
import { planWindows } from '../wealthflow-backfill.js';
import { windowFor } from '../gmail-scan.mjs';
import { CONSUMER_MAIL } from '../wealthflow-mail-ingest.mjs';
import fs from 'node:fs';
import path from 'node:path';

const AUG = Date.UTC(2026, 7, 1);
const SEP = Date.UTC(2026, 8, 1);

/* ═══════════════════════════════════════════════════════════════════════════
 * THE QUESTION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the wide query asks something every bank can answer', () => {
    const q = wideQuery({ after: AUG, before: SEP });

    it('drops the file-type gate that hid every non-PDF statement', () => {
        // A password-protected ZIP, an .htm attachment, or a PDF whose filename
        // carries no extension. None of these are in `filename:pdf`, and the
        // owner is never told a filter removed them.
        expect(q).not.toContain('filename:pdf');
        expect(q).toContain('has:attachment');
    });

    it('drops the vocabulary gate that hid every differently-worded bank', () => {
        for (const term of SUBJECT_TERMS) expect(q).not.toContain(`"${term}"`);
        expect(q).not.toContain('statement');
    });

    it('excludes personal mailboxes IN THE QUERY, using the list that already decides that', () => {
        // Cheaper than fetching them and refusing them, and it is the same rule
        // either way — so there is no second definition of "this is a person".
        for (const d of ['gmail.com', 'yahoo.com', 'outlook.com', 'icloud.com']) {
            expect(CONSUMER_MAIL.has(d)).toBe(true);
            expect(q).toContain(`-from:${d}`);
        }
    });

    it('stays inside the window it was given', () => {
        expect(q).toContain('after:2026/08/01');
        expect(q).toContain('before:2026/09/01');
    });

    it('is deterministic — the same window twice is the same string', () => {
        // A cursor carries the query it is resuming. An undecided ordering of
        // the exclusion list would make two runs of one scan incomparable.
        expect(wideQuery({ after: AUG, before: SEP })).toBe(q);
    });

    it('refuses a window that is not one', () => {
        expect(wideQuery({ after: 0, before: SEP })).toBe('');
        expect(wideQuery({ after: SEP, before: AUG })).toBe('');
        expect(wideQuery({})).toBe('');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT MUST NOT CHANGE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the routine scan is untouched', () => {
    const base = { months: 6, index: 0, now: Date.UTC(2026, 8, 3) };

    it('a curated owner still gets exactly their own senders and no guessing', () => {
        const q = windowFor({ ...base, senders: ['from:hnb.lk'] }).query;
        expect(q).toContain('filename:pdf');
        expect(q).toContain('from:hnb.lk');
        expect(q).not.toContain('"statement"');
        expect(q).not.toContain('-from:gmail.com');
    });

    it('a first-time owner still gets the vocabulary, not just the four built-ins', () => {
        // THE REGRESSION THIS CATCHES: the caller substitutes the built-in bank
        // domains when nobody is approved, so `fromClauses` is never empty and
        // a naive "use terms when there are no senders" test would silently
        // limit a first scan to the four banks this pipeline ships with.
        const q = windowFor({ ...base }).query;
        expect(q).toContain('"statement"');
        expect(q).toContain('from:hnb.lk');
        expect(q).toContain('filename:pdf');
    });

    it('an ordinary scan is NEVER a discovery run', () => {
        // A discovery window reads headers only and stores nothing. If an
        // ordinary scan became one, a first-time owner would scan their whole
        // mailbox, import not one statement, and be told the scan finished.
        expect(windowFor({ ...base }).discovery).toBeUndefined();
        expect(windowFor({ ...base, senders: ['from:hnb.lk'] }).discovery).toBeUndefined();
        expect(windowFor({ ...base, discover: null }).discovery).toBeUndefined();
    });

    it('only an explicit request is a discovery run, and it is marked as one', () => {
        const w = windowFor({ ...base, discover: true });
        expect(w.discovery).toBe(true);
        expect(w.query).toContain('has:attachment');
        expect(w.query).not.toContain('filename:pdf');
    });

    it('a bad index or clock is still refused, discovery or not', () => {
        expect(windowFor({ months: 6, index: null, now: SEP, discover: true })).toBe(null);
        expect(windowFor({ months: 6, index: 0, now: 0, discover: true })).toBe(null);
    });

    it('planWindows still walks newest-first and covers each month once', () => {
        const w = planWindows({ months: 3, now: Date.UTC(2026, 8, 15), discover: true });
        expect(w.map((x) => x.label)).toEqual(['2026-09', '2026-08', '2026-07']);
        expect(new Set(w.map((x) => x.label)).size).toBe(3);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE EVIDENCE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('recurrence is the signal nothing was recording', () => {
    it('the sender list now remembers WHICH MONTHS a sender wrote in', () => {
        let l = recordSighting([], { from: 'x@sampath.lk', subject: 'a', now: 1, month: '2026-08' });
        l = recordSighting(l, { from: 'x@sampath.lk', subject: 'b', now: 2, month: '2026-07' });
        expect(l[0].months.sort()).toEqual(['2026-07', '2026-08']);
    });

    it('merges months rather than replacing — a scan walks NEWEST first', () => {
        // The later call carries the OLDER month. Overwriting would leave one
        // month recorded however many the sender has written in, and the
        // recurrence signal would never fire for anybody.
        let l = recordSighting([], { from: 'x@boc.lk', now: 1, month: '2026-09' });
        for (const m of ['2026-08', '2026-07', '2026-06']) {
            l = recordSighting(l, { from: 'x@boc.lk', now: 2, month: m });
        }
        expect(l[0].months).toHaveLength(4);
    });

    it('counts a month once however many statements arrived in it', () => {
        let l = [];
        for (let i = 0; i < 5; i++) l = recordSighting(l, { from: 'x@seylan.lk', now: i, month: '2026-08' });
        expect(l[0].months).toEqual(['2026-08']);
        expect(l[0].seenCount).toBe(5);
    });

    it('keeps the full address, because noreply@ is evidence a domain cannot show', () => {
        const l = recordSighting([], { from: '"BOC" <eStatement@boc.lk>', now: 1, month: '2026-08' });
        expect(l[0].id).toBe('boc.lk');
        expect(l[0].lastFrom).toBe('estatement@boc.lk');
    });

    it('bounds the month list — this rides inside a stored document', () => {
        let l = [];
        for (let y = 2020; y < 2026; y++) {
            for (let m = 1; m <= 12; m++) {
                l = recordSighting(l, { from: 'x@ndbbank.com', now: 1, month: `${y}-${String(m).padStart(2, '0')}` });
            }
        }
        expect(l[0].months.length).toBeLessThanOrEqual(12);
    });

    it('survives a stored record with a junk months field', () => {
        const l = normalizeList([{ id: 'boc.lk', status: 'new', months: ['ok', 0, null, {}, 'x'] }]);
        expect(Array.isArray(l[0].months)).toBe(true);
        expect(l[0].months.every((m) => typeof m === 'string' && m)).toBe(true);
    });

    it('monthKey reads a timestamp, and refuses one that is not', () => {
        expect(monthKey(Date.UTC(2026, 7, 31))).toBe('2026-08');
        expect(monthKey(0)).toBe('');
        expect(monthKey('nonsense')).toBe('');
    });
});

describe('scoring says why, not just how much', () => {
    const entry = (over) => ({ id: 'sampath.lk', domain: 'sampath.lk', status: 'new', ...over });

    it('a monthly automated sender scores highest, and lists its reasons', () => {
        const r = scoreSender(entry({
            months: ['2026-08', '2026-07'], seenCount: 2,
            lastFrom: 'estatement@sampath.lk', lastSubject: 'Your account summary',
        }));
        expect(r.likely).toBe(true);
        expect(r.signals).toContain(SIGNAL.RECURRING);
        expect(r.why).toContain('arrives about once a month');
        expect(r.why.length).toBe(r.signals.length);
    });

    it('recurrence alone is worth more than vocabulary alone', () => {
        // The whole correction: the old discovery relied on vocabulary and
        // nothing else, which is exactly why differently-worded banks vanished.
        expect(WEIGHT[SIGNAL.RECURRING]).toBeGreaterThan(WEIGHT[SIGNAL.VOCABULARY]);
        const recurring = scoreSender(entry({ months: ['2026-08', '2026-07'], seenCount: 2 }));
        const wordy = scoreSender(entry({ months: ['2026-08'], seenCount: 1, lastSubject: 'statement' }));
        expect(recurring.score).toBeGreaterThan(wordy.score);
    });

    it('a bank that never says "statement" is still found', () => {
        // The case the old search could not see at all.
        const r = scoreSender(entry({
            id: 'boc.lk', domain: 'boc.lk',
            months: ['2026-08', '2026-07', '2026-06'], seenCount: 3,
            lastFrom: 'noreply@boc.lk', lastSubject: 'Ref 88213/2026',
        }));
        expect(r.signals).not.toContain(SIGNAL.VOCABULARY);
        expect(r.likely).toBe(true);
    });

    it('a one-off attachment from a company is not called a bank', () => {
        const r = scoreSender(entry({
            id: 'printshop.lk', domain: 'printshop.lk', months: ['2026-08'], seenCount: 1,
            lastFrom: 'kamal@printshop.lk', lastSubject: 'Your order',
        }));
        expect(r.likely).toBe(false);
        expect(r.score).toBeLessThan(LIKELY);
    });

    it('never exceeds one, whatever fires', () => {
        const r = scoreSender(entry({
            months: ['a', 'b', 'c'], seenCount: 40,
            lastFrom: 'noreply@sampath.lk', lastSubject: 'e-statement',
        }));
        expect(r.score).toBeLessThanOrEqual(1);
    });

    it('reads an automated address, and does not call a person one', () => {
        expect(looksAutomated('noreply@boc.lk')).toBe(true);
        expect(looksAutomated('do-not-reply@combank.lk')).toBe(true);
        expect(looksAutomated('eStatements@seylan.lk')).toBe(true);
        expect(looksAutomated('kamal.perera@combank.lk')).toBe(false);
        expect(looksAutomated('')).toBe(false);
        expect(looksAutomated(null)).toBe(false);
    });

    it('reads a wider vocabulary than the old search, and still no bill or invoice', () => {
        expect(saysStatement('Monthly Account Summary')).toBe(true);
        expect(saysStatement('Your Card Statement is ready')).toBe(true);
        expect(saysStatement('TRANSACTION ADVICE')).toBe(true);
        // These describe every non-statement financial mail ever sent, and
        // letting them back in is how a statements screen filled with receipts.
        expect(SUBJECT_TERMS.join(' ')).not.toContain('bill');
        expect(SUBJECT_TERMS.join(' ')).not.toContain('invoice');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE REPORT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the report the owner is shown', () => {
    const list = () => {
        let l = [];
        for (const m of ['2026-08', '2026-07', '2026-06']) {
            l = recordSighting(l, { from: 'estatement@sampath.lk', subject: 'Account summary', now: 1, month: m });
        }
        for (const m of ['2026-08', '2026-07']) {
            l = recordSighting(l, { from: 'noreply@boc.lk', subject: 'Ref 8821', now: 1, month: m });
        }
        l = recordSighting(l, { from: 'kamal@printshop.lk', subject: 'Your order', now: 1, month: '2026-08' });
        return l;
    };

    it('puts the likely banks first, with their reasons', () => {
        const r = discoveryReport(list());
        expect(r.likely.map((x) => x.id)).toEqual(['sampath.lk', 'boc.lk']);
        expect(r.rest.map((x) => x.id)).toEqual(['printshop.lk']);
        for (const x of r.likely) expect(x.why.length).toBeGreaterThan(0);
    });

    it('never re-offers a sender the owner already decided about', () => {
        // Re-offering something they blocked is how a helpful screen becomes
        // one people stop reading.
        const l = list().map((e) => (e.id === 'boc.lk' ? { ...e, status: 'blocked' } : e));
        const withApproved = l.map((e) => (e.id === 'sampath.lk' ? { ...e, status: 'approved' } : e));
        const ids = discoveryReport(withApproved).ranked.map((x) => x.id);
        expect(ids).not.toContain('boc.lk');
        expect(ids).not.toContain('sampath.lk');
    });

    it('names what it cannot find, rather than implying it found everything', () => {
        const r = discoveryReport(list());
        expect(r.cannotFind).toContain('link');
        expect(r.cannotFind).toContain('no attachment');
    });

    it('an empty mailbox reports nothing found, not an error', () => {
        const r = discoveryReport([]);
        expect(r.found).toBe(0);
        expect(r.likely).toEqual([]);
    });

    it('never throws on a list read back from storage', () => {
        fc.assert(fc.property(fc.anything(), (junk) => {
            expect(() => discoveryReport(junk)).not.toThrow();
            expect(() => rankCandidates(junk)).not.toThrow();
        }), { numRuns: runs(200) });
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RANKING IS ON THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the discovery report has a caller', () => {
    // A ranking module nothing renders is this repository's most repeated
    // defect. The evidence is worth nothing if the owner sees the same
    // unordered list of domains they saw before.
    const HTML = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
    const SCAN = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'gmail-scan.js'), 'utf8');

    it('the module is loaded by the app, as ESM', () => {
        expect(HTML).toMatch(/<script type="module" src="wealthflow-sender-discovery\.js">/);
    });

    it('the pending list is ranked, not printed in arrival order', () => {
        expect(HTML).toContain('WFDiscovery.discoveryReport(_senders.pending)');
        expect(HTML).toContain('report.ranked.map(');
    });

    it('every reason the ranking used is printed beside the row', () => {
        expect(HTML).toContain('scored.why');
        expect(HTML).toContain('wf-sender-why');
        expect(HTML).toContain('Looks like one of your banks');
    });

    it('a missing ranking costs the ordering, never the ability to approve', () => {
        // The fallback matters more than the feature: a helper that failed to
        // load must not take the approve button with it.
        expect(HTML).toContain("window.WFDiscovery && typeof WFDiscovery.discoveryReport === 'function'");
        expect(HTML).toContain('_senders.pending.map((e) => rowFor(e, null))');
    });

    it('the screen says what discovery cannot find', () => {
        expect(HTML).toContain('report.cannotFind');
    });

    it('the scan reads headers only on a discovery window, and says why', () => {
        expect(SCAN).toContain('const discovering = window.discovery === true;');
        expect(SCAN).toContain('format=metadata');
        expect(SCAN).toContain('if (discovering) {');
    });

    it('a discovery sighting is stamped with the MESSAGE month, not today', () => {
        // Recurrence is the strongest signal there is. Stamping every sighting
        // with the date of the run would make every sender look like it had
        // written exactly once, and the signal would never fire for anybody.
        expect(SCAN).toContain('month: monthKey(Number(msg.internalDate)');
    });
});
