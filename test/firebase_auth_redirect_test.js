import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SERVICE_WORKER = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

function storage(seed = {}) {
    const values = new Map(Object.entries(seed));
    return {
        getItem: (key) => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: (key) => values.delete(key),
        clear: () => values.clear(),
        value: (key) => values.get(key),
    };
}

function runtime({ redirectResult = { user: null }, decoy = false } = {}) {
    const localStorage = storage({ wf2_auth: JSON.stringify({ pin: 'hashed-pin' }), precious: 'keep-me' });
    const sessionStorage = storage();
    const calls = [];
    const auth = {
        currentUser: redirectResult.user || null,
        setPersistence: vi.fn(async () => { calls.push('persistence'); }),
        signInWithRedirect: vi.fn(async () => { calls.push('redirect'); }),
        getRedirectResult: vi.fn(async () => redirectResult),
    };
    function Provider() {
        this.setCustomParameters = vi.fn();
        this.addScope = vi.fn();
    }
    Provider.credentialFromResult = (result) => result.credential || null;
    const window = {
        firebase: { auth: Object.assign(() => auth, { GoogleAuthProvider: Provider, Auth: { Persistence: { LOCAL: 'local' } } }) },
        localStorage,
        sessionStorage,
        location: { origin: 'https://www.wealthflow.lk', pathname: '/', search: '', hash: '' },
        _isDecoyMode: decoy,
        addEventListener: vi.fn(),
    };
    const start = HTML.indexOf('window.WFAuth = (function ()');
    const end = HTML.indexOf('\n\n        const firebaseConfig', start);
    expect(start, 'inline auth coordinator missing').toBeGreaterThan(-1);
    vm.runInNewContext(HTML.slice(start, end), { window, firebase: window.firebase, location: window.location, localStorage, sessionStorage, navigator: {}, URL, Date, JSON, Promise, Error, console, setTimeout });
    return { api: window.WFAuth, auth, calls, localStorage, sessionStorage };
}

describe('first-party Firebase redirect authentication', () => {
    it('uses the official origin as authDomain in production', () => {
        expect(HTML).toMatch(/authDomain:\s*window\.location\.hostname\s*===\s*['"]www\.wealthflow\.lk['"]\s*\?\s*['"]www\.wealthflow\.lk['"]/);
    });

    it('loads the redirect coordinator and no longer starts Google auth with a popup', () => {
        expect(HTML).toContain('window.WFAuth = (function ()');
        expect(HTML).not.toContain('<script src="wealthflow-auth.js"');
        const signIn = HTML.slice(HTML.indexOf('function signInWithGoogle()'), HTML.indexOf('async function signOutGoogle()'));
        const switching = HTML.slice(HTML.indexOf('function switchGoogleAccount()'), HTML.indexOf('// ==================== BIOMETRICS'));
        expect(signIn).toContain('WFAuth.beginGoogleSignIn');
        expect(switching).toContain('WFAuth.beginGoogleSignIn');
        expect(signIn).not.toContain('signInWithPopup');
        expect(switching).not.toContain('signInWithPopup');
    });

    it('updates a legacy PWA worker before redirect and never lets a worker cache Firebase helper routes', () => {
        const authCoordinator = HTML.slice(HTML.indexOf('window.WFAuth = (function ()'), HTML.indexOf('\n\n        const firebaseConfig'));
        expect(authCoordinator).toContain('registration.update()');
        expect(authCoordinator.indexOf('await refreshWorkerForAuth()')).toBeLessThan(authCoordinator.indexOf('remember(options.mode)'));
        expect(SERVICE_WORKER).toContain("url.pathname.startsWith('/__/auth/')");
        expect(SERVICE_WORKER).toContain("url.pathname.startsWith('/__/firebase/')");
        expect(SERVICE_WORKER.indexOf("url.pathname.startsWith('/__/auth/')")).toBeLessThan(SERVICE_WORKER.indexOf("url.pathname === '/version.json'"));
    });

    it('settles the redirect result before installing the auth-state observer', () => {
        const boot = HTML.slice(HTML.indexOf('window.onload = async function'), HTML.indexOf('function finishBoot()'));
        expect(boot.indexOf('await window.WFAuth.consumeRedirectResult')).toBeGreaterThan(-1);
        expect(boot.indexOf('await window.WFAuth.consumeRedirectResult')).toBeLessThan(boot.indexOf('firebase.auth().onAuthStateChanged'));
        expect(boot).not.toMatch(/getRedirectResult\(\)\.then/);
    });

    it('persists auth before redirect and does not erase the PIN or local ledger', async () => {
        const r = runtime();
        await r.api.beginGoogleSignIn({ mode: 'sign-in' });
        expect(r.calls).toEqual(['persistence', 'redirect']);
        expect(r.localStorage.value('wf2_auth')).toContain('hashed-pin');
        expect(r.localStorage.value('precious')).toBe('keep-me');
        expect(JSON.parse(r.sessionStorage.value('wf_auth_redirect_intent_v1'))).toMatchObject({ mode: 'sign-in', version: 1 });
    });

    it('refuses account changes while the read-only decoy vault is active', async () => {
        const r = runtime({ decoy: true });
        await expect(r.api.beginGoogleSignIn({ mode: 'switch-account' })).rejects.toMatchObject({ code: 'wf/auth-decoy-mode' });
        expect(r.auth.signInWithRedirect).not.toHaveBeenCalled();
    });

    it('consumes the redirect once and retains the Drive credential without touching PIN data', async () => {
        const user = { uid: 'owner' };
        const r = runtime({ redirectResult: { user, credential: { accessToken: 'drive-token' } } });
        r.sessionStorage.setItem('wf_auth_redirect_intent_v1', JSON.stringify({ version: 1, mode: 'sign-in', startedAt: Date.now() }));
        const result = await r.api.consumeRedirectResult();
        expect(result.user.uid).toBe('owner');
        expect(JSON.parse(r.localStorage.value('wf_drive_token'))).toMatchObject({ token: 'drive-token' });
        expect(r.localStorage.value('wf2_auth')).toContain('hashed-pin');
        expect(r.sessionStorage.value('wf_auth_redirect_intent_v1')).toBeUndefined();
    });
});

describe('Firebase helper routing is ahead of the SPA catch-all', () => {
    it('transparently proxies both required reserved namespaces on Vercel', () => {
        const auth = VERCEL.rewrites.find((r) => r.source === '/__/auth/:path*');
        const init = VERCEL.rewrites.find((r) => r.source === '/__/firebase/:path*');
        const catchAll = VERCEL.rewrites.findIndex((r) => r.source === '/(.*)');
        expect(auth?.destination).toBe('https://wealthflow-6dffb.firebaseapp.com/__/auth/:path*');
        expect(init?.destination).toBe('https://wealthflow-6dffb.firebaseapp.com/__/firebase/:path*');
        expect(VERCEL.rewrites.indexOf(auth)).toBeLessThan(catchAll);
        expect(VERCEL.rewrites.indexOf(init)).toBeLessThan(catchAll);
    });

    it('keeps helper responses out of edge and browser caches', () => {
        const rules = VERCEL.headers.filter((h) => h.source.startsWith('/__/'));
        expect(rules).toHaveLength(2);
        for (const rule of rules) {
            expect(rule.headers).toContainEqual({ key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' });
        }
    });

    it('ships Cloudflare Pages function equivalents for a future DNS cutover', () => {
        for (const file of ['functions/__/auth/[[path]].js', 'functions/__/firebase/[[path]].js']) {
            expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
        }
    });
});
