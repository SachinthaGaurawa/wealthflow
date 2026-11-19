/* =============================================================================
 * test/sms_gateway_test_test.js — "Check the SMS gateway" sends one real text, to the verified own number only
 * -----------------------------------------------------------------------------
 * Owner, 2026-11-19: the check should text the owner, so the owner sees the gateway work. Pinned: the recipient is the number the server recorded as
 * verified (never anything in the request), the cost is capped, a refusal gives the slot back, and every refusal is explained in words.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { sendGatewayTest, testMessage, TEST_GAP_MS, MAX_TESTS_PER_DAY, DAY_MS } from '../sms-gateway-test.mjs';
import { handleNotify } from '../sms-notify.js';
import { analyzeSms } from '../textlk.mjs';
import { panelHtml } from '../wealthflow-sms.js';

const NOW = Date.UTC(2026, 10, 19, 16, 0, 0);
const E164 = '+94778787998';
const ENV = { SMS_ALLOWED_EMAILS: 'owner@example.com' };

function gateway({ fail = null, configured = true } = {}) {
    const sent = [];
    return {
        configured, senderId: 'WealthFlow', sent,
        async send({ to, message }) { sent.push({ to, message }); return fail ? { ok: false, retryable: false, message: 'x', ...fail } : { ok: true, gatewayId: 'g' + sent.length, cost: 1, segments: 1 }; },
        async balance() { return { ok: true, units: 50 }; },
    };
}
const verified = async (fs, uid = 'u1') => fs.db.collection('wf-sms').doc(uid).set({ ownerVerified: { phone: E164, at: NOW - 1000 } }, { merge: true });
const rootOf = (fs, uid = 'u1') => fs.data.get(`wf-sms/${uid}`) || {};

describe('the test text', () => {
    it('is one plain part and says what it is', () => {
        const m = testMessage();
        expect(m).toMatch(/working perfectly/);
        expect(m).toMatch(/WealthFlow/);
        expect(analyzeSms(m).segments).toBe(1);
        expect(analyzeSms(m).encoding).toMatch(/gsm|GSM/i);
    });
});

describe('sendGatewayTest', () => {
    it('texts the verified number, once, and answers with it masked', async () => {
        const fs = createFirestore(); const client = gateway(); await verified(fs);
        const r = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW });
        expect(r.ok).toBe(true);
        expect(client.sent).toEqual([{ to: E164, message: testMessage() }]);
        expect(r.sentTo).not.toContain('778787998');
        expect(rootOf(fs).gatewayTestLog).toEqual([NOW]);
    });
    it('with no verified number sends nothing and says how to add one', async () => {
        const fs = createFirestore(); const client = gateway();
        const r = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW });
        expect(r).toMatchObject({ ok: false, status: 409, reason: 'no-verified-number' });
        expect(r.message).toMatch(/Alerts to my own number/);
        expect(client.sent).toHaveLength(0);
    });
    it('an unverified number typed into the synced settings is never used', async () => {
        const fs = createFirestore(); const client = gateway();
        await fs.db.collection('wf-sms').doc('u1').set({ ownerOtp: { phone: '+94771234567', hash: 'x' } }, { merge: true });
        const r = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW });
        expect(r.ok).toBe(false);
        expect(client.sent).toHaveLength(0);
    });
    it('two taps in a row send one text, the second is told to wait', async () => {
        const fs = createFirestore(); const client = gateway(); await verified(fs);
        // (the in-memory database does not retry racing transactions the way Firestore does, so the second tap follows the first)
        const a = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW });
        const b = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW + 100 });
        expect([a.ok, b.ok]).toEqual([true, false]);
        expect(client.sent).toHaveLength(1);
        const again = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW + 1000 });
        expect(again).toMatchObject({ ok: false, status: 429, reason: 'wait' });
        const later = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW + TEST_GAP_MS + 1 });
        expect(later.ok).toBe(true);
    });
    it('caps the cost: ten a day, and the day rolls', async () => {
        const fs = createFirestore(); const client = gateway(); await verified(fs);
        for (let i = 0; i < MAX_TESTS_PER_DAY; i += 1) expect((await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW + i * (TEST_GAP_MS + 1) })).ok).toBe(true);
        const over = await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW + MAX_TESTS_PER_DAY * (TEST_GAP_MS + 1) });
        expect(over).toMatchObject({ ok: false, reason: 'daily-limit' });
        expect(client.sent).toHaveLength(MAX_TESTS_PER_DAY);
        expect((await sendGatewayTest({ db: fs.db, uid: 'u1', client, now: NOW + DAY_MS + 60000 })).ok).toBe(true);
    });
    it('a refusal is explained, passes none of the gateway\'s words through, and gives the slot back', async () => {
        const fs = createFirestore(); await verified(fs);
        const credit = gateway({ fail: { kind: 'credit', message: 'SECRET GATEWAY TEXT' } });
        const r = await sendGatewayTest({ db: fs.db, uid: 'u1', client: credit, now: NOW });
        expect(r).toMatchObject({ ok: false, reason: 'send-failed', failure: 'credit' });
        expect(r.message).toMatch(/no credit/);
        expect(JSON.stringify(r)).not.toMatch(/SECRET GATEWAY TEXT/);
        expect(rootOf(fs).gatewayTestLog).toEqual([]);
        const retry = await sendGatewayTest({ db: fs.db, uid: 'u1', client: gateway(), now: NOW + 1 });
        expect(retry.ok).toBe(true);
    });
    it('a timeout that may have been delivered keeps the slot and says so', async () => {
        const fs = createFirestore(); await verified(fs);
        const r = await sendGatewayTest({ db: fs.db, uid: 'u1', client: gateway({ fail: { kind: 'timeout', possiblySent: true } }), now: NOW });
        expect(r).toMatchObject({ ok: false, reason: 'not-confirmed' });
        expect(rootOf(fs).gatewayTestLog).toEqual([NOW]);
    });
    it('no token on the server is a 503 and sends nothing', async () => {
        const fs = createFirestore(); await verified(fs);
        const r = await sendGatewayTest({ db: fs.db, uid: 'u1', client: gateway({ configured: false }), now: NOW });
        expect(r).toMatchObject({ ok: false, status: 503 });
    });
});

describe('the door: POST /api/sms-notify { action: "gateway-test" }', () => {
    const res = () => { const r = { statusCode: 0, body: null, setHeader() {}, end(b) { r.body = b ? JSON.parse(b) : null; } }; return r; };
    const world = (client = gateway()) => {
        const fs = createFirestore();
        const table = { good: { uid: 'u1', email: 'owner@example.com', email_verified: true }, stranger: { uid: 'u9', email: 'x@else.org', email_verified: true } };
        const admin = { auth: () => ({ verifyIdToken: async (t) => { if (!table[t]) throw new Error('bad'); return table[t]; } }) };
        return { fs, client, deps: { client: () => client, getAdminDb: async () => ({ db: fs.db, admin }), env: ENV, now: () => NOW } };
    };
    const post = (body, token = 'good') => ({ method: 'POST', url: '/api/sms-notify', headers: token ? { authorization: 'Bearer ' + token } : {}, body });

    it('texts the signed-in account\'s own verified number, whatever the body names', async () => {
        const w = world(); await verified(w.fs);
        const r = res(); await handleNotify(post({ action: 'gateway-test', phone: '0771234567', to: '+94771234567', message: 'hello', uid: 'u9' }), r, w.deps);
        expect(r.statusCode).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(w.client.sent).toEqual([{ to: E164, message: testMessage() }]);
    });
    it('no token, a bad token and an account that may not use SMS get nothing sent', async () => {
        const w = world(); await verified(w.fs); await verified(w.fs, 'u9');
        const a = res(); await handleNotify(post({ action: 'gateway-test' }, null), a, w.deps);
        const b = res(); await handleNotify(post({ action: 'gateway-test' }, 'nope'), b, w.deps);
        const c = res(); await handleNotify(post({ action: 'gateway-test' }, 'stranger'), c, w.deps);
        expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([401, 401, 403]);
        expect(w.client.sent).toHaveLength(0);
    });
    it('answers a failure with an error code and a sentence', async () => {
        const w = world();
        const r = res(); await handleNotify(post({ action: 'gateway-test' }), r, w.deps);
        expect(r.statusCode).toBe(409);
        expect(r.body).toMatchObject({ ok: false, error: 'no-verified-number' });
        expect(r.body.message).toMatch(/verified number/);
    });
});

describe('the panel', () => {
    it('the button asks for the test text and says it costs one unit; the last answer is shown', () => {
        const html = panelHtml({ gateway: { at: NOW, configured: true, reachable: true, tokenAccepted: true }, gatewayTest: { at: NOW, ok: true, sentTo: '077 *** 7998' }, now: NOW });
        expect(html).toContain('WFSms.testGateway()');
        expect(html).toMatch(/one test text/i);
        expect(html).toContain('Test text sent to 077 *** 7998');
        const bad = panelHtml({ gatewayTest: { at: NOW, ok: false, message: 'The Text.lk account has no credit left.' }, now: NOW });
        expect(bad).toContain('The Text.lk account has no credit left.');
        expect(panelHtml({ gatewayBusy: true, now: NOW })).toMatch(/disabled/);
    });
});
