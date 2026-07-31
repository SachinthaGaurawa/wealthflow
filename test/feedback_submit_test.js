// =============================================================================
// WealthFlow Shadow Test Harness — the "Send feedback" button does something
// =============================================================================
// THE BUG THIS FILE EXISTS TO STOP.
//
// The user pressed "Send feedback" and NOTHING happened. No network request, no
// loading state, no error toast, and the modal stayed open. The natural reading
// is a dead event listener — and it was not: `onclick = _submitFeedback` was
// never touched, and the handler's entry path was byte-for-byte what it had
// always been.
//
// In an `async` click handler, two completely different failures look exactly
// like a dead listener, and neither prints anything:
//
//   1. A synchronous throw becomes an unhandled promise rejection. Silent.
//   2. An `await` on a promise that NEVER SETTLES simply stops. Also silent.
//
// The second one was real, and it sat on line 1121:
//
//     await window.db.collection('feedback').add(...)
//
// Firestore's add() resolves only when the SERVER acknowledges the write. When
// the SDK cannot reach the backend — offline, blocked, expired auth, exhausted
// quota — the write is applied to the local cache immediately and the promise
// stays pending forever. It never rejects, so the `try/catch` wrapped around it
// could not help, and the function halted before it ever reached the POST.
//
// That is why the endpoint fixes in #42 and #43 changed nothing the user could
// see: the request was never being issued in the first place.
//
// These tests drive the real handler with a Firestore stub that never settles —
// the exact production condition — and assert the POST still goes out. A test
// that only read the source could not have caught this, because the source was
// not wrong to look at; it was wrong to wait on.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/** Load the shipped browser IIFE with a controllable stub environment. */
function loadApp({ firestoreNeverSettles = false, fetchImpl = null, notify = null } = {}) {
    const noop = () => {};
    const win = {};
    const calls = { fetches: [], notices: [] };

    const el = (id) => ({
        id, value: '', checked: false, disabled: false, textContent: '',
        style: {}, dataset: {}, attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
        removeAttribute(k) { delete this.attrs[k]; },
        classList: { add: noop, remove: noop }, appendChild: noop, remove: noop,
        querySelector: () => null,
    });

    const nodes = {
        wfFbType: Object.assign(el('wfFbType'), { value: 'bug' }),
        wfFbText: Object.assign(el('wfFbText'), { value: 'the Add your income button is broken' }),
        wfFbDiag: Object.assign(el('wfFbDiag'), { checked: true }),
        wfFbSend: Object.assign(el('wfFbSend'), { textContent: 'Send feedback' }),
    };

    const doc = {
        readyState: 'complete', addEventListener: noop,
        getElementById: (id) => nodes[id] || null,
        querySelector: () => null, querySelectorAll: () => [],
        getElementsByTagName: () => [],
        createElement: () => el('created'),
        body: { appendChild: noop }, head: { appendChild: noop },
    };

    const store = () => {
        const m = new Map();
        return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
    };

    const fetchStub = fetchImpl || (async (url) => {
        calls.fetches.push(String(url));
        return { ok: true, status: 200, json: async () => ({ ok: true, issue: 77 }) };
    });

    win.notify = notify || ((m, t) => calls.notices.push({ m: String(m), t }));

    // The production condition: a write that is accepted locally and never acked.
    //
    // `firebase` must be passed as its OWN binding, not just hung off `window`.
    // The submit path tests `window.db && window.firebase && firebase.firestore`
    // and then calls the BARE `firebase` — which in a browser is the same global,
    // but inside this sandbox `window` is a plain object, so a bare reference
    // would throw ReferenceError into the surrounding try/catch and skip the
    // Firestore branch entirely. The first version of this harness did exactly
    // that: all nine tests passed against the KNOWN-BROKEN code, because the
    // stall they exist to reproduce was never reached.
    let firebase = null;
    if (firestoreNeverSettles) {
        win.db = { collection: () => ({ add: () => new Promise(() => {}) }) };
        firebase = { firestore: { FieldValue: { serverTimestamp: () => 'ts' } } };
        win.firebase = firebase;
    }

    new Function(
        'window', 'document', 'console', 'localStorage', 'sessionStorage', 'navigator',
        'setTimeout', 'setInterval', 'clearTimeout', 'fetch', 'screen', 'location', 'AbortController',
        'firebase',
        fs.readFileSync('wealthflow-update-system.js', 'utf8'),
    )(
        win, doc, { log: noop, warn: noop, error: noop }, store(), store(),
        { onLine: true, userAgent: 'test', language: 'en' },
        // Time is scaled 1000×, so the production 8s Firestore bound elapses in
        // 8ms here. What is under test is the BEHAVIOUR — does the submit give up
        // on a stalled write and carry on — not the wall-clock constant, and
        // sleeping through the real thing would spend ~24s of CI on every run.
        (fn, ms) => globalThis.setTimeout(fn, Math.min((ms || 0) / 1000, 25)),
        noop, globalThis.clearTimeout, fetchStub,
        { width: 390, height: 844 }, { href: 'http://localhost/', reload: noop },
        globalThis.AbortController, firebase,
    );

    return { wf: win.wfUpdate, calls, nodes, win };
}

describe('feedback submit: a stalled Firestore write cannot swallow the button', () => {
    it('still POSTs to /api/feedback-triage when Firestore never acknowledges', async () => {
        // THE REGRESSION TEST. Before the fix this await never returned at all —
        // the assertion below was unreachable, which is exactly what the user saw.
        const { wf, calls } = loadApp({ firestoreNeverSettles: true });
        await wf._submitFeedback();
        expect(calls.fetches.some((u) => u.includes('/api/feedback-triage'))).toBe(true);
    }, 20000);

    it('still tells the user what happened', async () => {
        const { wf, calls } = loadApp({ firestoreNeverSettles: true });
        await wf._submitFeedback();
        expect(calls.notices.length).toBeGreaterThan(0);
        expect(calls.notices.map((n) => n.m).join(' ')).toMatch(/work item #77/);
    }, 20000);

    it('returns the button to the user instead of leaving it stuck on "Sending…"', async () => {
        const { wf, nodes } = loadApp({ firestoreNeverSettles: true });
        await wf._submitFeedback();
        expect(nodes.wfFbSend.disabled).toBe(false);
        expect(nodes.wfFbSend.textContent).toBe('Send feedback');
        expect(nodes.wfFbSend.getAttribute('data-sending')).toBeNull();
    }, 20000);
});

describe('feedback submit: failures are visible, never silent', () => {
    it('shows a message when the whole submit throws', async () => {
        // A synchronous throw in an async handler is an unhandled rejection: the
        // page shows nothing and the button looks dead. It must surface instead.
        const { wf, calls } = loadApp({
            fetchImpl: () => { throw new Error('boom'); },
        });
        await wf._submitFeedback();
        const said = calls.notices.map((n) => n.m).join(' ');
        expect(said.length).toBeGreaterThan(0);
        expect(said).not.toMatch(/prioriti[sz]ed/i);
    }, 20000);

    it('re-enables the button even when the submit throws', async () => {
        const { wf, nodes } = loadApp({ fetchImpl: () => { throw new Error('boom'); } });
        await wf._submitFeedback();
        expect(nodes.wfFbSend.disabled).toBe(false);
    }, 20000);

    it('ignores a second click while the first is still in flight', async () => {
        // Without the guard, an impatient double-tap files the report twice.
        let resolve;
        const gate = new Promise((r) => { resolve = r; });
        const { wf, calls, nodes } = loadApp({
            fetchImpl: async (url) => {
                calls.fetches.push(String(url));
                await gate;
                return { ok: true, status: 200, json: async () => ({ ok: true, issue: 5 }) };
            },
        });
        const first = wf._submitFeedback();
        await Promise.resolve();
        await wf._submitFeedback();                       // must be a no-op
        expect(nodes.wfFbSend.getAttribute('data-sending')).toBe('1');
        resolve();
        await first;
        const triage = calls.fetches.filter((u) => u.includes('/api/feedback-triage'));
        expect(triage).toHaveLength(1);
    }, 20000);
});

describe('_withTimeout: the primitive that makes the above possible', () => {
    it('rejects a promise that never settles, rather than waiting forever', async () => {
        const { wf } = loadApp();
        await expect(wf._withTimeout(new Promise(() => {}), 50, 'stalled thing'))
            .rejects.toThrow(/stalled thing timed out/);
    });

    it('passes a value straight through when it resolves in time', async () => {
        const { wf } = loadApp();
        await expect(wf._withTimeout(Promise.resolve('ok'), 5000)).resolves.toBe('ok');
    });

    it('preserves a genuine rejection instead of masking it as a timeout', async () => {
        const { wf } = loadApp();
        await expect(wf._withTimeout(Promise.reject(new Error('real failure')), 5000))
            .rejects.toThrow('real failure');
    });
});
