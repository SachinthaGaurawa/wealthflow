// "Your Feedback" marks a report Fixed only when the update system really fixed it and the release carrying the fix is out
// (owner, 2026-11-06: reports the AI solved through an update must be shown as solved, and done properly).
import { describe, it, expect, afterEach } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

describe('feedback-status: what became of an issue', () => {
    it('finds the first release cut after the issue was closed, not an older one and not a later one', async () => {
        const { releaseAfter, releasesFromCommits } = await import('../feedback-status.js');
        const commits = [
            { commit: { message: 'release: v7.69.50 — automatic release', committer: { date: '2026-11-04T19:58:31Z' } } },
            { commit: { message: 'release: v7.69.49 — automatic release', committer: { date: '2026-11-04T18:42:57Z' } } },
            { commit: { message: 'release: v7.69.48 — automatic release', committer: { date: '2026-11-04T18:31:43Z' } } },
            { commit: { message: 'fix: something else (#9)', committer: { date: '2026-11-04T18:30:00Z' } } },
        ];
        const rel = releasesFromCommits(commits);
        expect(rel.map((r) => r.tag_name)).toEqual(['v7.69.50', 'v7.69.49', 'v7.69.48']);
        // #514 closed 18:29:02 → shipped in 7.69.48 (18:31), not 7.69.50
        expect(releaseAfter(rel, '2026-11-04T18:29:02Z').version).toBe('7.69.48');
        // closed after every release we know of: not shipped yet
        expect(releaseAfter(rel, '2026-11-05T09:00:00Z')).toBe(null);
        expect(releaseAfter(rel, 'not a date')).toBe(null);
    });

    it('says fixed / declined / stuck / working / waiting in one word', async () => {
        const { summarise } = await import('../feedback-status.js');
        const rel = [{ tag_name: 'v7.69.48', published_at: '2026-11-04T18:31:43Z' }];
        const closed = summarise({ number: 514, state: 'closed', state_reason: 'completed', closed_at: '2026-11-04T18:29:02Z', labels: [{ name: 'ai-working' }] }, [], rel);
        expect(closed).toMatchObject({ status: 'fixed', completed: true, shippedVersion: '7.69.48', releasePending: false });
        const pending = summarise({ number: 1, state: 'closed', closed_at: '2026-11-05T09:00:00Z', labels: [] }, [], rel);
        expect(pending).toMatchObject({ status: 'fixed', shippedVersion: null, releasePending: true });
        expect(summarise({ number: 2, state: 'closed', state_reason: 'not_planned', closed_at: '2026-11-04T18:29:02Z' }, [], rel).status).toBe('declined');
        expect(summarise({ number: 3, state: 'open', labels: [{ name: 'ai-stuck' }] }, [], rel).status).toBe('stuck');
        expect(summarise({ number: 4, state: 'open', labels: [{ name: 'ai-working' }] }, [], rel).status).toBe('working');
        expect(summarise({ number: 5, state: 'open', labels: [{ name: 'user-feedback' }] }, [], rel).status).toBe('waiting');
        // an OPEN issue is never "fixed", whatever its comments say
        expect(summarise({ number: 6, state: 'open' }, [{ body: 'Shipped in v7.70.0' }], rel).status).not.toBe('fixed');
    });

    it('finds a report again from the owner\'s own words, Sinhala included', async () => {
        const { parseSnippets } = await import('../feedback-status.js');
        const q = parseSnippets(JSON.stringify(['ඔයා දැක්කාද මේ ගැටලුව. Overalaped වෙලා. මේ ගැටලුව තියෙන්නේ phone වලට.', 'short']));
        expect(q).toHaveLength(1);
        expect(q[0].q).toMatch(/Overalaped/);
        expect(parseSnippets('not json')).toEqual([]);
        expect(parseSnippets(JSON.stringify(Array(20).fill('a long enough snippet of words'))).length).toBeLessThanOrEqual(5);
    });

    it('the endpoint answers with the status, the release, and the issue found by text', async () => {
        const { default: handler } = await import('../feedback-status.js');
        const real = globalThis.fetch;
        const seen = [];
        globalThis.fetch = async (url) => {
            const u = String(url); seen.push(u);
            const ok = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
            if (u.includes('/search/issues')) return ok({ items: [{ number: 514 }] });
            if (u.includes('/issues/514')) return ok({ number: 514, state: 'closed', state_reason: 'completed', closed_at: '2026-11-04T18:29:02Z', comments: 5, labels: [{ name: 'user-feedback' }], title: 'x' });
            if (u.includes('/commits?path=version.json')) return ok([{ commit: { message: 'release: v7.69.48 — automatic release', committer: { date: '2026-11-04T18:31:43Z' } } }]);
            return new Response('{}', { status: 404 });
        };
        const env = { ...process.env };
        process.env.GITHUB_REPO = 'a/b'; process.env.GH_PAT = 't';
        try {
            let out = null;
            await handler({ method: 'GET', url: '/api/feedback-status?texts=' + encodeURIComponent(JSON.stringify(['Did you see this. This is in CC installments'])) }, { status: () => ({ json: (b) => { out = b; } }), setHeader() {} });
            expect(out.ok).toBe(true);
            expect(out.matches[0].number).toBe(514);
            expect(out.items[0]).toMatchObject({ number: 514, status: 'fixed', shippedVersion: '7.69.48' });
            expect(out.fixedCount).toBe(1);
        } finally { globalThis.fetch = real; process.env = env; }
    });
});

describe('Your Feedback panel shows the mark', () => {
    const queue = (extra = {}) => JSON.stringify([{ text: 'Did you see this. This is in CC installments. Overlapped. Please make it quickly.', createdAt: new Date().toISOString(), issue: 514, ...extra }]);
    const open = async (fetchImpl, seed = {}) => {
        const m = loadBrowserModule('wealthflow-feedback-ai.js', {
            html: '<div id="root"></div>', fetchImpl, localStorage: { wf_feedback_queue: queue(), ...seed },
            globals: { firebase: null, currentUser: null },
        });
        await m.window.wfFeedbackAI.showBoard();
        await new Promise((r) => setTimeout(r, 120));
        return m;
    };
    const json = (b) => async () => ({ ok: true, status: 200, json: async () => b });

    it('marks a report Fixed with the update that carried it, and counts it as fixed rather than open', async () => {
        const m = await open(json({ ok: true, items: [{ number: 514, status: 'fixed', shippedVersion: '7.69.48', completed: true }], matches: [] }));
        const text = m.document.getElementById('wfFbBoard').textContent;
        expect(text).toMatch(/Fixed/);
        expect(text).toMatch(/in update v7\.69\.48/);
        expect(text).toMatch(/work item #514/);
        expect(text).toMatch(/0\s*open/);
        expect(text).toMatch(/1\s*fixed/);
        expect(text).not.toMatch(/CRITICAL/);
    });

    it('says nothing about a fix when the server cannot be reached (no guess)', async () => {
        const m = await open(async () => { throw new Error('offline'); });
        const text = m.document.getElementById('wfFbBoard').textContent;
        expect(text).not.toMatch(/Fixed —|Fixed —/);
        expect(text).toMatch(/CRITICAL/i);
    });

    it('keeps the last known answer on the device, so it is right offline too', async () => {
        const m = await open(async () => { throw new Error('offline'); }, { wf_fb_status: JSON.stringify({ 514: { number: 514, status: 'fixed', shippedVersion: '7.69.48' } }) });
        expect(m.document.getElementById('wfFbBoard').textContent).toMatch(/in update v7\.69\.48/);
    });

    it('shows an open report as being worked on, still critical', async () => {
        const m = await open(json({ ok: true, items: [{ number: 514, status: 'working' }], matches: [] }));
        const text = m.document.getElementById('wfFbBoard').textContent;
        expect(text).toMatch(/The AI is working on it/);
        expect(text).toMatch(/CRITICAL/i);
        expect(text).toMatch(/1\s*open/);
    });

    it('finds the work item of a report this device has no number for, by its words', async () => {
        const m = loadBrowserModule('wealthflow-feedback-ai.js', {
            html: '<div id="root"></div>',
            fetchImpl: async (url) => {
                expect(String(url)).toMatch(/texts=/);
                return { ok: true, status: 200, json: async () => ({ ok: true, matches: [{ text: 'Did you see this. This is in CC installments. Overlapped.', number: 514 }], items: [{ number: 514, status: 'fixed', shippedVersion: '7.69.48' }] }) };
            },
            localStorage: { wf_feedback_queue: JSON.stringify([{ text: 'Did you see this. This is in CC installments. Overlapped.', createdAt: new Date().toISOString() }]) },
            globals: { firebase: null, currentUser: null },
        });
        await m.window.wfFeedbackAI.showBoard();
        await new Promise((r) => setTimeout(r, 120));
        expect(m.document.getElementById('wfFbBoard').textContent).toMatch(/in update v7\.69\.48/);
    });

    it('does not call a cluster fixed when one of its reports has no known work item', async () => {
        const text = 'Did you see this. This is in CC installments. Overlapped.';
        const m = loadBrowserModule('wealthflow-feedback-ai.js', {
            html: '<div id="root"></div>',
            fetchImpl: json({ ok: true, items: [{ number: 514, status: 'fixed', shippedVersion: '7.69.48' }], matches: [] }),
            localStorage: { wf_feedback_queue: JSON.stringify([
                { text, createdAt: '2026-11-05T10:00:00.000Z', issue: 514 },
                { text, createdAt: new Date().toISOString() },
            ]) },
            globals: { firebase: null, currentUser: null },
        });
        await m.window.wfFeedbackAI.showBoard();
        await new Promise((r) => setTimeout(r, 120));
        expect(m.document.getElementById('wfFbBoard').textContent).not.toMatch(/in update v7\.69\.48/);
    });

    afterEach(() => { /* each test builds its own window */ });
});
