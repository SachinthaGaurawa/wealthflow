import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export const VAULT_ROOT = 'wf-statement-vault';
const KEY_HEX = /^[0-9a-f]{64}$/i;

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

/**
 * `STATEMENT_VAULT_KEY` is a 32-byte key generated once and pasted into the
 * deployment's own environment variables — the same trust boundary
 * `FIREBASE_SERVICE_ACCOUNT` already sits behind on this platform. This
 * replaces a Google Cloud KMS key, which needs a paid, separately-billed GCP
 * service (and admin console access to provision) that a Vercel Hobby
 * deployment has neither the budget nor the tooling to set up.
 */
export function cloudConfig(env = process.env) {
    if (!env.WEALTHFLOW_OWNER_UID || !KEY_HEX.test(env.STATEMENT_VAULT_KEY || '')) throw new Error('statement-cloud-not-configured');
    return { ownerUid: env.WEALTHFLOW_OWNER_UID, key: env.STATEMENT_VAULT_KEY };
}

const aad = uid => Buffer.from('wealthflow-statement-vault:v1:' + uid);

/**
 * Wraps (or unwraps) the vault's per-save data key with the deployment's own
 * master key, AES-256-GCM, entirely inside this process — no network call,
 * no external key-management service. The wrapped blob is `iv | tag |
 * ciphertext`, base64-encoded, so it stores exactly like the value a KMS
 * `encrypt` call used to return.
 */
async function localWrap({ plaintext, additionalAuthenticatedData }, env = process.env) {
    const master = Buffer.from(cloudConfig(env).key, 'hex');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', master, iv);
    cipher.setAAD(Buffer.from(additionalAuthenticatedData, 'base64'));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'base64')), cipher.final()]);
    return { ciphertext: Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64') };
}

async function localUnwrap({ ciphertext, additionalAuthenticatedData }, env = process.env) {
    const master = Buffer.from(cloudConfig(env).key, 'hex');
    const blob = Buffer.from(ciphertext, 'base64');
    if (blob.length <= 28) throw new Error('vault-key-wrap-invalid');
    const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', master, iv);
    decipher.setAAD(Buffer.from(additionalAuthenticatedData, 'base64'));
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return { plaintext: plain.toString('base64') };
}

export async function sealCloud(uid, entries, { wrap = payload => localWrap(payload) } = {}) {
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

export async function openCloud(uid, blob, { unwrap = payload => localUnwrap(payload) } = {}) {
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
