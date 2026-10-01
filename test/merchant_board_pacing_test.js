import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* TWO BOARD CALLS AT A TIME, NOT EIGHT. Production log of 2026-10-01 (18:20, Sri Lanka): four /api/verify and six /api/ai at the same second,
 * two of the boards refused (422) — each board is a question to every configured provider, and the providers' per-minute limits had been spent
 * by the other boards. A batch of unknown merchants now runs in two lanes, and a board refused only because too few providers could answer is
 * asked once more a few seconds later. */

const MERCHANTS = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'wealthflow-merchants.js'), 'utf8');

function world({ board }) {
    const mem = new Map(), stats = { inFlight: 0, maxInFlight: 0, asked: 0 };
    const win = { localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }, DB: { get: () => [], set() {} } };
    const fetchStub = async (url, options) => {
        const body = options && options.body ? JSON.parse(options.body) : {};
        if (String(url).includes('/api/verify')) return { ok: true, json: async () => ({ exists: 'unknown', abstain_reason: 'no_search_results', evidence_urls: [] }) };
        if (String(url).includes('/api/ai')) {
            stats.asked++; stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
            await new Promise((resolve) => setTimeout(resolve, 20));
            const answer = await board(body, stats.asked);
            stats.inFlight--;
            return { ok: true, json: async () => answer };
        }
        return { ok: true, json: async () => ({ version: 't', merchants: [] }) };
    };
    new Function('window', 'console', 'fetch', MERCHANTS)(win, { log() {}, warn() {} }, fetchStub);
    return { M: win.WFMerchants, stats };
}
const agreed = { unanimous: true, trustworthy: true, consensusOf: 9, reply: JSON.stringify({ category: 'Groceries', destination: 'expenses' }) };

describe('a batch of unknown merchants', () => {
    it('is asked of the AI board two at a time, however many there are — and every one is still answered', async () => {
        const w = world({ board: () => agreed });
        const names = ['ZZQ BLORP 0231 KUL', 'QQX WIBBLE 7731 COL', 'MMR FLOOP 1129 GAL', 'TTV SNORK 4410 KAN', 'RRP GLIMB 8802 MAT', 'LLN DRAXO 5523 JAF'];
        names.forEach((n) => w.M.discover(n, 'debit'));
        const result = await w.M.resolveUnknowns(8);
        expect(result.resolved).toBe(6);
        expect(w.stats.asked).toBe(6);
        expect(w.stats.maxInFlight).toBeLessThanOrEqual(2);
        expect(w.stats.maxInFlight).toBeGreaterThanOrEqual(2);              // two lanes, not one: it is not serial either
    });
});

describe('a board refused for lack of providers', () => {
    it('is asked once more after a pause, and the second answer settles it', async () => {
        vi.useFakeTimers();
        try {
            const w = world({ board: (_b, n) => (n === 1 ? { unanimous: false, trustworthy: false, reason: 'provider_unavailable', consensusOf: 3 } : agreed) });
            w.M.discover('ZZQ BLORP 0231 KUL', 'debit');
            const pending = w.M.resolveUnknowns(8);
            await vi.advanceTimersByTimeAsync(7000);
            expect(await pending).toMatchObject({ resolved: 1, byAi: 1, held: 0 });
            expect(w.stats.asked).toBe(2);
        } finally { vi.useRealTimers(); }
    });
    it('is NOT asked again when its providers answered and differed — that is an answer', async () => {
        const w = world({ board: () => ({ unanimous: false, trustworthy: false, reason: 'provider_disagreement', consensusOf: 8 }) });
        w.M.discover('ZZQ BLORP 0231 KUL', 'debit');
        expect(await w.M.resolveUnknowns(8)).toMatchObject({ resolved: 0, held: 1 });
        expect(w.stats.asked).toBe(1);
    });
});
