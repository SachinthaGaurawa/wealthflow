import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { accessTokenFrom, hintFrom } from '../google-oauth.mjs';
import {
    classify, authOf, probeGapMs, mayAsk, afterRefusal, publicAuth, mintAccessToken, refusalText, RECONNECT_REASON, verifyNewToken, saveRefusalText,
    PROBE_FIRST_MS, PROBE_MAX_MS, ALERT_EVERY_MS,
} from '../gmail-auth-state.mjs';
import { statusOf, linkRecord } from '../gmail-link.mjs';
import { syncMailbox } from '../gmail-hook.js';
import { runStatementSync } from '../statement-sync.js';

/* A GMAIL SIGN-IN THAT GOOGLE HAS TURNED DOWN IS SEEN, SHOWN TO THE OWNER, AND NOT HAMMERED.
 * Production, 2026-10-13 04:23 UTC: `statement-sync-failed { reason: 'token refresh rejected' }`, once. The card went on saying "Connected". */

afterEach(() => vi.restoreAllMocks());

const REFRESH = '1//0gSECRETrefreshTOKENvalue_aaaaaaaaaaaaaaaaaaaa';
const T0 = 1_900_000_000_000, HOUR = 3600e3;
const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' };
const refused = (code, status = 400) => Object.assign(new Error('token refresh rejected'), { transient: false, status, ...(code ? { code } : {}) });
const transient = () => Object.assign(new Error('token refresh unreachable'), { transient: true });

/** A mailbox document with a spy-able `set` that merges like Firestore. */
function mailbox(extra = {}) {
    const doc = { refresh_token: REFRESH, email: 'owner@example.com', ...extra };
    const writes = [];
    const ref = { set: async (value, options) => { writes.push(value); Object.assign(doc, options && options.merge ? value : value); } };
    return { doc, ref, writes };
}

describe('what a failed exchange was', () => {
    it.each([
        [refused('invalid_grant'), 'revoked'],
        [refused('invalid_client', 401), 'client'],
        [refused('unauthorized_client'), 'client'],
        [refused('', 400), 'rejected'],
        [refused('', 401), 'rejected'],
        [refused('', 403), 'rejected'],
        [refused('invalid_request', 400), 'rejected'],
        [transient(), 'transient'],
        [Object.assign(new Error('x'), { transient: true, status: 429 }), 'transient'],
        [Object.assign(new Error('x'), { transient: true, status: 503, code: 'invalid_grant' }), 'transient'],   // a 5xx is never a verdict
        [new Error('token refresh returned no access token'), 'other'],
        [null, 'other'],
    ])('%#: %s', (error, kind) => { expect(classify(error)).toBe(kind); });
});

describe('google-oauth: the refusal says which kind, and never carries the token', () => {
    const answer = (status, body) => async () => ({ ok: false, status, json: async () => body });
    it('keeps Google\'s error word (from the known list) and the status', async () => {
        const error = await accessTokenFrom(REFRESH, ENV, answer(400, { error: 'invalid_grant', error_description: `Token has been expired or revoked ${REFRESH}` })).catch(e => e);
        expect(error).toMatchObject({ message: 'token refresh rejected', status: 400, code: 'invalid_grant', transient: false });
        expect(JSON.stringify({ ...error, message: error.message })).not.toContain(REFRESH);
        expect(JSON.stringify(error)).not.toMatch(/expired or revoked/);        // none of Google's free text is carried
    });
    it('drops an error word that is not on the list, and survives an answer that is not JSON', async () => {
        expect(await accessTokenFrom(REFRESH, ENV, answer(400, { error: `weird ${REFRESH}` })).catch(e => e)).not.toHaveProperty('code');
        const notJson = await accessTokenFrom(REFRESH, ENV, async () => ({ ok: false, status: 401, json: async () => { throw new Error('html'); } })).catch(e => e);
        expect(notJson).toMatchObject({ status: 401, transient: false });
        const bare = await accessTokenFrom(REFRESH, ENV, async () => ({ ok: false, status: 400 })).catch(e => e);
        expect(bare).toMatchObject({ status: 400, transient: false });
    });
    it('a 429 and a 5xx stay transient', async () => {
        expect((await accessTokenFrom(REFRESH, ENV, answer(429, {})).catch(e => e)).transient).toBe(true);
        expect((await accessTokenFrom(REFRESH, ENV, answer(503, {})).catch(e => e)).transient).toBe(true);
    });
});

describe('the back-off', () => {
    it('6 h after the first refusal, 12 h after the second, then once a day', () => {
        expect([1, 2, 3, 4, 9].map(probeGapMs)).toEqual([6 * HOUR, 12 * HOUR, 24 * HOUR, 24 * HOUR, 24 * HOUR]);
        expect(PROBE_FIRST_MS).toBe(6 * HOUR); expect(PROBE_MAX_MS).toBe(24 * HOUR);
    });
    it('an unmarked mailbox may always be asked; a marked one only when its back-off has passed', () => {
        const marked = authOf({ gmailAuth: { kind: 'revoked', since: T0, lastAt: T0, attempts: 1 } });
        expect(mayAsk(null, T0)).toBe(true);
        expect(mayAsk(marked, T0 + 5 * HOUR)).toBe(false);
        expect(mayAsk(marked, T0 + 6 * HOUR)).toBe(true);
    });
    it('a damaged or empty mark reads as "not marked", never as an error', () => {
        for (const doc of [null, {}, { gmailAuth: null }, { gmailAuth: 'x' }, { gmailAuth: {} }]) expect(authOf(doc)).toBe(null);
    });
});

describe('mintAccessToken', () => {
    it('hands back the token when Google gives one, and writes nothing', async () => {
        const m = mailbox();
        const token = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => 'ya29.fine' });
        expect(token).toBe('ya29.fine');
        expect(m.writes).toEqual([]);
    });
    it('a refusal marks the mailbox, throws gmail-reconnect-required, keeps the refresh token and writes none of it anywhere', async () => {
        const m = mailbox(), lines = [];
        const error = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => { throw refused('invalid_grant'); }, alert: async () => ({ sent: false }), log: line => lines.push(line) }).catch(e => e);
        expect(error).toMatchObject({ message: RECONNECT_REASON, reconnect: true, transient: false, backedOff: false, kind: 'revoked' });
        expect(m.doc.gmailAuth).toMatchObject({ kind: 'revoked', since: T0, lastAt: T0, attempts: 1, code: 'invalid_grant', status: 400, alertedAt: 0 });
        expect(m.doc.refresh_token).toBe(REFRESH);                                   // nothing is deleted
        expect(JSON.stringify([m.writes, lines, error.message])).not.toContain(REFRESH);
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'gmail-auth-refused', kind: 'revoked', attempts: 1 });
        expect(lines[0]).not.toMatch(/owner@example/);
    });
    it('while marked it does NOT ask Google again, and does not write', async () => {
        const m = mailbox();
        const mint = vi.fn(async () => { throw refused('invalid_grant'); });
        await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint, alert: async () => ({ sent: true }), log: () => {} }).catch(() => {});
        const writes = m.writes.length;
        for (const minutes of [1, 30, 120, 300]) {
            const error = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0 + minutes * 60e3, mint, log: () => {} }).catch(e => e);
            expect(error).toMatchObject({ message: RECONNECT_REASON, reconnect: true, backedOff: true });
        }
        expect(mint).toHaveBeenCalledTimes(1);                                       // one request to Google, then four calls answered from the mark
        expect(m.writes.length).toBe(writes);
    });
    it('after the back-off it asks once more; another refusal keeps `since`, counts, and waits twice as long', async () => {
        const m = mailbox();
        const mint = vi.fn(async () => { throw refused('invalid_grant'); });
        const go = now => mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now, mint, alert: async () => ({ sent: false }), log: () => {} }).catch(e => e);
        await go(T0);
        await go(T0 + 6 * HOUR);
        expect(mint).toHaveBeenCalledTimes(2);
        expect(m.doc.gmailAuth).toMatchObject({ since: T0, lastAt: T0 + 6 * HOUR, attempts: 2 });
        expect((await go(T0 + 17 * HOUR)).backedOff).toBe(true);                     // 11 h after the second: still waiting (12 h)
        expect((await go(T0 + 18 * HOUR)).backedOff).toBe(false);
        expect(mint).toHaveBeenCalledTimes(3);
    });
    it('the first token that works clears the mark (a refusal that was a one-off mends itself)', async () => {
        const m = mailbox({ gmailAuth: { kind: 'rejected', since: T0 - 9 * HOUR, lastAt: T0 - 7 * HOUR, attempts: 1, alertedAt: 0 } });
        const token = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => 'ya29.back' });
        expect(token).toBe('ya29.back');
        expect(m.doc.gmailAuth).toBe(null);
        expect(statusOf(m.doc)).toMatchObject({ connected: true, needsReconnect: false });
    });
    it('a timeout, a 429 or a 5xx is not a refusal: nothing is marked, nothing is told, and the error is the exchange\'s own', async () => {
        const m = mailbox(), alert = vi.fn(), mint = async () => { throw transient(); };
        const error = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint, alert, log: () => {} }).catch(e => e);
        expect(error.message).toBe('token refresh unreachable'); expect(error.transient).toBe(true);
        expect(m.writes).toEqual([]); expect(alert).not.toHaveBeenCalled();
    });
    it('an answer that is neither a token nor a verdict is passed on unmarked', async () => {
        const m = mailbox();
        const error = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => { throw new Error('token refresh returned no access token'); } }).catch(e => e);
        expect(error.message).toBe('token refresh returned no access token'); expect(m.writes).toEqual([]);
    });
    it('a failed write or a missing ref still ends in the reconnect error, never a crash', async () => {
        const broken = { set: async () => { throw new Error('firestore down'); } };
        for (const ref of [broken, null, undefined]) {
            const error = await mintAccessToken({ ref, mail: { refresh_token: REFRESH }, env: ENV, now: T0, mint: async () => { throw refused('invalid_grant'); }, alert: async () => { throw new Error('webhook'); }, log: () => { throw new Error('log'); } }).catch(e => e);
            expect(error).toMatchObject({ message: RECONNECT_REASON, reconnect: true });
        }
    });
});

describe('the owner is told once a day, without any secret', () => {
    it('one alert on the first refusal; marked as told only when it reached the endpoint', async () => {
        const m = mailbox(), alert = vi.fn(async () => ({ sent: true }));
        await mintAccessToken({ ref: m.ref, mail: m.doc, env: { ...ENV, SMS_ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' }, now: T0, mint: async () => { throw refused('invalid_grant'); }, alert, log: () => {} }).catch(() => {});
        expect(alert).toHaveBeenCalledTimes(1);
        const sent = alert.mock.calls[0][0];
        expect(sent.text).toMatch(/Gmail/); expect(sent.text).toMatch(/reconnect|connect it again/i);
        expect(JSON.stringify({ text: sent.text, extra: sent.extra })).not.toMatch(new RegExp(`${REFRESH}|owner@example|hooks\\.example`));
        expect(m.doc.gmailAuth.alertedAt).toBe(T0);
    });
    it('a webhook that was down is tried again at the next refusal, not forgotten', async () => {
        const m = mailbox(), alert = vi.fn().mockResolvedValueOnce({ sent: false }).mockResolvedValueOnce({ sent: true });
        const go = now => mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now, mint: async () => { throw refused('invalid_grant'); }, alert, log: () => {} }).catch(() => {});
        await go(T0); expect(m.doc.gmailAuth.alertedAt).toBe(0);
        await go(T0 + 6 * HOUR); expect(alert).toHaveBeenCalledTimes(2); expect(m.doc.gmailAuth.alertedAt).toBe(T0 + 6 * HOUR);
    });
    it('no second alert within 24 h of the first, one again after', async () => {
        const m = mailbox(), alert = vi.fn(async () => ({ sent: true }));
        const go = now => mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now, mint: async () => { throw refused('invalid_grant'); }, alert, log: () => {} }).catch(() => {});
        await go(T0); await go(T0 + 6 * HOUR); await go(T0 + 18 * HOUR);
        expect(alert).toHaveBeenCalledTimes(1);
        await go(T0 + 18 * HOUR + 24 * HOUR); expect(alert.mock.calls.length).toBe(2);
        expect(ALERT_EVERY_MS).toBe(24 * HOUR);
    });
    it('with no webhook set it is silent, and the card is still the owner\'s way to know', async () => {
        const m = mailbox();
        await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => { throw refused('invalid_grant'); }, log: () => {} }).catch(() => {});
        expect(m.doc.gmailAuth.alertedAt).toBe(0);
        expect(statusOf(m.doc)).toMatchObject({ connected: true, needsReconnect: true, authProblem: 'revoked', authProblemSince: T0 });
    });
    it('a refused OAuth client says so, and does not send the owner to reconnect for nothing', async () => {
        const m = mailbox(), alert = vi.fn(async () => ({ sent: true }));
        const error = await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => { throw refused('invalid_client', 401); }, alert, log: () => {} }).catch(e => e);
        expect(alert.mock.calls[0][0].text).toMatch(/OAUTH_CLIENT/);
        expect(alert.mock.calls[0][0].text).toMatch(/will not help/);
        expect(statusOf(m.doc)).toMatchObject({ needsReconnect: false, authProblem: 'client' });
        expect(refusalText(error)).toMatch(/OAuth settings/);
        expect(refusalText(refused('invalid_grant'))).toMatch(/Disconnect and connect/);
    });
});

describe('what the app is told', () => {
    it('only a kind and a time: never a token, a code, a status or an address', () => {
        const doc = { refresh_token: REFRESH, email: 'o@example.com', gmailAuth: { kind: 'revoked', since: T0, lastAt: T0, attempts: 3, alertedAt: T0, code: 'invalid_grant', status: 400 } };
        const out = statusOf(doc);
        expect(out).toMatchObject({ connected: true, needsReconnect: true, authProblem: 'revoked', authProblemSince: T0 });
        expect(JSON.stringify(out)).not.toMatch(/invalid_grant|attempts|alertedAt|1\/\/0g/);
        expect(statusOf({ refresh_token: REFRESH })).toMatchObject({ needsReconnect: false });
        expect(statusOf(null)).toEqual({ connected: false });
        expect(publicAuth(null)).toEqual({ needsReconnect: false });
    });
    it('linking a mailbox again writes a record that does not itself carry the mark', () => {
        expect(linkRecord('o@example.com', REFRESH, T0)).not.toHaveProperty('gmailAuth');
    });
});

describe('every door the mailbox\'s token is spent at', () => {
    const KEY = 'owner_example_com', PATH = `wf-mail/${KEY}`;
    const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    const tokenRefused = (calls) => async (url) => { calls.push(String(url)); return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }; };

    it('a push for a refused mailbox is answered 204 (so Pub/Sub stops retrying it), marks the mailbox, and asks Google once however often it comes', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { db, data } = createFirestore({ [PATH]: { refresh_token: REFRESH, email: 'owner@example.com', historyId: '5' } });
        const calls = [];
        const note = { emailAddress: 'owner@example.com', historyId: '9' };
        const first = await syncMailbox(db, note, { env: ENV, f: tokenRefused(calls) });
        expect(first.status).toBe(204);
        expect(first.body).toMatchObject({ ok: false, skipped: RECONNECT_REASON });
        expect(data.get(PATH).gmailAuth).toMatchObject({ kind: 'revoked', attempts: 1 });
        expect(data.get(PATH).historyId).toBe('5');                                  // the bookmark is not moved: nothing that arrives meanwhile is skipped
        expect(data.get(PATH).refresh_token).toBe(REFRESH);
        for (let i = 0; i < 5; i++) expect((await syncMailbox(db, note, { env: ENV, f: tokenRefused(calls) })).status).toBe(204);
        expect(calls.filter(url => url === TOKEN_URL)).toHaveLength(1);
    });
    it('a push when Google merely did not answer is still a 500, so Pub/Sub retries it, and nothing is marked', async () => {
        const { db, data } = createFirestore({ [PATH]: { refresh_token: REFRESH, email: 'owner@example.com' } });
        const result = await syncMailbox(db, { emailAddress: 'owner@example.com', historyId: '9' }, { env: ENV, f: async () => { throw new Error('offline'); } });
        expect(result.status).toBe(500);
        expect(data.get(PATH).gmailAuth).toBeUndefined();
    });
    it('the automatic sync stops with gmail-reconnect-required (a reason the app can show) and leaves the queue and the token alone', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { db, data } = createFirestore({ [PATH]: { uid: 'u', email: 'owner@example.com', refresh_token: REFRESH, autonomous: true } });
        const calls = [];
        const owner = { uid: 'u', email: 'owner@example.com' };
        const error = await runStatementSync({ db, owner, env: ENV, f: tokenRefused(calls) }).catch(e => e);
        expect(error.message).toBe(RECONNECT_REASON);
        expect(data.get(PATH)).toMatchObject({ refresh_token: REFRESH, gmailAuth: { kind: 'revoked' } });
        const again = await runStatementSync({ db, owner, env: ENV, f: tokenRefused(calls) }).catch(e => e);
        expect(again.message).toBe(RECONNECT_REASON);
        expect(calls).toHaveLength(1);                                               // no retry spam on the schedule or an open app
    });
});

/* 2026-10-16: the owner pasted a fresh refresh token twice; the card said "connected" and Google had already answered `invalid_grant` ("Bad Request") at the first watch call.
 * A token Google definitely refuses is now caught in the paste box, with the reason, and not saved. */
describe('google-oauth: which invalid_grant it was (two fixed words, never Google\'s text)', () => {
    const answer = body => async () => ({ ok: false, status: 400, json: async () => body });
    it.each([
        ['Token has been expired or revoked.', 'expired'],
        ['Token has been expired or revoked', 'expired'],
        ['Bad Request', 'mismatch'],
        ['bad request.', 'mismatch'],
        ['Some other sentence', ''],
        ['', ''], [undefined, ''], [null, ''], [42, ''],
    ])('%j -> %j', (text, hint) => { expect(hintFrom(text)).toBe(hint); });
    it('rides on the refusal as a word, and none of the description or the token goes with it', async () => {
        const mismatch = await accessTokenFrom(REFRESH, ENV, answer({ error: 'invalid_grant', error_description: 'Bad Request' })).catch(e => e);
        expect(mismatch).toMatchObject({ code: 'invalid_grant', status: 400, hint: 'mismatch' });
        const expired = await accessTokenFrom(REFRESH, ENV, answer({ error: 'invalid_grant', error_description: `Token has been expired or revoked ${REFRESH}` })).catch(e => e);
        expect(expired.hint).toBe('expired');
        expect(JSON.stringify({ ...expired, message: expired.message })).not.toContain(REFRESH);
        expect(await accessTokenFrom(REFRESH, ENV, answer({ error: 'invalid_grant' })).catch(e => e)).not.toHaveProperty('hint');
    });
});

describe('the hint is kept on the mark and in the log line, as one of the two words only', () => {
    it('a refusal records it; an old or damaged mark reads as no hint', async () => {
        const m = mailbox(), lines = [];
        await mintAccessToken({ ref: m.ref, mail: m.doc, env: ENV, now: T0, mint: async () => { throw Object.assign(refused('invalid_grant'), { hint: 'mismatch' }); }, alert: async () => ({ sent: false }), log: line => lines.push(line) }).catch(() => {});
        expect(m.doc.gmailAuth).toMatchObject({ kind: 'revoked', hint: 'mismatch' });
        expect(JSON.parse(lines[0])).toMatchObject({ evt: 'gmail-auth-refused', hint: 'mismatch' });
        expect(authOf({ gmailAuth: { kind: 'revoked', hint: 'anything Google said' } }).hint).toBe('');
        expect(authOf({ gmailAuth: { kind: 'revoked' } }).hint).toBe('');
        expect(afterRefusal(null, refused('invalid_grant'), T0).hint).toBe('');
    });
    it('the app is still told only a kind and a time', () => {
        expect(statusOf({ refresh_token: REFRESH, gmailAuth: { kind: 'revoked', since: T0, lastAt: T0, attempts: 1, hint: 'mismatch' } })).not.toHaveProperty('hint');
    });
});

describe('verifyNewToken: a pasted token is asked of Google before it is saved', () => {
    const ID = '1020193373377-i2p46jo266q77mtmqd9uekrhdsa94oqa.apps.googleusercontent.com';
    const ENV2 = { GOOGLE_OAUTH_CLIENT_ID: ID, GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-server-secret-value' };
    const check = (mint, env = ENV2, log = () => {}) => verifyNewToken({ token: REFRESH, env, mint, log });

    it('a token Google gives an access token for is accepted', async () => {
        const mint = vi.fn(async () => 'ya29.fine');
        expect(await check(mint)).toEqual({ checked: true, refused: false });
        expect(mint).toHaveBeenCalledTimes(1);
        expect(mint.mock.calls[0][0]).toBe(REFRESH);
    });
    it('"Bad Request" says the token was not made for this app\'s OAuth client, names that client, and tells what to do', async () => {
        const out = await check(async () => { throw Object.assign(refused('invalid_grant'), { hint: 'mismatch' }); });
        expect(out).toMatchObject({ checked: true, refused: true, kind: 'revoked', hint: 'mismatch' });
        expect(out.text).toContain(ID);
        expect(out.text).toMatch(/Use your own OAuth credentials/);
        expect(out.text).toMatch(/not saved/);
    });
    it('"expired or revoked" points at the 7-day Testing limit and Publish app', async () => {
        const out = await check(async () => { throw Object.assign(refused('invalid_grant'), { hint: 'expired' }); });
        expect(out).toMatchObject({ refused: true, hint: 'expired' });
        expect(out.text).toMatch(/7 days/); expect(out.text).toMatch(/Publish app/);
    });
    it('a refusal with no hint, and a bare 400/401/403, get the client advice', async () => {
        for (const error of [refused('invalid_grant'), refused('', 400), refused('', 403), refused('invalid_request', 400)]) {
            const out = await check(async () => { throw error; });
            expect(out).toMatchObject({ refused: true });
            expect(out.text).toContain(ID);
        }
    });
    it('a refused OAuth client says the server\'s settings need checking, not the token', async () => {
        const out = await check(async () => { throw refused('invalid_client', 401); });
        expect(out).toMatchObject({ refused: true, kind: 'client' });
        expect(out.text).toMatch(/GOOGLE_OAUTH_CLIENT_ID/); expect(out.text).toMatch(/a new token will not help/);
    });
    it('a timeout, a 429, a 5xx and an unexpected answer never block a save', async () => {
        for (const error of [transient(), Object.assign(new Error('x'), { transient: true, status: 429 }), Object.assign(new Error('x'), { transient: true, status: 503 }), new Error('token refresh returned no access token')]) {
            expect(await check(async () => { throw error; })).toEqual({ checked: false, refused: false });
        }
    });
    it('with no OAuth client configured Google is not asked at all', async () => {
        const mint = vi.fn();
        for (const env of [{}, { GOOGLE_OAUTH_CLIENT_ID: ID }, { GOOGLE_OAUTH_CLIENT_SECRET: 'x' }, { GOOGLE_OAUTH_CLIENT_ID: ' ', GOOGLE_OAUTH_CLIENT_SECRET: ' ' }]) {
            expect(await check(mint, env)).toEqual({ checked: false, refused: false });
        }
        expect(mint).not.toHaveBeenCalled();
    });
    it('neither the answer nor the log line carries the token, the secret or any text of Google\'s', async () => {
        const lines = [];
        const out = await check(async () => { throw Object.assign(refused('invalid_grant'), { hint: 'mismatch', message: `Bad Request ${REFRESH}` }); }, ENV2, line => lines.push(line));
        const seen = JSON.stringify([out, lines]);
        expect(seen).not.toContain(REFRESH); expect(seen).not.toContain(ENV2.GOOGLE_OAUTH_CLIENT_SECRET);
        expect(JSON.parse(lines[0])).toEqual({ evt: 'gmail-token-refused-on-save', kind: 'revoked', code: 'invalid_grant', status: 400, hint: 'mismatch' });
    });
    it('a failing log line never changes the answer', async () => {
        const out = await check(async () => { throw refused('invalid_grant'); }, ENV2, () => { throw new Error('log'); });
        expect(out).toMatchObject({ refused: true });
    });
    it('saveRefusalText works with no environment at all', () => {
        expect(saveRefusalText('revoked', '', {})).toMatch(/OAuth Playground/);
        expect(saveRefusalText('revoked', '', {})).not.toMatch(/\(\)/);
    });
});
