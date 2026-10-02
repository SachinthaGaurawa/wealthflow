// Property and fuzz tests for the empty-statement decision: a page that carries money in any written form is never closed as empty,
// balances are compared in whole cents (never as floats), and no input makes the scan throw. Seeded, so a failure replays.
import { describe, it, expect } from 'vitest';
import { assessEmptiness, scanStatementText, statedBalanceCents } from '../statement-emptiness.mjs';

const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const pick = (r, list) => list[Math.floor(r() * list.length)];
const grouped = n => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const page = (body, opening = '1,000.00', closing = opening) => `Statement Period: 01/04/2024 to 30/04/2024\nAccount No 0123456789\nOpening Balance ${opening}\n${body}\nClosing Balance ${closing}\n`;
const FORMATS = [
    n => grouped(n), n => n.toFixed(2), n => String(Math.round(n)), n => n.toFixed(1),
    n => grouped(n).replace(/,/g, '.').replace(/\.(\d\d)$/, ',$1'), n => `Rs. ${grouped(n)} Cr`, n => `(${grouped(n)})`, n => `${grouped(n)} DR`,
];

describe('statement-emptiness: money in any written form is never called empty', () => {
    it('500 random transaction lines, every number format, balances that agree: never "empty"', () => {
        const r = rng(20261002), leaked = [];
        for (let i = 0; i < 500; i++) {
            const amount = 100 + Math.floor(r() * 9_000_000) / 100;
            const fmt = pick(r, FORMATS), day = String(1 + Math.floor(r() * 28)).padStart(2, '0');
            const line = pick(r, [`${day}/04/2024 TRANSFER ${fmt(amount)}`, `${day}/04/2024 SALARY\n${fmt(amount)}`, `${day} Apr 2024 ATM WDL ${fmt(amount)}`, `2024-04-${day} POS PURCHASE ${fmt(amount)}`]);
            const verdict = assessEmptiness({ text: page(line), parsed: { rows: [] } });
            if (verdict.decision === 'empty') leaked.push(line);
        }
        expect(leaked).toEqual([]);
    });
    it('opening and closing that differ by even one cent are never empty; equal ones are not moved', () => {
        const r = rng(7);
        for (let i = 0; i < 300; i++) {
            const opening = Math.floor(r() * 1e9) / 100, delta = 1 + Math.floor(r() * 5000);
            const moved = assessEmptiness({ text: page('', grouped(opening), grouped(opening + delta / 100)), parsed: { rows: [] } });
            expect(moved.decision).toBe('moved');
            const same = assessEmptiness({ text: page('', grouped(opening)), parsed: { rows: [] } });
            expect(same.decision).toBe('empty');
        }
    });
    it('balances from the reader are compared in cents: 0.1 + 0.2 and 0.3 are the same balance, 0.30 and 0.31 are not', () => {
        const text = page('');
        expect(assessEmptiness({ text, parsed: { rows: [], reconciliation: { opening: 0.1 + 0.2, closing: 0.3 } } }).decision).toBe('empty');
        expect(assessEmptiness({ text, parsed: { rows: [], reconciliation: { opening: 0.3, closing: 0.31 } } }).decision).toBe('moved');
        expect(statedBalanceCents({ text, parsed: { rows: [], reconciliation: { opening: 1234567.89, closing: 1234567.89 } } })).toBe(123456789);
    });
    it('a statement that says nothing moved and shows only zero lines stays empty (no false alarms on the dormant shape)', () => {
        const text = 'Statement Period: 01/04/2024 to 30/04/2024\nB/F 0.00\n01/04/2024 B/F 0.00\n30/04/2024 Int.Pd 0.00\n';
        expect(assessEmptiness({ text, parsed: { rows: [] } }).decision).toBe('empty');
    });
    it('never throws and never answers outside its contract on garbage, huge and hostile text', () => {
        const r = rng(99), alphabet = ['0', '9', '.', ',', '-', '(', ')', ' ', '\n', '/', 'a', 'Z', 'Rs', 'B/F', 'Balance', '٣', '１２３', '\u0000', '𝟚', 'ශ්‍රී', '‮'];
        for (let i = 0; i < 400; i++) {
            let text = ''; const n = Math.floor(r() * 400);
            for (let k = 0; k < n; k++) text += pick(r, alphabet);
            const verdict = assessEmptiness({ text, parsed: i % 3 ? { rows: [] } : { rows: [{ amount: NaN }, null, 'x', { amount: -5 }] } });
            expect(['empty', 'has-transactions', 'moved', 'unsure']).toContain(verdict.decision);
            expect(() => scanStatementText(text)).not.toThrow();
        }
        for (const bad of [undefined, null, 42, {}, '']) expect(['unsure', 'has-transactions', 'empty', 'moved']).toContain(assessEmptiness({ text: bad, parsed: bad }).decision);
        expect(assessEmptiness({ text: ('05/04/2024 X 1,000.00\n').repeat(50000), parsed: { rows: [] } }).decision).toBe('has-transactions');
    });
});
