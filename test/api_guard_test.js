// The guard on the endpoints that spend provider quota (wf-api-guard.mjs): another website's browser is refused,
// one caller is limited per minute and per day, and nothing that has no address (an in-process call) is touched.
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { check, guardApi, resetGuard, clientIp, isCrossSiteBrowser, POLICIES } from '../wf-api-guard.mjs';

const ENV = {};
const post = (headers = {}) => ({ method: 'POST', headers: { 'x-vercel-forwarded-for': '203.0.113.7', ...headers } });
const fakeRes = () => {
    const r = { code: 0, body: null, headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.code = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    return r;
};

describe('wf-api-guard', () => {
    beforeEach(() => resetGuard());

    it('only POST to a costly endpoint is counted', () => {
        for (let i = 0; i < 500; i++) expect(check({ method: 'GET', headers: {} }, 'ai', { env: ENV }).ok).toBe(true);
        expect(check(post(), 'health', { env: ENV }).why).toBe('not-counted');
    });

    it('refuses a browser on another website, not one on an allow-listed origin', () => {
        const evil = post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' });
        const v = check(evil, 'ai', { env: ENV });
        expect(v).toMatchObject({ ok: false, status: 403 });
        expect(check(post({ 'sec-fetch-site': 'cross-site', origin: 'https://www.wealthflow.lk' }), 'ai', { env: ENV }).ok).toBe(true);
        expect(check(post({ 'sec-fetch-site': 'same-origin', origin: 'https://www.wealthflow.lk' }), 'ai', { env: ENV }).ok).toBe(true);
        expect(check(post({ 'sec-fetch-site': 'same-site' }), 'ai', { env: ENV }).ok).toBe(true);
    });

    it('an older browser without Sec-Fetch is judged by Origin; same host is same-origin', () => {
        expect(isCrossSiteBrowser(post({ origin: 'https://evil.example', host: 'www.wealthflow.lk' }), ENV)).toBe(true);
        expect(isCrossSiteBrowser(post({ origin: 'https://wealthflow.vercel.app', host: 'wealthflow.vercel.app' }), ENV)).toBe(false);
        expect(isCrossSiteBrowser(post({ origin: 'null' }), ENV)).toBe(false);
    });

    it('a caller with no Origin and no Sec-Fetch (Shortcuts, cron, CI) is not a cross-site browser', () => {
        expect(isCrossSiteBrowser(post(), ENV)).toBe(false);
    });

    it('limits one caller per minute, answers 429 with Retry-After, and frees the caller after the minute', () => {
        const [perMin] = POLICIES.vision;
        const t0 = 1_000_000_000_000;
        for (let i = 0; i < perMin; i++) expect(check(post(), 'vision', { now: t0 + i, env: ENV }).ok).toBe(true);
        const over = check(post(), 'vision', { now: t0 + perMin, env: ENV });
        expect(over).toMatchObject({ ok: false, status: 429, why: 'per-minute' });
        expect(over.retryAfter).toBeGreaterThan(0);
        expect(check(post(), 'vision', { now: t0 + 61_000, env: ENV }).ok).toBe(true);
    });

    it('another caller, and another endpoint, have their own count', () => {
        const [perMin] = POLICIES['adobe-pdf-share'];
        for (let i = 0; i < perMin; i++) check(post(), 'adobe-pdf-share', { env: ENV });
        expect(check(post(), 'adobe-pdf-share', { env: ENV }).ok).toBe(false);
        expect(check(post({ 'x-vercel-forwarded-for': '198.51.100.9' }), 'adobe-pdf-share', { env: ENV }).ok).toBe(true);
        expect(check(post(), 'ai', { env: ENV }).ok).toBe(true);
    });

    it('stops a caller at the daily cap', () => {
        const [, perDay] = POLICIES['send-otp'];
        const t0 = 1_000_000_000_000;
        let last;
        // spread the calls across minutes so only the daily cap can stop them
        for (let i = 0; i <= perDay; i++) last = check(post(), 'send-otp', { now: t0 + i * 61_000, env: ENV });
        expect(last).toMatchObject({ ok: false, status: 429, why: 'per-day' });
    });

    it('an in-process call (no address) is never limited', () => {
        for (let i = 0; i < 1000; i++) expect(check({ method: 'POST', headers: {} }, 'ai', { env: ENV }).ok).toBe(true);
        expect(check({ method: 'POST' }, 'ai', { env: ENV }).ok).toBe(true);
    });

    it('WF_API_LIMIT_SCALE scales the limits and WF_API_GUARD=off switches the guard off', () => {
        const [perMin] = POLICIES['adobe-pdf-share'];
        const env = { WF_API_LIMIT_SCALE: '2' };
        for (let i = 0; i < perMin * 2; i++) expect(check(post(), 'adobe-pdf-share', { env }).ok).toBe(true);
        expect(check(post(), 'adobe-pdf-share', { env }).ok).toBe(false);
        resetGuard();
        const off = { WF_API_GUARD: 'off' };
        for (let i = 0; i < 100; i++) expect(check(post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }), 'adobe-pdf-share', { env: off }).ok).toBe(true);
    });

    it('clientIp prefers the headers Vercel sets and rejects junk', () => {
        expect(clientIp({ headers: { 'x-vercel-forwarded-for': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' } })).toBe('203.0.113.7');
        expect(clientIp({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })).toBe('1.1.1.1');
        expect(clientIp({ headers: { 'x-real-ip': '<script>' } })).toBe('');
        expect(clientIp(new Request('https://x.test/', { headers: { 'x-real-ip': '2001:db8::1' } }))).toBe('2001:db8::1');
    });

    it('guardApi writes the 429 itself, with Retry-After, and 403 for another website', () => {
        const [perMin] = POLICIES['adobe-pdf-share'];
        for (let i = 0; i < perMin; i++) guardApi(post(), fakeRes(), 'adobe-pdf-share');
        const res = fakeRes();
        expect(guardApi(post(), res, 'adobe-pdf-share')).toBe(false);
        expect(res.code).toBe(429);
        expect(res.headers['Retry-After']).toBeTruthy();
        const res2 = fakeRes();
        expect(guardApi(post({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' }), res2, 'ai')).toBe(false);
        expect(res2.code).toBe(403);
        expect(guardApi(post(), fakeRes(), 'ai')).toBe(true);
    });

    it('is wired into the router and into every handler Vercel serves directly', () => {
        const need = { 'api/router.js': /guardApi\(req, res, name\)/, 'api/ai.js': /guardApi\(req, res, 'ai'\)/, 'api/vision.js': /guardApi\(req, res, 'vision'\)/,
            'api/vision-scan.js': /guardApi\(req, res, 'vision-scan'\)/, 'api/verify.js': /guardApi\(req, res, 'verify'\)/ };
        for (const [f, re] of Object.entries(need)) expect(fs.readFileSync(f, 'utf8'), f).toMatch(re);
    });

    it('every endpoint it names exists in the router, so a typo cannot leave one unguarded', () => {
        const router = fs.readFileSync('api/router.js', 'utf8');
        const direct = new Set(['ai', 'verify', 'vision', 'vision-scan']);
        for (const name of Object.keys(POLICIES)) {
            if (direct.has(name)) { expect(fs.existsSync(`api/${name}.js`), name).toBe(true); continue; }
            expect(router, name).toMatch(new RegExp(`'${name}':`));
        }
    });
});
