/* =============================================================================
 * tenant-links.mjs — the unguessable link in every text message
 * -----------------------------------------------------------------------------
 * Every SMS carries a link to the tenant's own statement:  <origin>/t/<token>
 *
 *   - THE TOKEN IS RANDOM, NOT DERIVED. 96 bits from crypto.randomBytes. Derived tokens
 *     (a hash of the NIC, a counter) can be recomputed by anyone who knows the recipe
 *     and the NIC, and an NIC is not a secret. A random token is only ever learnt by
 *     being sent to the phone the lender recorded.
 *   - IT IS STABLE. The same lender and the same person get the same link in every
 *     message (the owner asked for a "deterministic" string): the (lender, NIC) pair is
 *     the key of an index document, and the first message creates it; every later one
 *     reads it. Created in a transaction, so two messages sent in parallel for a new
 *     tenant cannot mint two tokens.
 *   - IT IS NOT A CREDENTIAL. Holding the link lets a person ASK for a code. Seeing
 *     anything needs the NIC as well and a one-time code sent to the recorded phone
 *     (see tenant-portal.mjs).
 *   - IT CARRIES NO DATA. No NIC, no amount, no name: the token is an index key into
 *     a document only the server can read.
 *
 * COLLECTIONS (Admin SDK only; firestore.rules' default-deny seals them, as it does
 * wf-mail and wf-inbox):
 *
 *   wf-tenants/{token}              { uid, nicHash, active, createdAt }
 *   wf-tenant-subjects/{docId}      { token, uid, nicHash, createdAt }   docId = hash of (uid, NIC)
 *
 * `nicHash` is an HMAC of the canonical NIC under a server secret, so the index can
 * be searched by NIC (the portal's single balance sheet) without holding NICs.
 * ===========================================================================*/

import crypto from 'node:crypto';

export const TENANTS = 'wf-tenants';
export const SUBJECTS = 'wf-tenant-subjects';
/** The link a text message points at; vercel.json rewrites it to the portal page. */
export const PORTAL_PATH = '/t/';
/** Where the app is served. The Vercel project's production alias; overridable with WEALTHFLOW_PUBLIC_ORIGIN. */
export const DEFAULT_ORIGIN = 'https://wealthflow-personal.vercel.app';
export const TOKEN_BYTES = 12;                         // 96 bits -> 16 url-safe characters
export const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

const s = (v) => String(v == null ? '' : v);

/** The origin links are built on: an https origin with no path, query or credentials; anything else falls back to the production alias. */
export function publicOrigin(env = process.env) {
    const raw = s(env && env.WEALTHFLOW_PUBLIC_ORIGIN).trim().replace(/\/+$/, '');
    try {
        const u = new URL(raw);
        if (u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && (u.pathname === '/' || u.pathname === '')) return u.origin;
    } catch (_) { /* not a URL */ }
    return DEFAULT_ORIGIN;
}

/**
 * Are links injected into messages? ON, unless TENANT_PORTAL_LINKS says off|false|0|no: the portal page and its endpoint ship with
 * the links (tenant.html, /api/tenant-portal), so every text points at a page that exists. The switch stays as the owner's way to
 * stop putting links in texts without a deploy (it also keeps a text to one segment on the day a very long reference makes it two).
 */
export function linksEnabled(env = process.env) {
    return !['off', 'false', '0', 'no'].includes(s(env && env.TENANT_PORTAL_LINKS).trim().toLowerCase());
}

export const newToken = (randomBytes = crypto.randomBytes) => randomBytes(TOKEN_BYTES).toString('base64url');
export const linkFor = (token, env = process.env) => `${publicOrigin(env)}${PORTAL_PATH}${token}`;

/**
 * The server secret the portal's hashes and sessions are keyed with. TENANT_PORTAL_SECRET, else OTP_SECRET (already required to be 32+
 * bytes by otp-recovery.mjs), else a key derived from the Firebase service account — present whenever the Admin SDK is, so the portal
 * needs no variable of its own. Always domain-separated: no other use of the same material can produce the same bytes.
 */
export function portalSecret(env = process.env) {
    const pick = [env && env.TENANT_PORTAL_SECRET, env && env.OTP_SECRET].map(s).find((v) => Buffer.byteLength(v, 'utf8') >= 32);
    const material = pick || s(env && env.FIREBASE_SERVICE_ACCOUNT);
    if (Buffer.byteLength(material, 'utf8') < 32) {
        const e = new Error('no server secret available for the tenant portal (set TENANT_PORTAL_SECRET)');
        e.status = 503;
        throw e;
    }
    return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.from('wealthflow-tenant-portal'), Buffer.from('v1'), 32));
}

/** HMAC of the canonical NIC: stable for the same number, useless without the secret. */
export function nicHashOf(canonicalNic, secret) {
    return crypto.createHmac('sha256', secret).update(`nic|${s(canonicalNic)}`).digest('hex').slice(0, 40);
}

/** HMAC of the E.164 number: what the other lenders' records are matched on, so the portal never holds a number it was not given. */
export function phoneHashOf(e164, secret) {
    return crypto.createHmac('sha256', secret).update(`phone|${s(e164)}`).digest('hex').slice(0, 40);
}

const subjectDocId = (uid, canonicalNic) => crypto.createHash('sha256').update(`wf-tenant-subject|${s(uid)}|${s(canonicalNic)}`).digest('hex').slice(0, 40);

/**
 * The token for (lender, NIC): the one already issued, or a new one created now. Safe to call concurrently.
 * @returns {Promise<string>} the token
 */
export async function ensureTenantToken({ db, uid, canonicalNic, secret, randomBytes = crypto.randomBytes, now = Date.now() }) {
    const subjectRef = db.collection(SUBJECTS).doc(subjectDocId(uid, canonicalNic));
    const nicHash = nicHashOf(canonicalNic, secret);
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const fresh = newToken(randomBytes);
        const tenantRef = db.collection(TENANTS).doc(fresh);
        const token = await db.runTransaction(async (tx) => {
            const sub = await tx.get(subjectRef);
            if (sub.exists && sub.data() && TOKEN_RE.test(s(sub.data().token))) {
                const have = sub.data();
                // The secret was changed since the link was made (TENANT_PORTAL_SECRET added, OTP_SECRET rotated): every stored hash is now
                // for a key nobody holds, and the portal would turn the tenant away. The next text re-keys the link; the link itself stays.
                if (have.nicHash !== nicHash) {
                    tx.set(db.collection(TENANTS).doc(have.token), { nicHash }, { merge: true });
                    tx.set(subjectRef, { nicHash }, { merge: true });
                }
                return have.token;
            }
            const taken = await tx.get(tenantRef);
            if (taken.exists) return null;                                    // astronomically unlikely; draw again
            tx.set(tenantRef, { uid, nicHash, active: true, createdAt: now });
            tx.set(subjectRef, { token: fresh, uid, nicHash, createdAt: now });
            return fresh;
        });
        if (token) return token;
    }
    throw new Error('could not mint a tenant token');
}

export default { TENANTS, SUBJECTS, PORTAL_PATH, DEFAULT_ORIGIN, TOKEN_RE, publicOrigin, linksEnabled, newToken, linkFor, portalSecret, nicHashOf, phoneHashOf, ensureTenantToken };
