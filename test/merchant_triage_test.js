/* =============================================================================
 * test/merchant_triage_test.js — merchants are placed from evidence, or put to the owner; never guessed, never dropped
 * -----------------------------------------------------------------------------
 * WHAT WAS MEASURED BEFORE ANY CODE CHANGED (merchants.json, 950 merchants, each wrapped as "POS TRANSACTION <name> COLOMBO 03")
 *
 *   emailed statements (server, expenseCategoryFor)   584 of 950 known merchants filed as "Other"   — the list was never given to the server
 *   the app (WFMerchants.analyze)                     747 of 950 known merchants reported "AMBIGUOUS_REQUIRES_SEARCH", queued as
 *                                                     unknown and sent to the web and the AI board — because the curated registry
 *                                                     scores 0.9 and the "needs a search" line was drawn at the 0.95 WRITE gate.
 *                                                     With the providers out of quota, every one of them became a question for the owner.
 *   the app, first-listed-wins                        16 known merchants given the wrong category; 36 flagged "ambiguous" by a different
 *                                                     rule than the one that classified them
 *   "ZXQ TRADERS"                                     filed confidently as Shopping (the word "traders")
 *   "PAYME-VISA*COLOMBO"                              named "Payme Visa", queried on the web, or dropped (no key)
 *
 * The cases below are GENERATED, so thousands run every time. They check properties, not remembered answers.
 * ===========================================================================*/

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { classifyMerchant, inquiryFor, isGatewayOnly, merchantWords, registryLookup, REGISTRY_SIZE, SERVER_CATEGORY } from '../statement-merchants.mjs';
import { expenseCategoryFor, expenseRuleCategory, CLASSIFY_CATEGORIES } from '../wealthflow-statement-router.js';
import { repairCategoriesInUser } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MERCHANTS_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'merchants.json'), 'utf8'));
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-merchants.js'), 'utf8');
const row = narration => ({ narration, amount: 1500, direction: 'debit', directionSource: 'marker', needsReview: false, valid: true, date: '2026-09-02' });

// a seeded generator: the same "random" cases on every run, so a failure is reproducible
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
const pick = (r, list) => list[Math.floor(r() * list.length)];

// what a terminal, a payment gateway or a bank wraps around a merchant
const WRAPS = [
    s => s, s => s.toUpperCase(), s => ` ${s}  `, s => `POS TRANSACTION ${s} COLOMBO 03`, s => `POS ${s} LK`, s => `ECOM TXN ${s}`, s => `VISA DEBIT 4532******1234 ${s}`, s => `${s} 4029357733 SG`,
    s => `PAYPAL *${s}`, s => `SQ *${s}`, s => `IPG*${s}`, s => `PAYHERE*${s}`, s => `PAYME-VISA*${s}`, s => `PAYME VISA ${s} KANDY LK`, s => `CARD PURCHASE ${s} REF 884422`,
    s => `${s}/COLOMBO`, s => `${s} 4829 LK`, s => `TXN REF: AB12CD34 ${s}`, s => `${s} AMZ2K4TY1QR0 US`, s => `MERCH-${s}`,
];

const registry = MERCHANTS_JSON.merchants.filter(m => SERVER_CATEGORY[m.category]);

describe('the email pipeline knows the merchants the app knows', () => {
    it('loads the registry', () => {
        expect(REGISTRY_SIZE).toBeGreaterThan(700);
        expect(registry.length).toBeGreaterThan(800);
    });
    it('files at least nine in ten of the registry\'s merchants under a category (was 38%)', () => {
        const placed = registry.filter(m => expenseCategoryFor(row(`POS TRANSACTION ${m.key.toUpperCase()} COLOMBO 03`)) !== 'Other').length;
        expect(placed / registry.length).toBeGreaterThan(0.9);
    });
    it('every category it can name is one the AI board and the app accept', () => {
        for (const category of Object.values(SERVER_CATEGORY).filter(Boolean)) expect(CLASSIFY_CATEGORIES, category).toContain(category);
    });
});

describe('the merchant list is held to the router\'s own rules', () => {
    /* A merchant the list names more specifically than a brand word in the rules (so the longer name is what filing follows). Anything NOT here that disagrees with a rule is a data
     * error: "sri lanka transport board" was Insurance in merchants.json (an AI-consensus entry) and, once the list was trusted, would have filed bus fares as insurance. */
    const REFINEMENTS = new Set(['arpico insurance', 'medical insurance', 'softlogic finance life', 'softlogic life', 'amazon web', 'amazon web services', 'amazon prime', 'amazon prime video', 'playstation network', 'xbox', 'slt peo tv']);
    it('every registry merchant either agrees with the rules or is a named refinement of them', () => {
        const bad = registry.filter(m => { const rule = expenseRuleCategory({ narration: m.key }); return rule && rule !== SERVER_CATEGORY[m.category] && !REFINEMENTS.has(m.key); }).map(m => `${m.key}: list says ${m.category}, rules say ${expenseRuleCategory({ narration: m.key })}`);
        expect(bad).toEqual([]);
    });
    it('every named refinement is still in the list (this allowlist cannot go stale)', () => {
        const keys = new Set(registry.map(m => m.key));
        for (const key of REFINEMENTS) expect(keys.has(key), key).toBe(true);
    });
});

describe('a merchant keeps its answer whatever the terminal wraps around it', () => {
    const cases = registry.flatMap(m => WRAPS.map((wrap, k) => ({ key: m.key, k, text: wrap(m.key) })));
    it(`${cases.length} generated statement lines (registry × ${WRAPS.length} wrappers)`, () => {
        const failures = [];
        for (const c of cases) {
            const bare = JSON.stringify(classifyMerchant(c.key)), wrapped = JSON.stringify(classifyMerchant(c.text));
            if (bare !== wrapped) failures.push(`${c.text} → ${wrapped}, bare ${bare}`);
        }
        expect(failures.slice(0, 15), `${failures.length} of ${cases.length}`).toEqual([]);
        expect(cases.length).toBeGreaterThan(15000);
    });
    it('and the category does not depend on letter case or spacing', () => {
        for (const m of registry.slice(0, 300)) {
            const a = classifyMerchant(m.key), b = classifyMerchant(m.key.toUpperCase().replace(/ /g, '   ')), c = classifyMerchant(m.key.replace(/ /g, '-'));
            expect(JSON.stringify(b), m.key).toBe(JSON.stringify(a));
            expect(JSON.stringify(c), m.key).toBe(JSON.stringify(a));
        }
    });
});

describe('a merchant that is not known is never given a guess', () => {
    const r = rng(20261002);
    const syllables = ['zxq', 'blor', 'kup', 'vee', 'tam', 'qua', 'nol', 'ris', 'fep', 'dax', 'moz', 'hul', 'yib', 'wen'];
    const trade = ['TRADERS', 'ENTERPRISES', 'STORES', 'DISTRIBUTORS', 'TECHNOLOGIES', 'HOLDINGS', 'AGENCIES', '& SONS'];
    const unknown = Array.from({ length: 400 }, () => `${pick(r, syllables)}${pick(r, syllables)} ${pick(r, syllables)}${pick(r, syllables)} ${pick(r, trade)}`.toUpperCase());
    it(`${unknown.length * WRAPS.length} generated unknown merchants stay "Other" and carry a question`, () => {
        const wrong = [];
        for (const name of unknown) for (const wrap of WRAPS) {
            const text = wrap(name);
            // a generated name can by chance contain a real registry word; those are not "unknown" and are skipped, not counted
            if (registryLookup(name)) continue;
            const category = expenseCategoryFor(row(text));
            const ask = inquiryFor(text);
            if (category !== 'Other' || !ask || !['unknown', 'no-merchant-name'].includes(ask.reason)) wrong.push(`${text} → ${category} ${JSON.stringify(ask)}`);
        }
        expect(wrong.slice(0, 10), `${wrong.length} wrong`).toEqual([]);
    });
    it('a gateway, a card network and a town are not a merchant', () => {
        for (const text of ['PAYME-VISA*COLOMBO', 'PAYME VISA COLOMBO 03 LK', 'POS TRANSACTION - MIRIGAMA', 'IPG*KANDY', 'SQ *', 'VISA DEBIT 4532******1234 COLOMBO LK', 'ECOM TXN 4829 LK', 'PAYPAL *SG']) {
            expect(isGatewayOnly(text), text).toBe(true);
            expect(expenseCategoryFor(row(text)), text).toBe('Other');
            expect(inquiryFor(text), text).toMatchObject({ state: 'open', reason: 'no-merchant-name' });
        }
    });
    it('"how it trades" words alone never place a business', () => {
        for (const text of ['ZXQ TRADERS', 'PERERA ENTERPRISES', 'SILVA STORES', 'LANKA DISTRIBUTORS', 'ACME TECHNOLOGIES PVT LTD']) expect(expenseCategoryFor(row(text)), text).toBe('Other');
    });
    it('what a business sells does place it, whoever it is', () => {
        const want = { 'SUNRISE BAKERS PVT LTD': 'Dining', 'GREEN LEAF PHARMACY': 'Health', 'ROYAL JEWELLERS': 'Gold', 'ANURA FILLING STATION': 'Fuel', 'LAKE VIEW SUPERMARKET': 'Groceries', 'CITY INSTITUTE': 'Education' };
        for (const [text, category] of Object.entries(want)) for (const wrap of WRAPS) expect(expenseCategoryFor(row(wrap(text))), wrap(text)).toBe(category);
    });
});

describe('two kinds of business that fit equally well are an ambiguity, not a pick', () => {
    const family = c => (c === 'Telecom' || c === 'Internet' ? 'net' : c);
    const keys = registry.filter(m => m.key.split(' ').length === 1 && m.key.length >= 5 && (classifyMerchant(m.key) || {}).basis === 'registry');
    const r = rng(7);
    it('two unrelated registry names on one line: no silent winner, and the order they appear in does not matter', () => {
        let ambiguous = 0, checked = 0;
        for (let n = 0; n < 3000; n++) {
            const a = pick(r, keys), b = pick(r, keys);
            if (family(a.category) === family(b.category) || SERVER_CATEGORY[a.category] === SERVER_CATEGORY[b.category] || a.key.includes(b.key) || b.key.includes(a.key)) continue;
            const ab = classifyMerchant(`${a.key} ${b.key}`), ba = classifyMerchant(`${b.key} ${a.key}`);
            if ((ab && ab.words >= 2) || (ba && ba.words >= 2)) continue;     // the two words happen to be a registry name of their own ("laugfs supermarket")
            checked++;
            expect(ab.ambiguous, `${a.key} + ${b.key}`).toBe(true);
            expect(ba.ambiguous, `${b.key} + ${a.key}`).toBe(true);
            expect([...ab.candidates].sort(), `${a.key} + ${b.key}`).toEqual([...ba.candidates].sort());
            expect(ab.category).toBeNull();
            ambiguous++;
        }
        expect(checked).toBeGreaterThan(1000);
        expect(ambiguous).toBe(checked);
    });
    it('an ambiguous line is filed as "Other" and the question carries the candidates', () => {
        expect(expenseCategoryFor(row('ZZQ BAKERS JEWELLERS'))).toBe('Other');
        expect(inquiryFor('ZZQ BAKERS JEWELLERS')).toMatchObject({ state: 'open', reason: 'ambiguous' });
        expect(inquiryFor('ZZQ BAKERS JEWELLERS').candidates.sort()).toEqual(['Dining', 'Gold']);
    });
    it('two known merchants on one line stay "Other" even when one brand word is also in the rules (KEELLS ODEL)', () => {
        expect(expenseCategoryFor(row('POS KEELLS ODEL COLOMBO'))).toBe('Other');
        expect(inquiryFor('POS KEELLS ODEL COLOMBO')).toMatchObject({ state: 'open', reason: 'ambiguous' });
        expect(inquiryFor('POS KEELLS ODEL COLOMBO').candidates.sort()).toEqual(['Groceries', 'Shopping']);
        expect(expenseCategoryFor(row('POS KEELLS SUPER COLOMBO'))).toBe('Groceries');
    });
    it('a longer name inside which a shorter one sits is not a conflict ("amazon prime" is not also "amazon")', () => {
        expect(expenseCategoryFor(row('AMAZON PRIME'))).toBe('Entertainment');
        expect(expenseCategoryFor(row('AMAZON PRIME VIDEO LK'))).toBe('Entertainment');
        expect(expenseCategoryFor(row('AMAZON WEB SERVICES'))).toBe('Subscriptions');
        expect(expenseCategoryFor(row('AMAZON'))).toBe('Shopping');
    });
});

describe('adversarial input never throws and never takes long', () => {
    const r = rng(99);
    const alphabet = ['a', 'Z', '0', '9', ' ', '*', '-', '/', '.', '\\', '(', ')', '[', ']', '^', '$', '|', '+', '?', '{', '}', '😀', 'ß', 'İ', 'ǅ', '\u0000', '\n', '\t', 'ａ', '٣', '。', 'ā'];
    const junk = len => Array.from({ length: len }, () => pick(r, alphabet)).join('');
    it('5,000 random strings of every length, plus null, undefined, numbers, objects and a megabyte', () => {
        const inputs = [null, undefined, 0, 12.5, NaN, {}, [], true, '', ' ', '\n', 'x'.repeat(1_000_000), ('KEELLS SUPER ').repeat(40000), junk(100000)];
        for (let i = 0; i < 5000; i++) inputs.push(junk(Math.floor(r() * 120)));
        const started = Date.now();
        for (const input of inputs) {
            expect(() => { classifyMerchant(input); inquiryFor(input); isGatewayOnly(input); merchantWords(input); expenseCategoryFor({ narration: input }); }).not.toThrow();
            const out = classifyMerchant(input);
            expect(out === null || typeof out === 'object').toBe(true);
            if (out && out.category) expect(typeof out.category).toBe('string');
        }
        expect(Date.now() - started).toBeLessThan(20000);
    });
    it('is deterministic: the same line gives the same answer, in any order, any number of times', () => {
        const lines = registry.slice(0, 200).map(m => WRAPS[(m.key.length) % WRAPS.length](m.key));
        const first = lines.map(l => JSON.stringify([classifyMerchant(l), inquiryFor(l)]));
        for (let pass = 0; pass < 3; pass++) lines.slice().reverse().forEach((l, i) => expect(JSON.stringify([classifyMerchant(l), inquiryFor(l)])).toBe(first[lines.length - 1 - i]));
    });
    it('a line is never classified by a stray fragment of another word', () => {
        for (const text of ['SPARE PARTS DEPOT', 'GOLDEN KEY HOSPITAL', 'WALMART', 'BOXING DAY', 'BUSINESS CLASS', 'FUELLED', 'TOLLIVER', 'TAXIDERMY']) {
            const out = classifyMerchant(text);
            expect(out && out.basis === 'registry' && ['spar', 'gold', 'mart', 'box', 'bus', 'fuel', 'toll', 'taxi'].includes(out.key), text).toBeFalsy();
        }
    });
});

// ── the app's own engine ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function world({ records = {} } = {}) {
    const mem = new Map(), calls = { verify: 0, ai: 0, asked: [] };
    const store = Object.fromEntries(Object.entries(records).map(([k, v]) => [k, structuredClone(v)]));
    const win = {
        localStorage: { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) },
        DB: { get: k => store[k] || [], set: (k, v) => { store[k] = v; } },
    };
    const fetchStub = async (url, options) => {
        if (String(url).includes('/api/verify')) { calls.verify++; try { calls.asked.push(JSON.parse(options.body).merchant); } catch (_) {} return { ok: true, json: async () => ({ exists: 'unknown', abstain_reason: 'no_search_results', evidence_urls: [] }) }; }
        if (String(url).includes('/api/ai')) { calls.ai++; return { ok: true, json: async () => ({ unanimous: false }) }; }
        return { ok: true, json: async () => MERCHANTS_JSON };
    };
    new Function('window', 'console', 'fetch', SRC)(win, { log() {}, warn() {} }, fetchStub);
    return { M: win.WFMerchants, store, calls, mem };
}

describe('the app no longer asks about merchants it knows', () => {
    it('none of the registry\'s merchants is queued as unknown, except the few the list itself disagrees about (was 747 of 950)', async () => {
        const w = world();
        await new Promise(resolve => setTimeout(resolve, 30));      // the auto-updated list loads in the background
        let queued = 0; const names = [];
        for (const m of MERCHANTS_JSON.merchants) if (w.M.discover(`POS TRANSACTION ${m.key.toUpperCase()} COLOMBO 03`, 'debit')) { queued++; names.push(m.key); }
        expect(queued, names.join(', ')).toBeLessThanOrEqual(5);
    });
    it('a name the registry identifies is MATCHED; an unknown trade name is a SEARCH', () => {
        const { M } = world();
        for (const text of ['KEELLS SUPER COLOMBO 03', 'HEMAS PHARMACY', 'ODEL PVT LTD', 'CARGILLS FOOD CITY', 'AMAZON PRIME']) expect(M.analyze(`POS TRANSACTION ${text}`, 'debit').system_action, text).toBe('MATCHED_AND_VERIFIED');
        for (const text of ['ZXQ TRADERS', 'PERERA ENTERPRISES', 'SILVA STORES']) expect(M.analyze(`POS TRANSACTION ${text}`, 'debit').system_action, text).toBe('AMBIGUOUS_REQUIRES_SEARCH');
    });
    it('most-specific name wins and a genuine conflict is declined, not picked', () => {
        const { M } = world();
        expect(M.classify('POS SOFTLOGIC LIFE INSURANCE COLOMBO', 'debit')).toMatchObject({ category: 'Insurance', confidence: 0.9 });
        expect(M.classify('POS MEDICAL INSURANCE', 'debit').category).toBe('Insurance');
        const clash = M.classify('POS SAMPATH INSURANCE FUEL STATION', 'debit');
        expect(clash.confidence).toBeLessThan(0.85);
        expect(M.refine('POS SAMPATH INSURANCE FUEL STATION', 'debit', { tab: 'expenses', category: 'Other' })).toBeNull();
    });
    it('questions saved by the earlier version for merchants the engine now knows are dropped, with no web or AI call spent on them', async () => {
        const w = world();
        await new Promise(resolve => setTimeout(resolve, 30));
        const stale = ['POS TRANSACTION KEELLS SUPER COLOMBO 03', 'POS TRANSACTION HEMAS PHARMACY', 'POS TRANSACTION ODEL PVT LTD'];
        w.mem.set('wf_merchant_unknown', JSON.stringify(stale.map(raw => ({ key: raw.toLowerCase().slice(16, 30), raw, name: raw, at: 1 }))));
        w.mem.set('wf_merchant_pending', JSON.stringify([{ key: 'cargills food city', raw: 'POS TRANSACTION CARGILLS FOOD CITY', merchant: 'Cargills', type: '', alternatives: [], tries: 1, nextAt: 0, at: 1 }, { key: 'zxq traders', raw: 'POS ZXQ TRADERS', merchant: 'Zxq', type: '', alternatives: [], tries: 1, nextAt: 0, at: 1 }]));
        expect(w.M.pending().map(h => h.key)).toEqual(['zxq traders']);      // the known one is gone, the genuinely unknown one stays
        expect(w.M.unknowns()).toEqual([]);
        await w.M.resolveUnknowns(); await w.M.reconsider();
        expect(w.calls.asked.length).toBeGreaterThan(0);
        expect(w.calls.asked.every(name => /zxq/i.test(name))).toBe(true);   // only the unknown one is ever asked about
    });
    it('a line that names only a gateway goes straight to the owner and spends no web search and no AI call', async () => {
        const w = world();
        for (const text of ['PAYME-VISA*COLOMBO', 'PAYME VISA COLOMBO 03 LK', 'POS TRANSACTION - MIRIGAMA']) expect(w.M.discover(text, 'debit'), text).toBeTruthy();
        const result = await w.M.resolveUnknowns();
        expect([w.calls.verify, w.calls.ai]).toEqual([0, 0]);
        expect(result.resolved).toBe(0);
        const held = w.M.pending();
        expect(held.length).toBe(3);
        expect(held.every(h => h.reason && /gateway|place/.test(h.reason) && h.tries >= 4)).toBe(true);
        // asked again later by the autopilot? no: it has used all its tries
        expect((await w.M.reconsider()).retried).toBe(0);
        expect([w.calls.verify, w.calls.ai]).toEqual([0, 0]);
    });
    it('the same opaque line is one question, however many times it is filed', () => {
        const w = world();
        for (let i = 0; i < 20; i++) w.M.discover(`PAYME-VISA*COLOMBO 0${i}`, 'debit');
        expect(w.M.pending().length).toBe(1);
    });
    it('a gateway wrapper does not change a merchant\'s key, so the same shop is learned once', () => {
        const { M } = world();
        const keys = new Set(['KEELLS SUPER', 'PAYME-VISA*KEELLS SUPER', 'IPG*KEELLS SUPER', 'PAYHERE*KEELLS SUPER', 'POS TRANSACTION KEELLS SUPER COLOMBO 03'].map(t => M.merchantKey(t)));
        expect([...keys]).toEqual(['keells super']);
    });
});

describe('the email pipeline\'s question reaches the Merchant review, and the owner\'s own category is never touched', () => {
    const expenses = [
        { id: 'a', source: 'statement', desc: 'PAYME-VISA*COLOMBO', cat: 'Other', amount: 100, merchantReview: { state: 'open', reason: 'no-merchant-name', key: 'payme visa colombo', candidates: [] } },
        { id: 'b', source: 'statement', desc: 'KUP TRADERS', cat: 'Other', amount: 200, merchantReview: { state: 'open', reason: 'unknown', key: 'kup traders', candidates: [] } },
        { id: 'c', source: 'statement', desc: 'ZZQ CORNER MIX', cat: 'Other', amount: 300, merchantReview: { state: 'open', reason: 'ambiguous', key: 'zzq corner mix', candidates: ['Entertainment', 'Subscriptions', 'Pirate'] } },
        { id: 'd', source: 'statement', desc: 'KEELLS SUPER', cat: 'Gift', amount: 400 },                 // the owner set this by hand
        { id: 'e', source: 'manual', desc: 'KEELLS SUPER', cat: 'Other', amount: 500 },                    // not from a statement
    ];
    it('autopilot holds the question rows for the owner with the candidates mapped to the app\'s names, and changes no amount', async () => {
        const w = world({ records: { expenses } });
        w.M.autopilot({ force: true });
        await new Promise(resolve => setTimeout(resolve, 60));
        const held = w.M.pending();
        const byRaw = Object.fromEntries(held.map(h => [h.raw, h]));
        expect(byRaw['PAYME-VISA*COLOMBO']).toBeTruthy();
        expect(byRaw['ZZQ CORNER MIX'].alternatives.map(a => a.category)).toEqual(['Streaming', 'Software']);   // 'Pirate' is not a category; Entertainment/Subscriptions are the app's Streaming/Software
        expect(w.store.expenses.map(x => x.amount)).toEqual([100, 200, 300, 400, 500]);
        expect(w.store.expenses.find(x => x.id === 'd').cat).toBe('Gift');
        expect(w.store.expenses.find(x => x.id === 'e').cat).toBe('Other');
    });
    it('answering the question categorises the rows and closes the question', async () => {
        const w = world({ records: { expenses: [{ id: 'z', source: 'statement', desc: 'POS TRANSACTION OLD CORNER SHOP', cat: 'Other', amount: 50, merchantReview: { state: 'open', reason: 'unknown', key: 'old corner shop', candidates: [] } }, ...expenses] } });
        w.M.learn('POS TRANSACTION OLD CORNER SHOP', 'expenses', 'Groceries', 1, 'user');
        expect(w.M.applyLearned().changed).toBeGreaterThanOrEqual(1);
        const z = w.store.expenses.find(x => x.id === 'z');
        expect(z).toMatchObject({ cat: 'Groceries', categorySource: 'merchant-engine' });
        expect(z.merchantReview.state).toBe('resolved');
        expect(w.store.expenses.find(x => x.id === 'd').cat).toBe('Gift');
    });
});

describe('filing keeps the money and carries the question', () => {
    const base = { date: '2026-09-10', amount: 42.1, direction: 'debit', directionSource: 'column', needsReview: false };
    function fakeDb(initial) {
        const docs = new Map(Object.entries(initial));
        const collection = p => ({ doc: id => ref(p + '/' + id), where: (field, op, value) => ({ query: true, path: p, field, value }) });
        const ref = p => ({ path: p, id: p.split('/').at(-1), collection: name => collection(p + '/' + name) });
        return { docs, collection, doc: ref, async runTransaction(fn) {
            const pending = []; let writing = false;
            const result = await fn({ async get(r) { if (writing) throw new Error('read-after-write'); if (r.query) return { docs: [...docs.entries()].filter(([p, d]) => p.startsWith(r.path + '/') && d[r.field] === r.value).map(([p, d]) => ({ id: p.split('/').at(-1), data: () => structuredClone(d) })) }; return { exists: docs.has(r.path), data: () => structuredClone(docs.get(r.path)) }; }, set(r, value, opts) { writing = true; pending.push([r.path, structuredClone(value), opts]); } });
            for (const [p, value, opts] of pending) docs.set(p, opts?.merge ? { ...docs.get(p), ...value } : value);
            return result;
        } };
    }
    it('an unplaced merchant is filed under "Other" with its question; a placed one carries none; the amount is the statement\'s', async () => {
        const db = fakeDb({ 'users/u': {}, 'sources/s': { uid: 'u', cursor: 0, leaseToken: 't', leaseUntil: 9000 } });
        const rows = [{ ...base, description: 'PAYME-VISA*COLOMBO' }, { ...base, description: 'KUP TRADERS', amount: 10.05 }, { ...base, description: 'POS KEELLS SUPER COLOMBO 03', amount: 99.99 }];
        const decisions = rows.map(x => ({ module: 'expenses', category: expenseCategoryFor(x), verified: true, deterministic: true }));
        const out = await settleStatement({ db, uid: 'u', sourceRef: db.collection('sources').doc('s'), leaseToken: 't', now: 1000, rows, decisions, cursor: 0, totalRows: 3, bank: 'Bank', last4: '1234' });
        expect(out).toMatchObject({ filed: 3, review: 0 });
        const filed = db.docs.get('users/u').expenses;
        expect(filed.map(x => x.amount)).toEqual([42.1, 10.05, 99.99]);
        expect(filed[0]).toMatchObject({ cat: 'Other', merchantReview: { state: 'open', reason: 'no-merchant-name' } });
        expect(filed[1]).toMatchObject({ cat: 'Other', merchantReview: { state: 'open', reason: 'unknown' } });
        expect(filed[2].cat).toBe('Food & Groceries');                    // the classifier says Groceries; the row is filed under the dropdown's name (test/category_entry_name_test.js)
        expect(filed[2].merchantReview).toBeUndefined();
    });
    it('the repair gives older "Other" rows their question once, closes answered ones, and never touches a category the owner chose', () => {
        const original = { expenses: [
            { id: 'a', source: 'statement', desc: 'PAYME-VISA*COLOMBO', cat: 'Other', amount: 100 },
            { id: 'b', source: 'statement', desc: 'SUNRISE BAKERS PVT LTD', cat: 'Other', amount: 200, merchantReview: { state: 'open', reason: 'unknown', key: 'sunrise bakers', candidates: [] } },
            { id: 'c', source: 'statement', desc: 'KEELLS SUPER', cat: 'Gift', amount: 300, merchantReview: { state: 'open', reason: 'unknown', key: 'keells super', candidates: [] } },
            { id: 'd', source: 'manual', desc: 'PAYME-VISA*COLOMBO', cat: 'Other', amount: 400 },
        ] };
        const first = repairCategoriesInUser(original);
        expect(first.user.expenses[0].merchantReview).toMatchObject({ state: 'open', reason: 'no-merchant-name' });
        expect(first.user.expenses[1]).toMatchObject({ cat: 'Dining', categorySource: 'statement-taxonomy-v1' });
        expect(first.user.expenses[1].merchantReview.state).toBe('resolved');
        expect(first.user.expenses[2]).toMatchObject({ cat: 'Gift' });
        expect(first.user.expenses[2].merchantReview.state).toBe('resolved');
        expect(first.user.expenses[3]).toEqual(original.expenses[3]);
        expect(first.user.expenses.map(x => x.amount)).toEqual([100, 200, 300, 400]);
        const second = repairCategoriesInUser(first.user);
        expect(second).toMatchObject({ total: 0, asked: 0 });                 // idempotent: nothing to write the second time
    });
});
