/* =============================================================================
 * cron-auth.mjs — who may run a scheduled endpoint
 * -----------------------------------------------------------------------------
 * A cron endpoint has no user in front of it, so the identity check that guards
 * every other endpoint here — a verified Firebase ID token — does not apply. The
 * credential is a shared secret Vercel presents on the scheduled invocation.
 *
 * TWO RULES, AND THE SECOND IS THE ONE THAT GETS FORGOTTEN.
 *
 *   - The comparison is constant-time over a digest, so neither the value nor
 *     its length can be read out of how long the answer took.
 *   - AN UNCONFIGURED GUARD REFUSES EVERYTHING. With no secret set, the honest
 *     answer is that this deployment cannot authorise anybody — not that
 *     anybody may pass. release-brain.js states the same rule in the same
 *     words, and this repository has already produced the opposite defect more
 *     than once.
 *
 * It exists as its own module because there are now two endpoints that need it.
 * A second copy of a security decision is a second set of answers, and the two
 * drift — which is how one of them ends up being the lenient one.
 * ===========================================================================*/

import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time compare that also hides the length of either input. */
export function secretEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}

/** The bearer token on a request, or ''. Never throws — headers are external. */
export function bearerOf(req) {
    try {
        const h = (req && req.headers) || {};
        const raw = h.authorization || h.Authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
        return m ? m[1].trim() : '';
    } catch (_) { return ''; }
}

/**
 * May this request run scheduled work?
 *
 * A named outcome rather than a boolean, so a refusal can say WHICH mechanism
 * refused without revealing anything about the secret.
 */
export function cronAuthorized(req, { env = process.env } = {}) {
    const secret = String((env && env.CRON_SECRET) || '').trim();
    if (!secret) {
        return {
            ok: false, status: 503,
            reason: 'this endpoint has no credential configured (set CRON_SECRET). '
                + 'Refusing every request rather than allowing every request.',
        };
    }
    const token = bearerOf(req);
    if (!token) {
        return { ok: false, status: 401, reason: 'no Authorization: Bearer credential was presented.' };
    }
    if (!secretEquals(token, secret)) {
        return { ok: false, status: 401, reason: 'the bearer token is not the configured cron secret.' };
    }
    return { ok: true, status: 200, reason: '' };
}

export default { secretEquals, bearerOf, cronAuthorized };
