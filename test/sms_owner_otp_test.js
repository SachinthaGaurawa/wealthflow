/* =============================================================================
 * test/sms_owner_otp_test.js — "Alerts to my own number" go only to a number whose verification code was entered
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-23: adding a number must send a code to it, and the number is accepted only once the code is entered correctly.
 * What is pinned: the code is random, short-lived, single-use and tied to the account and the number; the limits that cap cost and guessing;
 * the failure paths (gateway refusal, double tap, expiry, wrong codes); the engine refuses an unverified number whatever the synced settings say;
 * the endpoint's door (who may ask); and the panel only ever saves a verified number. Nothing touches a network: the gateway is a stub, Firestore is in memory.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import {
    OTP_TTL_MS, RESEND_GAP_MS, MAX_TRIES, MAX_SENDS_PER_DAY, newCode, codeHash, otpMessage, verifiedPhoneOf, sendOwnerCode, verifyOwnerCode,
} from '../sms-owner-otp.mjs';
import { ownerEvents, withVerifiedOwner } from '../sms-owner.mjs';
import { sweepUser } from '../sms-engine.mjs';
import { handleNotify } from '../sms-notify.js';
import { analyzeSms } from '../textlk.mjs';
import { boot, ownerAlertsHtml, ownerCodeCall, describeIssue, panelHtml } from '../wealthflow-sms.js';

const NOW = Date.UTC(2026, 9, 23, 5, 0, 0);
const ENV = { OTP_SECRET: 'o'.repeat(48), SMS_ALLOWED_EMAILS: 'owner@example.com' };
const PHONE = '0778787998';
const E164 = '+94778787998';

function gateway({ fail = null, configured = true } = {}) {
    const sent = [];
    return {
        configured, senderId: 'WealthFlow', sent,
        async send({ to, message }) {
            sent.push({ to, message });
            return fail ? { ok: false, retryable: false, message: 'x', ...fail } : { ok: true, gatewayId: 'g' + sent.length, cost: 1, segments: 1 };
        },
        async balance() { return { ok: true, units: 50 }; },
    };
}
const codeOf = (client) => (/(\d{6})/.exec(client.sent.at(-1).message) || [])[1];
const rootOf = (fs, uid = 'u1') => fs.data.get(`wf-sms/${uid}`) || {};

describe('the code', () => {
    it('is six digits with leading zeros kept, and comes from a cryptographic source', () => {
        expect(newCode(() => 42)).toBe('000042');
        expect(newCode(() => 999999)).toBe('999999');
        const seen = new Set(Array.from({ length: 60 }, () => newCode()));
        expect(seen.size).toBeGreaterThan(50);
        for (const c of seen) expect(c).toMatch(/^\d{6}$/);
    });
    it('is kept only as an HMAC bound to the secret, the account and the number', () => {
        const a = codeHash('s'.repeat(40), 'u1', E164, '123456');
        expect(a).toMatch(/^[a-f0-9]{64}$/);
        expect(codeHash('s'.repeat(40), 'u1', E164, '123456')).toBe(a);
        expect(codeHash('s'.repeat(40), 'u2', E164, '123456')).not.toBe(a);
        expect(codeHash('s'.repeat(40), 'u1', '+94771234567', '123456')).not.toBe(a);
        expect(codeHash('t'.repeat(40), 'u1', E164, '123456')).not.toBe(a);
        expect(codeHash('s'.repeat(40), 'u1', E164, '123457')).not.toBe(a);
    });
    it('the text is one part, says what it is, and warns not to share it', () => {
        const m = otpMessage('123456');
        expect(m).toContain('123456');
        expect(m).toMatch(/WealthFlow/);
        expect(m).toMatch(/10 minutes/);
        expect(m).toMatch(/Do not share/);
        expect(analyzeSms(m).segments).toBe(1);
    });
    it('only a stored, well-formed Sri Lankan mobile number counts as verified', () => {
        expect(verifiedPhoneOf(null)).toBe('');
        expect(verifiedPhoneOf({ ownerVerified: { phone: E164, at: 1 } })).toBe(E164);
        expect(verifiedPhoneOf({ ownerVerified: { phone: '+15551234567' } })).toBe('');
        expect(verifiedPhoneOf({ ownerVerified: E164 })).toBe('');
    });
});

describe('asking for a code', () => {
    it('texts the number being added, keeps only the hash, and counts the text', async () => {
        const fs = createFirestore(); const client = gateway();
        const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW });
        expect(r).toMatchObject({ ok: true, resendAfterMs: RESEND_GAP_MS });
        expect(r.expiresAt).toBe(NOW + OTP_TTL_MS);
        expect(r.sentTo).toMatch(/^\+94\*+7998$/);
        expect(client.sent).toHaveLength(1);
        expect(client.sent[0].to).toBe(E164);
        const code = codeOf(client);
        expect(code).toMatch(/^\d{6}$/);
        const root = rootOf(fs);
        expect(JSON.stringify(root)).not.toContain(code);
        expect(root.ownerOtp).toMatchObject({ phone: E164, tries: 0, sentAt: NOW, exp: NOW + OTP_TTL_MS });
        expect(root.ownerOtpLog).toEqual([NOW]);
        expect(root.ownerVerified).toBeUndefined();
    });
    it('refuses a number that is not a Sri Lankan mobile, and sends nothing', async () => {
        for (const bad of ['', 'abc', '011 234 5678', '+1 555 123 4567', '077 12']) {
            const fs = createFirestore(); const client = gateway();
            const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: bad, client, env: ENV, now: NOW });
            expect(r).toMatchObject({ ok: false, status: 400, reason: 'invalid-phone' });
            expect(client.sent).toHaveLength(0);
            expect(fs.data.size).toBe(0);
        }
    });
    it('says it is not set up, without a text, when the secret is missing or short or the gateway has no token', async () => {
        for (const [env, client] of [[{}, gateway()], [{ OTP_SECRET: 'short' }, gateway()], [ENV, gateway({ configured: false })]]) {
            const fs = createFirestore();
            const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env, now: NOW });
            expect(r).toMatchObject({ ok: false, status: 503, reason: 'not-configured' });
            expect(client.sent).toHaveLength(0);
            expect(fs.data.size).toBe(0);
        }
    });
    it('a second tap, or a second device, within 45 seconds sends nothing (the check and the reservation are one Firestore transaction; the in-memory stand-in does not simulate two at the same instant)', async () => {
        const fs = createFirestore(); const client = gateway();
        const a = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW });
        const b = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW + 100 });
        expect([a.ok, b.ok]).toEqual([true, false]);
        expect(client.sent).toHaveLength(1);
        const wait = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW + 5000 });
        expect(wait).toMatchObject({ ok: false, status: 429, reason: 'wait' });
        expect(wait.retryAfterMs).toBe(RESEND_GAP_MS - 5000);
        expect(client.sent).toHaveLength(1);
    });
    it('a new code replaces the old one, which no longer works', async () => {
        const fs = createFirestore(); const client = gateway();
        await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW });
        const first = codeOf(client);
        await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW + RESEND_GAP_MS + 1 });
        const second = codeOf(client);
        if (first !== second) {
            expect(await verifyOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, code: first, env: ENV, now: NOW + RESEND_GAP_MS + 2 })).toMatchObject({ ok: false, reason: 'wrong-code' });
        }
        expect(await verifyOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, code: second, env: ENV, now: NOW + RESEND_GAP_MS + 3 })).toMatchObject({ ok: true });
    });
    it('is capped at five texts in 24 hours, then opens again', async () => {
        const fs = createFirestore(); const client = gateway();
        let at = NOW;
        for (let i = 0; i < MAX_SENDS_PER_DAY; i += 1) {
            const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: at });
            expect(r.ok, `send ${i + 1}`).toBe(true);
            at += RESEND_GAP_MS + 1000;
        }
        const sixth = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: at });
        expect(sixth).toMatchObject({ ok: false, status: 429, reason: 'daily-limit' });
        expect(client.sent).toHaveLength(MAX_SENDS_PER_DAY);
        const later = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW + 24 * 3600e3 + 1000 });
        expect(later.ok).toBe(true);
    });
    it('a refusal from the gateway gives the reservation back, so a failure that was not the owner\'s costs nothing', async () => {
        const fs = createFirestore();
        const refusing = gateway({ fail: { kind: 'credit' } });
        const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client: refusing, env: ENV, now: NOW });
        expect(r).toMatchObject({ ok: false, status: 502, reason: 'send-failed' });
        expect(r.message).toMatch(/no credit/);
        expect(rootOf(fs).ownerOtp).toBeNull();
        expect(rootOf(fs).ownerOtpLog).toEqual([]);
        const ok = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client: gateway(), env: ENV, now: NOW + 1000 });   // no 45 s wait after a failure
        expect(ok.ok).toBe(true);
    });
    it('a text that may have been delivered (a timeout) keeps the reservation and the code stays valid', async () => {
        const fs = createFirestore();
        const slow = gateway({ fail: { kind: 'timeout', possiblySent: true } });
        const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client: slow, env: ENV, now: NOW });
        expect(r).toMatchObject({ ok: false, reason: 'not-confirmed' });
        const code = codeOf(slow);
        expect(await verifyOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, code, env: ENV, now: NOW + 5000 })).toMatchObject({ ok: true });
    });
    it('an already verified number is not texted again', async () => {
        const fs = createFirestore({ 'wf-sms/u1': { ownerVerified: { phone: E164, at: 1 } } }); const client = gateway();
        const r = await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW });
        expect(r).toMatchObject({ ok: true, alreadyVerified: true });
        expect(client.sent).toHaveLength(0);
    });
});

describe('entering the code', () => {
    async function asked(over = {}) {
        const fs = createFirestore(over.seed || {}); const client = gateway();
        await sendOwnerCode({ db: fs.db, uid: 'u1', phone: PHONE, client, env: ENV, now: NOW });
        return { fs, client, code: codeOf(client) };
    }
    const verify = (fs, code, now = NOW + 60000, phone = PHONE, uid = 'u1') => verifyOwnerCode({ db: fs.db, uid, phone, code, env: ENV, now });

    it('the right code makes the number verified, once, and the status card (which the page can read) carries it', async () => {
        const { fs, code } = await asked();
        const r = await verify(fs, code);
        expect(r).toEqual({ ok: true, phone: E164 });
        expect(rootOf(fs).ownerVerified).toEqual({ phone: E164, at: NOW + 60000 });
        expect(rootOf(fs).ownerOtp).toBeNull();
        expect(fs.data.get('users/u1/smsLog/_status').ownerVerified).toBe(E164);
        expect(await verify(fs, code)).toMatchObject({ ok: false, reason: 'no-code' });          // single use
    });
    it('a wrong code is refused and counted; five wrong codes end that code, even for the right one', async () => {
        const { fs, code } = await asked();
        const wrong = code === '000000' ? '111111' : '000000';
        for (let i = 1; i < MAX_TRIES; i += 1) {
            const r = await verify(fs, wrong);
            expect(r).toMatchObject({ ok: false, status: 400, reason: 'wrong-code', triesLeft: MAX_TRIES - i });
        }
        expect(await verify(fs, wrong)).toMatchObject({ ok: false, reason: 'wrong-code', triesLeft: 0 });
        expect(await verify(fs, code)).toMatchObject({ ok: false, reason: 'no-code' });
        expect(rootOf(fs).ownerVerified).toBeUndefined();
    });
    it('a code that is not six digits is refused without using a try', async () => {
        const { fs, code } = await asked();
        for (const bad of ['', '12345', '1234567', 'abcdef', '12 34']) expect(await verify(fs, bad)).toMatchObject({ ok: false, reason: 'bad-format' });
        expect(rootOf(fs).ownerOtp.tries).toBe(0);
        expect(await verify(fs, code.slice(0, 3) + ' ' + code.slice(3))).toMatchObject({ ok: true });         // a space typed in the middle is fine
    });
    it('expires after ten minutes', async () => {
        const { fs, code } = await asked();
        expect(await verify(fs, code, NOW + OTP_TTL_MS + 1)).toMatchObject({ ok: false, reason: 'expired' });
        expect(await verify(fs, code, NOW + 1000)).toMatchObject({ ok: false, reason: 'no-code' });
        expect(rootOf(fs).ownerVerified).toBeUndefined();
    });
    it('is for the number it was sent to: the same code does not verify another number', async () => {
        const { fs, code } = await asked();
        expect(await verify(fs, code, NOW + 1000, '0771234567')).toMatchObject({ ok: false, reason: 'no-code' });
        expect(rootOf(fs).ownerVerified).toBeUndefined();
    });
    it('is for the account it was sent to: another account holding the same record cannot use it', async () => {
        const { fs, code } = await asked();
        fs.data.set('wf-sms/u2', JSON.parse(JSON.stringify(rootOf(fs))));
        expect(await verify(fs, code, NOW + 1000, PHONE, 'u2')).toMatchObject({ ok: false, reason: 'wrong-code' });
        expect(rootOf(fs, 'u2').ownerVerified).toBeUndefined();
    });
    it('nothing is verified without a code having been asked for first', async () => {
        const fs = createFirestore();
        expect(await verify(fs, '123456')).toMatchObject({ ok: false, reason: 'no-code' });
        expect(fs.data.size).toBe(0);
    });
    it('verifying a second number replaces the first as the verified one', async () => {
        const { fs, code } = await asked();
        await verify(fs, code);
        const client = gateway();
        await sendOwnerCode({ db: fs.db, uid: 'u1', phone: '0771234567', client, env: ENV, now: NOW + 120000 });
        expect(rootOf(fs).ownerVerified.phone).toBe(E164);                                     // still the old one until the new code is entered
        await verifyOwnerCode({ db: fs.db, uid: 'u1', phone: '0771234567', code: codeOf(client), env: ENV, now: NOW + 130000 });
        expect(rootOf(fs).ownerVerified.phone).toBe('+94771234567');
    });
});

describe('the engine only texts a verified number', () => {
    const dueTomorrow = (n = 1) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
    const books = (owner) => ({ settings: { currency: 'LKR', owner_sms: owner }, subscriptions: [{ id: 'o1', name: 'Licence', amount: 45000, cycle: 'once', dueDate: dueTomorrow(), createdAt: dueTomorrow(-9) }] });
    const own = { enabled: true, phone: PHONE, at: 1 };
    const run = async (user, seed) => {
        const fs = createFirestore(seed || {}); const client = gateway();
        const summary = await sweepUser({ db: fs.db, uid: 'u1', user, client, now: NOW, env: {}, deps: { random: () => 0.5 } });
        return { fs, client, summary };
    };

    it('an unverified number is paused with a reason the owner can act on, and nothing is sent or queued', async () => {
        const { client, summary, fs } = await run(books(own));
        expect(client.sent).toHaveLength(0);
        expect(summary.derived).toBe(0);
        expect(fs.data.get('users/u1/smsLog/_status').issues).toEqual([{ recordKind: 'owner', recordId: 'owner', reason: 'phone-not-verified' }]);
        expect(fs.data.get('users/u1/smsLog/_status').ownerVerified).toBe('');
    });
    it('a verified number gets its alerts, and the status card says which number is verified', async () => {
        const { client, fs } = await run(books(own), { 'wf-sms/u1': { ownerVerified: { phone: E164, at: 1 } } });
        expect(client.sent).toHaveLength(1);
        expect(client.sent[0].to).toBe(E164);
        expect(fs.data.get('users/u1/smsLog/_status').ownerVerified).toBe(E164);
    });
    it('a verified number is not a licence for another: a different saved number is paused', async () => {
        const { client } = await run(books({ ...own, phone: '0771234567' }), { 'wf-sms/u1': { ownerVerified: { phone: E164, at: 1 } } });
        expect(client.sent).toHaveLength(0);
    });
    it('whatever the synced settings say about verification is replaced by the server\'s own record', async () => {
        const lying = { ...own, verifiedPhone: E164, verified: true, ownerVerified: E164 };
        expect((await run(books(lying))).client.sent).toHaveLength(0);
        const viaHelper = withVerifiedOwner(books(lying), '');
        expect(viaHelper.settings.owner_sms.verifiedPhone).toBe('');
        expect(ownerEvents(viaHelper, NOW, 'LKR', (ms) => ms).issues[0].reason).toBe('phone-not-verified');
    });
    it('what was queued for a number that stops being verified is cancelled before it goes', async () => {
        const fs = createFirestore({ 'wf-sms/u1': { ownerVerified: { phone: E164, at: 1 } } });
        const down = { configured: false, senderId: 'WealthFlow', async send() { return { ok: false }; } };
        const up = gateway();
        const user = books(own);
        const first = await sweepUser({ db: fs.db, uid: 'u1', user, client: down, now: NOW, env: {}, deps: { random: () => 0.5 } });
        expect(first.derived).toBe(1);
        fs.data.set('wf-sms/u1', { ownerVerified: null });
        const second = await sweepUser({ db: fs.db, uid: 'u1', user, client: up, now: NOW, env: {}, deps: { random: () => 0.5 } });
        expect(second.cancelled).toBe(1);
        expect(up.sent).toHaveLength(0);
    });
    it('the owner\'s alerts stay off, with no issue, when the switch is off', async () => {
        const { summary, fs } = await run(books({ ...own, enabled: false }));
        expect(summary.issues).toBe(0);
        expect(fs.data.get('users/u1/smsLog/_status').issues).toEqual([]);
    });
});

describe('the door: POST /api/sms-notify with an owner-otp action', () => {
    const res = () => { const r = { statusCode: 0, body: null, setHeader() {}, end(b) { r.body = b ? JSON.parse(b) : null; } }; return r; };
    const world = ({ tokens, env = {}, client = gateway() } = {}) => {
        const fs = createFirestore();
        const table = tokens || { good: { uid: 'u1', email: 'owner@example.com', email_verified: true } };
        const admin = { auth: () => ({ verifyIdToken: async (t) => { if (!table[t]) throw new Error('bad'); return table[t]; } }) };
        return { fs, client, deps: { client: () => client, getAdminDb: async () => ({ db: fs.db, admin }), env: { ...ENV, ...env }, now: () => NOW, randomInt: () => 424242 } };
    };
    const post = (body, token = 'good') => ({ method: 'POST', url: '/api/sms-notify', headers: token ? { authorization: 'Bearer ' + token } : {}, body });

    it('send then verify, end to end, as the signed-in account', async () => {
        const w = world();
        const a = res(); await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }), a, w.deps);
        expect(a.statusCode).toBe(200);
        expect(a.body).toMatchObject({ ok: true, resendAfterMs: RESEND_GAP_MS });
        expect(JSON.stringify(a.body)).not.toMatch(/424242|hash/);
        expect(codeOf(w.client)).toBe('424242');
        const b = res(); await handleNotify(post({ action: 'owner-otp-verify', phone: PHONE, code: '424242' }), b, w.deps);
        expect(b.statusCode).toBe(200);
        expect(b.body).toEqual({ ok: true, phone: E164 });
        expect(rootOf(w.fs).ownerVerified.phone).toBe(E164);
    });
    it('a wrong code is a 400 that says so and nothing else', async () => {
        const w = world();
        await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }), res(), w.deps);
        const r = res(); await handleNotify(post({ action: 'owner-otp-verify', phone: PHONE, code: '000001' }), r, w.deps);
        expect(r.statusCode).toBe(400);
        expect(r.body).toMatchObject({ ok: false, error: 'wrong-code', triesLeft: MAX_TRIES - 1 });
    });
    it('no token, a bad token and an account that may not use SMS are refused, and no code is sent', async () => {
        const w = world({ tokens: { good: { uid: 'u1', email: 'owner@example.com', email_verified: true }, stranger: { uid: 'u9', email: 'x@else.org', email_verified: true } } });
        const none = res(); await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }, null), none, w.deps);
        const bad = res(); await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }, 'nope'), bad, w.deps);
        const stranger = res(); await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }, 'stranger'), stranger, w.deps);
        expect([none.statusCode, bad.statusCode, stranger.statusCode]).toEqual([401, 401, 403]);
        expect(w.client.sent).toHaveLength(0);
        expect(w.fs.data.size).toBe(0);
    });
    it('the account is the token\'s: a uid in the body is ignored', async () => {
        const w = world();
        await handleNotify(post({ action: 'owner-otp-send', phone: PHONE, uid: 'someone-else' }), res(), w.deps);
        expect(w.fs.data.has('wf-sms/u1')).toBe(true);
        expect(w.fs.data.has('wf-sms/someone-else')).toBe(false);
    });
    it('is not held back by the sweep\'s kick throttle, and an ordinary kick still is', async () => {
        const w = world();
        const a = res(); await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }), a, w.deps);
        const b = res(); await handleNotify(post({ action: 'owner-otp-verify', phone: PHONE, code: '424242' }), b, w.deps);
        expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
        await w.fs.db.collection('wf-sms').doc('u1').set({ lastKickAt: NOW }, { merge: true });
        const kick = res(); await handleNotify(post({}), kick, w.deps);
        expect(kick.body).toMatchObject({ throttled: true });
    });
    it('without OTP_SECRET it says verification is not set up (503) and sends nothing', async () => {
        const w = world({ env: { OTP_SECRET: '' } });
        const r = res(); await handleNotify(post({ action: 'owner-otp-send', phone: PHONE }), r, w.deps);
        expect(r.statusCode).toBe(503);
        expect(r.body.message).toMatch(/not set up/);
        expect(w.client.sent).toHaveLength(0);
    });
});

describe('the panel', () => {
    it('a saved, verified number is LOCKED: read-only, with Change number, and no Save or Send code to press by mistake', () => {
        const html = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: E164 });
        expect(html).toMatch(/Verified: \+94 77 878 7998/);
        expect(html).toMatch(/id="_wf_own_phone"[^>]*readonly/);
        expect(html).toContain('id="_wf_own_change"');
        expect(html).not.toContain('_wf_own_save');
        expect(html).not.toContain('_wf_own_code');
        expect(html).not.toContain('_wf_own_cancel');
        expect(html).toMatch(/Locked/);
        expect(html).toContain('id="_wf_own_on" checked');                                           // the switch stays live and shows what is saved
    });
    it('locked shows the SAVED number whatever half-typed text a redraw still carries', () => {
        const html = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: E164, form: { phone: '071 222 3344', enabled: false } });
        expect(html).toContain('value="' + PHONE + '"');
        expect(html).not.toContain('071 222 3344');
        expect(html).toContain('id="_wf_own_on" checked');
    });
    it('after Change number the box is open: Save for the same number, Send code for another, and Cancel puts the saved one back', () => {
        const same = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: E164, form: { editing: true } });
        expect(same).toContain('data-mode="save"');
        expect(same).not.toMatch(/id="_wf_own_phone"[^>]*readonly/);
        expect(same).toContain('id="_wf_own_cancel"');
        expect(same).not.toContain('_wf_own_change');
        const other = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: E164, form: { editing: true, phone: '071 222 3344' } });
        expect(other).toContain('data-mode="send"');
        expect(other).toMatch(/keep going to \+94 77 878 7998/);
    });
    it('a number that was saved but is not the verified one stays open (an older number is never shown as locked)', () => {
        const html = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: '+94771234567' });
        expect(html).not.toContain('_wf_own_change');
        expect(html).not.toMatch(/readonly/);
    });
    it('shows Send code for a number that is not the verified one, and says the verified one keeps going meanwhile', () => {
        const html = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: '+94771234567' });
        expect(html).toContain('data-mode="send"');
        expect(html).toContain('>Send code<');
        expect(html).toMatch(/not verified yet/);
        expect(html).toMatch(/keep going to \+94 77 123 4567/);
    });
    it('a saved number nobody has verified (an older one) asks to be verified', () => {
        const html = ownerAlertsHtml({ enabled: true, phone: PHONE, verified: '' });
        expect(html).toContain('data-mode="send"');
        expect(html).not.toMatch(/keep going to/);
    });
    it('shows the code row, with Verify and Resend, once a code is on its way for the typed number', () => {
        const html = ownerAlertsHtml({ enabled: true, phone: '', verified: '', form: { phone: PHONE, enabled: true, pendingPhone: E164, resendAt: 123456 } });
        expect(html).toContain('id="_wf_own_code"');
        expect(html).toContain('maxlength="8"');                                                     // room for "482 913" as it may be pasted
        expect(html).toContain('autocomplete="one-time-code"');
        expect(html).toContain('id="_wf_own_verify"');
        expect(html).toContain('id="_wf_own_resend" data-at="123456"');
        expect(ownerAlertsHtml({ enabled: true, phone: '', verified: '', form: { phone: '0771234567', pendingPhone: E164 } })).not.toContain('_wf_own_code');   // another number: no stale code box
    });
    it('keeps what is being typed across a redraw, and shows the message in its colour, escaped', () => {
        const html = ownerAlertsHtml({ enabled: false, phone: '', verified: '', form: { phone: '"><i>', enabled: true, msg: 'That code is not right.<b>', tone: 'bad' } });
        expect(html).toContain('checked');
        expect(html).not.toContain('"><i>');
        expect(html).not.toContain('<b>');
        expect(html).toMatch(/color:var\(--red/);
    });
    it('the status card explains a paused alert in whole sentences', () => {
        expect(describeIssue({ recordKind: 'owner', recordId: 'owner', reason: 'phone-not-verified' })).toMatch(/paused until this number is verified.*Send code/);
        expect(describeIssue({ recordKind: 'owner', recordId: 'owner', reason: 'phone-bad-length' })).toMatch(/^Alerts to your own number/);
        expect(panelHtml({ rows: [], status: { configured: true, issues: [{ recordKind: 'owner', recordId: 'owner', reason: 'phone-not-verified' }] } })).toMatch(/paused until this number is verified/);
    });
});

describe('the page glue', () => {
    function page(status) {
        const settings = { owner_sms: { enabled: true, phone: PHONE, at: 1 } };
        const saved = []; const calls = []; const timers = []; let handler = null;
        const win = {
            _isDecoyMode: false, appData: { income: [], debtors: [], settings },
            currentUser: { uid: 'u1', getIdToken: async () => 'tok' },
            notify() {}, localStorage: { getItem: () => null, setItem() {} },
            document: { visibilityState: 'visible', addEventListener() {} }, addEventListener() {},
            DB: { getObj: (k, d) => (k === 'settings' ? win.appData.settings : d), set: (k, v) => { saved.push([k, v]); if (k === 'settings') win.appData.settings = v; } },
            fetch: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status: 200, json: async () => ({ ok: true, summary: {} }) }; },
            firebase: { firestore: () => ({ collection: () => ({ doc: () => ({ collection: () => ({ orderBy: () => ({ limit: () => ({ onSnapshot: (ok) => { handler = ok; return () => {}; } }) }) }) }) }) }) },
            setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval() {}, setTimeout: (fn) => { fn(); return 0; }, requestAnimationFrame: (fn) => fn(),
        };
        const api = boot(win); timers[0]();
        if (status) handler({ docs: [{ id: '_status', data: () => status }] });
        return { api, win, saved, calls };
    }

    it('the switch cannot be turned on for a number the server has not verified, and nothing is saved', () => {
        const p = page({ configured: true, ownerVerified: '' });
        expect(p.api.setOwnerAlerts({ enabled: true, phone: PHONE })).toMatchObject({ ok: false });
        expect(p.api.setOwnerAlerts({ enabled: true, phone: PHONE }).error).toMatch(/Verify this number first/);
        expect(p.saved).toHaveLength(0);
    });
    it('another number than the verified one is refused too, while the verified one saves', () => {
        const p = page({ configured: true, ownerVerified: E164 });
        expect(p.api.setOwnerAlerts({ enabled: true, phone: '0771234567' }).ok).toBe(false);
        expect(p.api.setOwnerAlerts({ enabled: true, phone: PHONE }).ok).toBe(true);
        expect(p.saved.at(-1)[1].owner_sms).toMatchObject({ enabled: true, phone: PHONE });
    });
    it('switching off is always allowed, and never replaces the saved number with one that is not verified', () => {
        const p = page({ configured: true, ownerVerified: E164 });
        expect(p.api.setOwnerAlerts({ enabled: false, phone: '0771234567' }).ok).toBe(true);
        expect(p.saved.at(-1)[1].owner_sms).toMatchObject({ enabled: false, phone: PHONE });
    });
    it('an empty number with the switch off clears it; an empty number with the switch on is refused', () => {
        const p = page({ configured: true, ownerVerified: E164 });
        expect(p.api.setOwnerAlerts({ enabled: true, phone: '' }).ok).toBe(false);
        expect(p.api.setOwnerAlerts({ enabled: false, phone: '' }).ok).toBe(true);
        expect(p.saved.at(-1)[1].owner_sms.phone).toBe('');
    });
});

describe('the page\'s call to the endpoint', () => {
    const deps = (over = {}) => ({ getIdToken: async () => 'tok', fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, sentTo: '+94****7998' }) }), ...over });
    it('posts the action with the signed-in token and returns the answer', async () => {
        let seen = null;
        const r = await ownerCodeCall(deps({ fetchImpl: async (url, init) => { seen = { url, init }; return { status: 200, json: async () => ({ ok: true, sentTo: 'x' }) }; } }), { action: 'owner-otp-send', phone: PHONE });
        expect(r.ok).toBe(true);
        expect(seen.url).toBe('/api/sms-notify');
        expect(seen.init.headers.Authorization).toBe('Bearer tok');
        expect(JSON.parse(seen.init.body)).toEqual({ action: 'owner-otp-send', phone: PHONE });
    });
    it('always answers with ok and a sentence the owner can read: no token, 403, an unreadable body, a thrown fetch', async () => {
        expect(await ownerCodeCall(deps({ getIdToken: async () => null }), {})).toMatchObject({ ok: false, message: expect.stringMatching(/Sign in again/) });
        expect(await ownerCodeCall(deps({ fetchImpl: async () => ({ status: 403, json: async () => ({ ok: false }) }) }), {})).toMatchObject({ ok: false, message: expect.stringMatching(/not enabled for this account/) });
        expect(await ownerCodeCall(deps({ fetchImpl: async () => ({ status: 502, json: async () => { throw new Error('html'); } }) }), {})).toMatchObject({ ok: false, message: expect.stringMatching(/Try again/) });
        expect(await ownerCodeCall(deps({ fetchImpl: async () => { throw new Error('offline'); } }), {})).toMatchObject({ ok: false, message: expect.stringMatching(/Could not reach/) });
        expect(await ownerCodeCall(deps({ fetchImpl: async () => ({ status: 429, json: async () => ({ ok: false, reason: 'wait', message: 'A code was just sent.', retryAfterMs: 9000 }) }) }), {})).toMatchObject({ ok: false, reason: 'wait', retryAfterMs: 9000, message: 'A code was just sent.' });
    });
});
