/* =============================================================================
 * sms-gateway-test.mjs — "Check the SMS gateway" sends one real text to the owner's own number
 * -----------------------------------------------------------------------------
 * Owner, 2026-11-19: the free check says Text.lk answers, but the only proof that a text arrives is a text arriving. The button now asks for one.
 *
 * WHO GETS IT. Only the number this account has PROVED it holds (`ownerVerified` on the sealed `wf-sms/{uid}` document, sms-owner-otp.mjs). The request
 * body carries no number and no wording: a stolen or malicious client cannot use this to text anybody else. An account with no verified number is told
 * how to add one and nothing is sent.
 *
 * COST. One text costs one SMS unit, so: at least 30 s between tests, at most 10 in 24 h per account. The slot is reserved in a transaction BEFORE the
 * gateway is called (two taps at once send one text) and given back when the gateway definitely refused (a failure that was not the owner's costs nothing).
 *
 * Nothing here logs a full number or the gateway's own words.
 * ===========================================================================*/

import { maskPhone } from './wealthflow-phone.js';
import { verifiedPhoneOf } from './sms-owner-otp.mjs';

export const TEST_GAP_MS = 30 * 1000;
export const MAX_TESTS_PER_DAY = 10;
export const DAY_MS = 24 * 60 * 60 * 1000;

const s = (v) => String(v == null ? '' : v);

/** One part, plain letters only. */
export const testMessage = () => 'WealthFlow test message: the SMS gateway is working perfectly. You can ignore this text.';

/** What the page is told for each way the gateway can refuse. Nothing from the gateway is passed through. */
const WORDS = {
    config: 'The text service is not set up on this deployment yet (TEXTLK_API_TOKEN).',
    credit: 'The Text.lk account has no credit left, so the test text could not be sent. Top it up on the Text.lk dashboard.',
    auth: 'Text.lk did not accept the token on the server. Make a new API token on the Text.lk dashboard and put it in TEXTLK_API_TOKEN.',
    sender: 'Text.lk does not accept the sender ID. Check that it is approved on the Text.lk dashboard.',
    destination: 'Text.lk cannot send to your own number.',
    blocked: 'Your own number cannot receive texts (opted out or blocked).',
    'invalid-recipient': 'Text.lk says your own number is not one it can reach.',
    network: 'The server could not reach Text.lk just now. Try again in a minute.',
    timeout: 'Text.lk did not answer in time. Try again in a minute.',
    server: 'Text.lk had a problem on its side. Try again in a minute.',
    'rate-limit': 'Text.lk asked us to slow down. Try again in a minute.',
};

const fail = (status, reason, message, extra = {}) => ({ ok: false, status, reason, message, ...extra });

/**
 * @returns {{ok:true, sentTo:string, at:number} | {ok:false, status:number, reason:string, message:string}}
 */
export async function sendGatewayTest({ db, uid, client, now = Date.now() }) {
    if (!client || !client.configured) return fail(503, 'not-configured', WORDS.config);
    const ref = db.collection('wf-sms').doc(uid);
    let phone = '';
    const reserved = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const root = (snap.exists && snap.data()) || {};
        phone = verifiedPhoneOf(root);
        if (!phone) return { none: true };
        const log = (Array.isArray(root.gatewayTestLog) ? root.gatewayTestLog : []).map(Number).filter((t) => Number.isFinite(t) && now - t < DAY_MS);
        const last = log.length ? Math.max(...log) : 0;
        if (last && now - last < TEST_GAP_MS) return { wait: TEST_GAP_MS - (now - last) };
        if (log.length >= MAX_TESTS_PER_DAY) return { limit: true };
        tx.set(ref, { gatewayTestLog: [...log, now] }, { merge: true });
        return { reserved: true };
    });
    if (reserved.none) return fail(409, 'no-verified-number', 'Add your own number under "Alerts to my own number" and enter the code that is texted to it. The test text goes only to that verified number.');
    if (reserved.wait) return fail(429, 'wait', 'A test text was just sent. Wait half a minute before asking for another.', { retryAfterMs: reserved.wait });
    if (reserved.limit) return fail(429, 'daily-limit', 'Ten test texts were sent today. Try again tomorrow.');

    const sent = await client.send({ to: phone, message: testMessage() });
    if (!sent || !sent.ok) {
        const maybe = !!(sent && sent.possiblySent);
        if (!maybe) {
            // give back only this test's own slot, so a test reserved meanwhile keeps its place in the log
            try {
                await db.runTransaction(async (tx) => {
                    const snap = await tx.get(ref);
                    const root = (snap.exists && snap.data()) || {};
                    const log = (Array.isArray(root.gatewayTestLog) ? root.gatewayTestLog : []).map(Number);
                    const i = log.indexOf(now);
                    if (i >= 0) { log.splice(i, 1); tx.set(ref, { gatewayTestLog: log }, { merge: true }); }
                });
            } catch (_) { /* the next test is only rate limited for 30 s */ }
        }
        console.warn(`[WF-SMS] gateway test not sent kind=${s(sent && sent.kind).slice(0, 30)} maybeDelivered=${maybe}`);
        return fail(502, maybe ? 'not-confirmed' : 'send-failed', maybe
            ? 'Text.lk did not confirm the test text. If it arrives, the gateway works; if not, try again in a minute.'
            : (WORDS[sent && sent.kind] || 'The test text could not be sent. Try again in a moment.'), { failure: s(sent && sent.kind).slice(0, 30) });
    }
    return { ok: true, sentTo: maskPhone(phone), at: now };
}

export default { TEST_GAP_MS, MAX_TESTS_PER_DAY, testMessage, sendGatewayTest };
