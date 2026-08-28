/* =============================================================================
 * admin-db.mjs — the one Firebase Admin SDK bootstrap
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Firestore security rules see a REST request carrying only the public Web API
 * key as UNAUTHENTICATED. Every collection such a request must write therefore
 * has to be open to the whole internet. The Admin SDK authenticates with a
 * service account and BYPASSES rules entirely, which is what lets a collection be
 * sealed in firestore.rules while the server keeps writing it.
 *
 * inbox-store.mjs proved that out for wf-inbox. statement-store.js now needs the
 * same thing so that `create` on the share collections can be sealed, and so that
 * revoking a share (DELETE) works against sealed rules instead of being refused.
 *
 * Two endpoints needing identical credential handling is exactly the case the
 * fetch-timeout.mjs extraction was made for: two copies of a security-relevant
 * policy is one more than can be kept in step. inbox-store.mjs re-exports this
 * module under its existing names, so its callers are unchanged and there is
 * still only ONE implementation of the bootstrap.
 *
 * FAILURE DISCIPLINE. getAdminDb never throws and never returns a bare null: a
 * missing or malformed credential comes back as a REASON. A caller must be able
 * to answer "not configured" rather than something that looks like "empty".
 * ===========================================================================*/

/** Under the maxDuration ceiling, with room left to answer honestly. */
export const DEFAULT_DEADLINE_MS = 8000;

/**
 * Stop waiting after `ms`. The Admin SDK speaks gRPC and takes no AbortSignal, so
 * the AbortController deadlines used on the REST paths do not carry over. This
 * bounds OUR wait rather than the call — which is the part that matters: a
 * handler that answers "the database did not respond in 8s" is strictly better
 * than one killed at maxDuration with nothing recorded and no explanation.
 */
export async function withDeadline(promise, ms = DEFAULT_DEADLINE_MS, what = 'Firestore') {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_res, rej) => {
                timer = setTimeout(() => {
                    const e = new Error(`${what} did not answer within ${ms}ms`);
                    e.name = 'TimeoutError';
                    e.timedOut = true;
                    rej(e);
                }, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

let _db = null;
let _admin = null;
let _adminModule = null;

/**
 * TEST SEAM. Inject a stand-in for the firebase-admin module so a suite can
 * exercise the real write/delete code without a service account and without ever
 * reaching the live project — four documents were once created in the production
 * database by a probe, and every suite here has been hard-blocked from the
 * network since. Passing null restores the real module.
 *
 * No shipped file may call this; test/share_admin_sdk_test.js asserts that, so
 * the seam cannot become a production code path.
 */
export function _setAdminModule(m) { _adminModule = m || null; _db = null; _admin = null; }

/**
 * The Firestore handle, or a reason it is unavailable — never a throw, and never
 * a null with no explanation.
 *
 * RETURNS A WRAPPER, NOT A HANDLE: { db, reason, admin }. Destructure it. Reading
 * the wrapper as if it were the handle is not a mistake the truthiness check
 * catches — the object is always truthy — so `if (!db)` on the wrapper passes and
 * the very next line dies on `db.collection is not a function`. That is exactly
 * how /api/gmail-link reached production unable to serve a single request.
 *
 * `admin` is the INITIALISED module, handed back so that callers needing
 * admin.auth() or admin.firestore.FieldValue do not import firebase-admin a
 * second time. A separate import is a second bootstrap around the module whose
 * whole purpose is to be the only one — and it cannot be redirected by
 * _setAdminModule, so any handler using it is untestable without the network.
 * It is non-null only when initialisation actually succeeded, because
 * admin.auth() on an uninitialised app throws.
 *
 * Needs FIREBASE_SERVICE_ACCOUNT (the same secret release-brain.js uses), NOT the
 * public FIREBASE_API_KEY. If it is absent the caller reports 503 rather than
 * degrading into something that reads as success.
 */
export async function getAdminDb() {
    if (_db) return { db: _db, reason: null, admin: _admin };

    let admin = _adminModule;
    if (!admin) {
        try {
            admin = (await import('firebase-admin')).default;
        } catch (e) {
            return { db: null, admin: null, reason: 'firebase-admin could not be loaded: ' + ((e && e.message) || e) };
        }
    }
    if (!admin || !admin.apps) {
        return { db: null, admin: null, reason: 'firebase-admin loaded but exposes no app registry — wrong module shape.' };
    }

    if (!admin.apps.length) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw || !String(raw).trim()) {
            return {
                db: null,
                admin: null,
                reason: 'FIREBASE_SERVICE_ACCOUNT is not configured on this deployment. '
                    + 'The inbox and share endpoints use the Firebase Admin SDK so that their '
                    + 'collections can be closed to unauthenticated access; set it in '
                    + 'Vercel → Settings → Environment Variables.',
            };
        }
        let cred;
        try {
            cred = JSON.parse(raw);
        } catch (e) {
            // NEVER pass a JSON.parse message through: V8 embeds the first ~10
            // bytes of the input in it, which here is the head of a private key.
            const at = String((e && e.message) || '').match(/at position (\d+)/);
            return {
                db: null,
                admin: null,
                reason: 'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON ('
                    + (at ? 'malformed at position ' + at[1] : 'malformed') + ').',
            };
        }
        try {
            admin.initializeApp({ credential: admin.credential.cert(cred) });
        } catch (e) {
            return { db: null, admin: null, reason: 'firebase-admin rejected that credential: ' + ((e && e.message) || e) };
        }
    }

    try {
        _db = admin.firestore();
    } catch (e) {
        return { db: null, admin: null, reason: 'firebase-admin initialised but Firestore is unavailable: ' + ((e && e.message) || e) };
    }
    _admin = admin;
    return { db: _db, reason: null, admin: _admin };
}

/** Reset the cached handle. Tests only — production wants the warm instance. */
export function _resetAdminDb() { _db = null; _admin = null; }
