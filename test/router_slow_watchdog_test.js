/* The router names the route of a request that is about to hit Vercel's 60 s limit.
 *
 * Production 2026-10-02/03: "Task timed out after 60 seconds" on /api/router, 14 in a day and 3 the next,
 * with nothing saying which of the ~35 endpoints behind the router it was, and the raw logs gone within hours.
 * After 50 s the router now writes one error-level line naming the endpoint, which the 7-day error table keeps. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let release;
let behaviour = 'hang';
vi.mock('../health.js', () => ({
    default: async (req, res) => {
        if (behaviour === 'hang') await new Promise(resolve => { release = resolve; });
        if (behaviour === 'throw') throw new Error('boom');
        res.status(200).json({ ok: true });
    },
}));

const { default: handler, SLOW_MS } = await import('../api/router.js');

const response = () => {
    const out = { status: 0, body: null, headersSent: false, writableEnded: false };
    return Object.assign(out, {
        setHeader() {},
        status(code) { out.status = code; return out; },
        json(body) { out.body = body; out.headersSent = true; out.writableEnded = true; return out; },
        end() { out.writableEnded = true; return out; },
    });
};
const request = (name, method = 'POST') => ({ method, url: `/api/router?path=${name}`, query: { path: name }, headers: {} });

describe('router: a request still running after 50 s is named before Vercel stops it', () => {
    let errors;
    beforeEach(() => {
        vi.useFakeTimers();
        behaviour = 'hang';
        errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => { vi.useRealTimers(); errors.mockRestore(); });

    it('the limit sits below Vercel\'s 60 s so the process is still alive to write the line', () => {
        expect(SLOW_MS).toBeLessThan(60000);
        expect(SLOW_MS).toBeGreaterThanOrEqual(40000);
    });

    it('writes one error line naming the endpoint when a handler is still running at 50 s', async () => {
        const res = response();
        const running = handler(request('health'), res);
        await vi.advanceTimersByTimeAsync(SLOW_MS - 1);
        expect(errors).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2);
        expect(errors).toHaveBeenCalledTimes(1);
        const line = String(errors.mock.calls[0][0]);
        expect(line).toContain('[WF-SLOW] /api/health (POST)');
        expect(line).toContain('50s');
        await vi.advanceTimersByTimeAsync(20000);
        expect(errors).toHaveBeenCalledTimes(1);                         // once per request, not a stream
        release();
        await running;
        expect(res.status).toBe(200);                                    // the handler still answers normally
    });

    it('writes nothing for a request that answers in time, and leaves no timer behind', async () => {
        behaviour = 'fast';
        const res = response();
        await handler(request('health'), res);
        expect(res.status).toBe(200);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(SLOW_MS * 2);
        expect(errors).not.toHaveBeenCalled();
    });

    it('drops the timer when the handler throws too', async () => {
        behaviour = 'throw';
        const res = response();
        await handler(request('health'), res);
        expect(res.status).toBe(500);
        expect(vi.getTimerCount()).toBe(0);
        const slow = errors.mock.calls.filter(call => String(call[0]).includes('[WF-SLOW]'));
        expect(slow).toHaveLength(0);
    });

    it('never puts anything from the request into the line: an unknown path starts no timer', async () => {
        const res = response();
        await handler(request('x'.repeat(40) + '-secret'), res);
        expect(res.status).toBe(404);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(SLOW_MS * 2);
        expect(errors).not.toHaveBeenCalled();
    });

    it('a pre-flight OPTIONS starts no timer', async () => {
        const res = response();
        await handler({ method: 'OPTIONS', url: '/api/router?path=health', query: { path: 'health' }, headers: {} }, res);
        expect(res.writableEnded).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
