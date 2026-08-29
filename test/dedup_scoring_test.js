// =============================================================================
// wealthflow-dedup.js — duplicate-match scoring order
// =============================================================================
// The `compare()` scoring ladder had a dead branch: the exact-merchant + same-day
// case (`mScore >= 0.99 && sameDay`) was listed AFTER the looser `mScore >= 0.88
// && sameDay` case, so the looser branch always won and an exact merchant match
// was scored 0.9 ("amount+day+merchant") instead of the intended 0.92
// ("amount+day+exact-merchant"). These tests load the browser IIFE hermetically
// and pin the corrected order.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let wfDedup;

beforeAll(() => {
    // Load the browser IIFE with `window` injected as a function parameter, the
    // same hermetically-safe pattern the format module's test uses.
    const win = { console };
    const src = fs.readFileSync(path.join(process.cwd(), 'wealthflow-dedup.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', src)(win);
    wfDedup = win.wfDedup;
});

const DAY = (iso) => Date.parse(iso);

describe('wfDedup.compare() — exact merchant on the same day', () => {
    it('scores an exact merchant match (same day, no card) as 0.92 / amount+day+exact-merchant', () => {
        const a = { amount: 5000, date_ms: DAY('2024-06-01T10:00:00Z'), desc: 'KEELLS SUPER' };
        const b = { amount: 5000, date_ms: DAY('2024-06-01T18:00:00Z'), desc: 'KEELLS SUPER' };
        const c = wfDedup.compare(a, b);
        expect(c.match).toBe(true);
        expect(c.score).toBe(0.92);
        expect(c.why).toBe('amount+day+exact-merchant');
        expect(c.certain).toBe(false);
    });

    it('still scores a fuzzy merchant match (same day, no card) as 0.9 / amount+day+merchant', () => {
        const a = { amount: 5000, date_ms: DAY('2024-06-01T10:00:00Z'), desc: 'KEELLS SUPER MARKET' };
        const b = { amount: 5000, date_ms: DAY('2024-06-01T18:00:00Z'), desc: 'KEELLS SUPER MART' };
        const c = wfDedup.compare(a, b);
        expect(c.match).toBe(true);
        expect(c.score).toBe(0.9);
        expect(c.why).toBe('amount+day+merchant');
    });

    it('keeps exact merchant + matching card as the certain 1.0 verdict', () => {
        const a = { amount: 5000, date_ms: DAY('2024-06-01T10:00:00Z'), desc: 'KEELLS SUPER', card_last4: '1234' };
        const b = { amount: 5000, date_ms: DAY('2024-06-01T18:00:00Z'), desc: 'KEELLS SUPER', card_last4: '1234' };
        const c = wfDedup.compare(a, b);
        expect(c.match).toBe(true);
        expect(c.score).toBe(1);
        expect(c.certain).toBe(true);
    });

    it('still refuses two different cards even with an exact merchant + day', () => {
        const a = { amount: 5000, date_ms: DAY('2024-06-01T10:00:00Z'), desc: 'KEELLS SUPER', card_last4: '1234' };
        const b = { amount: 5000, date_ms: DAY('2024-06-01T18:00:00Z'), desc: 'KEELLS SUPER', card_last4: '5678' };
        const c = wfDedup.compare(a, b);
        expect(c.match).toBe(false);
        expect(c.why).toBe('different cards');
    });
});
