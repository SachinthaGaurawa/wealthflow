import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { PROBE_WORDS, probeHtml, wordsFound, probeVerdict, run, renderProbeImage } from '../autonomy/vision-probe.mjs';

describe('vision probe: does the reader read a picture', () => {
    it('the invented words appear in the picture html and nowhere else in the repository', () => {
        const html = probeHtml();
        for (const w of PROBE_WORDS) {
            expect(html).toContain(w);
            for (const f of ['index.html', 'wf-screenshot-reader.mjs', 'autonomous-fix-agent.js']) {
                expect(fs.readFileSync(f, 'utf8').includes(w), `${w} must not appear in ${f}`).toBe(false);
            }
        }
    });

    it('finds words ignoring case, spacing and thousands commas', () => {
        expect(wordsFound('I see QUARTZ  harbor and lkr 48271.50 here')).toEqual(['Quartz Harbor', 'LKR 48,271.50']);
        expect(wordsFound('a blue rectangle')).toEqual([]);
        expect(wordsFound('')).toEqual([]);
    });

    it('passes with two of three words, fails with one or none, and says which provider answered', () => {
        const ok = probeVerdict({ ok: true, text: 'Quartz Harbor LKR 48,271.50', provider: 'github-models', model: 'openai/gpt-4.1' });
        expect(ok.ok).toBe(true);
        expect(ok.reason).toMatch(/github-models\/openai\/gpt-4\.1 returned 2 of 3/);
        const one = probeVerdict({ ok: true, text: 'Quartz Harbor and something', provider: 'x', model: 'y' });
        expect(one.ok).toBe(false);
        expect(one.reason).toMatch(/did not read the picture/);
        expect(probeVerdict({ ok: true, text: 'a card', provider: 'x', model: 'y' }).ok).toBe(false);
    });

    it('a provider that never answered fails with every HTTP reason, never a pass', () => {
        const v = probeVerdict({ ok: false, tried: ['github-models/openai/gpt-4.1: HTTP 403', 'github-models/openai/gpt-4o: HTTP 403'] });
        expect(v.ok).toBe(false);
        expect(v.reason).toMatch(/HTTP 403; github-models\/openai\/gpt-4o: HTTP 403/);
        expect(probeVerdict(null).ok).toBe(false);
        expect(probeVerdict({ ok: false, tried: [] }).reason).toMatch(/no vision-capable credential/);
    });

    it('run() renders, asks one reader without a cross-check, and returns the verdict', async () => {
        const calls = [];
        const v = await run({
            env: {}, log: () => {},
            renderImpl: async () => 'data:image/png;base64,AAAA',
            describeImpl: async (a) => { calls.push(a); return { ok: true, text: 'Quartz Harbor / LKR 48,271.50 / Ledger 7Q', provider: 'github-models', model: 'm' }; },
        });
        expect(v.ok).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0].verify).toBe(false);
        expect(calls[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    });

    it('renders a real PNG in a browser when one is available', async () => {
        let url;
        try { url = await renderProbeImage(); } catch (e) { return; }   // no Chromium here: CI has it
        expect(url).toMatch(/^data:image\/png;base64,iVBOR/);
        expect(url.length).toBeGreaterThan(3000);
    });

    it('the workflow passes only the run token, asks for models:read and changes nothing', () => {
        const y = fs.readFileSync('.github/workflows/vision-probe.yml', 'utf8');
        expect(y).toMatch(/models:\s*read/);
        expect(y).toMatch(/contents:\s*read/);
        expect(y).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
        expect(y).toMatch(/node autonomy\/vision-probe\.mjs/);
    });
});

describe('vision probe: diagnosis when the picture was not read', () => {
    it('asks the catalogue and a text-only question, printing only status and a short head of the body', async () => {
        const { diagnose } = await import('../autonomy/vision-probe.mjs');
        const seen = [];
        const fetchImpl = async (url, init) => { seen.push({ url: String(url), init }); return { status: 200, text: async () => 'OK\n' + 'x'.repeat(500) }; };
        const lines = await diagnose({ env: { GITHUB_TOKEN: 'tok' }, fetchImpl });
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatch(/^catalogue: HTTP 200 OK x+$/);
        expect(lines[0].length).toBeLessThan(140);
        expect(seen[0].url).toBe('https://models.github.ai/catalog/models');
        expect(seen[1].init.method).toBe('POST');
        expect(JSON.parse(seen[1].init.body).messages[0].content).toMatch(/PONG/);
        expect(seen[0].init.headers.Authorization).toBe('Bearer tok');
    });

    it('a network error is reported, never thrown, and run() only diagnoses a failure', async () => {
        const { diagnose, run } = await import('../autonomy/vision-probe.mjs');
        expect((await diagnose({ env: {}, fetchImpl: async () => { throw new Error('boom'); } }))[0]).toBe('catalogue: boom');
        const logged = [];
        let diagnosed = 0;
        const base = { env: {}, log: (m) => logged.push(m), renderImpl: async () => 'data:image/png;base64,AAAA', diagnoseImpl: async () => { diagnosed++; return ['a: b']; } };
        await run({ ...base, describeImpl: async () => ({ ok: true, text: 'Quartz Harbor LKR 48,271.50', provider: 'p', model: 'm' }) });
        expect(diagnosed).toBe(0);
        await run({ ...base, describeImpl: async () => ({ ok: false, tried: ['x: HTTP 200'] }) });
        expect(diagnosed).toBe(1);
        expect(logged.join('\n')).toMatch(/diagnosis a: b/);
    });
});
