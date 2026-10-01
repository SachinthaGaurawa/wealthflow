import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unanimousDecision } from '../api/ai-matrix.mjs';

// "Merchant review: let the AI decide on its own, and ask the owner only what is hard."
// The board accepts an answer only when every engine's JSON is IDENTICAL, and the merchant question asked for a
// sentence and a decimal from a dozen models — so nothing was ever settled and everything was held. These tests
// run the real module against a stubbed web search and AI board.
const ROOT = path.resolve(import.meta.dirname, '..');
const MERCHANTS = fs.readFileSync(path.join(ROOT, 'wealthflow-merchants.js'), 'utf8');
const PANEL = fs.readFileSync(path.join(ROOT, 'wealthflow-verify-panel.js'), 'utf8');

function world({ web = () => ({ exists: 'unknown', abstain_reason: 'no_search_results', evidence_urls: [] }), board = () => ({ unanimous: false, trustworthy: false, consensusOf: 0, reply: null }), records = {} } = {}) {
    const mem = new Map(), calls = { verify: [], ai: [] };
    const store = Object.fromEntries(Object.entries(records).map(([k, v]) => [k, structuredClone(v)]));
    const writes = [];
    const win = {
        localStorage: { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) },
        DB: { get: k => store[k] || [], set: (k, v) => { store[k] = v; writes.push(k); } },
    };
    const fetchStub = async (url, options) => {
        const body = options?.body ? JSON.parse(options.body) : {};
        if (String(url).includes('/api/verify')) { calls.verify.push(body.merchant); return { ok: true, json: async () => web(body.merchant, calls.verify.length) }; }
        if (String(url).includes('/api/ai')) { calls.ai.push(body); return { ok: true, json: async () => board(body) }; }
        return { ok: true, json: async () => ({ version: 't', merchants: [] }) };
    };
    new Function('window', 'console', 'fetch', MERCHANTS)(win, { log() {}, warn() {} }, fetchStub);
    return { M: win.WFMerchants, win, mem, calls, store, writes };
}
const found = (category, confidence = 0.97, extra = {}) => ({ exists: true, vendor: 'Some Shop', industry: 'retail', category, destination: 'expenses', confidence, evidence_urls: ['https://example.lk/shop'], abstain_reason: null, ...extra });
const agreed = (category, destination = 'expenses') => ({ unanimous: true, trustworthy: true, consensusOf: 9, reply: JSON.stringify({ category, destination }) });
const queue = (w, ...raws) => raws.forEach(raw => w.M.discover(raw, 'debit'));
const pend = w => w.M.pending();

describe('the question the board is asked', () => {
    it('can be answered identically by many engines: two closed fields, no sentence, no decimal', () => {
        const engines = Array.from({ length: 6 }, (_, i) => ({ ok: true, name: 'E' + i, reply: JSON.stringify({ category: 'Groceries', destination: 'expenses' }) }));
        expect(unanimousDecision(engines, { expected: engines.map(e => e.name), minimumProviders: 5 }).unanimous).toBe(true);
        // the old shape — a free-text "why" and a confidence from each model — is never identical
        const old = engines.map((e, i) => ({ ...e, reply: JSON.stringify({ vendor: 'Shop', category: 'Groceries', destination: 'expenses', confidence: 0.9 + i / 100, why: 'reason ' + i }) }));
        expect(unanimousDecision(old, { expected: old.map(e => e.name), minimumProviders: 5 }).unanimous).toBe(false);
    });
    it('is sent as a financial decision, with the closed shape and the safe way out', async () => {
        const w = world({ board: () => agreed('Groceries') });
        queue(w, 'ZZQ BLORP 0231 KUL');
        await w.M.resolveUnknowns();
        const body = w.calls.ai[0];
        expect(body.financialDecision).toBe(true);
        expect(body.prompt).toContain('{"category":"...","destination":"subscription|expenses"}');
        expect(body.prompt).toContain('{"category":"Other","destination":"expenses"}');
        expect(body.prompt).not.toMatch(/confidence|"why"|"vendor"/);
    });
});

describe('settling a merchant without asking', () => {
    it('web search, cited and sure: learned, and the board is not even asked', async () => {
        const w = world({ web: () => found('Groceries', 0.97) });
        queue(w, 'ZZQ BLORP 0231 KUL');
        expect(await w.M.resolveUnknowns()).toMatchObject({ resolved: 1, verified: 1, held: 0 });
        expect(w.calls.ai).toHaveLength(0);
        expect(w.M.classify('ZZQ BLORP 0231 KUL', 'debit')).toMatchObject({ category: 'Groceries' });
        expect(w.M.export()[w.M.merchantKey('ZZQ BLORP 0231 KUL')]).toMatchObject({ category: 'Groceries', src: 'web' });
    });
    it('the unanimous board alone settles it when the web is silent', async () => {
        const w = world({ board: () => agreed('Groceries') });
        queue(w, 'ZZQ BLORP 0231 KUL');
        expect(await w.M.resolveUnknowns()).toMatchObject({ resolved: 1, verified: 0, byAi: 1, held: 0 });
        expect(Object.values(w.M.export())[0]).toMatchObject({ category: 'Groceries', src: 'ai' });
    });
    it('two witnesses that each fall short of the gate but agree settle it', async () => {
        const w = world({ web: () => found('Groceries', 0.9), board: () => agreed('Groceries') });
        queue(w, 'ZZQ BLORP 0231 KUL');
        expect(await w.M.resolveUnknowns()).toMatchObject({ resolved: 1, held: 0 });
        expect(Object.values(w.M.export())[0]).toMatchObject({ category: 'Groceries', src: 'web+ai' });
    });
    it('a subscription answer is filed as one', async () => {
        const w = world({ board: () => agreed('Streaming', 'subscription') });
        queue(w, 'ZZ UNIQUE STREAMING 0231');
        await w.M.resolveUnknowns();
        expect(Object.values(w.M.export())[0]).toMatchObject({ category: 'Streaming', tab: 'subscription' });
    });
});

describe('what stays with the owner is only what is hard — with every witness\'s answer', () => {
    it('holds a merchant the web and the board disagree about, showing both', async () => {
        const w = world({ web: () => found('Dining', 0.9), board: () => agreed('Groceries') });
        queue(w, 'ZZQ BLORP 0231 KUL');
        expect(await w.M.resolveUnknowns()).toMatchObject({ resolved: 0, held: 1 });
        const [h] = pend(w);
        expect(h).toMatchObject({ tries: 1, reason: 'the web and the AI board named different categories' });
        expect(h.alternatives.map(a => [a.source, a.category])).toEqual([['web', 'Dining'], ['ai', 'Groceries']]);
        expect(h.nextAt - Date.now()).toBeGreaterThan(3000 * 1000);
        expect(Object.keys(w.M.export())).toHaveLength(0);
    });
    it.each([
        ['a split board and a silent web', () => ({ unanimous: false, trustworthy: false, consensusOf: 6, reply: null }), 'the AI engines did not all give the same answer'],
        ['no answer at all', () => null, 'neither the web nor the AI board could identify this merchant'],
        ['a board that can only say "Other"', () => agreed('Other'), 'the AI engines agreed only that they cannot tell what this is'],
        ['an answer outside the taxonomy', () => agreed('Pirate Supplies'), 'the AI engines agreed only that they cannot tell what this is'],
    ])('holds it for %s', async (_, board, reason) => {
        const w = world({ board });
        queue(w, 'ZZQ BLORP 0231 KUL');
        await w.M.resolveUnknowns();
        expect(pend(w)[0]).toMatchObject({ reason });
    });
    it('holds a name that fits two categories unless a witness picks one of them', async () => {
        const w = world({ board: () => agreed('Gold') });
        const raw = 'Sampath Insurance Fuel Station';   // insurance and fuel both match the registry
        expect(w.M.analyze(raw, 'debit').system_action).toBe('AMBIGUOUS_REQUIRES_SEARCH');
        queue(w, raw);
        await w.M.resolveUnknowns();
        expect(pend(w)[0]).toMatchObject({ reason: 'the text fits more than one category and the witnesses did not settle it' });
    });
    it('never overrules what the rules already know with one board answer', async () => {
        const w = world({ board: () => agreed('Gold') });
        queue(w, 'NETFLIX.COM 0231');
        await w.M.resolveUnknowns();
        expect(Object.values(w.M.export()).length).toBe(0);
    });
});

describe('the web is asked under three names before it is given up on', () => {
    it('retries with the cleaned name and then the first two words, only while the web has no record', async () => {
        const w = world({ web: (q, n) => (n < 3 ? { exists: 'unknown', abstain_reason: 'no_search_results', evidence_urls: [] } : found('Groceries', 0.97)) });
        queue(w, 'IB POS ANURA TRADING CO 0231 KUL');
        await w.M.resolveUnknowns();
        expect(w.calls.verify).toHaveLength(3);
        expect(w.calls.verify[0]).toBe('IB POS ANURA TRADING CO 0231 KUL');
        expect(w.calls.verify[1]).toBe('anura trading kul');
        expect(w.calls.verify[2]).toBe('anura trading');
        expect(new Set(w.calls.verify).size).toBe(3);
        expect(Object.values(w.M.export())[0]).toMatchObject({ category: 'Groceries' });
    });
    it('does not keep asking when search is not configured', async () => {
        const w = world({ web: () => ({ exists: 'unknown', abstain_reason: 'search_not_configured', evidence_urls: [] }) });
        queue(w, 'IB POS ANURA TRADING CO 0231 KUL');
        await w.M.resolveUnknowns();
        expect(w.calls.verify).toHaveLength(1);
        expect(pend(w)[0].reason).toContain('web search is not configured');
    });
});

describe('a held merchant is asked again later, not forgotten and not nagged', () => {
    const hold = (w, patch = {}) => { w.mem.set('wf_merchant_pending', JSON.stringify([{ key: 'zzq blorp kul', raw: 'ZZQ BLORP 0231 KUL', merchant: 'ZZ', tries: 1, nextAt: Date.now() - 1000, at: 1, alternatives: [], ...patch }])); };
    it('settles it the moment a witness can, and takes it off the owner\'s list', async () => {
        const w = world({ board: () => agreed('Groceries') }); hold(w);
        expect(await w.M.reconsider()).toMatchObject({ retried: 1, resolved: 1 });
        expect(pend(w)).toEqual([]);
    });
    it('counts the try and waits longer when it is still hard', async () => {
        const w = world({}); hold(w, { tries: 2 });
        await w.M.reconsider();
        expect(pend(w)[0].tries).toBe(3);
        expect(pend(w)[0].nextAt - Date.now()).toBeGreaterThan(20 * 3600 * 1000);
    });
    it('leaves it alone before it is due and after four tries', async () => {
        const w = world({ board: () => agreed('Groceries') });
        hold(w, { nextAt: Date.now() + 3600000 });
        expect((await w.M.reconsider()).retried).toBe(0);
        hold(w, { tries: 4 });
        expect((await w.M.reconsider()).retried).toBe(0);
        expect(w.calls.ai).toHaveLength(0);
    });
});

describe('the same shop next month is recognised', () => {
    it('finds a learned merchant by its words, whatever else the narration carries, longest key first', () => {
        const w = world();
        w.M.learn('KEELLS SUPER WELLAWATTE 0231', 'expenses', 'Groceries', 1);
        w.M.learn('ZZ AMAZON PRIME 9911', 'subscription', 'Streaming', 1);
        w.M.learn('ZZ AMAZON 9911', 'expenses', 'Shopping', 1);
        expect(w.M.classify('POS KEELLS SUPER COLOMBO 03 REF 88123', 'debit')).toMatchObject({ category: 'Groceries', matched: expect.stringContaining('learned:') });
        expect(w.M.classify('IB ZZ AMAZON PRIME VIDEO 8822', 'debit')).toMatchObject({ category: 'Streaming' });
        expect(w.M.classify('ZZ AMAZON MARKETPLACE 1', 'debit')).toMatchObject({ category: 'Shopping' });
    });
    it('does not match a key that is too short to mean one business, or a name that only shares a word', () => {
        const w = world();
        w.M.learn('ZZ CEB 1234', 'expenses', 'Utilities', 1);
        w.M.learn('ZZ WIDGET SHOP 1234', 'expenses', 'Shopping', 1);
        expect(w.M._learnedHit('ZZ CEB COLOMBO')).toMatchObject({ key: 'zz ceb' });
        expect(w.M._learnedHit('CEB')).toBeNull();
        expect(w.M._learnedHit('WIDGET FACTORY OUTLET')).toBeNull();
        expect(w.M._learnedHit('ZZ')).toBeNull();
    });
});

describe('recognising a learned merchant stays fast', () => {
    it('classifies thousands of distinct narrations against hundreds of learned merchants well inside a page render', () => {
        const w = world();
        for (let i = 0; i < 400; i++) w.M.learn('ZQ' + i.toString(36) + ' TRADERS HOUSE ' + (1000 + i), 'expenses', 'Shopping', 1);
        const t0 = Date.now();
        for (let i = 0; i < 3000; i++) w.M.classify('POS SOMEONE ELSE ' + i + ' REF ' + (90000 + i), 'debit');
        expect(Date.now() - t0).toBeLessThan(1500);
        // and the index is rebuilt when the map changes, not served stale
        w.M.learn('QWERTY PLUMBING 5512', 'expenses', 'Utilities', 1);
        expect(w.M.classify('IB QWERTY PLUMBING COLOMBO 03', 'debit')).toMatchObject({ category: 'Utilities' });
        w.M.forgetLearned();
        expect(w.M.classify('IB QWERTY PLUMBING COLOMBO 03', 'debit')).toMatchObject({ category: 'Utilities' });
    });
});

describe('the sweep over what statements filed', () => {
    const rec = (over = {}) => ({ id: 'r' + Math.random(), source: 'statement', desc: 'POS KEELLS SUPER WELLAWATTE', cat: 'Other', amount: 10, date: '2026-01-02', ...over });
    it('applies what is already known to generic statement rows, and only those', async () => {
        const w = world({ records: { expenses: [rec(), rec({ cat: 'Dining' }), rec({ source: undefined }), rec({ desc: 'POS ZZ NOBODY KNOWS 7' })], cconetime: [rec({ category: 'Card Purchase', cat: undefined })] } });
        const out = w.M.applyLearned();
        expect(out.changed).toBe(2);
        expect(w.store.expenses.map(r => r.cat)).toEqual(['Groceries', 'Dining', 'Other', 'Other']);
        expect(w.store.expenses[0].categorySource).toBe('merchant-engine');
        expect(w.store.cconetime[0].category).toBe('Groceries');
        expect(w.writes.sort()).toEqual(['cconetime', 'expenses']);
        expect(w.M.applyLearned().changed).toBe(0);   // settled means settled
    });
    it('settles a merchant nobody knows by itself, then applies the answer to every row that carries it', async () => {
        const w = world({ board: () => agreed('Health'), records: { expenses: [rec({ desc: 'POS ZZQ BLORP 0231 KUL' }), rec({ desc: 'IB ZZQ BLORP 0232 KUL' }), rec({ desc: 'POS ZZQ BLORP 0233' })] } });
        expect(w.M.impact(w.M.merchantKey('POS ZZQ BLORP 0231 KUL'))).toBe(3);
        const out = await w.M.autopilot({ force: true });
        expect(out).toMatchObject({ discovered: 1, resolved: 1, held: 0 });
        expect(out.applied).toBe(3);
        expect(w.store.expenses.map(r => r.cat)).toEqual(['Health', 'Health', 'Health']);
        expect(w.M.autonomy()).toMatchObject({ settledByTheSystem: 1, waitingForYou: 0, lastApplied: 3 });
    });
    it('puts only the hard ones to the owner, ranked by how many rows the answer will change', async () => {
        const w = world({ board: () => ({ unanimous: false, trustworthy: false, consensusOf: 5, reply: null }), records: { expenses: [rec({ desc: 'POS ZZQ ALPHA 0231' }), ...Array.from({ length: 4 }, (_, i) => rec({ desc: 'POS ZZQ BETA 02' + i + '1' }))] } });
        const out = await w.M.autopilot({ force: true });
        expect(out).toMatchObject({ resolved: 0, held: 2 });
        expect(w.M.impact(w.M.merchantKey('POS ZZQ BETA 0201'))).toBe(4);
        expect(w.M.autonomy()).toMatchObject({ waitingForYou: 2 });
        // the owner's answer is learned and applied to all four
        expect(w.M.confirm(w.M.merchantKey('POS ZZQ BETA 0201'), 'Shopping')).toBe(true);
        expect(w.M.applyLearned().changed).toBe(4);
    });
    it('is throttled, unless forced, and does nothing without the app\'s data', async () => {
        const w = world({ records: { expenses: [] } });
        await w.M.autopilot({ force: true });
        expect(await w.M.autopilot()).toEqual({ skipped: true });
        const bare = world(); delete bare.win.DB;
        expect(await bare.M.autopilot({ force: true })).toEqual({ skipped: true });
    });
    it('never writes a category outside the taxonomy, or to a row it cannot vouch for', async () => {
        const w = world({ board: () => agreed('Pirate Supplies'), records: { expenses: [rec({ desc: 'POS ZZQ BLORP 0231' })] } });
        await w.M.autopilot({ force: true });
        expect(w.store.expenses[0].cat).toBe('Other');
        expect(w.writes).toEqual([]);
    });
});

describe('the review screen shows the hard cases in the order that matters', () => {
    it('puts the answer that changes the most first, shows what each witness said, and says how much the system did alone', () => {
        const held = [
            { key: 'a', raw: 'A SHOP', merchant: 'A', confidence: 0.5, alternatives: [], _impact: 0 },
            { key: 'b', raw: 'B SHOP', merchant: 'B', confidence: 0.2, alternatives: [{ category: 'Dining', source: 'web', conf: 0.9 }, { category: 'Groceries', source: 'ai', conf: 0.96 }], reason: 'the web and the AI board named different categories' },
        ];
        const impacts = { a: 1, b: 7 };
        const win = { WFMerchants: { pending: () => held, impact: k => impacts[k], autonomy: () => ({ settledByTheSystem: 12, waitingForYou: 2 }), CATEGORIES: ['Dining', 'Groceries'] }, document: { getElementById: () => null } };
        new Function('window', 'document', 'console', PANEL)(win, win.document, { log() {} });
        let html = '';
        win.WFVerifyPanel.render({ set innerHTML(v) { html = v; }, get innerHTML() { return html; }, querySelectorAll: () => [] });
        expect(html.indexOf('B SHOP')).toBeLessThan(html.indexOf('A SHOP'));
        expect(html).toContain('will categorise 7 transactions');
        expect(html).toContain('Web search: Dining'); expect(html).toContain('AI board: Groceries');
        expect(html).toContain('the web and the AI board named different categories');
    });
});
