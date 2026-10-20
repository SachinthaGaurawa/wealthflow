/* =============================================================================
 * test/helpers/backup-fakes.js — in-memory Firestore, Google Drive and firebase-admin for the backup suites
 * -----------------------------------------------------------------------------
 * Shared by backup_restore_points_test.js (the module), backup_honesty_test.js (the page's half) and backup_sweep_test.js (the server run).
 * None of them is lenient on purpose: a Drive request with a stale token gets a 401, a Firestore batch that fails writes NOTHING, and a
 * Drive that stores a truncated file reports the truncated size — so whatever the code says afterwards is what the assertions check.
 * ===========================================================================*/

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const FOLDER_NAME = 'WealthFlow Backups';

const getPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, dotted, value) => {
    const keys = dotted.split('.');
    let o = obj;
    keys.slice(0, -1).forEach((k) => { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; });
    o[keys[keys.length - 1]] = value;
};

/** What `admin.firestore.FieldPath.documentId()` returns here: orderBy() on it sorts by document id. */
export const DOC_ID = Object.freeze({ __docId: true });

/** A Firestore with the slice of the API the module, the page and the sweep use. A failed batch commit applies NOTHING, like the real one. */
export function makeDb({ failCommit = false, hangCommit = false, failGet = false } = {}) {
    const store = new Map();
    const state = { failCommit, hangCommit, failGet, commitStarted: null, reads: [], writes: [] };
    state.started = new Promise((r) => { state.commitStarted = r; });
    const idsIn = (col) => [...store.keys()].filter((p) => p.startsWith(col + '/') && !p.slice(col.length + 1).includes('/'));
    const offline = () => Object.assign(new Error('offline'), { code: 'unavailable' });
    const docRef = (p) => ({
        id: p.split('/').pop(),
        path: p,
        collection: (n) => colRef(p + '/' + n),
        async get() {
            if (state.failGet) throw offline();
            state.reads.push(p);
            const d = store.get(p);
            return { id: p.split('/').pop(), exists: d !== undefined, data: () => (d === undefined ? undefined : structuredClone(d)) };
        },
        async set(data, opts) {
            state.writes.push(p);
            store.set(p, opts && opts.merge ? Object.assign({}, store.get(p) || {}, structuredClone(data)) : structuredClone(data));
        },
        async delete() { state.writes.push(p); store.delete(p); },
    });
    /** A query: where / select / orderBy / limit / startAfter / get, over the direct children of one collection. */
    const query = (p, q = {}) => {
        const next = (patch) => query(p, Object.assign({}, q, patch));
        return {
            where: (field, op, value) => next({ filters: (q.filters || []).concat([{ field, op, value }]) }),
            select: (...fields) => next({ fields }),
            orderBy: (field, dir = 'asc') => next({ order: { field, dir } }),
            limit: (n) => next({ n }),
            startAfter: (snap) => next({ after: snap && snap.id }),
            async get() {
                if (state.failGet) throw offline();
                let rows = idsIn(p).map((x) => ({ id: x.slice(p.length + 1), d: store.get(x) }));
                (q.filters || []).forEach((f) => {
                    rows = rows.filter((r) => {
                        const v = getPath(r.d, f.field);
                        if (f.op === 'in') return f.value.includes(v);
                        if (f.op === '==') return v === f.value;
                        throw new Error('fake Firestore: unsupported operator ' + f.op);
                    });
                });
                const o = q.order || { field: DOC_ID, dir: 'asc' };
                const key = (r) => (o.field === DOC_ID ? r.id : getPath(r.d, o.field));
                rows.sort((a, b) => { const x = key(a), y = key(b); const c = x < y ? -1 : x > y ? 1 : 0; return o.dir === 'desc' ? -c : c; });
                if (q.after != null) { const at = rows.findIndex((r) => r.id === q.after); if (at >= 0) rows = rows.slice(at + 1); }
                if (q.n != null) rows = rows.slice(0, q.n);
                return {
                    docs: rows.map((r) => ({
                        id: r.id,
                        data: () => {
                            if (!q.fields) return structuredClone(r.d);
                            const out = {};
                            q.fields.forEach((f) => { const v = getPath(r.d, f); if (v !== undefined) setPath(out, f, structuredClone(v)); });
                            return out;
                        },
                    })),
                };
            },
        };
    };
    const colRef = (p) => Object.assign(query(p), { doc: (id) => docRef(p + '/' + id) });
    return {
        store, state,
        collection: (n) => colRef(n),
        doc: (p) => docRef(p),
        batch() {
            const ops = [];
            return {
                set: (ref, data) => ops.push(['set', ref, data]),
                delete: (ref) => ops.push(['delete', ref]),
                async commit() {
                    if (state.hangCommit) { state.commitStarted(); return new Promise(() => {}); }
                    if (state.failCommit) throw Object.assign(new Error('write rejected'), { code: 'permission-denied' });
                    for (const [k, ref, data] of ops) { if (k === 'set') await ref.set(data); else await ref.delete(); }
                },
            };
        },
    };
}

/** firebase-admin, reduced to what backup-sweep.js touches: the Auth lookup and the document-id field path. */
export function makeAdmin({ users = {}, authDown = false } = {}) {
    const auth = () => ({
        async getUser(uid) {
            if (authDown) throw Object.assign(new Error('auth backend unavailable'), { code: 'auth/internal-error' });
            const u = users[uid];
            if (!u) throw Object.assign(new Error('no user'), { code: 'auth/user-not-found' });
            return { uid, email: u.email || '', disabled: !!u.disabled };
        },
    });
    return { auth, firestore: { FieldPath: { documentId: () => DOC_ID } } };
}

/** A Drive that refuses any token but `valid`, stores what it is given, and can be told to misbehave. */
export function makeDrive({ valid = 'good', quota = false, truncate = false, down = false } = {}) {
    const files = new Map();
    const calls = [];
    let seq = 0;
    const st = { valid, quota, truncate, down, files, calls };
    const res = (status, body, text) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (text !== undefined ? text : JSON.stringify(body)) });
    const err = (status, reason, message = reason) => res(status, { error: { code: status, message, status: String(reason), errors: [{ reason }] } });
    st.fetch = async (url, init = {}) => {
        const method = init.method || 'GET';
        calls.push({ url, method });
        if (st.down) throw new TypeError('fetch failed');
        const auth = init.headers && init.headers.Authorization;
        if (auth !== 'Bearer ' + st.valid) return err(401, 'authError', 'Invalid Credentials');
        const u = new URL(url);
        const p = u.pathname;
        if (p === '/upload/drive/v3/files' && method === 'POST') {
            if (st.quota) return err(403, 'storageQuotaExceeded', 'The user\'s Drive storage quota has been exceeded.');
            const meta = JSON.parse(await init.body.get('metadata').text());
            const text = await init.body.get('file').text();
            const id = 'file' + (++seq);
            files.set(id, { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, appProperties: meta.appProperties || {}, text,
                size: Buffer.byteLength(text) - (st.truncate ? 5 : 0), trashed: false, createdTime: new Date(1760000000000 + seq * 1000).toISOString() });
            const f = files.get(id);
            return res(200, { id, name: f.name, size: String(f.size), parents: f.parents, createdTime: f.createdTime });
        }
        const one = p.match(/^\/drive\/v3\/files\/([^/]+)$/);
        if (one && method === 'GET') {
            const f = files.get(decodeURIComponent(one[1]));
            if (!f) return err(404, 'notFound');
            if (u.searchParams.get('alt') === 'media') return res(200, null, f.text);
            return res(200, { id: f.id, size: String(f.size), trashed: f.trashed, mimeType: f.mimeType });
        }
        if (one && method === 'PATCH') { const f = files.get(decodeURIComponent(one[1])); if (!f) return err(404, 'notFound'); Object.assign(f, JSON.parse(init.body)); return res(200, { id: f.id }); }
        if (p === '/drive/v3/files' && method === 'POST') {
            const b = JSON.parse(init.body);
            const id = 'folder' + (++seq);
            files.set(id, { id, name: b.name, mimeType: b.mimeType, parents: b.parents || ['root'], appProperties: {}, size: 0, trashed: false, createdTime: new Date(1760000000000 + seq * 1000).toISOString() });
            return res(200, { id });
        }
        if (p === '/drive/v3/files' && method === 'GET') {
            const q = u.searchParams.get('q') || '';
            let list = [...files.values()].filter((f) => !f.trashed);
            if (q.includes("mimeType = '" + FOLDER_MIME + "'")) list = list.filter((f) => f.mimeType === FOLDER_MIME && f.name === FOLDER_NAME && f.parents.includes('root'));
            else list = list.filter((f) => f.mimeType === 'application/json' && f.name.startsWith('WealthFlow_'));
            const desc = /desc/.test(u.searchParams.get('orderBy') || '');
            list.sort((a, b) => (desc ? -1 : 1) * a.createdTime.localeCompare(b.createdTime));
            return res(200, { files: list.map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, size: String(f.size), appProperties: f.appProperties })) });
        }
        return err(400, 'badRequest', 'unhandled ' + method + ' ' + p);
    };
    return st;
}
