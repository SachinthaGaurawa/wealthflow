/* =============================================================================
 * test/textlk_test.js — the Text.lk gateway client
 * -----------------------------------------------------------------------------
 * WHAT IS PINNED
 *   - E.164 handling for every shape of number a person types, Sri Lankan and not
 *   - the request that goes on the wire (URL, bearer header, JSON body, digits-only recipient)
 *   - SUCCESS means the gateway says so; every other answer is classified, and the
 *     classification is what the retry logic branches on
 *   - the API token is never in anything returned
 *   - a stalled or unreadable answer is "unknown", never a silent success
 * No network: `fetchImpl` is injected, and these suites are blocked from the real one.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    TextLkClient, KIND, normalizePhone, maskPhone, normalizeSenderId, sameSender, analyzeSms, classifyFailure,
    redact, retryAfterMs, DEFAULT_BASE, DEFAULT_SENDER, MAX_SEGMENTS,
} from '../textlk.mjs';

const TOKEN = '1234|SuperSecretTokenValue0123456789abcdef';

function reply(status, body, headers = {}) {
    return {
        status, ok: status >= 200 && status < 300,
        headers: { get: (k) => headers[String(k).toLowerCase()] ?? null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
}
function clientWith(handler, extra = {}) {
    const calls = [];
    const c = new TextLkClient({
        token: TOKEN, timeoutMs: 500,
        fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); },
        ...extra,
    });
    return { c, calls };
}

describe('phone numbers: any way a person types them, one way on the wire', () => {
    const good = [
        ['077 123 4567', '+94771234567'],
        ['0771234567', '+94771234567'],
        ['771234567', '+94771234567'],
        ['94771234567', '+94771234567'],
        ['+94 77 123 4567', '+94771234567'],
        ['0094 77 123 4567', '+94771234567'],
        ['(077) 123-4567', '+94771234567'],
        ['+1 (415) 555-2671', '+14155552671'],
        ['001 415 555 2671', '+14155552671'],
        ['+44 7911 123456', '+447911123456'],
        ['+971 50 123 4567', '+971501234567'],
    ];
    for (const [input, e164] of good) {
        it(`${input} -> ${e164}`, () => {
            const p = normalizePhone(input);
            expect(p.ok, JSON.stringify(p)).toBe(true);
            expect(p.e164).toBe(e164);
            expect(p.gateway).toBe(e164.slice(1));
        });
    }

    const bad = [
        ['', 'empty'],
        ['call me', 'not-a-number'],
        ['077-12', 'bad-length'],
        ['0112 345 678', 'not-a-mobile-number'],           // a Colombo landline cannot receive an SMS
        ['+94 11 234 5678', 'not-a-mobile-number'],
        ['+1 (015) 555-2671', 'bad-length'],                // NANP area codes never start with 0
        ['4155552671', 'needs-country-code'],               // a bare foreign number is ambiguous: refused, not guessed
        ['+9477+1234567', 'misplaced-plus'],
        ['+0123456789', 'bad-length'],
        ['+1234567890123456', 'bad-length'],                // more than 15 digits is not E.164
    ];
    for (const [input, reason] of bad) {
        it(`refuses "${input}" (${reason})`, () => {
            const p = normalizePhone(input);
            expect(p.ok).toBe(false);
            expect(p.reason).toBe(reason);
        });
    }

    // what comes with a number copied out of a contacts app, a chat or a contacts file
    const copied = [
        ['tel:+94771234567', '+94771234567'],                                   // a vCard writes its numbers as links
        ['TEL:+94 77 123 4567', '+94771234567'],
        ['callto:0771234567', '+94771234567'],
        ['\u200e+94 77 123 4567\u200f', '+94771234567'],                          // left-to-right / right-to-left marks around a number
        ['\u202a+94 77 123 4567\u202c', '+94771234567'],
        ['\u200b077 123 4567', '+94771234567'],                                 // a zero-width space
        ['+94\u00a077\u00a0123\u00a04567', '+94771234567'],                      // non-breaking spaces
        ['\u0660\u0667\u0667\u0661\u0662\u0663\u0664\u0665\u0666\u0667', '+94771234567'],   // Arabic-Indic digits
        ['\u06f0\u06f7\u06f7 \u06f1\u06f2\u06f3 \u06f4\u06f5\u06f6\u06f7', '+94771234567'],  // Persian digits
        ['\u0de6\u0ded\u0ded\u0de7\u0de8\u0de9\u0dea\u0deb\u0dec\u0ded', '+94771234567'],   // Sinhala Lith digits (0 7 7 1 2 3 4 5 6 7)
        ['\uff0b\uff19\uff14\uff17\uff17\uff11\uff12\uff13\uff14\uff15\uff16\uff17', '+94771234567'],   // full-width
        ['\u0966\u096d\u096d\u0967\u0968\u0969\u096a\u096b\u096c\u096d', '+94771234567'],   // Devanagari digits
    ];
    for (const [input, e164] of copied) {
        it(`copied as ${JSON.stringify(input)} -> ${e164}`, () => {
            const p = normalizePhone(input);
            expect(p.ok, JSON.stringify(p)).toBe(true);
            expect(p.e164).toBe(e164);
        });
    }
    it('cleaning never guesses: an extension, a second number or a word is still refused', () => {
        for (const input of ['077 123 4567 ext 12', '+94771234567;ext=12', '077 123 4567 / 071 111 1111', '077 123 4567 mobile']) expect(normalizePhone(input).ok, input).toBe(false);
    });

    it('accepts a different default country for bare local numbers', () => {
        expect(normalizePhone('0501234567', { defaultCountry: '971' }).e164).toBe('+971501234567');
    });

    it('masks a number to something recognisable and not usable', () => {
        expect(maskPhone('+94771234567')).toBe('+94*****4567');
        expect(maskPhone('+94771234567')).not.toContain('77123');
        expect(maskPhone('')).toBe('***');
    });
});

describe('sender id', () => {
    it('is matched without regard to case, and the approved spelling is kept', () => {
        expect(normalizeSenderId('wealthflow')).toBe('WealthFlow');
        expect(normalizeSenderId('WEALTHFLOW')).toBe('WealthFlow');
        expect(normalizeSenderId(' WealthFlow ')).toBe('WealthFlow');
        expect(DEFAULT_SENDER).toBe('WealthFlow');
        expect(sameSender('WEALTHFLOW', 'WealthFlow')).toBe(true);
        expect(sameSender('WealthFlow', 'OTHER')).toBe(false);
    });
    it('refuses what a sender id cannot be', () => {
        for (const bad of ['', 'ab', 'WEALTH FLOW', 'WEALTHFLOW-APP', 'TWELVECHARSXX', 'WéALTH']) expect(normalizeSenderId(bad), bad).toBeNull();
    });
    it('falls back to the approved id when the configured one is unusable', () => {
        expect(new TextLkClient({ token: TOKEN, senderId: 'x y' }).senderId).toBe(DEFAULT_SENDER);
    });
});

describe('message size: GSM-7 vs UCS-2, parts', () => {
    it('counts plain text as one part up to 160', () => {
        expect(analyzeSms('a'.repeat(160))).toEqual({ encoding: 'GSM-7', units: 160, segments: 1 });
        expect(analyzeSms('a'.repeat(161)).segments).toBe(2);
        expect(analyzeSms('a'.repeat(306)).segments).toBe(2);
        expect(analyzeSms('a'.repeat(307)).segments).toBe(3);
    });
    it('counts the extension table (braces, euro) as two units', () => {
        expect(analyzeSms('{}').units).toBe(4);
    });
    it('one non-GSM character turns the whole message to UCS-2, 70 to a part', () => {
        const a = analyzeSms('a'.repeat(70) + 'ස');
        expect(a.encoding).toBe('UCS-2');
        expect(a.segments).toBe(2);
        expect(analyzeSms('ස'.repeat(70)).segments).toBe(1);
    });
});

describe('what goes on the wire', () => {
    it('POSTs JSON to sms/send with a bearer token, digits-only recipient, the approved sender id and type plain', async () => {
        const { c, calls } = clientWith(() => reply(200, { status: 'success', message: 'ok', data: { uid: 'abc123', to: '94771234567', cost: '1', sms_count: 1 } }));
        const r = await c.send({ to: '077 123 4567', message: 'Hello there' });
        expect(r.ok).toBe(true);
        expect(r.gatewayId).toBe('abc123');
        expect(r.cost).toBe(1);
        expect(r.segments).toBe(1);
        expect(r.to).toBe('+94771234567');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(DEFAULT_BASE + 'sms/send');
        expect(calls[0].init.method).toBe('POST');
        expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(calls[0].init.headers['Content-Type']).toBe('application/json');
        expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(calls[0].init.body)).toEqual({ recipient: '94771234567', sender_id: 'WealthFlow', type: 'plain', message: 'Hello there' });
    });

    it('treats the gateway status as case-insensitive', async () => {
        const { c } = clientWith(() => reply(200, { status: 'SUCCESS', data: {} }));
        expect((await c.send({ to: '0771234567', message: 'x' })).ok).toBe(true);
    });

    it('cleans a token pasted with quotes or the word Bearer', async () => {
        const { c, calls } = clientWith(() => reply(200, { status: 'success', data: {} }), { token: ` "Bearer ${TOKEN}"\n` });
        await c.send({ to: '0771234567', message: 'x' });
        expect(calls[0].init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it('refuses plaintext or odd base URLs and uses the real endpoint instead', () => {
        expect(new TextLkClient({ token: TOKEN, baseUrl: 'http://app.text.lk/api/v3/' }).baseUrl).toBe(DEFAULT_BASE);
        expect(new TextLkClient({ token: TOKEN, baseUrl: 'javascript:alert(1)' }).baseUrl).toBe(DEFAULT_BASE);
        expect(new TextLkClient({ token: TOKEN, baseUrl: 'https://example.test/v3' }).baseUrl).toBe('https://example.test/v3/');
    });

    it('is not configured without a token, and says so without calling out', async () => {
        let called = false;
        const c = new TextLkClient({ token: '', fetchImpl: async () => { called = true; return reply(200, {}); } });
        expect(c.configured).toBe(false);
        const r = await c.send({ to: '0771234567', message: 'x' });
        expect(r).toMatchObject({ ok: false, kind: KIND.CONFIG });
        expect(called).toBe(false);
    });

    it('reads the token from TEXTLK_API_TOKEN and the sender from TEXTLK_SENDER_ID', () => {
        const c = TextLkClient.fromEnv({ TEXTLK_API_TOKEN: TOKEN, TEXTLK_SENDER_ID: 'WEALTHFLOW' });
        expect(c.configured).toBe(true);
        expect(c.senderId).toBe('WealthFlow');
        expect(TextLkClient.fromEnv({}).configured).toBe(false);
    });

    it('never serialises the token', () => {
        const c = new TextLkClient({ token: TOKEN });
        expect(JSON.stringify(c)).not.toContain('SuperSecret');
        expect(JSON.stringify(c)).toContain('"configured":true');
    });
});

describe('refusals before anything is sent', () => {
    it('an invalid recipient never reaches the gateway', async () => {
        let called = false;
        const c = new TextLkClient({ token: TOKEN, fetchImpl: async () => { called = true; return reply(200, {}); } });
        expect(await c.send({ to: '0112345678', message: 'x' })).toMatchObject({ ok: false, kind: KIND.INVALID_RECIPIENT, retryable: false });
        expect(called).toBe(false);
    });
    it('an empty or oversized message never reaches the gateway', async () => {
        const { c, calls } = clientWith(() => reply(200, {}));
        expect(await c.send({ to: '0771234567', message: '   ' })).toMatchObject({ kind: KIND.INVALID_MESSAGE });
        expect(await c.send({ to: '0771234567', message: 'a'.repeat(153 * (MAX_SEGMENTS + 1)) })).toMatchObject({ kind: KIND.INVALID_MESSAGE });
        expect(calls).toHaveLength(0);
    });
});

describe('every answer is classified, because the retry logic branches on it', () => {
    const cases = [
        [200, { status: 'error', message: 'Insufficient balance. Please top up your account' }, KIND.CREDIT, true],
        [200, { status: 'error', message: 'You do not have enough SMS units' }, KIND.CREDIT, true],
        [402, { status: 'error', message: 'Payment required' }, KIND.CREDIT, true],
        [401, { status: 'error', message: 'Unauthenticated.' }, KIND.AUTH, true],
        [403, { message: 'Invalid API token' }, KIND.AUTH, true],
        [422, { status: 'error', message: 'The selected sender id is invalid or not approved' }, KIND.SENDER, true],
        [422, { status: 'error', message: 'The recipient number is blacklisted' }, KIND.BLOCKED, false],
        [429, { status: 'error', message: 'Too many requests' }, KIND.RATE_LIMIT, true],
        [200, { status: 'error', message: 'Rate limit exceeded' }, KIND.RATE_LIMIT, true],
        [500, 'Internal Server Error', KIND.SERVER, true],
        [503, { message: 'Service unavailable' }, KIND.SERVER, true],
        [422, { status: 'error', message: 'Something unexpected' }, KIND.REJECTED, false],
        [200, { status: 'error', message: 'invalid phone number' }, KIND.INVALID_RECIPIENT, false],
    ];
    for (const [http, body, kind, retryable] of cases) {
        it(`HTTP ${http} ${JSON.stringify(body).slice(0, 50)} -> ${kind}${retryable ? ' (retry)' : ' (give up)'}`, async () => {
            const { c } = clientWith(() => reply(http, body));
            const r = await c.send({ to: '0771234567', message: 'x' });
            expect(r.ok).toBe(false);
            expect(r.kind).toBe(kind);
            expect(r.retryable).toBe(retryable);
        });
    }

    it('reads Retry-After in seconds on a 429', async () => {
        const { c } = clientWith(() => reply(429, { status: 'error', message: 'Too many requests' }, { 'retry-after': '120' }));
        expect((await c.send({ to: '0771234567', message: 'x' })).retryAfterMs).toBe(120000);
    });
    it('reads Retry-After as an HTTP date and caps it at a day', () => {
        const now = Date.parse('2026-10-05T10:00:00Z');
        expect(retryAfterMs('Mon, 05 Oct 2026 10:01:00 GMT', now)).toBe(60000);
        expect(retryAfterMs('999999999', now)).toBe(86400000);
        expect(retryAfterMs('soon', now)).toBe(0);
        expect(retryAfterMs('', now)).toBe(0);
    });

    it('an answer that is neither success nor error is "unknown" and possibly sent', async () => {
        const { c } = clientWith(() => reply(200, '<html>maintenance</html>'));
        const r = await c.send({ to: '0771234567', message: 'x' });
        expect(r).toMatchObject({ ok: false, kind: KIND.UNKNOWN, retryable: true, possiblySent: true });
    });

    it('a network failure is retryable', async () => {
        const { c } = clientWith(() => { throw Object.assign(new Error('getaddrinfo ENOTFOUND app.text.lk'), { name: 'TypeError' }); });
        expect(await c.send({ to: '0771234567', message: 'x' })).toMatchObject({ ok: false, kind: KIND.NETWORK, retryable: true });
    });

    it('a timeout is retryable and flagged as possibly sent', async () => {
        const { c } = clientWith(() => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
        expect(await c.send({ to: '0771234567', message: 'x' })).toMatchObject({ ok: false, kind: KIND.TIMEOUT, retryable: true, possiblySent: true });
    });

    it('a body that stalls after the headers does not hang the sender', async () => {
        const stalled = { status: 200, ok: true, headers: { get: () => null }, text: () => new Promise(() => {}) };
        const { c } = clientWith(() => stalled, { timeoutMs: 60 });
        const r = await c.send({ to: '0771234567', message: 'x' });
        expect(r.ok).toBe(false);
        expect(r.kind).toBe(KIND.UNKNOWN);
    });
});

describe('the token never leaves the module', () => {
    it('is scrubbed from a gateway message that echoes it', async () => {
        const { c } = clientWith(() => reply(401, { status: 'error', message: `Invalid token ${TOKEN} for Bearer ${TOKEN}` }));
        const r = await c.send({ to: '0771234567', message: 'x' });
        expect(JSON.stringify(r)).not.toContain('SuperSecret');
        expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
    it('redact handles encoded tokens and bare Bearer headers', () => {
        expect(redact(`x ${encodeURIComponent(TOKEN)} y`, TOKEN)).toBe('x [token] y');
        expect(redact('Authorization: Bearer abcdefghijklmnop', '')).toBe('Authorization: Bearer [token]');
    });
});

describe('balance', () => {
    it('reads the remaining units', async () => {
        const { c, calls } = clientWith(() => reply(200, { status: 'success', data: { remaining_unit: '10', expired_on: '2031-10-03' } }));
        const b = await c.balance();
        expect(b).toEqual({ ok: true, units: 10, expiresOn: '2031-10-03' });
        expect(calls[0].url).toBe(DEFAULT_BASE + 'balance');
        expect(calls[0].init.method).toBe('GET');
    });
    it('classifies a refused token', async () => {
        const { c } = clientWith(() => reply(401, { status: 'error', message: 'Unauthenticated.' }));
        expect(await c.balance()).toMatchObject({ ok: false, kind: KIND.AUTH });
    });
});

describe('lookup: what became of a text the gateway took', () => {
    const ask = (status) => clientWith(() => reply(200, { status: 'success', data: { uid: 'abc12345', status } }));
    it('reads the answer by word: a yes, a no, and "not yet"', async () => {
        expect(await ask('Delivered').c.lookup('abc12345')).toEqual({ ok: true, state: 'delivered', raw: 'Delivered' });
        for (const w of ['Undelivered', 'Failed', 'Rejected', 'Expired']) expect(await ask(w).c.lookup('abc12345')).toMatchObject({ ok: true, state: 'undelivered' });
        for (const w of ['Sent', 'Queued', '', 'Accepted']) expect(await ask(w).c.lookup('abc12345')).toMatchObject({ ok: true, state: 'pending' });
    });
    it('asks GET sms/{uid}, never sends, and refuses an id that is not one', async () => {
        const { c, calls } = ask('Delivered');
        await c.lookup('abc12345');
        expect(calls[0].url).toBe(DEFAULT_BASE + 'sms/abc12345');
        expect(calls[0].init.method).toBe('GET');
        expect(await c.lookup('../balance')).toMatchObject({ ok: false });
        expect(calls).toHaveLength(1);
    });
    it('a failed lookup is a failure, not a verdict', async () => {
        const { c } = clientWith(() => reply(404, { status: 'error', message: 'Message not found' }));
        expect(await c.lookup('abc12345')).toMatchObject({ ok: false });
    });
});

describe('classifyFailure on its own', () => {
    it('does not mistake an auth message that mentions a balance for a credit problem', () => {
        expect(classifyFailure(401, 'Unauthorized: invalid token, cannot read balance')).toBe(KIND.AUTH);
    });
});
