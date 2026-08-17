/* =============================================================================
 * inbox-store.mjs — the SMS inbox's Firestore access, via the Admin SDK
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * inbox-push / inbox-pull / inbox-ack reached Firestore over the REST API with
 * only the public Web apiKey. To Firestore's security rules such a request is
 * UNAUTHENTICATED — `request.auth == null` — so the only way those endpoints
 * could work was for the rules to allow unauthenticated access to the collection
 * they use. firestore.rules says so in its own words:
 *
 *     match /wf-inbox/{deviceHash}/{document=**} {
 *       allow read, write: if true;
 *     }
 *     // HARDENING TODO: move inbox-*.js to the Admin SDK + a per-device token,
 *     // then lock this branch down to that token.
 *
 * That branch holds classified bank transactions, and the app applies whatever
 * inbox-pull returns straight into the user's ledger. Its only protection was the
 * unguessability of a 16-hex-character device hash in the path — a secret that
 * travels in URLs and therefore into access logs.
 *
 * The naive hardening does not work. Changing that branch to
 * `if request.auth != null` denies every one of these endpoints, because none of
 * them holds a Firebase Auth session — the SMS pipeline would break again, this
 * time with a 403 instead of the 500 that #111 fixed.
 *
 * THE FIX: the Admin SDK authenticates with a service account and BYPASSES
 * security rules entirely — the same mechanism release-brain.js already relies on
 * to write system/* while that collection is `allow write: if false`. Once these
 * three endpoints go through it, the rules can close wf-inbox to the whole
 * internet and the pipeline keeps working.
 *
 * WHAT THAT MOVES, AND WHAT IT DOES NOT
 *
 * It removes the database from the public internet. It does NOT weaken the
 * per-device boundary — but it does make this file the ONLY thing enforcing it.
 * Firestore is no longer a second opinion: whatever bucket the server addresses
 * is the bucket that gets read or written. So the token checks here are now
 * load-bearing in a way they were not before, which is why they live in one
 * audited place instead of three copies.
 *
 * DEADLINES. The Admin SDK speaks gRPC and takes no AbortSignal, so the
 * `AbortController` deadlines added in #112 do not carry over. Losing them would
 * silently undo that work: a stalled backend would once again hold the whole
 * invocation to maxDuration and surface as FUNCTION_INVOCATION_TIMEOUT. Every
 * call here is therefore wrapped in `withDeadline`, which stops US waiting even
 * though the underlying RPC may continue — the endpoint answers with a fact
 * instead of consuming the budget.
 * ===========================================================================*/

/** Under the maxDuration: 60 ceiling, with room left to answer honestly. */
export const DEFAULT_DEADLINE_MS = 8000;

/**
 * Stop waiting after `ms`. The underlying RPC is not cancellable, so this bounds
 * OUR wait rather than the call — which is the part that matters: a handler that
 * answers "the database did not respond in 8s" is strictly better than one that
 * is killed at 60s with nothing recorded.
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

/**
 * The Firestore handle, or a reason it is unavailable — never a throw, and never
 * a null with no explanation. Same shape and same failure discipline as
 * release-brain.js's getAdmin(), deliberately: a missing credential must read as
 * "not configured", not as "empty inbox".
 *
 * NOTE the credential change. These endpoints used to need FIREBASE_API_KEY (the
 * public Web key); they now need FIREBASE_SERVICE_ACCOUNT, the same secret
 * release-brain.js already uses. If it is absent the endpoints report 503 rather
 * than degrading to something that looks like success.
 */
export async function getInboxDb() {
    if (_db) return { db: _db, reason: null };

    let admin;
    try {
        admin = (await import('firebase-admin')).default;
    } catch (e) {
        return { db: null, reason: 'firebase-admin could not be loaded: ' + ((e && e.message) || e) };
    }
    if (!admin || !admin.apps) {
        return { db: null, reason: 'firebase-admin loaded but exposes no app registry — wrong module shape.' };
    }

    if (!admin.apps.length) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw || !String(raw).trim()) {
            return {
                db: null,
                reason: 'FIREBASE_SERVICE_ACCOUNT is not configured on this deployment. '
                    + 'The inbox endpoints now use the Firebase Admin SDK so that wf-inbox can be '
                    + 'closed to unauthenticated access; set it in Vercel → Settings → Environment Variables.',
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
                reason: 'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON ('
                    + (at ? 'malformed at position ' + at[1] : 'malformed') + ').',
            };
        }
        try {
            admin.initializeApp({ credential: admin.credential.cert(cred) });
        } catch (e) {
            return { db: null, reason: 'firebase-admin rejected that credential: ' + ((e && e.message) || e) };
        }
    }

    try {
        _db = admin.firestore();
    } catch (e) {
        return { db: null, reason: 'firebase-admin initialised but Firestore is unavailable: ' + ((e && e.message) || e) };
    }
    return { db: _db, reason: null };
}

/** Reset the cached handle. Tests only — production wants the warm instance. */
export function _resetInboxDb() { _db = null; }

export const INBOX_ROOT = 'wf-inbox';
export const ITEMS = 'items';

/**
 * The device bucket name: the first 8 bytes of SHA-256 over the token, hex.
 *
 * THIS ALGORITHM MUST NOT CHANGE. It is the address of every item already in the
 * database; altering the digest, the truncation or the encoding would silently
 * orphan every pending transaction rather than fail visibly. It is byte-identical
 * to the REST implementation it replaces, which is why the migration is
 * transparent to items already stored.
 */
export async function tokenHash(token) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token)));
    return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The document key the client sees, unchanged from the REST era so that an ack
 *  issued before this migration still resolves after it. */
export function itemKey(tHash, msgHash) {
    return `${INBOX_ROOT}/${tHash}/${ITEMS}/${msgHash}`;
}

/**
 * Validate a client-supplied key and return the message id inside it, or null.
 *
 * With the Admin SDK there is no security rule left to catch a bad path, so this
 * is the whole boundary: the key must name THIS device's bucket exactly, and must
 * contain no traversal or extra segments. Anything else is refused before a
 * database call is made.
 */
export function itemIdFrom(key, tHash) {
    const s = String(key == null ? '' : key);
    if (s.includes('..') || s.includes('//')) return null;
    const prefix = `${INBOX_ROOT}/${tHash}/${ITEMS}/`;
    if (!s.startsWith(prefix)) return null;
    const id = s.slice(prefix.length);
    // A single path segment, and nothing Firestore would reject as a document id.
    if (!id || id.includes('/') || id.length > 400 || /^__.*__$/.test(id)) return null;
    return id;
}

/**
 * The device token, from the header the app sends or a JSON body field.
 *
 * THE QUERY STRING IS NO LONGER ACCEPTED. `?token=…` used to work here as a
 * manual-debug convenience, and it is the weakest possible channel for a
 * capability: query strings are written to server access logs, proxy logs and
 * browser history, and they travel in the Referer header to any third party the
 * page later links to. This token is the ONLY thing identifying a device's
 * inbox — with wf-inbox sealed, it is the whole boundary — so a channel that
 * copies it into logs is not an acceptable place to carry it.
 *
 * Nothing in the app used it: wealthflow-autonomous.js sends the header on both
 * inbox-pull and inbox-ack, and sms-ingest forwards the header to inbox-push. The
 * only cost is that a hand-typed browser URL no longer authenticates, which is
 * the point.
 */
export function deviceTokenFrom(req, body) {
    const raw = String(
        (body && body.device_token)
        || (req && req.headers && req.headers['x-wf-device-token'])
        || '',
    ).trim();
    return raw.length >= 16 ? raw : '';
}

/** Vercel hands a Node handler an already-parsed body for JSON content types,
 *  but not for every content type. Throws on malformed JSON. */
export function jsonBody(req) {
    const b = req && req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
    const text = Buffer.isBuffer(b) ? b.toString('utf8') : (typeof b === 'string' ? b : '');
    if (!text.trim()) throw new Error('empty body');
    return JSON.parse(text);
}
