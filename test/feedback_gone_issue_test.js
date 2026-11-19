/* =============================================================================
 * test/feedback_gone_issue_test.js
 * -----------------------------------------------------------------------------
 * 2026-11-19: the owner's diagnosis said "#513 filed for over 48 h with no AI work started" for days. #513 had been DELETED on
 * GitHub (the API answers 410 "This issue was deleted"). /api/feedback-status read any non-2xx as "unknown", the app turned
 * "unknown" into 'open', and the diagnosis counted 'open' + old as an idle report. A deleted work item can never be worked on,
 * so nothing could ever clear the warning. These tests pin the whole path: server answer, device mapping, diagnosis wording.
 * ===========================================================================*/
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import handler, { goneItem } from '../feedback-status.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function call(url) {
    return new Promise((resolve) => {
        const res = { setHeader() {}, status() { return res; }, json: (b) => resolve(b) };
        Promise.resolve(handler({ method: 'GET', url }, res)).then((r) => { if (r instanceof Response) r.json().then(resolve); });
    });
}
const issueJson = (n) => ({ number: n, state: 'open', title: 't' + n, labels: [], comments: 0 });
const reply = (code, body) => new Response(body == null ? '' : JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function stub(map) {
    vi.stubEnv('GITHUB_REPO', 'o/r'); vi.stubEnv('GH_PAT', 'x');
    vi.stubGlobal('fetch', vi.fn(async (url) => {
        const m = String(url).match(/\/issues\/(\d+)$/);
        if (m && map[m[1]]) return map[m[1]]();
        return reply(200, []);
    }));
}

describe('/api/feedback-status and an issue GitHub no longer has', () => {
    it('410 (deleted) is reported as gone, never as unknown or open', async () => {
        stub({ 513: () => reply(410, { message: 'This issue was deleted' }) });
        const out = await call('/api/feedback-status?issues=513');
        expect(out.items).toEqual([goneItem(513)]);
        expect(out.goneCount).toBe(1);
        expect(out.items[0].completed).toBe(false);
    });

    it('404 is gone only when another issue in the same request was readable', async () => {
        stub({ 7: () => reply(200, issueJson(7)), 8: () => reply(404, { message: 'Not Found' }) });
        const out = await call('/api/feedback-status?issues=7,8');
        expect(out.items.find((i) => i.number === 7).status).toBe('waiting');
        expect(out.items.find((i) => i.number === 8).gone).toBe(true);
    });

    it('a lone 404 stays unknown: it may be a token that cannot see the repository', async () => {
        stub({ 8: () => reply(404, { message: 'Not Found' }) });
        const out = await call('/api/feedback-status?issues=8');
        expect(out.items[0].status).toBe('unknown');
        expect(out.items[0].gone).toBeUndefined();
    });

    it('a server error stays unknown (GitHub being down is not a deleted issue)', async () => {
        stub({ 9: () => reply(502, { message: 'bad gateway' }) });
        const out = await call('/api/feedback-status?issues=9');
        expect(out.items[0].status).toBe('unknown');
    });
});

describe('the device stops waiting for a deleted work item', () => {
    const src = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');
    it('maps gone to its own status and marks it seen so it is not polled again', () => {
        const block = src.slice(src.indexOf('if (st.gone) {'), src.indexOf('const next = Object.assign({}, x, {'));
        expect(block).toMatch(/_status: 'gone'/);
        expect(block).toMatch(/_completedSeen: true/);
    });
    it('the Your Feedback board leaves a gone item out of its badge', () => {
        const board = fs.readFileSync(path.join(ROOT, 'wealthflow-feedback-ai.js'), 'utf8');
        expect(board).toMatch(/x\.status !== 'gone'/);
    });
});
