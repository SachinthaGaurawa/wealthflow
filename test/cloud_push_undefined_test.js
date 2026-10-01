import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// One `undefined` anywhere in the document makes Firestore refuse the WHOLE
// push — and every push after it, until the page is reloaded and the field
// vanishes with localStorage's JSON round trip. The owner's diagnostics showed
// exactly that ("Unsupported field value: undefined … users/…", from
// syncToCloud) right after the card page began un-settling charges with
// `x.paidAt = undefined`. Two defences: stop writing it, and never send it.
const html = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function _wfCloudSafe(v, d = 0) {');
const end = html.indexOf('function syncToCloud() {');
const cloudSafe = new Function(html.slice(start, end) + '\nreturn _wfCloudSafe;')();
const hasUndefined = v => v === undefined || (v && typeof v === 'object' && Object.values(v).some(hasUndefined));

describe('the cloud payload is safe for Firestore', () => {
    it('is extracted from the real page code', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });
    it('drops undefined object fields at every depth and nulls them inside arrays', () => {
        const input = { a: 1, b: undefined, list: [{ id: 1, paidAt: undefined, x: [undefined, 2] }, undefined], deep: { deeper: { gone: undefined, kept: 'k' } }, fn() {}, n: null, z: 0, s: '' };
        const out = cloudSafe(input);
        expect(hasUndefined(out)).toBe(false);
        expect(out).toEqual({ a: 1, list: [{ id: 1, x: [null, 2] }, null], deep: { deeper: { kept: 'k' } }, n: null, z: 0, s: '' });
    });
    it('does not change the caller\'s data', () => {
        const input = { rec: { id: 1, paidAt: undefined } };
        cloudSafe(input);
        expect('paidAt' in input.rec).toBe(true);
    });
    it('leaves special objects (Date, server timestamps) alone', () => {
        class FieldValue { constructor() { this.sentinel = true; } }
        const stamp = new FieldValue(), when = new Date(0);
        const out = cloudSafe({ stamp, when, plain: { ok: 1 } });
        expect(out.stamp).toBe(stamp);
        expect(out.when).toBe(when);
    });
    it('keeps every real value a ledger holds', () => {
        const ledger = { expenses: [{ id: 'a', amount: 12.5, date: '2026-01-02', cat: 'Food', recurring: false, notes: '' }], balance: { total: 0, flows: [] }, incomeReceived: { '2026-01': true } };
        expect(cloudSafe(ledger)).toEqual(ledger);
    });
    it('survives a cycle without hanging', () => {
        const a = { name: 'a' }; a.self = a;
        expect(() => cloudSafe(a)).not.toThrow();
    });
    it('the payload is built through it, and a synchronous throw from set() cannot escape', () => {
        const at = html.indexOf('function syncToCloud() {');
        const body = html.slice(at, at + 5200);
        // the push is a transaction, and a synchronous throw while it is started still becomes a rejection, not an escape
        expect(body).toMatch(/tx\.set\(userDocRef, Object\.assign\(\{\}, _wfCloudSafe\(appData\)/);
        expect(body).toMatch(/try \{\s*_push = userDocRef\.firestore\.runTransaction\([\s\S]*?\} catch \(err\) \{ _push = Promise\.reject\(err\); \}/);
    });
    it('the card page no longer writes undefined into a charge', () => {
        expect(html).not.toMatch(/paidAt\s*=\s*undefined/);
    });
});
