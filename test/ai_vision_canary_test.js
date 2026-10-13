import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import handler, { modelBook, resetProviderCooldowns, resetHealthMemory } from '../api/ai.js';
import { resetReasoningLearning } from '../ai-chat.mjs';
import { resetGeminiLearning } from '../gemini-client.mjs';
import { CANARY_IMAGE_B64, CANARY_IMAGE_TRUTH } from '../ai-canary-image.mjs';
import { CANARY_GAP_MS, DOC, VISION_DOC, VISION_CANARY_PROMPT, scoreVision, visionReportOf, visionVerdictOf, serveHealth, saveReport, loadReport } from '../ai-health.mjs';
import { KEYS, response, world } from './helpers/ai-world.js';

/* THE RECEIPT READERS, MEASURED THE WAY THE BOARD IS. `GET /api/ai?canary=vision` shows a made-up receipt (vendor ACME MART, total 1250.00) to every
 * provider that can read an image and reports who read it right. The text canary says whether the board agrees about WORDS; this says whether the
 * scanner's engines can see. */

beforeEach(() => { resetHealthMemory(); vi.stubEnv('AI_CANARY_DEADLINE_MS', '2000'); });
afterEach(() => { modelBook.reset(); resetProviderCooldowns(); resetReasoningLearning(); resetGeminiLearning(); resetHealthMemory(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const RIGHT = '{"vendor":"ACME MART","amount":1250}';

describe('the receipt', () => {
    it('is a real JPEG a model can open, small enough to send on every run, and its answer is what the scorer expects', () => {
        const bytes = Buffer.from(CANARY_IMAGE_B64, 'base64');
        expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        expect([...bytes.subarray(bytes.length - 2)]).toEqual([0xff, 0xd9]);
        expect(bytes.length).toBeLessThan(16 * 1024);
        expect(CANARY_IMAGE_B64.startsWith('/9j/')).toBe(true);
        expect(CANARY_IMAGE_TRUTH).toEqual({ vendor: 'ACME MART', amount: 1250 });
        expect(VISION_CANARY_PROMPT).toMatch(/JSON/);
        expect(VISION_CANARY_PROMPT).toMatch(/TOTAL/);
    });

    it('carries nothing of the owner\'s: a fixed picture, no key-shaped or personal text', () => {
        const text = Buffer.from(CANARY_IMAGE_B64, 'base64').toString('latin1');
        expect(text).not.toMatch(/[0-9a-f]{32}\.[A-Za-z0-9]{20,}/);
    });
});

describe('scoreVision: what one provider read off the receipt', () => {
    it('right vendor and right total', () => {
        expect(scoreVision(RIGHT)).toEqual({ vendor: true, amount: true });
        expect(scoreVision('```json\n{"vendor":"acme mart","amount":"1,250.00"}\n```')).toEqual({ vendor: true, amount: true });
        expect(scoreVision('Here you go: {"merchant":"ACME MART Ltd","total":"LKR 1250.00"} hope that helps')).toEqual({ vendor: true, amount: true });
    });
    it('each half is judged on its own — a right store with the wrong number is not a pass', () => {
        expect(scoreVision('{"vendor":"ACME MART","amount":125}')).toEqual({ vendor: true, amount: false });
        expect(scoreVision('{"vendor":"KEELLS","amount":1250}')).toEqual({ vendor: false, amount: true });
        expect(scoreVision('{"vendor":"","amount":0}')).toEqual({ vendor: false, amount: false });
        expect(scoreVision('{"vendor":"ACME MART"}')).toEqual({ vendor: true, amount: false });
    });
    it('anything that is not a JSON object is null, never a throw', () => {
        for (const junk of [null, undefined, '', 'I cannot read images', '{broken', '[1,2]', 5, '```', 'OK\r\n']) expect(scoreVision(junk), String(junk)).toBeNull();
    });
});

describe('the report and the sentence', () => {
    const probe = [
        { name: 'Slow', ok: true, ms: 9000, provider: 'slow-vision-model', reply: RIGHT },
        { name: 'Wrong', ok: true, ms: 700, provider: 'wrong-model', reply: '{"vendor":"ACME MART","amount":12}' },
        { name: 'Down', ok: false, ms: 120, error: 'Down status 429: ' + 'slow down '.repeat(60) },
        { name: 'Fast', ok: true, ms: 800, provider: 'fast-model', reply: '```json\n' + RIGHT + '\n```' },
        { name: 'Words', ok: true, ms: 300, provider: 'chatty', reply: 'I see a receipt from a shop.' },
    ];
    const report = visionReportOf({ decision: { unanimous: false, reason: 'provider_disagreement', minimumProviders: 5 }, probe, ms: 12000, at: 7 });

    it('names who read it, who answered but read it wrong, who failed and why; those that read it come first, fastest first', () => {
        expect(report.kind).toBe('vision');
        expect(report.summary.reading).toEqual(['Fast', 'Slow']);
        expect(report.summary.answeredWrong).toEqual(['Words', 'Wrong']);
        expect(report.summary.failing).toHaveLength(1);
        expect(report.providers.map((p) => p.name)).toEqual(['Fast', 'Slow', 'Words', 'Wrong', 'Down']);
        expect(report.providers.find((p) => p.name === 'Words')).toMatchObject({ ok: true, why: 'not-json', read: { vendor: false, amount: false } });
        expect(report.board).toMatchObject({ asked: 5, answered: 4, floor: 5, unanimous: false, reason: 'provider_disagreement' });
    });

    it('a failure keeps enough of its words to say where the provider stopped (the model chain), but never a key', () => {
        const down = report.providers.find((p) => p.name === 'Down');
        expect(down.error.length).toBeGreaterThan(140);
        expect(down.error.length).toBeLessThanOrEqual(400);
        const leaky = visionReportOf({ decision: {}, probe: [{ name: 'X', ok: false, ms: 1, error: 'failed https://x.example/v1?key=abc123SECRET456&alt=json Bearer abcdefghijklmnop0123456789' }] });
        const text = JSON.stringify(leaky);
        expect(text).not.toContain('abc123SECRET456'); expect(text).not.toContain('abcdefghijklmnop0123456789');
    });

    it('the verdict is one sentence a person can act on', () => {
        expect(visionVerdictOf(report)).toMatch(/^GOOD — 2 of 5 providers read the receipt right \(Fast, Slow\); answered but read it wrong: Words, Wrong/);
        expect(visionVerdictOf(visionReportOf({ decision: {}, probe: [{ name: 'A', ok: true, ms: 1, provider: 'a', reply: RIGHT }, { name: 'B', ok: false, ms: 1, error: 'B status 402' }] }))).toMatch(/^THIN — 1 of 2/);
        expect(visionVerdictOf(visionReportOf({ decision: {}, probe: [{ name: 'A', ok: true, ms: 1, provider: 'a', reply: 'no' }] }))).toMatch(/^NO PROVIDER READ THE RECEIPT — 1 of 1 answered \(read it wrong: A\)/);
        expect(visionVerdictOf(visionReportOf({ decision: {}, probe: [] }))).toMatch(/^NO PROVIDER ASKED/);
        expect(visionVerdictOf(null)).toBe('no vision report yet');
    });
});

describe('serveHealth: the vision report has its own shelf', () => {
    const makeDb = () => {
        const store = new Map();
        return { store, getDb: async () => ({ db: { collection: (c) => ({ doc: (id) => ({ get: async () => ({ exists: store.has(`${c}/${id}`), data: () => store.get(`${c}/${id}`) }), set: async (v) => { store.set(`${c}/${id}`, v); } }) }) } }) };
    };
    const call = async (url, deps) => { const res = response(); await serveHealth({ method: 'GET', url, headers: {} }, res, deps); return res; };
    const board = (probe) => vi.fn(async (_req, res) => res.status(200).json({ unanimous: false, reason: 'provider_disagreement', minimumProviders: 5, probe }));

    it('?canary=vision asks the board the receipt question with the image, stores the report under canary-vision, and leaves the text report alone', async () => {
        const { store, getDb } = makeDb();
        const run = board([{ name: 'A', ok: true, ms: 10, provider: 'a', reply: RIGHT }]);
        const res = await call('/api/ai?canary=vision', { run, getDb, withDeadline: (p) => p });
        expect(res.code).toBe(200);
        expect(res.body).toMatchObject({ ok: true, cached: false });
        expect(res.body.verdict).toMatch(/^THIN — 1 of 1/);
        expect(res.body.report.kind).toBe('vision');
        const sent = run.mock.calls[0][0];
        expect(sent.body).toMatchObject({ image: CANARY_IMAGE_B64, prompt: VISION_CANARY_PROMPT, financialDecision: true, mode: 'unanimous' });
        expect(sent.__probe).toBe(true);
        expect([...store.keys()]).toEqual([`${VISION_DOC.collection}/${VISION_DOC.id}`]);
        expect(VISION_DOC.id).not.toBe(DOC.id);
        expect(await loadReport(getDb, (p) => p, DOC)).toBeNull();
        expect((await loadReport(getDb, (p) => p, VISION_DOC)).kind).toBe('vision');
    });

    it('is rate-limited like the text canary: a young report is served and the board is not called again', async () => {
        const { getDb } = makeDb();
        let clock = 1_000_000;
        const run = board([{ name: 'A', ok: true, ms: 10, provider: 'a', reply: RIGHT }]);
        const deps = { run, getDb, withDeadline: (p) => p, now: () => clock };
        await call('/api/ai?canary=vision', deps);
        for (let i = 0; i < 4; i++) { const again = await call('/api/ai?canary=vision', deps); expect(again.body.cached).toBe(true); }
        expect(run).toHaveBeenCalledTimes(1);
        clock += CANARY_GAP_MS + 1;
        expect((await call('/api/ai?canary=vision', deps)).body.cached).toBe(false);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('?health=vision only reads: no provider is called, and with no report it says so', async () => {
        const { getDb } = makeDb();
        const run = board([]);
        const none = await call('/api/ai?health=vision', { run, getDb, withDeadline: (p) => p });
        expect(none.body).toMatchObject({ ok: true, report: null, verdict: 'no vision report yet' });
        expect(run).not.toHaveBeenCalled();
    });

    it('a text canary and a vision canary do not read each other\'s report', async () => {
        const { getDb } = makeDb();
        await saveReport(getDb, (p) => p, { at: Date.now(), kind: 'vision', summary: { reading: [], answeredWrong: [], failing: [] }, board: { asked: 0 } }, VISION_DOC);
        const run = board([]);
        const text = await call('/api/ai?health=1', { run, getDb, withDeadline: (p) => p });
        expect(text.body.report).toBeNull();
        expect(text.body.verdict).toBe('no report yet');
    });
});

describe('GET /api/ai?canary=vision, through the real endpoint', () => {
    const get = async (url) => { const res = response(); await handler({ method: 'GET', url, headers: {} }, res); return res; };

    it('asks the providers that can read an image — with the image, not just the words — and reports who read it', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        const w = world({ answer: RIGHT }); vi.stubGlobal('fetch', w.fetch);
        const res = await get('/api/ai?canary=vision');
        expect(res.code).toBe(200);
        expect(res.body.report.kind).toBe('vision');
        expect(res.body.report.providers.length).toBeGreaterThan(3);
        expect(res.body.report.summary.reading.length).toBeGreaterThan(0);
        // the picture really went out, to more than one provider, in the form each provider takes it
        const withImage = w.log.filter((c) => JSON.stringify(c.body).includes(CANARY_IMAGE_B64.slice(0, 40)));
        expect(withImage.length).toBeGreaterThan(3);
        // …and what was asked is the fixed receipt question, nothing of the owner's
        expect(w.log.some((c) => JSON.stringify(c.body).includes('Read this receipt image'))).toBe(true);
    });

    it('a plain GET is still refused; the vision canary never answers without ?canary / ?health', async () => {
        for (const key of KEYS) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', world({ answer: RIGHT }).fetch);
        expect((await get('/api/ai')).code).toBe(405);
        expect((await get('/api/ai?vision=1')).code).toBe(405);
    });
});
