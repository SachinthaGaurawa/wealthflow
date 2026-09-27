import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../merchant-search.js';
import { expenseCategoryFor } from '../wealthflow-statement-router.js';
import { merchantNameFor } from '../statement-sync.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const request = merchant => ({ method: 'POST', json: async () => ({ merchant, country: 'Sri Lanka' }) });

describe('parallel merchant intelligence', () => {
    it('extracts the merchant and classifies Pizza Hut without a network guess', () => {
        const row = { description: 'POS TRANSACTION PIZZA HUT 4471 REF 887302911' };
        expect(merchantNameFor(row)).toBe('PIZZA HUT');
        expect(expenseCategoryFor(row)).toBe('Dining');
    });
    it('fans out to every configured researcher and requires agreeing categories', async () => {
        vi.stubEnv('TAVILY_API_KEY', 't'); vi.stubEnv('BRAVE_API_KEY', 'b');
        const fetch = vi.fn(async url => url.includes('tavily')
            ? { ok: true, json: async () => ({ answer: 'Pizza Hut is a pizza restaurant.' }) }
            : { ok: true, json: async () => ({ web: { results: [{ title: 'Pizza Hut', description: 'Fast food pizza restaurant' }] } }) });
        vi.stubGlobal('fetch', fetch);
        const response = await handler(request('PIZZA HUT'));
        const body = await response.json();
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(body).toMatchObject({ ok: true, category: 'Dining', confidence: 0.9, consensus: { agreed: 2, answered: 2, configured: 2 } });
        expect(body.provider).toContain('consensus:');
    });
    it('continues when one engine is down but lowers confidence instead of pretending consensus', async () => {
        vi.stubEnv('TAVILY_API_KEY', 't'); vi.stubEnv('BRAVE_API_KEY', 'b');
        vi.stubGlobal('fetch', vi.fn(async url => {
            if (url.includes('tavily')) throw new Error('offline');
            return { ok: true, json: async () => ({ web: { results: [{ title: 'Pizza Hut', description: 'Pizza restaurant' }] } }) };
        }));
        const body = await (await handler(request('PIZZA HUT'))).json();
        expect(body).toMatchObject({ ok: true, category: 'Dining', confidence: 0.72, failed: ['tavily'] });
    });
    it('fails closed when researchers identify different business types', async () => {
        vi.stubEnv('TAVILY_API_KEY', 't'); vi.stubEnv('BRAVE_API_KEY', 'b');
        vi.stubGlobal('fetch', vi.fn(async url => url.includes('tavily')
            ? { ok: true, json: async () => ({ answer: 'A hospital and medical clinic.' }) }
            : { ok: true, json: async () => ({ web: { results: [{ description: 'Pizza restaurant' }] } }) }));
        const body = await (await handler(request('AMBIGUOUS NAME'))).json();
        expect(body).toMatchObject({ ok: false, reason: 'provider_disagreement' });
    });
});
