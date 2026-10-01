import { describe, it, expect, beforeEach } from 'vitest';
import { createModelBook } from '../ai-models.mjs';
import { DEFAULT_MODEL, classifyGeminiError, geminiGenerate, geminiKeyOf, mimeOfBase64, msUntilQuotaReset, resetGeminiLearning } from '../gemini-client.mjs';

/**
 * Google's AI Studio dashboard for the project key listed 404, 429, 503, 400 and 403 — every one a request the project made knowing,
 * or able to know, that it would fail: retired model names in eleven hand-written callers, a Pro model on a key with no Pro quota,
 * a model asked again seconds after "retry in 40 s". These tests pin the behaviour that stops that, against Google's real answer
 * shapes (the JSON error envelope with RetryInfo / QuotaFailure details).
 */

const quotaBody = ({ id = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', value = '10', retry = '12s', message = 'You exceeded your current quota' } = {}) => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message, details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: id, quotaValue: value }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: retry }] } });
const errBody = (code, status, message) => JSON.stringify({ error: { code, status, message } });
const GONE = errBody(404, 'NOT_FOUND', 'This model models/gemini-2.0-flash is no longer available to new users. Please update your code to use a newer model.');
const OK = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], ...extra });
const LIST = { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }, { name: 'models/text-embedding-9', supportedGenerationMethods: ['embedContent'] }] };

/** A scripted Google: `answers[model]` is a queue of { status, body } | { ok: json }; the model list is answered from LIST. */
function google(answers = {}, { list = LIST } = {}) {
    const calls = [];
    const queues = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
    const fetcher = async (url, init) => {
        const u = String(url);
        if (/\/models\?/.test(u)) { calls.push({ list: true }); return { ok: true, status: 200, json: async () => list, text: async () => JSON.stringify(list) }; }
        const model = /models\/([^:]+):generateContent/.exec(u)[1];
        const body = JSON.parse(init.body);
        calls.push({ model, body });
        const q = queues[model] || [];
        const next = q.length > 1 ? q.shift() : q[0] || { ok: OK('hello from ' + model) };
        if (next.ok) return { ok: true, status: 200, json: async () => next.ok, text: async () => JSON.stringify(next.ok) };
        return { ok: false, status: next.status, json: async () => JSON.parse(next.body), text: async () => next.body };
    };
    return { fetcher, calls, models: () => calls.filter((c) => c.model).map((c) => c.model), lists: () => calls.filter((c) => c.list).length };
}

let clock, book, sleeps;
const base = () => ({ key: 'k', parts: [{ text: 'hi' }], book, now: () => clock.t, sleep: async (ms) => { sleeps.push(ms); clock.t += ms; }, log: () => {} });
beforeEach(() => { clock = { t: 1_800_000_000_000 }; book = createModelBook({ now: () => clock.t }); sleeps = []; resetGeminiLearning(); });

describe('reading what Google said', () => {
    it('a model that is gone, however Google words it', () => {
        expect(classifyGeminiError(404, GONE).kind).toBe('gone');
        expect(classifyGeminiError(404, errBody(404, 'NOT_FOUND', 'models/gemini-1.5-pro is not found for API version v1beta, or is not supported for generateContent.')).kind).toBe('gone');
        expect(classifyGeminiError(410, '').kind).toBe('gone');
    });
    it('a per-minute quota carries Google\'s own "retry in", and the quota value to pace against', () => {
        const c = classifyGeminiError(429, quotaBody());
        expect(c).toMatchObject({ kind: 'quota-minute', retryAfterMs: 12000, quotaValue: 10, parkMs: 12000 });
        // a very short or very long retry is clamped: never a busy loop, never parked for ever
        expect(classifyGeminiError(429, quotaBody({ retry: '0.2s' })).parkMs).toBe(5000);
        expect(classifyGeminiError(429, quotaBody({ retry: '4000s' })).parkMs).toBe(300000);
        // the message form, when there are no details
        expect(classifyGeminiError(429, errBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded. Please retry in 41.5s.')).retryAfterMs).toBe(41500);
    });
    it('a per-DAY quota is parked until the quota resets, and "limit: 0" (no quota for this model at all) for a day', () => {
        const day = classifyGeminiError(429, quotaBody({ id: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', value: '250', retry: '' }));
        expect(day.kind).toBe('quota-day');
        expect(day.parkMs).toBeGreaterThanOrEqual(10 * 60 * 1000); expect(day.parkMs).toBeLessThanOrEqual(24 * 3600 * 1000);
        const zero = classifyGeminiError(429, errBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-pro'));
        expect(zero).toMatchObject({ kind: 'quota-zero', parkMs: 24 * 3600 * 1000 });
    });
    it('a busy model, a key problem, a region problem, and a setting the model does not take are all told apart', () => {
        for (const [status, body] of [[503, errBody(503, 'UNAVAILABLE', 'The model is overloaded.')], [500, errBody(500, 'INTERNAL', 'Internal error')], [504, errBody(504, 'DEADLINE_EXCEEDED', 'x')], [502, '<html>bad gateway</html>']]) expect(classifyGeminiError(status, body).kind).toBe('overloaded');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.')).kind).toBe('key');
        expect(classifyGeminiError(403, errBody(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked. Please use another API key.')).kind).toBe('key');
        expect(classifyGeminiError(403, errBody(403, 'PERMISSION_DENIED', 'Generative Language API has not been used in project 123 before or it is disabled.')).kind).toBe('key');
        expect(classifyGeminiError(403, errBody(403, 'PERMISSION_DENIED', 'Requests from referer <empty> are blocked.')).kind).toBe('key');
        expect(classifyGeminiError(400, errBody(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.')).kind).toBe('region');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'JSON mode is not enabled for this model; response_mime_type unsupported')).kind).toBe('bad-json-mode');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'Thinking level is not supported for this model.')).kind).toBe('bad-thinking');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'Invalid safety setting: HARM_CATEGORY_X')).kind).toBe('bad-safety');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'max_output_tokens must be at most 8192')).kind).toBe('bad-tokens');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'Unable to process input image. Please retry with a different image.')).kind).toBe('bad-image');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'The input token count exceeds the maximum number of tokens allowed.')).kind).toBe('too-long');
        expect(classifyGeminiError(400, errBody(400, 'INVALID_ARGUMENT', 'Something else entirely')).kind).toBe('bad-request');
    });
    it('nonsense in, an answer out — it never throws', () => {
        for (const [s, t] of [[0, undefined], [200, null], [429, '{'], [500, 12], [418, '[]'], [undefined, {}]]) expect(() => classifyGeminiError(s, t)).not.toThrow();
        expect(classifyGeminiError(418, '').kind).toBe('other');
    });
    it('the daily reset is between ten minutes and a day away, whatever the hour', () => {
        for (let h = 0; h < 24; h++) { const ms = msUntilQuotaReset(Date.UTC(2026, 9, 1, h, 17, 0)); expect(ms).toBeGreaterThanOrEqual(600000); expect(ms).toBeLessThanOrEqual(86400000); }
    });
});

describe('small helpers', () => {
    it('the key is found under the project\'s own name first', () => {
        expect(geminiKeyOf({ WealthFlow_API_Key: ' a ', GEMINI_API_KEY: 'b' })).toBe('a');
        expect(geminiKeyOf({ GEMINI_API_KEY: 'b' })).toBe('b');
        expect(geminiKeyOf({ GOOGLE_API_KEY: 'c' })).toBe('c');
        expect(geminiKeyOf({ WealthFlow_API_Key: '  ' })).toBe('');
        expect(geminiKeyOf({})).toBe('');
    });
    it('an image is sent as what it is', () => {
        expect(mimeOfBase64('/9j/4AAQSkZJRg==')).toBe('image/jpeg');
        expect(mimeOfBase64('iVBORw0KGgo=')).toBe('image/png');
        expect(mimeOfBase64('UklGRiQAAABXRUJQ')).toBe('image/webp');
        expect(mimeOfBase64('JVBERi0xLjQ=')).toBe('application/pdf');
        expect(mimeOfBase64('data:image/png;base64,iVBORw0KGgo=')).toBe('image/png');
        expect(mimeOfBase64('????')).toBe('image/jpeg');
        expect(mimeOfBase64(undefined)).toBe('image/jpeg');
    });
});

describe('one call, done properly', () => {
    it('asks the model the dashboard shows serving the key, in the shape Google takes, and remembers it', async () => {
        const g = google();
        const r = await geminiGenerate({ ...base(), fetcher: g.fetcher, json: true, thinking: 'low', temperature: 0.1, maxOutputTokens: 2500, system: 'be brief' });
        expect(r.text).toBe('hello from ' + DEFAULT_MODEL);
        expect(g.models()).toEqual([DEFAULT_MODEL]); expect(g.lists()).toBe(0);
        const body = g.calls[0].body;
        expect(body.generationConfig).toMatchObject({ temperature: 0.1, maxOutputTokens: 2500, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'low' } });
        expect(body.systemInstruction.parts[0].text).toBe('be brief');
        expect(body.safetySettings).toHaveLength(4);
        expect(body.contents[0].role).toBe('user');
        expect(book.current('Gemini:any')).toBe(DEFAULT_MODEL);
    });
    it('thinking is only asked of the families that take it, in the form they take', async () => {
        const g25 = google({ 'gemini-2.5-flash': { ok: OK('x') } });
        book.remember('Gemini:any', 'gemini-2.5-flash');
        await geminiGenerate({ ...base(), fetcher: g25.fetcher, thinking: 'low' });
        expect(g25.calls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
        const gp = google({ 'gemini-3.8-pro': { ok: OK('x') } });
        book.remember('Gemini:any', 'gemini-3.8-pro');
        await geminiGenerate({ ...base(), fetcher: gp.fetcher, thinking: 'low' });
        expect(gp.calls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' });
        const gx = google({ 'some-future-model': { ok: OK('x') } });
        book.remember('Gemini:any', 'some-future-model');
        await geminiGenerate({ ...base(), fetcher: gx.fetcher, thinking: 'low' });
        expect(gx.calls[0].body.generationConfig.thinkingConfig).toBeUndefined();
        // and nothing at all unless the caller asked
        const g0 = google(); await geminiGenerate({ ...base(), fetcher: g0.fetcher });
        expect(g0.calls[0].body.generationConfig.thinkingConfig).toBeUndefined();
        expect(g0.calls[0].body.generationConfig.responseMimeType).toBeUndefined();
    });
    it('joins every text part and never returns the model\'s thoughts', async () => {
        const g = google({ [DEFAULT_MODEL]: { ok: { candidates: [{ content: { parts: [{ text: 'secret reasoning', thought: true }, { text: 'A' }, { text: 'B' }] }, finishReason: 'STOP' }] } } });
        expect((await geminiGenerate({ ...base(), fetcher: g.fetcher })).text).toBe('AB');
    });

    describe('a retired model', () => {
        it('is asked ONCE: the provider\'s own list names the replacement, which is remembered; the next call goes straight there', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 404, body: GONE } });
            const first = await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(g.models()).toEqual([DEFAULT_MODEL, 'gemini-2.5-flash']); expect(g.lists()).toBe(1);
            expect(first.model).toBe('gemini-2.5-flash');
            const again = await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(g.models()).toEqual([DEFAULT_MODEL, 'gemini-2.5-flash', 'gemini-2.5-flash']);   // the dead model is not asked again
            expect(again.model).toBe('gemini-2.5-flash');
        });
        it('a hundred calls after a retirement cost exactly one failing request — the whole point', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 404, body: GONE } });
            for (let i = 0; i < 100; i++) await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(g.models().filter((m) => m === DEFAULT_MODEL)).toHaveLength(1);
        });
        it('an unreachable model list leaves Google\'s own error, not a loop', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 404, body: GONE } }, { list: { models: [] } });
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toMatchObject({ kind: 'gone', status: 404, message: expect.stringMatching(/^Gemini status 404: /) });
            expect(g.models()).toEqual([DEFAULT_MODEL]);
        });
    });

    describe('a quota', () => {
        it('moves to another model at once (the quota is per model) and parks the first for as long as Google said', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 429, body: quotaBody({ retry: '30s' }) } });
            const first = await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(first.model).toBe('gemini-2.5-flash');
            // inside the 30 s: straight to the other model, the parked one is not touched
            clock.t += 20000;
            await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(g.models().filter((m) => m === DEFAULT_MODEL)).toHaveLength(1);
        });
        it('a per-day quota is not probed again for hours; "limit: 0" not for a day', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 429, body: quotaBody({ id: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', value: '250', retry: '' }) } });
            await geminiGenerate({ ...base(), fetcher: g.fetcher });
            clock.t += 5 * 60 * 1000;
            await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(g.models().filter((m) => m === DEFAULT_MODEL)).toHaveLength(1);
            expect(book.isBad('Gemini:any', DEFAULT_MODEL)).toBe(true);
            const z = google({ [DEFAULT_MODEL]: { status: 429, body: errBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded ... limit: 0') } });
            const b2 = createModelBook({ now: () => clock.t });
            await geminiGenerate({ ...base(), book: b2, fetcher: z.fetcher });
            clock.t += 23 * 3600 * 1000;
            expect(b2.isBad('Gemini:any', DEFAULT_MODEL)).toBe(true);
            clock.t += 2 * 3600 * 1000;
            expect(b2.isBad('Gemini:any', DEFAULT_MODEL)).toBe(false);
        });
        it('when EVERY model is out of quota the answer is Google\'s own 429, the call count is bounded, and nothing loops', async () => {
            const every = Object.fromEntries(['gemini-3.8-flash', 'gemini-3.8-flash-lite', 'gemini-2.5-flash', 'gemini-3.8-pro'].map((m) => [m, { status: 429, body: quotaBody() }]));
            const g = google(every);
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toMatchObject({ kind: 'quota-minute', status: 429, retryAfterMs: 12000, message: expect.stringMatching(/^Gemini status 429/) });
            expect(g.models().length).toBeLessThanOrEqual(4);
            // and the very next call, inside the park, makes no request to a model that is parked
            const before = g.models().length;
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toBeTruthy();
            expect(g.models().length).toBe(before);
        });
        it('once Google has said "10 a minute", the client stays under 80% of it instead of finding out again', async () => {
            const g = google({ [DEFAULT_MODEL]: [{ status: 429, body: quotaBody({ value: '10', retry: '1s' }) }, { ok: OK('a') }] });
            await geminiGenerate({ ...base(), fetcher: g.fetcher });           // learns: 10/min → soft limit 8
            clock.t += 6000;                                                    // the park (min 5 s) is over
            g.calls.length = 0;
            const used = [];
            for (let i = 0; i < 12; i++) { const r = await geminiGenerate({ ...base(), fetcher: g.fetcher }); used.push(r.model); }
            expect(used.filter((m) => m === DEFAULT_MODEL).length).toBeLessThanOrEqual(8);
            expect(used.some((m) => m !== DEFAULT_MODEL)).toBe(true);
        });
    });

    describe('a busy model', () => {
        it('is asked once more after a short pause, on the same model', async () => {
            const g = google({ [DEFAULT_MODEL]: [{ status: 503, body: errBody(503, 'UNAVAILABLE', 'The model is overloaded.') }, { ok: OK('second time') }] });
            const r = await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(r.text).toBe('second time'); expect(r.model).toBe(DEFAULT_MODEL);
            expect(sleeps).toHaveLength(1); expect(sleeps[0]).toBeGreaterThanOrEqual(400); expect(sleeps[0]).toBeLessThan(1200);
        });
        it('still busy: another model answers, and the busy one is left alone for a little while', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 503, body: errBody(503, 'UNAVAILABLE', 'overloaded') } });
            const r = await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(r.model).toBe('gemini-2.5-flash');
            expect(g.models().filter((m) => m === DEFAULT_MODEL)).toHaveLength(2);
            await geminiGenerate({ ...base(), fetcher: g.fetcher });
            expect(g.models().filter((m) => m === DEFAULT_MODEL)).toHaveLength(2);
        });
        it('with no time to spare it does not wait — it moves on', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 503, body: errBody(503, 'UNAVAILABLE', 'overloaded') } });
            const r = await geminiGenerate({ ...base(), fetcher: g.fetcher, deadlineMs: 6000 });
            expect(sleeps).toHaveLength(0); expect(r.model).toBe('gemini-2.5-flash');
        });
    });

    describe('a setting this model does not take', () => {
        it('JSON mode: re-sent without it, once, and remembered so the next call is not a 400 again', async () => {
            const g = google({ [DEFAULT_MODEL]: [{ status: 400, body: errBody(400, 'INVALID_ARGUMENT', 'JSON mode is not supported with this model (response_mime_type)') }, { ok: OK('{"a":1}') }] });
            const r = await geminiGenerate({ ...base(), fetcher: g.fetcher, json: true });
            expect(r.text).toBe('{"a":1}');
            expect(g.calls[0].body.generationConfig.responseMimeType).toBe('application/json');
            expect(g.calls[1].body.generationConfig.responseMimeType).toBeUndefined();
            await geminiGenerate({ ...base(), fetcher: g.fetcher, json: true });
            expect(g.calls[2].body.generationConfig.responseMimeType).toBeUndefined();
            expect(g.calls).toHaveLength(3);
        });
        it('thinking: re-sent without it, once, remembered', async () => {
            const g = google({ [DEFAULT_MODEL]: [{ status: 400, body: errBody(400, 'INVALID_ARGUMENT', 'Thinking level "low" is not supported for this model.') }, { ok: OK('x') }] });
            await geminiGenerate({ ...base(), fetcher: g.fetcher, thinking: 'low' });
            expect(g.calls[1].body.generationConfig.thinkingConfig).toBeUndefined();
            await geminiGenerate({ ...base(), fetcher: g.fetcher, thinking: 'low' });
            expect(g.calls[2].body.generationConfig.thinkingConfig).toBeUndefined();
        });
        it('safety settings, and a token limit above what the model allows', async () => {
            const g = google({ [DEFAULT_MODEL]: [{ status: 400, body: errBody(400, 'INVALID_ARGUMENT', 'Invalid safety setting HARM_CATEGORY_HARASSMENT') }, { status: 400, body: errBody(400, 'INVALID_ARGUMENT', 'max_output_tokens is too large; the maximum is 8192') }, { ok: OK('x') }] });
            const r = await geminiGenerate({ ...base(), fetcher: g.fetcher, maxOutputTokens: 20000 });
            expect(r.text).toBe('x');
            expect(g.calls[1].body.safetySettings).toBeUndefined();
            expect(g.calls[2].body.generationConfig.maxOutputTokens).toBe(8192);
        });
        it('a 400 about a setting that was never sent is NOT retried (it cannot be fixed by sending less)', async () => {
            const g = google({ [DEFAULT_MODEL]: { status: 400, body: errBody(400, 'INVALID_ARGUMENT', 'JSON mode is not supported') } });
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toMatchObject({ kind: 'bad-json-mode' });
            expect(g.calls).toHaveLength(1);
        });
    });

    describe('what is not worth a second request', () => {
        it('a key problem, a region, an image Google cannot read, a prompt that is too long: ONE request, Google\'s own message', async () => {
            for (const [status, body, kind] of [[403, errBody(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked.'), 'key'], [400, errBody(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'), 'key'], [400, errBody(400, 'FAILED_PRECONDITION', 'User location is not supported for the API use.'), 'region'], [400, errBody(400, 'INVALID_ARGUMENT', 'Unable to process input image.'), 'bad-image'], [400, errBody(400, 'INVALID_ARGUMENT', 'The input token count exceeds the maximum.'), 'too-long']]) {
                const g = google({ [DEFAULT_MODEL]: { status, body } });
                await expect(geminiGenerate({ ...base(), book: createModelBook({ now: () => clock.t }), fetcher: g.fetcher })).rejects.toMatchObject({ kind, status, message: new RegExp(`^Gemini status ${status}: `) });
                expect(g.calls).toHaveLength(1);
            }
        });
        it('a safety block is final and says so', async () => {
            const g = google({ [DEFAULT_MODEL]: { ok: { promptFeedback: { blockReason: 'SAFETY' } } } });
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toThrow('Blocked by Google Safety');
            expect(g.calls).toHaveLength(1);
        });
        it('a request that ran out of time is the caller\'s deadline: it propagates, nothing is asked again', async () => {
            let n = 0;
            const fetcher = async () => { n++; const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e; };
            await expect(geminiGenerate({ ...base(), fetcher })).rejects.toThrow(/aborted/);
            expect(n).toBe(1);
        });
        it('no time left means no request', async () => {
            const g = google();
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher, deadlineMs: 800 })).rejects.toMatchObject({ kind: 'deadline' });
            expect(g.calls).toHaveLength(0);
        });
    });

    describe('an empty answer', () => {
        it('one emptied by thinking (MAX_TOKENS) is asked again with room to answer', async () => {
            const empty = { candidates: [{ content: {}, finishReason: 'MAX_TOKENS' }] };
            const g = google({ [DEFAULT_MODEL]: [{ ok: empty }, { ok: OK('the answer') }] });
            const r = await geminiGenerate({ ...base(), fetcher: g.fetcher, maxOutputTokens: 2500 });
            expect(r.text).toBe('the answer');
            expect(g.calls[0].body.generationConfig.maxOutputTokens).toBe(2500);
            expect(g.calls[1].body.generationConfig.maxOutputTokens).toBe(5000);
        });
        it('an empty answer that is not about the budget gets one quiet retry, then says it is empty', async () => {
            const empty = { candidates: [{ content: {}, finishReason: 'STOP' }] };
            const g = google({ [DEFAULT_MODEL]: { ok: empty } });
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toThrow('Gemini returned an empty response');
            expect(g.calls).toHaveLength(2);
        });
        it('a refusal by Google\'s filters is reported as that, not as empty', async () => {
            const g = google({ [DEFAULT_MODEL]: { ok: { candidates: [{ content: {}, finishReason: 'PROHIBITED_CONTENT' }] } } });
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher })).rejects.toThrow('Blocked by Google Safety');
        });
    });

    describe('the strong reader', () => {
        it('has its own slot, finds a pro model from the list, and a key with no pro quota costs one request, not one per scan', async () => {
            const g = google({ 'gemini-3.8-pro': { status: 429, body: errBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric ... limit: 0, model: gemini-3.8-pro') } });
            await expect(geminiGenerate({ ...base(), fetcher: g.fetcher, tier: 'pro' })).rejects.toBeTruthy().catch(() => {});
            const first = g.models();
            expect(first[0]).toBe('gemini-3.8-pro');
            for (let i = 0; i < 20; i++) await geminiGenerate({ ...base(), fetcher: g.fetcher, tier: 'pro' }).catch(() => {});
            expect(g.models().filter((m) => m === 'gemini-3.8-pro')).toHaveLength(1);
            // and the fast slot is untouched by any of it
            expect(book.current('Gemini:any')).toBe('');
        });
    });

    it('an environment override is honoured first, and replaced like any other model if it is gone', async () => {
        const g = google({ 'gemini-9-custom': { status: 404, body: GONE } });
        const r = await geminiGenerate({ ...base(), fetcher: g.fetcher, model: 'gemini-9-custom' });
        expect(g.models()[0]).toBe('gemini-9-custom');
        expect(r.model).toBe('gemini-3.8-flash');
    });
    it('refuses to start without a key or without anything to read', async () => {
        await expect(geminiGenerate({ ...base(), key: '' })).rejects.toThrow('Gemini key not configured');
        await expect(geminiGenerate({ ...base(), parts: [] })).rejects.toThrow('Gemini needs something to read');
    });
    it('the key travels in the query, URL-encoded, and a model name is never built from anything but the book', async () => {
        const urls = [];
        const fetcher = async (url) => { urls.push(String(url)); return { ok: true, status: 200, json: async () => OK('x'), text: async () => '' }; };
        await geminiGenerate({ ...base(), key: 'a b&c', fetcher });
        expect(urls[0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=a%20b%26c`);
    });
});
