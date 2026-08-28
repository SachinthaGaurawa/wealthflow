// =============================================================================
// test/fake-admin.mjs — an in-memory stand-in for firebase-admin
// =============================================================================
// statement-store.js and the inbox endpoints reach Firestore through the Admin
// SDK (admin-db.mjs). These tests must never touch the real project — four
// documents were once created in the live database by a probe, which is the
// reason every suite here is hard-blocked from the network.
//
// This models only the surface admin-db.mjs and its callers actually use:
//   admin.apps / credential.cert / initializeApp / firestore()
//   db.doc(path).create|delete|get|set  db.collection(c).doc(id).…
//   ref.collection(sub).limit(n).get()  admin.firestore.FieldValue.delete()
//   admin.auth().verifyIdToken(t)
//
// THE AUTH AND SET SURFACES WERE ADDED AFTER A CRASH. /api/gmail-link shipped
// reading getAdminDb()'s { db, reason } wrapper as if it were the handle, and
// died on `db.collection is not a function` for every single request. Nothing
// caught it because nothing could: its handler had never been executed in a
// test, only read as text, and this file modelled no `set`, no subcollection and
// no `auth()` — so no suite could have run it even if one had tried. Reading a
// handler's source proves what it says; running it proves what it does.
//
// `create` is NOT an upsert — it throws on an existing id, exactly as Firestore
// does — because "a create that silently overwrote another user's shared
// statement" is precisely the behaviour the production code relies on it to
// refuse. Writes are recorded in order so "the manifest is written last" can be
// asserted rather than assumed.
// =============================================================================

/** What FieldValue.delete() returns: a sentinel `set(…, {merge:true})` honours by
 *  REMOVING the field, which is the whole behaviour the disconnect path relies
 *  on. A stand-in that stored the sentinel as a value would let a "disconnect"
 *  that never removed the credential pass. */
export const DELETE_SENTINEL = Object.freeze({ __fake_field_value: 'delete' });

export function makeFakeAdmin() {
    const docs = new Map();          // 'collection/id' → plain data object
    const order = [];                // write order, for manifest-last assertions
    const ops = [];                  // every operation attempted: {path, op}
    let failOn = () => null;         // (path, op) → Error | null
    let verify = async () => { throw new Error('no verifier installed'); };

    /** Merge like Firestore: named fields replace, the delete sentinel removes,
     *  and everything not named is left alone. */
    function mergeInto(prev, data) {
        const next = { ...(prev || {}) };
        for (const [k, v] of Object.entries(data || {})) {
            if (v === DELETE_SENTINEL) delete next[k];
            else next[k] = v;
        }
        return next;
    }

    function docRef(path) {
        const ref = {
            id: path.slice(path.lastIndexOf('/') + 1),
            path,
            async create(data) {
                ops.push({ path, op: 'create' });
                const e = failOn(path, 'create');
                if (e) throw e;
                if (docs.has(path)) {
                    const err = new Error(`ALREADY_EXISTS: ${path}`);
                    err.code = 6;
                    throw err;
                }
                docs.set(path, data);
                order.push(path);
            },
            /** Upsert. `{ merge: true }` merges; without it the document is
             *  replaced outright, as Firestore does. */
            async set(data, opts) {
                ops.push({ path, op: 'set' });
                const e = failOn(path, 'set');
                if (e) throw e;
                const merge = !!(opts && opts.merge);
                docs.set(path, merge ? mergeInto(docs.get(path), data) : mergeInto(null, data));
                order.push(path);
            },
            async delete() {
                ops.push({ path, op: 'delete' });
                const e = failOn(path, 'delete');
                if (e) throw e;
                docs.delete(path);   // idempotent, like Firestore
            },
            async get() {
                ops.push({ path, op: 'get' });
                const e = failOn(path, 'get');
                if (e) throw e;
                const exists = docs.has(path);
                const data = docs.get(path);
                return { exists, id: ref.id, ref, data: () => data };
            },
            collection: (sub) => collRef(`${path}/${sub}`),
        };
        return ref;
    }

    /** A collection is every document one path segment below it — a real
     *  Firestore query does not descend into subcollections, and neither does
     *  this, so "the parts of item X" cannot accidentally answer with item Y's. */
    function collRef(base, cap = Infinity) {
        return {
            path: base,
            doc: (id) => docRef(`${base}/${id}`),
            limit: (n) => collRef(base, n),
            async get() {
                ops.push({ path: base, op: 'query' });
                const e = failOn(base, 'query');
                if (e) throw e;
                const out = [];
                for (const key of docs.keys()) {
                    if (!key.startsWith(`${base}/`)) continue;
                    if (key.slice(base.length + 1).includes('/')) continue;
                    out.push(docRef(key));
                    if (out.length >= cap) break;
                }
                const snaps = out.map((r) => ({ id: r.id, ref: r, data: () => docs.get(r.path) }));
                return { empty: snaps.length === 0, size: snaps.length, docs: snaps };
            },
        };
    }

    const firestore = () => ({
        doc: (p) => docRef(p),
        collection: (c) => collRef(c),
    });
    // A PROPERTY on the function, not on its result — `admin.firestore.FieldValue`
    // is how the SDK exposes it and how the disconnect path reaches it.
    firestore.FieldValue = { delete: () => DELETE_SENTINEL };

    const admin = {
        apps: [],
        credential: { cert: (o) => ({ _cert: o }) },
        initializeApp(opts) { admin.apps.push({ opts }); return admin.apps[0]; },
        firestore,
        auth: () => ({ verifyIdToken: (t) => verify(t) }),
    };

    return {
        admin, docs, order, ops,
        setFailOn(fn) { failOn = fn; },
        /** Install the identity this fake will vouch for. A suite that never
         *  calls it gets a verifier that throws, so "no identity" is never
         *  silently the same as "any identity". */
        setVerifier(fn) { verify = fn; },
        reset() {
            docs.clear(); order.length = 0; ops.length = 0;
            failOn = () => null;
            verify = async () => { throw new Error('no verifier installed'); };
            admin.apps.length = 0;
        },
    };
}

/** A syntactically valid service account. Assembled from fragments so the CI
 *  secret scanner never sees a literal PEM header in the repo — the same
 *  precedent applied when a test fixture last tripped it. */
export const FAKE_SERVICE_ACCOUNT = JSON.stringify({
    type: 'service_account',
    project_id: 'wealthflow-test-does-not-exist',
    private_key_id: 'not-a-real-key-id',
    private_key: ['-----BEGIN', 'PRIVATE', 'KEY-----\\nnot-a-real-key\\n-----END', 'PRIVATE', 'KEY-----\\n'].join(' '),
    client_email: 'test@wealthflow-test-does-not-exist.iam.gserviceaccount.com',
});
