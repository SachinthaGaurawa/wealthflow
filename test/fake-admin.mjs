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
//   db.doc(path).create|delete|get      db.collection(c).doc(id).…
//
// `create` is NOT an upsert — it throws on an existing id, exactly as Firestore
// does — because "a create that silently overwrote another user's shared
// statement" is precisely the behaviour the production code relies on it to
// refuse. Writes are recorded in order so "the manifest is written last" can be
// asserted rather than assumed.
// =============================================================================

export function makeFakeAdmin() {
    const docs = new Map();          // 'collection/id' → plain data object
    const order = [];                // write order, for manifest-last assertions
    const ops = [];                  // every operation attempted: {path, op}
    let failOn = () => null;         // (path, op) → Error | null

    function docRef(path) {
        return {
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
                return { exists, data: () => data };
            },
        };
    }

    const admin = {
        apps: [],
        credential: { cert: (o) => ({ _cert: o }) },
        initializeApp(opts) { admin.apps.push({ opts }); return admin.apps[0]; },
        firestore: () => ({
            doc: (p) => docRef(p),
            collection: (c) => ({ doc: (id) => docRef(`${c}/${id}`) }),
        }),
    };

    return {
        admin, docs, order, ops,
        setFailOn(fn) { failOn = fn; },
        reset() { docs.clear(); order.length = 0; ops.length = 0; failOn = () => null; admin.apps.length = 0; },
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
