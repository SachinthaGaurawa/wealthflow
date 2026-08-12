/* =============================================================================
 * test/feedback_recurrence_test.js — a report that comes back must say so, and
 * the endpoint must never claim an action it did not complete
 * -----------------------------------------------------------------------------
 * TWO DEFECTS, ONE ENDPOINT
 *
 *   1. The dedup lookup asked for OPEN issues only. A problem reported again
 *      after its issue was closed matched nothing and filed a brand-new issue,
 *      losing the link to the first and hiding the most valuable signal user
 *      feedback can carry: THE FIX DID NOT HOLD. The recurrence read as an
 *      unrelated first report.
 *
 *   2. Fixing that introduced the repository's signature defect in the one
 *      endpoint that exists to tell the owner the truth. The response said
 *      "Issue #N was reopened" whenever the issue had been closed as completed
 *      — derived from its state_reason, NOT from whether the PATCH succeeded.
 *      githubPatch swallows its errors and returns null, so a failed reopen
 *      still reported success, with `reopened: false` sitting right next to it.
 *      Surfaced by the consensus board flagging silent failure in the helpers.
 *
 * These run the REAL handler against a stubbed fetch, so they assert behaviour
 * rather than the shape of the source.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import handler from '../feedback-triage.js';

const REPO = 'owner/repo';
const realFetch = globalThis.fetch;

/** Collects the response `send()` produces, whichever shape it uses. */
function fakeRes() {
    const r = { _status: 0, _json: null };
    r.setHeader = () => {};
    r.status = (c) => { r._status = c; return r; };
    r.json = (o) => { r._json = o; return r; };
    return r;
}

/**
 * Stub GitHub. `issues` is what the label search returns; `fail` names the
 * calls that should answer non-2xx.
 */
function stubGitHub({ issues = [], fail = [] } = {}) {
    const seen = [];
    globalThis.fetch = vi.fn(async (url, opts = {}) => {
        const method = opts.method || 'GET';
        seen.push({ url: String(url), method });
        const ok = (data) => ({ ok: true, status: 200, json: async () => data });
        const bad = () => ({ ok: false, status: 503, json: async () => ({ message: 'unavailable' }) });

        if (method === 'GET' && /\/issues\?/.test(url)) return ok(issues);
        if (method === 'POST' && /\/comments$/.test(url)) return fail.includes('comment') ? bad() : ok({ id: 1 });
        if (method === 'PATCH' && /\/issues\/\d+$/.test(url)) return fail.includes('reopen') ? bad() : ok({ number: 7, state: 'open' });
        if (method === 'POST' && /\/issues$/.test(url)) return ok({ number: 123 });
        return ok({});
    });
    return seen;
}

const TEXT = 'Exports freeze the dashboard whenever transactions are downloaded';
const call = async (over = {}) => {
    const res = fakeRes();
    const out = await handler({ body: { text: TEXT, ...over } }, res);
    return res._json || (out && typeof out.json === 'function' ? await out.json() : out);
};

beforeEach(() => {
    process.env.GITHUB_REPO = REPO;
    process.env.GITHUB_TOKEN = 'test-token';
});
afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
});

describe('the lookup can see closed issues at all', () => {
    it('searches every state, not just open', async () => {
        const seen = stubGitHub({ issues: [] });
        await call();
        const search = seen.find((s) => /\/issues\?/.test(s.url));
        expect(search, 'no issue search was made').toBeTruthy();
        expect(search.url).toMatch(/state=all/);
        expect(search.url).not.toMatch(/state=open/);
    });
});

describe('a recurrence on a CLOSED-as-completed issue', () => {
    const closedFixed = [{ number: 7, state: 'closed', state_reason: 'completed', labels: [] }];

    it('reopens it and says so', async () => {
        stubGitHub({ issues: closedFixed });
        const out = await call();
        expect(out.deduped).toBe(7);
        expect(out.reopened).toBe(true);
        expect(out.reason).toMatch(/#7 was reopened/);
    });

    it('files NO new issue', async () => {
        const seen = stubGitHub({ issues: closedFixed });
        await call();
        expect(seen.filter((s) => s.method === 'POST' && /\/issues$/.test(s.url)),
            'it duplicated an issue that already tracks this').toEqual([]);
    });

    it('leaves a comment recording the recurrence', async () => {
        const seen = stubGitHub({ issues: closedFixed });
        const out = await call();
        expect(seen.some((s) => s.method === 'POST' && /\/issues\/7\/comments$/.test(s.url))).toBe(true);
        expect(out.recurrenceNoted).toBe(true);
    });

    it('DOES NOT claim it reopened the issue when the PATCH failed', async () => {
        // The defect the consensus board's silent-failure concern led to.
        stubGitHub({ issues: closedFixed, fail: ['reopen'] });
        const out = await call();
        expect(out.reopened).toBe(false);
        expect(out.reason, 'it reported an action it never completed').not.toMatch(/was reopened/);
        expect(out.reason).toMatch(/reopening it failed/i);
        expect(out.reason).toMatch(/needs a human/i);
    });

    it('says so when the comment failed too', async () => {
        stubGitHub({ issues: closedFixed, fail: ['comment'] });
        const out = await call();
        expect(out.recurrenceNoted).toBe(false);
    });

    it('still answers 200 — the report WAS received', async () => {
        // A GitHub hiccup must not turn a successful dedup into a user-facing
        // error. The honesty fix must not have changed that.
        const res = fakeRes();
        stubGitHub({ issues: closedFixed, fail: ['reopen', 'comment'] });
        await handler({ body: { text: TEXT } }, res);
        expect(res._status).toBe(200);
        expect(res._json.ok).not.toBe(false);
    });
});

describe('a recurrence on an issue we DECLINED', () => {
    const declined = [{ number: 9, state: 'closed', state_reason: 'not_planned', labels: [] }];

    it('does not resurrect the decision', async () => {
        // Reopening every time someone re-reports a declined item is exactly the
        // churn this pipeline exists to eliminate.
        const seen = stubGitHub({ issues: declined });
        const out = await call();
        expect(seen.some((s) => s.method === 'PATCH'), 'it reopened a deliberately declined issue').toBe(false);
        expect(out.reopened).toBe(false);
    });

    it('records the recurrence and says the decision stands', async () => {
        stubGitHub({ issues: declined });
        const out = await call();
        expect(out.deduped).toBe(9);
        expect(out.reason).toMatch(/Already decided on issue #9/);
        expect(out.reason).toMatch(/recorded/);
    });

    it('does not claim the recurrence was recorded when the comment failed', async () => {
        stubGitHub({ issues: declined, fail: ['comment'] });
        const out = await call();
        expect(out.reason).toMatch(/Recording the recurrence failed/);
        expect(out.reason).not.toMatch(/has been recorded/);
    });
});

describe('an OPEN issue still short-circuits exactly as before', () => {
    it('dedupes without commenting or patching', async () => {
        const seen = stubGitHub({ issues: [{ number: 5, state: 'open', labels: [] }] });
        const out = await call();
        expect(out.deduped).toBe(5);
        expect(out.reason).toMatch(/Already tracked by issue #5/);
        expect(out.recurrence).toBeUndefined();
        expect(seen.some((s) => s.method === 'PATCH')).toBe(false);
    });

    it('prefers the open issue when both an open and a closed one match', async () => {
        const seen = stubGitHub({
            issues: [
                { number: 8, state: 'closed', state_reason: 'completed', labels: [] },
                { number: 12, state: 'open', labels: [] },
            ],
        });
        const out = await call();
        expect(out.deduped).toBe(12);
        expect(seen.some((s) => s.method === 'PATCH')).toBe(false);
    });
});

describe('a genuinely new report is unaffected', () => {
    it('files an issue when nothing matches', async () => {
        const seen = stubGitHub({ issues: [] });
        const out = await call();
        expect(seen.some((s) => s.method === 'POST' && /\/issues$/.test(s.url))).toBe(true);
        expect(out.issue).toBe(123);
        expect(out.deduped).toBeUndefined();
    });
});

describe('the stub is real enough to be worth trusting', () => {
    it('the handler genuinely calls fetch — otherwise every assertion above is vacuous', async () => {
        const seen = stubGitHub({ issues: [] });
        await call();
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[0].url).toMatch(/api\.github\.com/);
    });

    it('every request carries the bearer token', async () => {
        // Also answers the consensus board's "no authentication checks" claim
        // directly: the new POST/PATCH helpers authenticate identically to the
        // pre-existing GET.
        stubGitHub({ issues: [{ number: 7, state: 'closed', state_reason: 'completed', labels: [] }] });
        await call();
        for (const c of globalThis.fetch.mock.calls) {
            const headers = (c[1] || {}).headers || {};
            expect(headers.Authorization, `unauthenticated call to ${c[0]}`).toBe('Bearer test-token');
        }
    });
});
