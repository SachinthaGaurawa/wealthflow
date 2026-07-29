/* =============================================================================
 * test/e2e/firebase-stub.mjs — a signed-in browser, without touching production
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TEST FILE AND NOT A FLAG IN index.html
 *   The obvious way to let a runtime sweep past the login screen is a
 *   "test mode" flag in the app: `?testMode=1`, `localStorage.testMode`,
 *   `window.__TEST__`, or a `NODE_ENV === 'test'` branch.
 *
 *   Every one of those is a PRODUCTION AUTH BYPASS on a personal-finance app.
 *   `index.html` is a static file served straight to browsers — there is no
 *   bundler and no build step, so nothing strips a dev-only branch on the way
 *   out. `NODE_ENV` does not exist in a browser at all. Any flag the app itself
 *   honours is a flag an attacker can set from devtools.
 *
 *   So the bypass lives HERE, in the harness, and never ships. Playwright
 *   intercepts the four Firebase CDN scripts the page requests and answers with
 *   the stub below. The application source is not modified, not conditionally
 *   compiled, and not aware that it is under test. There is no production code
 *   path to exploit, because there is no production code change.
 *
 * WHY A STUB AND NOT THE REAL SDK
 *   The sweep must be hermetic: no network, no real Google account, no real
 *   Firestore, no cost, and identical results on every run. It also has to work
 *   at all — the CI sandbox cannot reach gstatic.com, so the real SDK never
 *   loads there and the app dies on `ReferenceError: firebase is not defined`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not fake a PIN, and it does not pretend the user's data exists.
 *   Firestore reads come back EMPTY, which is the honest new-user state. A sweep
 *   that invented plausible data would be testing the fixture, not the app.
 * ===========================================================================*/

/** The signed-in identity every sweep runs as. Obviously fake, on purpose. */
export const TEST_USER = {
    uid: 'e2e-sweep-user',
    email: 'sweep@e2e.invalid',          // .invalid is reserved by RFC 2606
    displayName: 'E2E Sweep',
    photoURL: '',
    emailVerified: true,
    providerData: [{ providerId: 'google.com' }],
};

/**
 * The script served in place of the real firebase-*-compat bundles.
 *
 * Kept as a string because it is evaluated in the PAGE, not in node. It defines
 * only the surface index.html actually calls — verified by grepping the app for
 * `firebase.<x>()` rather than guessing at the SDK's full API.
 */
export function firebaseStubSource(user = TEST_USER) {
    return `
(function () {
  if (window.firebase && window.firebase.__stub) return;   // the app loads 4 scripts; install once

  var USER = ${JSON.stringify(user)};

  // ── Firestore: chainable, and always empty ────────────────────────────────
  // Every terminal read resolves to "nothing there", which is a real state the
  // app must handle (a brand-new account). Writes succeed and are discarded.
  function emptySnap() {
    return { exists: false, data: function () { return null; }, id: 'stub', get: function () { return null; } };
  }
  function emptyQuery() {
    return { empty: true, size: 0, docs: [], forEach: function () {} };
  }
  function docRef() {
    var d = {
      get: function () { return Promise.resolve(emptySnap()); },
      set: function () { return Promise.resolve(); },
      update: function () { return Promise.resolve(); },
      delete: function () { return Promise.resolve(); },
      onSnapshot: function (cb) { try { typeof cb === 'function' && cb(emptySnap()); } catch (e) {} return function () {}; },
    };
    d.collection = function () { return collRef(); };
    return d;
  }
  function collRef() {
    var c = {
      doc: function () { return docRef(); },
      add: function () { return Promise.resolve(docRef()); },
      get: function () { return Promise.resolve(emptyQuery()); },
      onSnapshot: function (cb) { try { typeof cb === 'function' && cb(emptyQuery()); } catch (e) {} return function () {}; },
    };
    // query builders all return the same chainable object
    ['where', 'orderBy', 'limit', 'startAfter', 'endBefore', 'startAt', 'endAt'].forEach(function (m) {
      c[m] = function () { return c; };
    });
    return c;
  }

  var firestore = function () {
    return {
      collection: function () { return collRef(); },
      doc: function () { return docRef(); },
      batch: function () {
        return { set: function () {}, update: function () {}, delete: function () {}, commit: function () { return Promise.resolve(); } };
      },
      runTransaction: function (fn) { try { return Promise.resolve(fn({ get: function () { return Promise.resolve(emptySnap()); }, set: function () {}, update: function () {}, delete: function () {} })); } catch (e) { return Promise.resolve(); } },
      enablePersistence: function () { return Promise.resolve(); },
      settings: function () {},
    };
  };
  firestore.FieldValue = {
    serverTimestamp: function () { return new Date(); },
    increment: function (n) { return n; },
    arrayUnion: function () { return []; },
    arrayRemove: function () { return []; },
    delete: function () { return null; },
  };
  firestore.Timestamp = {
    now: function () { return { toDate: function () { return new Date(); }, seconds: Math.floor(Date.now() / 1000) }; },
    fromDate: function (d) { return { toDate: function () { return d; }, seconds: Math.floor(d.getTime() / 1000) }; },
  };

  // ── Auth: already signed in ───────────────────────────────────────────────
  // onAuthStateChanged fires ASYNCHRONOUSLY, like the real SDK. Firing it
  // synchronously would let the app observe an ordering it never sees in
  // production, and the sweep would be testing a fiction.
  var listeners = [];
  var auth = function () {
    return {
      currentUser: USER,
      onAuthStateChanged: function (cb) {
        if (typeof cb === 'function') { listeners.push(cb); setTimeout(function () { try { cb(USER); } catch (e) {} }, 0); }
        return function () {};
      },
      onIdTokenChanged: function (cb) {
        if (typeof cb === 'function') setTimeout(function () { try { cb(USER); } catch (e) {} }, 0);
        return function () {};
      },
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
    return {
      ref: function () {
        var r = {
          put: function () { return { on: function () {}, then: function (f) { return Promise.resolve(f && f({ ref: r })); } }; },
          putString: function () { return Promise.resolve({ ref: r }); },
          getDownloadURL: function () { return Promise.resolve(''); },
          delete: function () { return Promise.resolve(); },
          child: function () { return r; },
        };
        return r;
      },
    };
  };

  window.firebase = {
    __stub: true,
    apps: [],
    initializeApp: function (cfg) { var a = { name: '[DEFAULT]', options: cfg || {} }; window.firebase.apps = [a]; return a; },
    app: function () { return { name: '[DEFAULT]', options: {} }; },
    auth: auth,
    firestore: firestore,
    storage: storage,
  };
})();
`;
}

/** The CDN URLs the app requests, which the harness answers with the stub. */
export const FIREBASE_CDN_GLOB = 'https://www.gstatic.com/firebasejs/**';

/**
 * Install the stub on a Playwright page. Must be called BEFORE navigation, so
 * the interception is in place when the page requests the SDK.
 */
export async function installFirebaseStub(page, user = TEST_USER) {
    const body = firebaseStubSource(user);
    await page.route(FIREBASE_CDN_GLOB, (route) =>
        route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body }));
    // Belt and braces: if the page ever inlines the SDK instead of fetching it,
    // this still defines the global before any app script runs.
    await page.addInitScript(body);
}
