/* =============================================================================
 * test/tenant_portal_test.js — the code, the lockout, the session: nothing leaks, nothing doubles
 * -----------------------------------------------------------------------------
 * The portal answers to strangers, so these tests are written from the stranger's side:
 * what can be learnt from the answers, how many guesses the rules allow, what a copy of
 * the database holds, and what two requests racing each other can do.
 * ===========================================================================*/

import { describe, it, expect, vi } from 'vitest';
import {
    requestCode, verifyCode, readSession, loadStatement, endSession, newCode, codeProof, failState, hit, pickRecipient, sessionHash,
    LIMITS, LOCK, OTP_TTL_MS, RESEND_GAP_MS, SESSION_TTL_MS, MSG, LIMITS_COL, MIN_ANSWER_MS, ipKey, clientIp, parseCookies, sessionCookie,
} from '../tenant-portal.mjs';
import { ensureTenantToken, phoneHashOf } from '../tenant-links.mjs';
import { KIND } from '../textlk.mjs';
import { normalizeNic } from '../wealthflow-nic.js';
import { makeDb, seedTenant, gateway, codeIn, codes, allText, lenderDoc, SECRET, UID, NIC, CANON, PHONE, T0 } from './helpers/tenant-fixture.js';

const ask = (db, client, token, over = {}) => requestCode({ db, client, token, nic: NIC, ip: 'ip1', secret: SECRET, now: T0, random: codes('123456'), ...over });
const check = (db, token, code, over = {}) => verifyCode({ db, token, nic: NIC, code, ip: 'ip1', secret: SECRET, now: T0 + 1000, ...over });
const sid = (cookie) => /wf_tp=[A-Za-z0-9_-]{16}\.([A-Za-z0-9_-]{32});/.exec(cookie)[1];

async function ready(over = {}) {
    const { fs, db } = makeDb();
    const token = await seedTenant(fs, db, over);
    return { fs, db, token };
}

describe('the code itself', () => {
    it('is six digits, zero-padded, from the cryptographic source', () => {
        expect(newCode(() => 42)).toBe('000042');
        expect(newCode(() => 999999)).toBe('999999');
        const seen = new Set();
        for (let i = 0; i < 3000; i += 1) { const c = newCode(); expect(c).toMatch(/^\d{6}$/); seen.add(c); }
        expect(seen.size).toBeGreaterThan(2900);                       // not a small cycle
    });

    it('asks the generator for 0..999999 and nothing else', () => {
        const calls = [];
        newCode((lo, hi) => { calls.push([lo, hi]); return 5; });
        expect(calls).toEqual([[0, 1000000]]);
    });

    it('is bound to its link and its moment: the same digits prove nothing elsewhere or later', () => {
        const a = codeProof(SECRET, 'AAAAAAAAAAAAAAAA', 1000, '123456');
        expect(codeProof(SECRET, 'AAAAAAAAAAAAAAAA', 1000, '123456')).toBe(a);
        expect(codeProof(SECRET, 'BBBBBBBBBBBBBBBB', 1000, '123456')).not.toBe(a);
        expect(codeProof(SECRET, 'AAAAAAAAAAAAAAAA', 1001, '123456')).not.toBe(a);
        expect(codeProof(Buffer.alloc(32, 1), 'AAAAAAAAAAAAAAAA', 1000, '123456')).not.toBe(a);
    });
});

describe('asking for a code', () => {
    it('texts the recorded number once, from the server, and keeps no code anywhere', async () => {
        const { fs, db, token } = await ready();
        const gw = gateway();
        const out = await ask(db, gw, token);
        expect(out.status).toBe(200);
        expect(out.body.ok).toBe(true);
        expect(gw.sent).toHaveLength(1);
        expect(gw.sent[0].to).toBe('+94771234567');
        expect(gw.sent[0].message).toBe('123456 is your WealthFlow verification code. It expires in 3 minutes. Do not share it with anyone.');
        const stored = fs.data.get(`wf-tenants/${token}/otp/current`);
        expect(stored.hash).toBe(codeProof(SECRET, token, T0, '123456'));
        expect(stored.expiresAt).toBe(T0 + OTP_TTL_MS);
        expect(stored.attemptsLeft).toBe(5);
        expect(allText(fs)).not.toContain('123456');                   // a copy of the whole database holds no code
        const portal = JSON.stringify([...fs.data.entries()].filter(([k]) => !k.startsWith('users/')));
        expect(portal).not.toContain(NIC);                              // nor an NIC: only its HMAC is ever kept
        expect(portal).not.toContain(CANON);
        expect(portal).not.toContain('771234567');                      // nor a phone number: only a hash and a mask
    });

    it('goes to the number on the record, not to anything the caller says', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        await requestCode({ db, client: gw, token, nic: NIC, ip: 'ip1', secret: SECRET, now: T0, random: codes('123456'), to: '0779999999', phone: '0779999999' });
        expect(gw.sent.map((m) => m.to)).toEqual(['+94771234567']);
    });

    it('gives the same answer for every well-formed request, whatever is behind it', async () => {
        const real = await ready();
        const expected = await ask(real.db, gateway(), real.token);

        const cases = {};
        const a = await ready(); cases.unknownToken = await ask(a.db, gateway(), 'zzzzzzzzzzzzzzzz');
        const b = await ready(); cases.wrongNic = await ask(b.db, gateway(), b.token, { nic: '198534000999' });
        const c = await ready(); cases.gatewayDown = await ask(c.db, gateway(() => ({ ok: false, kind: KIND.CREDIT, message: 'no units', retryable: true })), c.token);
        const d = await ready({ user: lenderDoc({ income: [], debtors: [] }) }); cases.noRecipient = await ask(d.db, gateway(), d.token);
        const e = await ready({ user: lenderDoc({ income: [{ ...lenderDoc().income[0], sms_notifications_enabled: false }], debtors: [] }) }); cases.switchedOff = await ask(e.db, gateway(), e.token);
        const f = await ready(); f.fs.data.set(`wf-tenants/${f.token}`, { ...f.fs.data.get(`wf-tenants/${f.token}`), active: false }); cases.inactive = await ask(f.db, gateway(), f.token);
        const g = await ready(); await ask(g.db, gateway(), g.token); cases.cooldown = await ask(g.db, gateway(), g.token, { now: T0 + 5000 });

        expect(expected.status).toBe(200);
        for (const [name, out] of Object.entries(cases)) expect({ name, status: out.status, body: out.body }).toEqual({ name, status: expected.status, body: expected.body });
    });

    it('a lender the owner has switched off sends no code, and the stranger is told the same as ever; one never registered still does', async () => {
        const off = await ready();
        off.fs.data.set(`wf-sms/${UID}`, { active: false, deactivatedReason: 'the sign-in account is disabled' });
        const gw = gateway();
        const out = await ask(off.db, gw, off.token);
        const normal = await ask((await ready()).db, gateway(), (await ready()).token);
        expect(gw.calls).toBe(0);
        expect(off.fs.data.has(`wf-tenants/${off.token}/otp/current`)).toBe(false);              // no slot taken, no daily count used
        expect({ status: out.status, body: out.body }).toEqual({ status: normal.status, body: normal.body });

        const on = await ready();
        on.fs.data.set(`wf-sms/${UID}`, { active: true });
        const gw2 = gateway(); await ask(on.db, gw2, on.token);
        expect(gw2.sent).toHaveLength(1);
        const none = await ready(); const gw3 = gateway(); await ask(none.db, gw3, none.token);        // no registration document at all
        expect(gw3.sent).toHaveLength(1);
    });

    it('does not make a request that does nothing quicker than one that texts', async () => {
        const { db, token } = await ready();
        const pad = vi.fn(async () => {});
        await ask(db, gateway(), 'zzzzzzzzzzzzzzzz', { pad });                       // unknown link
        await ask(db, gateway(), token, { nic: '198534000999', pad });              // wrong NIC
        await ask(db, gateway(), token, { pad });                                   // the real thing
        expect(pad).toHaveBeenCalledTimes(3);
        expect(pad.mock.calls.every(([ms]) => ms === MIN_ANSWER_MS)).toBe(true);
    });

    it('refuses input that is not shaped like a link and an NIC, with words that reveal nothing', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        // not an NIC and not a passport / ID number either (5-20 letters and digits): there is nothing to compare
        for (const nic of ['', 'abc', '123', '1234', 'x'.repeat(21), 'AB 12!', '<script>']) {
            const out = await ask(db, gw, token, { nic });
            expect(out.status, nic).toBe(400);
            expect(out.body.error).toBe(MSG.BAD_NIC);
        }
        for (const bad of ['', 'short', 'x'.repeat(17), 'abcdefghijklmnop!', '../../etc/passwd']) {
            expect((await ask(db, gw, bad)).status, bad).toBe(400);
        }
        expect(gw.calls).toBe(0);
    });

    it('a string that could be a passport or ID number gets the same uniform answer as a wrong NIC, never a different one', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        for (const nic of ['85340093', '8534009377V', 'N1234567', 'ID:N1234567']) {
            const out = await ask(db, gw, token, { nic });
            expect(out.status, nic).toBe(200);
            expect(out.body.message).toBe(MSG.ACCEPTED);
        }
        expect(gw.calls).toBe(0);                                  // none of them is this link's identity, so no text goes out
    });

    it('accepts either shape of the same NIC', async () => {
        for (const nic of ['853400937V', '853400937v', '198534000937', ' 1985-3400-0937 ']) {
            const { db, token } = await ready();
            const gw = gateway();
            await ask(db, gw, token, { nic });
            expect(gw.sent, nic).toHaveLength(1);
        }
    });

    it('two requests racing for one link send one text', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        const outs = await Promise.all(Array.from({ length: 6 }, () => ask(db, gw, token)));
        expect(gw.sent).toHaveLength(1);
        expect(new Set(outs.map((o) => JSON.stringify(o))).size).toBe(1);
    });

    it('holds a second code back for 60 seconds, then replaces the first, which dies', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        await ask(db, gw, token, { random: codes('111111') });
        await ask(db, gw, token, { now: T0 + RESEND_GAP_MS - 1, random: codes('222222') });
        expect(gw.sent).toHaveLength(1);
        await ask(db, gw, token, { now: T0 + RESEND_GAP_MS, random: codes('333333') });
        expect(gw.sent.map((m) => codeIn(m.message))).toEqual(['111111', '333333']);
        expect((await check(db, token, '111111', { now: T0 + RESEND_GAP_MS + 1000 })).status).toBe(401);       // the old code is dead
        expect((await check(db, token, '333333', { now: T0 + RESEND_GAP_MS + 2000 })).status).toBe(200);
    });

    it('caps codes per link: 5 an hour, 10 a day', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        let at = T0;
        for (let i = 0; i < 5; i += 1) { await ask(db, gw, token, { now: at }); at += RESEND_GAP_MS + 1; }
        expect(gw.sent).toHaveLength(5);
        const sixth = await ask(db, gw, token, { now: at });
        expect(sixth.status).toBe(429);
        expect(sixth.body.error).toBe(MSG.CODES_CAPPED);
        expect(sixth.body.retryAfterSec).toBeGreaterThan(0);
        expect(gw.sent).toHaveLength(5);

        // the hour turns: five more are allowed, then the day's ten are spent
        at = T0 + 3600e3 + 1;
        for (let i = 0; i < 5; i += 1) { await ask(db, gw, token, { now: at }); at += RESEND_GAP_MS + 1; }
        expect(gw.sent).toHaveLength(10);
        at = T0 + 2 * 3600e3 + 2;
        const eleventh = await ask(db, gw, token, { now: at });
        expect(eleventh.status).toBe(429);
        expect(gw.sent).toHaveLength(10);
        // and tomorrow it starts again
        const tomorrow = await ask(db, gw, token, { now: Date.parse('2026-10-06T00:00:01Z') });
        expect(tomorrow.status).toBe(200);
        expect(gw.sent).toHaveLength(11);
    });

    it('stops at the account-wide daily cap, because each code is a unit the owner pays for', async () => {
        const { fs, db, token } = await ready();
        fs.data.set(`${LIMITS_COL}/otp-day-2026-10-05`, { count: LIMITS.codesPerDay, day: '2026-10-05' });
        const gw = gateway();
        const out = await ask(db, gw, token);
        expect(out.status).toBe(503);
        expect(out.body.error).toBe(MSG.UNAVAILABLE);
        expect(gw.calls).toBe(0);
    });

    it('limits one address: 30 requests an hour, whatever it asks for', async () => {
        const { db, token } = await ready();
        const gw = gateway();
        const ghost = 'zzzzzzzzzzzzzzzz';                              // an unknown link: asking costs nothing but the address's allowance
        for (let i = 0; i < LIMITS.requestsPerIpHour; i += 1) expect((await ask(db, gw, ghost, { now: T0 + i })).status).toBe(200);
        const blocked = await ask(db, gw, ghost, { now: T0 + 100 });
        expect(blocked.status).toBe(429);
        expect(blocked.body.retryAfterSec).toBeGreaterThan(0);
        expect((await ask(db, gw, ghost, { ip: 'someone-else', now: T0 + 100 })).status).toBe(200);
        expect((await ask(db, gw, token, { now: T0 + 3600e3 + 1 })).status).toBe(200);     // the window moves on
    });

    it('a code that certainly never left is dead; one that may have left stays valid', async () => {
        const certain = await ready();
        await ask(certain.db, gateway(() => ({ ok: false, kind: KIND.CREDIT, message: 'insufficient credit', retryable: true })), certain.token, { random: codes('424242') });
        expect(certain.fs.data.get(`wf-tenants/${certain.token}/otp/current`).status).toBe('failed');
        expect((await check(certain.db, certain.token, '424242')).status).toBe(401);

        const maybe = await ready();
        await ask(maybe.db, gateway(() => ({ ok: false, kind: KIND.TIMEOUT, message: 'no answer', retryable: true, possiblySent: true })), maybe.token, { random: codes('424242') });
        expect((await check(maybe.db, maybe.token, '424242')).status).toBe(200);

        const threw = await ready();
        await ask(threw.db, { async send() { throw new Error('boom'); } }, threw.token, { random: codes('424242') });
        expect((await check(threw.db, threw.token, '424242')).status).toBe(200);
    });

    it('tells the owner, in the log they already read, that a code went out or could not, never what the code was', async () => {
        const ok = await ready();
        await ask(ok.db, gateway(), ok.token, { random: codes('565656') });
        const row = [...ok.fs.data.entries()].find(([p]) => p.startsWith(`users/${UID}/smsLog/otp-`))[1];
        expect(row.status).toBe('sent');
        expect(row.to).toBe('+94*****4567');
        expect(row.alert).toBe('Admin Alert: SMS Delivered Successfully to Tenant');
        expect(JSON.stringify(row)).not.toContain('565656');

        const bad = await ready();
        await ask(bad.db, gateway(() => ({ ok: false, kind: KIND.CREDIT, message: 'insufficient credit', retryable: true })), bad.token, { random: codes('565656') });
        const failed = [...bad.fs.data.entries()].find(([p]) => p.startsWith(`users/${UID}/smsLog/otp-`))[1];
        expect(failed.status).toBe('failed');
        expect(failed.error.kind).toBe('credit');
        expect(failed.alert).toBeUndefined();
        expect(JSON.stringify(failed)).not.toContain('565656');
    });
});

describe('checking the code', () => {
    it('opens a session for the right NIC and the right code, once', async () => {
        const { fs, db, token } = await ready();
        await ask(db, gateway(), token);
        const out = await check(db, token, '123456');
        expect(out.status).toBe(200);
        expect(out.cookie).toMatch(new RegExp(`^wf_tp=${token}\\.[A-Za-z0-9_-]{32}; HttpOnly; Secure; SameSite=Strict; Path=/api/tenant-portal; Max-Age=1200$`));
        expect(out.body).toEqual({ ok: true, expiresAt: T0 + 1000 + SESSION_TTL_MS, expiresInSec: 1200 });
        // the server holds the hash of the session id, never the id
        const id = sid(out.cookie);
        expect(allText(fs)).not.toContain(id);
        expect(fs.data.has(`wf-tenants/${token}/sessions/${sessionHash(id)}`)).toBe(true);
        // and the code is spent
        expect((await check(db, token, '123456', { now: T0 + 2000 })).status).toBe(401);
    });

    it('refuses a wrong code, a wrong NIC and an unknown link in the same words', async () => {
        const { db, token } = await ready();
        await ask(db, gateway(), token);
        const wrongCode = await check(db, token, '000000');
        const wrongNic = await check(db, token, '123456', { nic: '198534000999' });
        const unknown = await check(db, 'zzzzzzzzzzzzzzzz', '123456');
        const notAsked = await check((await ready()).db, (await ready()).token, '123456');
        for (const out of [wrongCode, wrongNic, unknown, notAsked]) expect({ status: out.status, body: out.body }).toEqual({ status: 401, body: { ok: false, error: MSG.DENIED } });
        expect(wrongCode.cookie).toBeUndefined();
    });

    it('a correct NIC with a wrong code, and a wrong NIC with a right code, both fail and both cost an attempt', async () => {
        const { fs, db, token } = await ready();
        await ask(db, gateway(), token);
        await check(db, token, '000000');
        await check(db, token, '123456', { nic: '198534000999' });
        expect(fs.data.get(`wf-tenants/${token}/otp/current`).attemptsLeft).toBe(3);
        expect((await check(db, token, '123456', { now: T0 + 5000 })).status).toBe(200);       // the right pair still works
    });

    it('five wrong answers lock the link and kill the live code, even for the right answer afterwards', async () => {
        const { fs, db, token } = await ready();
        await ask(db, gateway(), token);
        for (let i = 0; i < 4; i += 1) expect((await check(db, token, String(100000 + i), { now: T0 + 1000 + i })).status).toBe(401);
        const fifth = await check(db, token, '100004', { now: T0 + 1010 });
        expect(fifth.status).toBe(429);
        expect(fifth.body.retryAfterSec).toBe(15 * 60);
        expect(fs.data.get(`wf-tenants/${token}/otp/current`).status).toBe('spent');
        const right = await check(db, token, '123456', { now: T0 + 2000 });
        expect(right.status).toBe(429);
        expect(right.cookie).toBeUndefined();
        // the lock says the same thing whether the NIC is right or wrong
        const locked = await check(db, token, '123456', { nic: '198534000999', now: T0 + 2000 });
        expect(locked.body).toEqual(right.body);
    });

    it('after the lock a new code works, and the next lock is twice as long', async () => {
        const { fs, db, token } = await ready();
        const gw = gateway();
        await ask(db, gw, token);
        for (let i = 0; i < 5; i += 1) await check(db, token, String(100000 + i), { now: T0 + 1000 + i });
        let t = T0 + 15 * 60e3 + 2000;
        expect((await ask(db, gw, token, { now: t, random: codes('777777') })).status).toBe(200);
        expect(gw.sent.map((m) => codeIn(m.message))).toEqual(['123456', '777777']);
        for (let i = 0; i < 5; i += 1) await check(db, token, String(100000 + i), { now: t + 1000 + i });
        expect(fs.data.get(`wf-tenants/${token}`).lockedUntil).toBe(t + 1004 + 30 * 60e3);
        t += 30 * 60e3 + 2000;
        await ask(db, gw, token, { now: t, random: codes('888888') });
        const ok = await check(db, token, '888888', { now: t + 1000 });
        expect(ok.status).toBe(200);
        expect(fs.data.get(`wf-tenants/${token}`)).toMatchObject({ fails: 0, lockCount: 0, lockedUntil: 0 });      // proving who you are clears the slate
    });

    it('wrong NICs asked for codes count toward the lock too, so the NIC cannot be searched', async () => {
        const { fs, db, token } = await ready();
        const gw = gateway();
        for (let i = 0; i < LOCK.fails; i += 1) await ask(db, gw, token, { nic: `19853400099${i}`, ip: `ip${i}`, now: T0 + i });
        const next = await ask(db, gw, token, { ip: 'fresh', now: T0 + 10 });
        expect(next.status).toBe(429);                                                         // even the right NIC, now
        expect(gw.calls).toBe(0);
        expect(fs.data.get(`wf-tenants/${token}`).lockedUntil).toBeGreaterThan(T0);
    });

    it('expires after 3 minutes, to the millisecond', async () => {
        const a = await ready();
        await ask(a.db, gateway(), a.token);
        expect((await check(a.db, a.token, '123456', { now: T0 + OTP_TTL_MS - 1 })).status).toBe(200);
        const b = await ready();
        await ask(b.db, gateway(), b.token);
        expect((await check(b.db, b.token, '123456', { now: T0 + OTP_TTL_MS })).status).toBe(401);
        const c = await ready();
        await ask(c.db, gateway(), c.token);
        expect((await check(c.db, c.token, '123456', { now: T0 + 10 * 60e3 })).status).toBe(401);
    });

    it('an expired code does not open on a late attempt, however many times it is tried', async () => {
        const { db, token } = await ready();
        await ask(db, gateway(), token);
        for (let i = 0; i < 3; i += 1) expect((await check(db, token, '123456', { now: T0 + OTP_TTL_MS + 1000 * (i + 1) })).status).toBe(401);
    });

    it('two correct submissions at once make one session', async () => {
        const { fs, db, token } = await ready();
        await ask(db, gateway(), token);
        const outs = await Promise.all(Array.from({ length: 5 }, () => check(db, token, '123456')));
        expect(outs.filter((o) => o.status === 200)).toHaveLength(1);
        expect(outs.filter((o) => o.status === 401)).toHaveLength(4);
        expect([...fs.data.keys()].filter((k) => k.startsWith(`wf-tenants/${token}/sessions/`))).toHaveLength(1);
    });

    it('a code issued for one link is worthless on another, even if the digits are the same', async () => {
        const { fs, db } = makeDb();
        const tokenA = await seedTenant(fs, db, { uid: 'ownerA' });
        const tokenB = await seedTenant(fs, db, { uid: 'ownerB' });
        const gw = gateway();
        await ask(db, gw, tokenA, { random: codes('123456') });
        expect((await check(db, tokenB, '123456')).status).toBe(401);                  // B never asked
        // a stolen copy of A's record placed under B proves nothing: the proof names the link it was made for
        fs.data.set(`wf-tenants/${tokenB}/otp/current`, structuredClone(fs.data.get(`wf-tenants/${tokenA}/otp/current`)));
        expect((await check(db, tokenB, '123456', { now: T0 + 2000 })).status).toBe(401);
        expect((await check(db, tokenA, '123456', { now: T0 + 3000 })).status).toBe(200);
    });

    it('limits one address: 100 tries an hour', async () => {
        const { db, token } = await ready();
        for (let i = 0; i < LIMITS.verifiesPerIpHour; i += 1) await check(db, 'zzzzzzzzzzzzzzzz', '000000', { now: T0 + i });
        const blocked = await check(db, token, '000000', { now: T0 + 100 });
        expect(blocked.status).toBe(429);
    });

    it('refuses codes that are not six digits before touching anything', async () => {
        const { fs, db, token } = await ready();
        const before = allText(fs);
        for (const code of ['', '12345', '1234567', 'abcdef', '12 456', '１２３４５６']) {
            const out = await check(db, token, code);
            expect(out.status, code).toBe(400);
            expect(out.body.error).toBe(MSG.BAD_CODE);
        }
        expect(allText(fs)).toBe(before);
    });
});

describe('failState', () => {
    it('counts inside a window, forgets outside it, and doubles each lock up to a day', () => {
        expect(failState({}, 1000)).toEqual({ fails: 1, failStart: 1000, lockCount: 0, lockedUntil: 0 });
        expect(failState({ fails: 1, failStart: 1000 }, 2000)).toEqual({ fails: 2, failStart: 1000, lockCount: 0, lockedUntil: 0 });
        expect(failState({ fails: 4, failStart: 1000 }, 2000)).toEqual({ fails: 0, failStart: 0, lockCount: 1, lockedUntil: 2000 + 15 * 60e3 });
        expect(failState({ fails: 4, failStart: 1000, lockCount: 1 }, 2000).lockedUntil).toBe(2000 + 30 * 60e3);
        expect(failState({ fails: 4, failStart: 1000, lockCount: 20 }, 2000).lockedUntil).toBe(2000 + 86400e3);
        expect(failState({ fails: 4, failStart: 1000 }, 1000 + LOCK.windowMs + 1)).toEqual({ fails: 1, failStart: 1000 + LOCK.windowMs + 1, lockCount: 0, lockedUntil: 0 });
    });
});

describe('the session', () => {
    async function signedIn() {
        const ctx = await ready();
        await ask(ctx.db, gateway(), ctx.token);
        const out = await check(ctx.db, ctx.token, '123456');
        return { ...ctx, cookie: out.cookie.split(';')[0], expiresAt: out.body.expiresAt };
    }

    it('is found by its cookie, and only while it is live', async () => {
        const { db, token, cookie, expiresAt } = await signedIn();
        expect((await readSession({ db, cookieHeader: `a=b; ${cookie}; c=d`, now: T0 + 5000 })).token).toBe(token);
        expect(await readSession({ db, cookieHeader: cookie, now: expiresAt - 1 })).toBeTruthy();
        expect(await readSession({ db, cookieHeader: cookie, now: expiresAt })).toBeNull();                 // 20 minutes, not sliding
    });

    it('is not found for a guess, a tamper, another link, a missing cookie or a malformed one', async () => {
        const { fs, db, token, cookie } = await signedIn();
        const [name, value] = cookie.split('=');
        const [tok, id] = value.split('.');
        const flipped = id.slice(0, -1) + (id.endsWith('A') ? 'B' : 'A');
        const other = await seedTenant(fs, db, { uid: 'ownerB' });
        for (const header of [undefined, '', 'wf_tp=', `${name}=${tok}.${flipped}`, `${name}=${other}.${id}`, `${name}=${tok}`, `${name}=${tok}.${id}x`, `${name}=${id}.${tok}`, `${name}=${tok}.${'A'.repeat(32)}`, 'other=1']) {
            expect(await readSession({ db, cookieHeader: header, now: T0 + 5000 }), String(header)).toBeNull();
        }
        void token;
    });

    it('dies with its link: switching the link off ends every session at once', async () => {
        const { fs, db, token, cookie } = await signedIn();
        fs.data.set(`wf-tenants/${token}`, { ...fs.data.get(`wf-tenants/${token}`), active: false });
        expect(await readSession({ db, cookieHeader: cookie, now: T0 + 5000 })).toBeNull();
    });

    it('ends on sign-out', async () => {
        const { db, cookie } = await signedIn();
        const live = await readSession({ db, cookieHeader: cookie, now: T0 + 5000 });
        await endSession({ db, live });
        expect(await readSession({ db, cookieHeader: cookie, now: T0 + 6000 })).toBeNull();
    });

    it('clears out the link\'s expired sessions when a new one opens', async () => {
        const { fs, db, token } = await ready();
        for (let i = 0; i < 3; i += 1) fs.data.set(`wf-tenants/${token}/sessions/old${i}`, { createdAt: 1, expiresAt: 2, phoneHash: 'x' });
        await ask(db, gateway(), token);
        await check(db, token, '123456');
        expect([...fs.data.keys()].filter((k) => k.includes('/sessions/old'))).toHaveLength(0);
        expect([...fs.data.keys()].filter((k) => k.startsWith(`wf-tenants/${token}/sessions/`))).toHaveLength(1);
    });

    it('builds the statement for the lender and the NIC, and nothing else', async () => {
        const { fs, db, cookie } = await signedIn();
        const live = await readSession({ db, cookieHeader: cookie, now: T0 + 5000 });
        const st = await loadStatement({ db, live, secret: SECRET, now: T0 + 5000 });
        expect(st.groups.map((g) => g.kind)).toEqual(['investment', 'loan']);
        const text = JSON.stringify(st);
        for (const secret of ['PRIVATE COMPANY NAME', 'PRIVATE NOTE', 'PRIVATE DEBTOR NAME', 'PRIVATE DEBTOR NOTE', NIC, CANON, '0771234567', '077 123 4567', '+94771234567', 'inv1', 'deb1', '777']) {
            expect(text, secret).not.toContain(secret);
        }
        void fs;
    });

    it('adds another lender\'s records only when the NIC AND the verified phone both match', async () => {
        const { fs, db, token } = await ready();
        const nicHash = fs.data.get(`wf-tenants/${token}`).nicHash;
        const other = (uid, phone, nic = NIC) => ({
            settings: { currency: 'USD' },
            income: [],
            debtors: [{ id: `x-${uid}`, name: 'Hidden', phone, nic, sms_notifications_enabled: true, sms_enabled_at: 1, events: [{ id: 'e', kind: 'lent', amount: 1234, date: '2026-09-01', confirmed: true }] }],
        });
        await seedTenant(fs, db, { uid: 'same-phone', user: other('same-phone', '0771234567') });
        await seedTenant(fs, db, { uid: 'other-phone', user: other('other-phone', '0719999999') });
        await seedTenant(fs, db, { uid: 'switched-off', user: { ...other('switched-off', '0771234567'), debtors: [{ ...other('switched-off', '0771234567').debtors[0], sms_notifications_enabled: false }] } });
        void nicHash;

        await ask(db, gateway(), token);
        const out = await check(db, token, '123456');
        const live = await readSession({ db, cookieHeader: out.cookie.split(';')[0], now: T0 + 5000 });
        const st = await loadStatement({ db, live, secret: SECRET, now: T0 + 5000 });
        const usd = st.groups.filter((g) => g.currency === 'USD');
        expect(usd).toHaveLength(1);                                                         // only the lender whose record carries the verified phone
        expect(usd[0].outstanding).toBe(1234);
        expect(st.totals.find((t) => t.currency === 'USD').loanOutstanding).toBe(1234);
        expect(st.totals.find((t) => t.currency === 'LKR')).toBeTruthy();
        expect(JSON.stringify(st)).not.toContain('Hidden');
    });
});

describe('who a code goes to', () => {
    it('is the number on the record switched on most recently for that NIC', () => {
        const user = lenderDoc({
            income: [
                { id: 'a', nic: NIC, phone: '0771111111', sms_notifications_enabled: true, sms_enabled_at: 100 },
                { id: 'b', nic: '198534000937', phone: '0772222222', sms_notifications_enabled: true, sms_enabled_at: 200 },
                { id: 'c', nic: '198534000999', phone: '0773333333', sms_notifications_enabled: true, sms_enabled_at: 900 },
                { id: 'd', nic: NIC, phone: '0774444444', sms_notifications_enabled: false, sms_enabled_at: 800 },
                { id: 'e', nic: NIC, phone: 'garbage', sms_notifications_enabled: true, sms_enabled_at: 700 },
            ],
            debtors: [],
        });
        const r = pickRecipient(user, normalizeNic(NIC).canonical, SECRET);
        expect(r.e164).toBe('+94772222222');
        expect(r.masked).toBe('+94*****2222');
        expect(r.phoneHash).toBe(phoneHashOf('+94772222222', SECRET));
        expect(pickRecipient({}, CANON, SECRET)).toBeNull();
        expect(pickRecipient(null, CANON, SECRET)).toBeNull();
    });
});

describe('small helpers', () => {
    it('hit() counts a window and lets it slide', async () => {
        const { db } = makeDb();
        const r = [];
        for (let i = 0; i < 4; i += 1) r.push((await hit(db, 'k', 3, 1000, 5000 + i)).ok);
        expect(r).toEqual([true, true, true, false]);
        expect((await hit(db, 'k', 3, 1000, 6001)).ok).toBe(true);
    });

    it('reads the caller from the platform\'s own header first, and hashes it', () => {
        expect(clientIp({ headers: { 'x-vercel-forwarded-for': '1.2.3.4', 'x-forwarded-for': '9.9.9.9' } })).toBe('1.2.3.4');
        expect(clientIp({ headers: { 'x-forwarded-for': '5.6.7.8, 10.0.0.1' } })).toBe('5.6.7.8');
        expect(clientIp({ headers: {} })).toBe('unknown');
        expect(ipKey({ headers: { 'x-real-ip': '1.2.3.4' } }, SECRET)).toMatch(/^[0-9a-f]{24}$/);
        expect(ipKey({ headers: { 'x-real-ip': '1.2.3.4' } }, SECRET)).not.toContain('1.2.3.4');
    });

    it('parses cookies, and builds one that cannot be read by script, sent cross-site or sent to any other path', () => {
        expect(parseCookies('a=1; wf_tp=abc.def; b=x=y')).toEqual({ a: '1', wf_tp: 'abc.def', b: 'x=y' });
        expect(parseCookies(undefined)).toEqual({});
        const c = sessionCookie('T'.repeat(16), 'S'.repeat(32));
        for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/api/tenant-portal', 'Max-Age=1200']) expect(c).toContain(attr);
        expect(c).not.toMatch(/Domain=/i);
    });

    it('a NIC that the lender typed in either shape finds the same tenant', async () => {
        const { fs, db } = makeDb();
        const t1 = await ensureTenantToken({ db, uid: UID, canonicalNic: normalizeNic('853400937V').canonical, secret: SECRET, now: 1 });
        const t2 = await ensureTenantToken({ db, uid: UID, canonicalNic: normalizeNic('198534000937').canonical, secret: SECRET, now: 2 });
        expect(t1).toBe(t2);
        void fs;
    });
});

describe('changing the server secret', () => {
    it('re-keys an existing link the next time a text is sent for it, without changing the link', async () => {
        const { fs, db } = makeDb();
        const oldKey = Buffer.alloc(32, 1);
        const newKey = Buffer.alloc(32, 2);
        const token = await ensureTenantToken({ db, uid: UID, canonicalNic: CANON, secret: oldKey, now: 1 });
        const before = fs.data.get(`wf-tenants/${token}`).nicHash;
        const again = await ensureTenantToken({ db, uid: UID, canonicalNic: CANON, secret: newKey, now: 2 });
        expect(again).toBe(token);
        expect(fs.data.get(`wf-tenants/${token}`).nicHash).not.toBe(before);
        expect(fs.data.get(`wf-tenant-subjects/${[...fs.data.keys()].find((k) => k.startsWith('wf-tenant-subjects/')).split('/')[1]}`).nicHash).toBe(fs.data.get(`wf-tenants/${token}`).nicHash);
        expect(fs.data.get(`wf-tenants/${token}`)).toMatchObject({ uid: UID, active: true, createdAt: 1 });
    });
});
