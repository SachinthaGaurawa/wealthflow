/* =============================================================================
 * test/e2e/firebase-cloud.mjs — ONE shared cloud document, several "devices"
 * ---------------------------------------------------------------------------
 * firebase-stub.mjs answers every read with "nothing there", which is the right
 * fixture for a UI sweep and the wrong one for a sync bug: a setting that
 * reverts after a few hours is an argument between TWO devices about one
 * Firestore document, and one browser talking to an empty stub cannot have it.
 *
 * This stub keeps the user's document in node and lets any number of pages
 * (each page = a device with its own localStorage, in its own browser context)
 * read it, write it and listen to it with Firestore's real merge rules:
 *
 *   · set(data, {merge:true}) deep-merges MAPS and replaces ARRAYS (so a map key
 *     can never be removed by a merge-set, exactly as in production)
 *   · update() with FieldPath / FieldValue.delete() removes a field
 *   · runTransaction() reads the current document and commits its set()s, and is OPTIMISTIC like the real one: if another
 *     device wrote between the read and the commit the commit is refused and the update function runs again on the new
 *     document (a stub that skipped this made two devices that edit at the same moment lose a write that production keeps)
 *   · onSnapshot() listeners are told about every commit, the writer included
 *
 * A device can be cut off with cloud.cutOff(page): its reads and writes fail
 * and it hears nothing, which is what offline looks like to the app — and it is
 * how a device becomes STALE about a setting another device changed.
 *
 * Everything else (other documents, collections, storage, auth) behaves as in
 * the plain stub: empty reads, discarded writes, an already-signed-in user.
 * ===========================================================================*/

import { TEST_USER } from './firebase-stub.mjs';

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/** Firestore's merge-set: maps merge key by key, everything else is replaced. */
function mergeInto(target, patch) {
    for (const k of Object.keys(patch)) {
        const v = patch[k];
        if (isPlain(v) && v.__fv === 'delete') { delete target[k]; continue; }
        if (isPlain(v) && v.__fv === 'ts') { target[k] = Date.now(); continue; }
        if (isPlain(v)) {
            if (!isPlain(target[k])) target[k] = {};
            mergeInto(target[k], v);
        } else {
            target[k] = clone(v);
        }
    }
    return target;
}

export function createCloud(initial = null) {
    let doc = initial ? clone(initial) : null;
    let version = 0;
    const pages = new Set();
    const cut = new Set();
    const log = [];

    const deliver = async () => {
        for (const p of pages) {
            if (cut.has(p)) continue;
            try { await p.evaluate(() => window.__cloudDeliver && window.__cloudDeliver()); } catch { /* page closed */ }
        }
    };

    return {
        get doc() { return doc ? clone(doc) : null; },
        log,
        /** Replace the document outright (a test fixture, not an app write). */
        seed(data) { doc = clone(data); },
        cutOff(page) { cut.add(page); },
        reconnect(page) { cut.delete(page); },
        isCut: (page) => cut.has(page),
        async attach(page, user = TEST_USER) {
            pages.add(page);
            page.on('close', () => pages.delete(page));
            await page.exposeBinding('__cloudOp', async (src, op, payload) => {
                const p = src.page;
                if (cut.has(p)) return { error: 'unavailable' };
                if (op === 'get') return { exists: !!doc, data: doc ? clone(doc) : null, version };
                if (op === 'set') {
                    const { data, merge, expect } = payload;
                    if (expect !== undefined && expect !== version) return { error: 'aborted' };
                    version++;
                    if (!doc || !merge) doc = {};
                    mergeInto(doc, data);
                    log.push({ op: 'set', merge: !!merge, keys: Object.keys(data) });
                } else if (op === 'update') {
                    if (!doc) return { error: 'not-found' };
                    version++;
                    for (const [path, value] of payload.pairs) {
                        const parts = path.split('\u0000');
                        let t = doc;
                        for (let i = 0; i < parts.length - 1; i++) { if (!isPlain(t[parts[i]])) t[parts[i]] = {}; t = t[parts[i]]; }
                        const last = parts[parts.length - 1];
                        if (isPlain(value) && value.__fv === 'delete') delete t[last];
                        else if (isPlain(value) && value.__fv === 'ts') t[last] = Date.now();
                        else t[last] = clone(value);
                    }
                    log.push({ op: 'update', n: payload.pairs.length });
                }
                // Tell every listener, the writer included, like the real thing.
                setTimeout(deliver, 5);
                return { ok: true };
            });
            await page.addInitScript(cloudStubSource(user));
            await page.route('https://www.gstatic.com/firebasejs/**', (route) =>
                route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: cloudStubSource(user) }));
        },
    };
}

/** Page-side: only users/{uid} is stateful; every other path behaves as the plain stub. */
export function cloudStubSource(user = TEST_USER) {
    return `
(function () {
  if (window.firebase && window.firebase.__stub) return;
  var USER = ${JSON.stringify(user)};
  var DEL = { __fv: 'delete' }, TS = { __fv: 'ts' };
  var snapListeners = [];

  function call(op, payload) {
    return window.__cloudOp(op, payload).then(function (r) {
      if (r && r.error) { var e = new Error(r.error); e.code = r.error; throw e; }
      return r;
    });
  }
  function snapOf(r) {
    return {
      exists: !!(r && r.exists),
      id: 'u',
      metadata: { fromCache: false, hasPendingWrites: false },
      __v: r ? r.version : undefined,
      data: function () { return r && r.exists ? JSON.parse(JSON.stringify(r.data)) : null; },
      get: function (k) { return r && r.exists ? r.data[k] : undefined; },
    };
  }
  function emptySnap() { return { exists: false, id: 'x', metadata: {}, data: function () { return null; }, get: function () { return null; } }; }
  function emptyQuery() { return { empty: true, size: 0, docs: [], forEach: function () {} }; }

  function userDoc(owner) {
    var d = {
      __user: true, firestore: owner, path: 'users/' + USER.uid,
      get: function () { return call('get').then(snapOf); },
      set: function (data, opts) { return call('set', { data: enc(data), merge: !!(opts && opts.merge) }); },
      update: function () {
        var a = Array.prototype.slice.call(arguments), pairs = [];
        if (a.length === 1 && a[0] && typeof a[0] === 'object') { Object.keys(a[0]).forEach(function (k) { pairs.push([k, enc(a[0][k])]); }); }
        else for (var i = 0; i + 1 < a.length; i += 2) {
          var f = a[i]; var path = (f && f.__path) ? f.__path.join('\\u0000') : String(f);
          pairs.push([path, enc(a[i + 1])]);
        }
        return call('update', { pairs: pairs });
      },
      delete: function () { return Promise.resolve(); },
      onSnapshot: function (cb, errCb) {
        var entry = { cb: cb, err: typeof errCb === 'function' ? errCb : null, last: null };
        snapListeners.push(entry);
        call('get').then(function (r) { entry.last = JSON.stringify(r); try { cb(snapOf(r)); } catch (e) {} }).catch(function () {});
        return function () { snapListeners = snapListeners.filter(function (x) { return x !== entry; }); };
      },
    };
    d.collection = function () { return plainColl(owner); };
    return d;
  }
  function plainDoc(owner) {
    var d = {
      firestore: owner,
      get: function () { return Promise.resolve(emptySnap()); },
      set: function () { return Promise.resolve(); },
      update: function () { return Promise.resolve(); },
      delete: function () { return Promise.resolve(); },
      onSnapshot: function (cb) { try { typeof cb === 'function' && cb(emptySnap()); } catch (e) {} return function () {}; },
    };
    d.collection = function () { return plainColl(owner); };
    return d;
  }
  function plainColl(owner) {
    var c = {
      doc: function () { return plainDoc(owner); },
      add: function () { return Promise.resolve(plainDoc(owner)); },
      get: function () { return Promise.resolve(emptyQuery()); },
      onSnapshot: function (cb) { try { typeof cb === 'function' && cb(emptyQuery()); } catch (e) {} return function () {}; },
    };
    ['where', 'orderBy', 'limit', 'startAfter', 'endBefore', 'startAt', 'endAt'].forEach(function (m) { c[m] = function () { return c; }; });
    return c;
  }
  function enc(v) {
    if (v === undefined) return null;
    if (v === DEL || v === TS) return v;
    if (v instanceof Date) return { __fv: 'ts' };
    if (Array.isArray(v)) return v.map(enc);
    if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { if (v[k] !== undefined) o[k] = enc(v[k]); }); return o; }
    return v;
  }

  var silent = false;
  window.__cloudDeliver = function () {
    if (silent) return Promise.resolve();
    return call('get').then(function (r) {
      var sig = JSON.stringify(r);
      snapListeners.slice().forEach(function (e) { if (e.last !== sig) { e.last = sig; try { e.cb(snapOf(r)); } catch (err) {} } });
    }).catch(function () {});
  };
  // A listener the server ends with an error (a dropped stream, an expired token): every error callback fires and the listeners go away.
  window.__cloudBreakListeners = function (code) {
    var gone = snapListeners; snapListeners = [];
    gone.forEach(function (e) { if (e.err) { var er = new Error(String(code || 'unavailable')); er.code = code || 'unavailable'; try { e.err(er); } catch (x) {} } });
    return gone.length;
  };
  // A listener that stays open but is never told anything again (a half-open connection): deliveries are swallowed until switched off.
  window.__cloudSilence = function (on) { silent = !!on; };
  window.__cloudListenerCount = function () { return snapListeners.length; };

  var firestore = function () {
    var db = {
      collection: function (name) {
        if (name === 'users') return { doc: function (id) { return id === USER.uid ? userDoc(db) : plainDoc(db); } };
        return plainColl(db);
      },
      doc: function () { return plainDoc(db); },
      batch: function () { return { set: function () {}, update: function () {}, delete: function () {}, commit: function () { return Promise.resolve(); } }; },
      runTransaction: function (fn) {
        var attempt = 0;
        var run = function () {
          var writes = [], readVersion;
          var tx = {
            get: function (ref) { return ref && ref.__user ? ref.get().then(function (snap) { readVersion = snap.__v; return snap; }) : Promise.resolve(emptySnap()); },
            set: function (ref, data, opts) { if (ref && ref.__user) writes.push([ref, data, opts]); },
            update: function () {}, delete: function () {},
          };
          return Promise.resolve(fn(tx)).then(function (out) {
            return writes.reduce(function (p, w, i) {
              return p.then(function () { return call('set', { data: enc(w[1]), merge: !!(w[2] && w[2].merge), expect: i === 0 ? readVersion : undefined }); });
            }, Promise.resolve()).then(function () { return out; });
          }).catch(function (e) { if (e && e.code === 'aborted' && ++attempt < 6) return run(); throw e; });
        };
        return run();
      },
      enablePersistence: function () { return Promise.resolve(); },
      settings: function () {},
    };
    return db;
  };
  firestore.FieldValue = {
    serverTimestamp: function () { return TS; },
    increment: function (n) { return n; },
    arrayUnion: function () { return []; }, arrayRemove: function () { return []; },
    delete: function () { return DEL; },
  };
  firestore.FieldPath = function () { this.__path = Array.prototype.slice.call(arguments); };
  firestore.Timestamp = {
    now: function () { return { toDate: function () { return new Date(); }, seconds: Math.floor(Date.now() / 1000) }; },
    fromDate: function (d) { return { toDate: function () { return d; }, seconds: Math.floor(d.getTime() / 1000) }; },
  };

  var auth = function () {
    return {
      currentUser: USER,
      onAuthStateChanged: function (cb) { if (typeof cb === 'function') setTimeout(function () { try { cb(USER); } catch (e) {} }, 0); return function () {}; },
      onIdTokenChanged: function (cb) { if (typeof cb === 'function') setTimeout(function () { try { cb(USER); } catch (e) {} }, 0); return function () {}; },
      signInWithPopup: function () { return Promise.resolve({ user: USER }); },
      signInWithRedirect: function () { return Promise.resolve(); },
      getRedirectResult: function () { return Promise.resolve({ user: null }); },
      signInWithEmailLink: function () { return Promise.resolve({ user: USER }); },
      sendSignInLinkToEmail: function () { return Promise.resolve(); },
      isSignInWithEmailLink: function () { return false; },
      setPersistence: function () { return Promise.resolve(); },
      signOut: function () { return Promise.resolve(); },
      useDeviceLanguage: function () {},
    };
  };
  auth.GoogleAuthProvider = function () { this.addScope = function () {}; this.setCustomParameters = function () {}; };
  auth.GoogleAuthProvider.credential = function () { return {}; };
  auth.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  var storage = function () {
    return { ref: function () { var r = { put: function () { return { on: function () {}, then: function (f) { return Promise.resolve(f && f({ ref: r })); } }; }, putString: function () { return Promise.resolve({ ref: r }); }, getDownloadURL: function () { return Promise.resolve(''); }, delete: function () { return Promise.resolve(); }, child: function () { return r; } }; return r; } };
  };
  window.firebase = {
    __stub: true, apps: [],
    initializeApp: function (cfg) { var a = { name: '[DEFAULT]', options: cfg || {} }; window.firebase.apps = [a]; return a; },
    app: function () { return { name: '[DEFAULT]', options: {} }; },
    auth: auth, firestore: firestore, storage: storage,
  };
})();
`;
}
