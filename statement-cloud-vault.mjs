import { randomBytes, createCipheriv, createDecipheriv, createSign } from 'node:crypto';

export const VAULT_ROOT = 'wf-statement-vault';
const KEY_PATH = /^projects\/[a-zA-Z0-9_.:-]+\/locations\/[a-zA-Z0-9_-]+\/keyRings\/[a-zA-Z0-9_-]+\/cryptoKeys\/[a-zA-Z0-9_-]+$/;
let tokenCache;

export function validateEntries(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error('invalid-vault-entries');
    const clean = entries.map((e, i) => {
        if (!e || typeof e.password !== 'string' || !e.password.length || e.password.length > 1024) throw new Error('invalid-vault-entry');
        const out = { id: String(e.id || `entry-${i}`), password: e.password };
        for (const field of ['bank', 'label', 'kind', 'format']) {
            if (e[field] != null && (typeof e[field] !== 'string' || e[field].length > 200)) throw new Error('invalid-vault-entry');
            out[field] = e[field] || '';
        }
        return out;
    });
    if (Buffer.byteLength(JSON.stringify(clean)) > 65536) throw new Error('vault-too-large');
    return clean;
}

export function cloudConfig(env = process.env) {
    if (!env.WEALTHFLOW_OWNER_UID || !KEY_PATH.test(env.STATEMENT_VAULT_KMS_KEY || '')) throw new Error('statement-cloud-not-configured');
    return { ownerUid: env.WEALTHFLOW_OWNER_UID, key: env.STATEMENT_VAULT_KMS_KEY };
}

/** A short-lived service token; private keys and plaintext never leave the trusted server. */
export async function cloudAccessToken(env = process.env, f = fetch) {
    let sa;
    try { sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT || ''); } catch (_) { throw new Error('cloud-identity-not-configured'); }
    if (!sa.client_email || !sa.private_key) throw new Error('cloud-identity-not-configured');
    if (tokenCache && tokenCache.email === sa.client_email && tokenCache.until > Date.now() + 60000) return tokenCache.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    let assertion;
    try { assertion = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url'); }
    catch (_) { throw new Error('cloud-identity-not-configured'); }
    try {
        const r = await f('https://oauth2.googleapis.com/token', { method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
            signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error();
        const body = await r.json();
        if (typeof body.access_token !== 'string' || !body.access_token) throw new Error();
        tokenCache = { email: sa.client_email, value: body.access_token, until: Date.now() + Math.min(3600, Number(body.expires_in) || 300) * 1000 };
        return tokenCache.value;
    } catch (_) { throw new Error('cloud-token-unavailable'); }
}

export async function kmsCall(action, payload, { env = process.env, f = fetch } = {}) {
    const { key } = cloudConfig(env);
    const token = await cloudAccessToken(env, f);
    try {
        const r = await f(`https://cloudkms.googleapis.com/v1/${key}:${action}`, { method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error();
        return await r.json();
    } catch (_) { throw new Error('vault-key-service-unavailable'); }
}

const aad = uid => Buffer.from('wealthflow-statement-vault:v1:' + uid);

export async function sealCloud(uid, entries, { wrap = payload => kmsCall('encrypt', payload) } = {}) {
    if (!uid || typeof uid !== 'string') throw new Error('invalid-vault-owner');
    const body = Buffer.from(JSON.stringify(validateEntries(entries)));
    const key = randomBytes(32), iv = randomBytes(12);
    try {
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        cipher.setAAD(aad(uid));
        const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
        const wrapped = await wrap({ plaintext: key.toString('base64'), additionalAuthenticatedData: aad(uid).toString('base64') });
        if (!wrapped || typeof wrapped.ciphertext !== 'string' || !wrapped.ciphertext) throw new Error('vault-key-wrap-failed');
        return { v: 1, uid, iv: iv.toString('base64'), ct: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'), wrappedKey: wrapped.ciphertext, count: entries.length, savedAt: Date.now() };
    } finally { key.fill(0); body.fill(0); }
}

export async function openCloud(uid, blob, { unwrap = payload => kmsCall('decrypt', payload) } = {}) {
    if (!blob || blob.v !== 1 || blob.uid !== uid || typeof blob.ct !== 'string' || blob.ct.length > 100000) throw new Error('vault-owner-or-format-invalid');
    let key, body;
    try {
        const unwrapped = await unwrap({ ciphertext: blob.wrappedKey, additionalAuthenticatedData: aad(uid).toString('base64') });
        key = Buffer.from(unwrapped.plaintext || '', 'base64');
        if (key.length !== 32) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
        decipher.setAAD(aad(uid));
        decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
        body = Buffer.concat([decipher.update(Buffer.from(blob.ct, 'base64')), decipher.final()]);
        return validateEntries(JSON.parse(body.toString('utf8')));
    } catch (_) { throw new Error('vault-unavailable-or-corrupt'); }
    finally { if (key) key.fill(0); if (body) body.fill(0); }
}
