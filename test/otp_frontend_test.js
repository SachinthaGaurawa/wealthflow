import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('async function _recoveryHeaders()'), html.indexOf('function proceedToNewPin()'));
expect(source).toContain('async function verifyRecoveryOTP()');

function harness(user) {
    const nodes = new Map();
    const node = id => {
        if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', style: {} });
        return nodes.get(id);
    };
    node('recovOtpEmail').value = 'USER@example.com';
    node('recovOtpCode').value = '123456';
    const storage = new Map([['wf_otp_hash', 'proof'], ['wf_otp_expires', '1234567890123']]);
    const calls = [];
    const context = {
        $: node,
        document: { querySelector: () => node('button') },
        sessionStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
        fetch: async (url, options) => {
            calls.push({ url, options });
            return { ok: true, json: async () => ({ hash: 'signed-proof', expiresAt: 1234567890123 }) };
        },
        _persistRaw() {}, notify() {}, console: { error() {} },
        setTimeout: fn => fn(), proceedToNewPin: () => { context.advanced = true; }
    };
    if (user !== undefined) context.firebase = { auth: () => ({ currentUser: user }) };
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, node, storage, calls };
}

test('both OTP requests attach the current Firebase token and preserve the server proof', async () => {
    let tokenReads = 0;
    const h = harness({ getIdToken: async () => 'token-' + ++tokenReads });
    await h.context.sendRecoveryOTP();
    await h.context.verifyRecoveryOTP();
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0].options.headers.Authorization).toBe('Bearer token-1');
    expect(h.calls[1].options.headers.Authorization).toBe('Bearer token-2');
    expect(JSON.parse(h.calls[1].options.body)).toEqual({
        email: 'user@example.com', otp: '123456', hash: 'signed-proof', expiresAt: '1234567890123'
    });
    expect(h.context.advanced).toBe(true);
    expect(h.storage.has('wf_otp_hash')).toBe(false);
});

for (const [name, user] of [['SDK unavailable', undefined], ['signed out', null], ['empty token', { getIdToken: async () => '' }]]) {
    test(name + ' blocks both requests before network or PIN reset', async () => {
        const h = harness(user);
        await h.context.sendRecoveryOTP();
        await h.context.verifyRecoveryOTP();
        expect(h.calls).toHaveLength(0);
        expect(h.node('recovErr').textContent).toMatch(/Sign in/);
        expect(h.context.advanced).toBeUndefined();
        expect(h.node('button').disabled).toBe(false);
    });
}

test('expired session errors remain visible and cannot reset the PIN', async () => {
    const h = harness({ getIdToken: async () => { throw new Error('Session expired'); } });
    await h.context.verifyRecoveryOTP();
    expect(h.calls).toHaveLength(0);
    expect(h.node('recovErr').textContent).toMatch(/Session expired/);
    expect(h.context.advanced).toBeUndefined();
});

test('server denial preserves proof for retry and never advances recovery', async () => {
    const h = harness({ getIdToken: async () => 'token' });
    h.context.fetch = async () => ({ ok: false, json: async () => ({ error: 'Account mismatch' }) });
    await h.context.verifyRecoveryOTP();
    expect(h.node('recovErr').textContent).toMatch(/Account mismatch/);
    expect(h.context.advanced).toBeUndefined();
    expect(h.storage.get('wf_otp_hash')).toBe('proof');
});

test('six non-digits are rejected without a verification request', async () => {
    const h = harness({ getIdToken: async () => 'token' });
    h.node('recovOtpCode').value = 'ABCDEF';
    await h.context.verifyRecoveryOTP();
    expect(h.calls).toHaveLength(0);
    expect(h.context.advanced).toBeUndefined();
});
