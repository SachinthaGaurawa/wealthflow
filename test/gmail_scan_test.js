/* =============================================================================
 * test/gmail_scan_test.js — planning a reach into the past
 * -----------------------------------------------------------------------------
 * A Pub/Sub watch subscribes to the FUTURE, and /api/gmail-hook reads history
 * forward from a bookmark. Neither can reach a statement already in the inbox,
 * which is most of them and the half that can say what someone actually spends.
 *
 * wealthflow-backfill.js planned that scan when it was merged and no caller ever
 * used the planning half. These pin the decisions of the endpoint that does.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { SCAN, scanSenders, windowFor, boundedMax, listUrl, pageResult } from '../gmail-scan.mjs';
import { BANKS } from '../wealthflow-mail-ingest.mjs';

const NOW = Date.parse('2026-08-28T10:00:00Z');

describe('the senders come from the live allowlist, not a copy', () => {
    it('is exactly the BANKS domains', () => {
        /* A second list would drift, and a drifted allowlist means the scan
         * quietly stops finding one bank's statements while looking fine. */
        expect(scanSenders()).toEqual(BANKS.map((b) => b.domain));
    });

    it('is not empty, which would search the whole mailbox', () => {
        expect(scanSenders().length).toBeGreaterThan(0);
    });
});

describe('the window is derived, never accepted', () => {
    it('builds a bounded query for the month at that index', () => {
        const w = windowFor({ months: 6, index: 0, now: NOW });
        expect(w.label).toBe('2026-08');
        expect(w.query).toContain('has:attachment');
        expect(w.query).toContain('after:2026/08/01');
        expect(w.query).toContain('before:2026/09/01');
        for (const d of scanSenders()) expect(w.query).toContain(`from:${d}`);
    });

    it('walks backwards month by month', () => {
        expect(windowFor({ months: 6, index: 1, now: NOW }).label).toBe('2026-07');
        expect(windowFor({ months: 6, index: 5, now: NOW }).label).toBe('2026-03');
    });

    it('returns null past the end of the plan', () => {
        expect(windowFor({ months: 3, index: 3, now: NOW })).toBe(null);
        expect(windowFor({ months: 3, index: 99, now: NOW })).toBe(null);
    });

    it('refuses a nonsense index instead of guessing one', () => {
        for (const index of [-1, 'first', null, undefined, NaN, 1.5e308]) {
            expect(windowFor({ months: 6, index, now: NOW }), String(index)).toBe(null);
        }
    });

    it('refuses without a clock to plan against', () => {
        /* `now` comes from the CALLER's cursor, not from this process. The
         * client planned its windows at some instant; if the server used its
         * own, a scan running across midnight on the 1st would shift every
         * window by one — re-reading a month and skipping another. */
        expect(windowFor({ months: 6, index: 0 })).toBe(null);
        expect(windowFor({ months: 6, index: 0, now: 0 })).toBe(null);
        expect(windowFor({ months: 6, index: 0, now: 'yesterday' })).toBe(null);
    });

    it('the same inputs give the same window on both sides', async () => {
        const { planWindows } = await import('../wealthflow-backfill.js');
        const mine = windowFor({ months: 12, index: 4, now: NOW });
        const theirs = planWindows({ months: 12, now: NOW, senders: scanSenders() })[4];
        expect(mine).toEqual(theirs);
    });

    it('clamps depth rather than refusing a big number', () => {
        expect(windowFor({ months: 100000, index: 0, now: NOW })).toBeTruthy();
        expect(windowFor({ months: 100000, index: SCAN.MAX_MONTHS, now: NOW })).toBe(null);
    });

    it('a zero or negative depth still yields one window', () => {
        expect(windowFor({ months: 0, index: 0, now: NOW })).toBeTruthy();
        expect(windowFor({ months: -5, index: 1, now: NOW })).toBe(null);
    });
});

describe('how much one call may fetch', () => {
    it('caps at the per-call maximum', () => {
        expect(boundedMax(1000)).toBe(SCAN.MAX_MESSAGES_PER_CALL);
        expect(boundedMax(5)).toBe(5);
    });

    it('a missing or absurd value falls back to the cap, never to zero', () => {
        /* Zero would make every page empty and the scan would report finishing
         * having read nothing — the quiet kind of wrong. */
        for (const v of [undefined, null, 0, -3, 'lots', NaN]) {
            expect(boundedMax(v), String(v)).toBe(SCAN.MAX_MESSAGES_PER_CALL);
        }
    });
});

describe('the Gmail URL', () => {
    const w = { query: 'has:attachment after:2026/08/01' };

    it('encodes the query rather than pasting it', () => {
        const u = listUrl('https://x/y', w, null, 10);
        expect(u).toContain('q=has%3Aattachment');
        expect(u).toContain('maxResults=10');
        expect(u).not.toContain('pageToken');
    });

    it('carries a page token when there is one', () => {
        expect(listUrl('https://x/y', w, 'tok-123', 10)).toContain('pageToken=tok-123');
    });

    it('a hostile page token cannot add parameters', () => {
        const u = listUrl('https://x/y', w, '&maxResults=9999&q=everything', 10);
        expect(u).toContain('maxResults=10');
        expect(u).not.toContain('maxResults=9999');
    });

    it('caps maxResults even when asked for more', () => {
        expect(listUrl('https://x/y', w, null, 5000)).toContain(`maxResults=${SCAN.MAX_MESSAGES_PER_CALL}`);
    });
});

describe('what a page reports', () => {
    it('counts statements STORED, not messages seen', () => {
        /* A window with forty newsletters and one statement did not scan one
         * thing. A progress display that conflates them looks stuck. */
        const r = pageResult({ ids: ['a', 'b', 'c'], stored: [{ key: 'k1', bank: 'HNB', filename: 'x.pdf' }] });
        expect(r.ids.length).toBe(3);
        expect(r.statements).toBe(1);
    });

    it('is empty and well-formed when nothing matched', () => {
        expect(pageResult({})).toEqual({ ids: [], statements: 0, stored: [], skipped: [], pageToken: null });
    });

    it('carries the page token so the cursor can advance', () => {
        expect(pageResult({ pageToken: 'next' }).pageToken).toBe('next');
        expect(pageResult({ pageToken: '' }).pageToken).toBe(null);
    });

    it('bounds the skipped list so one bad month cannot return a novel', () => {
        const many = Array.from({ length: 50 }, (_, i) => ({ reason: `r${i}` }));
        expect(pageResult({ skipped: many }).skipped.length).toBe(10);
    });
});
