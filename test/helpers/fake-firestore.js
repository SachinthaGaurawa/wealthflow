// A small in-memory Firestore: enough of the Admin SDK's surface for the
// statement pipeline (documents, collections, where/limit/orderBy queries,
// transactions that refuse a read after a write, and live snapshots), so the
// whole server flow can run against it without a network.
export function createFirestore(seed = {}) {
    const data = new Map(Object.entries(seed).map(([path, value]) => [path, structuredClone(value)]));
    const watchers = new Set();
    const idOf = path => path.split('/').at(-1);
    const parentOf = path => path.split('/').slice(0, -1).join('/');
    const notify = () => watchers.forEach(run => run());

    function snapshot(path) {
        return { id: idOf(path), exists: data.has(path), ref: docRef(path), data: () => (data.has(path) ? structuredClone(data.get(path)) : undefined) };
    }
    function write(path, value, options) {
        data.set(path, options?.merge ? { ...(data.get(path) || {}), ...structuredClone(value) } : structuredClone(value));
        notify();
    }
    function docRef(path) {
        return {
            path, id: idOf(path),
            get: async () => snapshot(path),
            set: async (value, options) => write(path, value, options),
            delete: async () => { data.delete(path); notify(); },
            collection: name => collectionRef(`${path}/${name}`),
        };
    }
    function query(path, filters = [], max = Infinity, after = '') {
        const rows = () => [...data.keys()]
            .filter(key => parentOf(key) === path && (!after || idOf(key) > after) && filters.every(([field, op, value]) => (op === '==' ? data.get(key)?.[field] === value : op === 'in' ? Array.isArray(value) && value.includes(data.get(key)?.[field]) : false)))
            .sort().slice(0, max).map(snapshot);
        const q = {
            isQuery: true, path,
            where: (field, op, value) => query(path, [...filters, [field, op, value]], max, after),
            orderBy: () => q, startAfter: cursor => query(path, filters, max, typeof cursor === 'string' ? cursor : String(cursor?.id || '')),
            limit: count => query(path, filters, count, after),
            get: async () => { const docs = rows(); return { docs, empty: !docs.length, size: docs.length }; },
            onSnapshot(next) {
                let last = '';
                const run = () => { const docs = rows(); const key = JSON.stringify(docs.map(d => [d.id, d.data()])); if (key !== last) { last = key; next({ docs, size: docs.length, metadata: { fromCache: false, hasPendingWrites: false } }); } };
                watchers.add(run); run();
                return () => watchers.delete(run);
            },
        };
        return q;
    }
    function collectionRef(path) { return { ...query(path), doc: id => docRef(`${path}/${id}`), path }; }

    return {
        data,
        db: {
            doc: docRef,
            collection: collectionRef,
            async runTransaction(work) {
                const writes = []; let wrote = false;
                const result = await work({
                    get: async ref => { if (wrote) throw new Error('read-after-write'); return ref.isQuery ? ref.get() : ref.get(); },
                    set: (ref, value, options) => { wrote = true; writes.push([ref.path, value, options]); },
                });
                writes.forEach(([path, value, options]) => write(path, value, options));
                return result;
            },
        },
    };
}
