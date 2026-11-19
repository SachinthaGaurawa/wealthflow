/* Owner 2026-11-19: the system must learn which providers have credit, use those and the free ones, and stop wasting calls on
 * the rest. The roll call asks every keyed provider once; no-credit and refused keys are set aside before work is dealt out. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    permanentReason, failureKind, probeProviders, rollCallMarkdown, benchedProviders, _resetBench, _resetHealedModels,
    assignProviders, orderFor, chat, PROVIDERS,
} from '../wf-llm-router.mjs';

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const ok = (t = 'OK') => reply(200, { choices: [{ message: { content: t } }] });

describe('no credit is recognised in every wording', () => {
    it('Anthropic 400, OpenAI-style 429 quota, Cohere trial cap and 402 are permanent; a minute rate limit is not', () => {
        expect(permanentReason(400, '{"error":{"message":"Your credit balance is too low to access the Anthropic API"}}')).toMatch(/no credit/);
        expect(permanentReason(429, 'You exceeded your current quota, please check your plan and billing details')).toMatch(/quota or credit/);
        expect(permanentReason(429, 'insufficient_quota')).toMatch(/quota or credit/);
        expect(permanentReason(429, 'You are using a Trial key, which is limited to 1000 API calls / month')).toMatch(/quota or credit/);
        expect(permanentReason(402, '')).toMatch(/payment/);
        expect(permanentReason(429, 'Rate limit reached for requests, retry in 20s')).toBe(null);
        expect(permanentReason(400, 'Invalid request: messages must not be empty')).toBe(null);
        expect(failureKind(permanentReason(400, 'credit balance is too low'))).toBe('credit');
        expect(failureKind(permanentReason(401, 'x'))).toBe('key');
        expect(failureKind('something else')).toBe('other');
    });
});

describe('roll call', () => {
    let file, calls;
    const env = { GROQ_API_KEY: 'k1', MISTRAL_API_KEY: 'k2', CEREBRAS_API_KEY: 'k3', ANTHROPIC_API_KEY: 'k4' };
    beforeEach(() => {
        _resetBench(); _resetHealedModels(); calls = [];
        file = path.join(os.tmpdir(), `wf-health-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
        env.WF_PROVIDER_HEALTH_FILE = file;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.stubGlobal('fetch', async (url) => {
            const id = /groq/.test(url) ? 'groq' : /mistral/.test(url) ? 'mistral' : /cerebras/.test(url) ? 'cerebras' : /anthropic/.test(url) ? 'anthropic' : 'other';
            calls.push(id);
            if (id === 'groq') return ok();
            if (id === 'mistral') return reply(429, 'Rate limit reached for requests');
            if (id === 'cerebras') return reply(402, 'payment required');
            return reply(400, '{"error":{"message":"Your credit balance is too low"}}');
        });
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); try { fs.unlinkSync(file); } catch { /* none */ } });

    it('names each provider ok, credit or rate, and sets the no-credit ones aside', async () => {
        const rows = await probeProviders({ env, force: true });
        const by = Object.fromEntries(rows.map((r) => [r.id, r.status]));
        expect(by).toEqual({ cerebras: 'credit', groq: 'ok', mistral: 'rate', anthropic: 'credit' });
        expect(benchedProviders().map((b) => b.provider).sort()).toEqual(['anthropic', 'cerebras']);
    });

    it('a second process of the same job reads the answer instead of asking again', async () => {
        await probeProviders({ env, force: true });
        const n = calls.length;
        _resetBench();
        const rows = await probeProviders({ env });
        expect(calls.length).toBe(n);
        expect(rows.every((r) => r.cached)).toBe(true);
        expect(benchedProviders().map((b) => b.provider).sort()).toEqual(['anthropic', 'cerebras']);   // and they are set aside again
    });

    it('a reviewer is never dealt a provider that has no credit', async () => {
        await probeProviders({ env, force: true });
        const lanes = assignProviders([{ name: 'a', prefer: ['code'] }, { name: 'b', prefer: ['fast'] }], { env });
        const dealt = lanes.flatMap((l) => [l.primary, ...l.fallbacks, ...l.shared]).filter(Boolean);
        expect(dealt).not.toContain('cerebras');
        expect(dealt).not.toContain('anthropic');
        expect(dealt).toContain('groq');
    });

    it('the table says who answers and what only the owner can fix, by exact key name', async () => {
        const md = rollCallMarkdown(await probeProviders({ env, force: true }), { env });
        expect(md).toMatch(/1 of 4 answer/);
        expect(md).toMatch(/CEREBRAS_API_KEY \(add credit\)/);
        expect(md).toMatch(/ANTHROPIC_API_KEY \(add credit\)/);
        expect(md).not.toMatch(/MISTRAL_API_KEY \(/);
    });
});

describe('equal providers share the work', () => {
    beforeEach(() => { _resetBench(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('the provider asked least goes first among providers that fit the role equally; WF_ROUTER_SPREAD=0 keeps registry order', async () => {
        const env = { DEEPSEEK_API_KEY: 'a', MISTRAL_API_KEY: 'b', FIREWORKS_API_KEY: 'c' };
        vi.stubGlobal('fetch', async () => ok('x'));
        const first = orderFor({ prefer: ['code'], env }).map((p) => p.id);
        expect(first[0]).toBe('deepseek');
        await chat({ prompt: 'hi', prefer: ['code'], env, maxTokens: 8 });          // deepseek answers and has now been used once
        const second = orderFor({ prefer: ['code'], env }).map((p) => p.id);
        expect(second[0]).not.toBe('deepseek');
        expect(orderFor({ prefer: ['code'], env: { ...env, WF_ROUTER_SPREAD: '0' } })[0].id).toBe('deepseek');
    });

    it('Ollama Cloud is a provider, asked with the key the workflows already forward', () => {
        const p = PROVIDERS.find((x) => x.id === 'ollama');
        expect(p.keys).toEqual(['OLLAMA_API_KEY']);
        expect(orderFor({ env: { OLLAMA_API_KEY: 'x' } }).map((q) => q.id)).toEqual(['ollama']);
    });
});
