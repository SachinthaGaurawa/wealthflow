// 2026-11-06 (#524): a report from Settings named no page, and every vision provider failed. Two repairs:
//  - the screenshot reader asks the provider for its own model list when the vision models it names are gone;
//  - the app records the pages open just before a report, and the issue says so, so the fix agent can open the right one.
import { describe, it, expect } from 'vitest';
import { describeScreenshot } from '../wf-screenshot-reader.mjs';
import { diagnosticsSection } from '../feedback-triage.js';

const PNG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40);
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('screenshot reader: models that are gone are replaced from the provider\'s own list', () => {
    it('reads the picture with a vision model found in the list, after the named ones were refused as gone', async () => {
        const asked = [];
        const fetchImpl = async (url, init = {}) => {
            const u = String(url);
            if (u.endsWith('/models')) return res(200, { data: [{ id: 'mistral-embed' }, { id: 'pixtral-large-2511' }, { id: 'mistral-large-2512' }] });
            const model = JSON.parse(init.body || '{}').model;
            asked.push(model);
            if (model === 'mistral-small-latest' || model === 'pixtral-large-latest') return res(404, { message: 'Model not found' });
            return res(200, { choices: [{ message: { content: 'SCREEN: CC Instalments\nPROBLEM: the label runs over the amount' } }] });
        };
        const logs = [];
        const r = await describeScreenshot({ dataUrl: PNG, title: 't', text: 'x', env: { MISTRAL_API_KEY: 'k' }, fetchImpl, log: (m) => logs.push(m) });
        expect(r.ok).toBe(true);
        expect(r.provider).toBe('mistral');
        expect(asked.slice(0, 2)).toEqual(['mistral-small-latest', 'pixtral-large-latest']);
        expect(asked.at(-1)).not.toMatch(/small-latest|pixtral-large-latest$/);
        expect(r.text).toMatch(/CC Instalments/);
        expect(logs.join(' ')).toMatch(/provider's own list/);
    });

    it('does not go looking when the key is simply refused (same key, same answer)', async () => {
        let listed = 0;
        const fetchImpl = async (url) => { if (String(url).endsWith('/models')) listed++; return res(401, {}); };
        const r = await describeScreenshot({ dataUrl: PNG, env: { MISTRAL_API_KEY: 'bad' }, fetchImpl });
        expect(r.ok).toBe(false);
        expect(listed).toBe(0);
        expect(r.tried.join(' ')).toMatch(/401/);
    });
});

describe('the pages open just before a report are written into the issue', () => {
    it('prints them oldest to newest, last six, ignoring anything that is not a page name', () => {
        const t = diagnosticsSection({ activePage: 'settings', recentPages: ['a1', 'a2', 'dashboard', 'ccinstall', 'settings', 7, null, 'x', 'y'] });
        expect(t).toMatch(/Pages open just before \(oldest to newest\) \| .*>.*\|/);
        expect(t).toMatch(/\| App page \| settings \|/);
        expect(t.split('\n').find((l) => /Pages open just before/.test(l))).not.toMatch(/a1/);
    });
    it('leaves the row out when the device sent none', () => {
        expect(diagnosticsSection({ activePage: 'settings' })).not.toMatch(/Pages open just before/);
    });
});

describe('screenshot reader: GitHub Models', () => {
    const ENV = { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'tok' };

    it('sends the GitHub Accept and API-version headers (HTTP 200 and no answer without them on 2026-11-07)', async () => {
        const seen = [];
        const fetchImpl = async (url, init = {}) => { seen.push({ url: String(url), headers: init.headers }); return res(200, { choices: [{ message: { content: 'SCREEN: Dashboard' } }] }); };
        const r = await describeScreenshot({ dataUrl: PNG, verify: false, env: ENV, fetchImpl });
        expect(r.ok).toBe(true);
        expect(r.provider).toBe('github-models');
        expect(seen[0].url).toBe('https://models.github.ai/inference/chat/completions');
        expect(seen[0].headers.Accept).toBe('application/vnd.github+json');
        expect(seen[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28');
        expect(seen[0].headers.Authorization).toBe('Bearer tok');
    });

    it('other providers do not get the GitHub headers', async () => {
        const seen = [];
        const fetchImpl = async (url, init = {}) => { seen.push(init.headers); return res(200, { choices: [{ message: { content: 'SCREEN: Dashboard' } }] }); };
        await describeScreenshot({ dataUrl: PNG, verify: false, env: { MISTRAL_API_KEY: 'k' }, fetchImpl });
        expect(seen[0].Accept).toBeUndefined();
    });

    it('a 200 with no answer says what the body carried instead of looking like success', async () => {
        const fetchImpl = async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json'); }, text: async () => 'OK' });
        const r = await describeScreenshot({ dataUrl: PNG, verify: false, env: ENV, fetchImpl });
        expect(r.ok).toBe(false);
        expect(r.tried.join(' ')).toMatch(/HTTP 200 no answer in the body: OK/);
    });
});
