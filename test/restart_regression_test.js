import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
const live = fs.readFileSync(new URL('../wealthflow-live-update.js', import.meta.url), 'utf8');
const update = fs.readFileSync(new URL('../wealthflow-update-system.js', import.meta.url), 'utf8');
function harness(source) {
    const events = new Map(), timers = [], intervals = [], store = new Map();
    const listen = (type, fn) => { const a = events.get(type) || []; a.push(fn); events.set(type, a); };
    const element = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, remove() {}, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, innerHTML: '' });
    let sha = 'old', calls = 0, reloads = 0, refreshes = 0, clock = 100000, hold = null;
    const ctx = { console: { log() {}, warn() {}, error() {} }, AbortController,
        setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimeout() {},
        setInterval: f => { intervals.push(f); return intervals.length; }, clearInterval() {},
        requestAnimationFrame: f => f(), CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        Date: class extends Date { static now() { return clock; } },
        localStorage: { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k), key: i => [...store.keys()][i], get length() { return store.size; } },
        sessionStorage: { getItem: () => { throw Error('unavailable'); }, setItem() {} },
        document: { readyState: 'loading', visibilityState: 'visible', activeElement: null, body: element(), head: element(), documentElement: element(), addEventListener: listen, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: element },
        navigator: { serviceWorker: { controller: {}, addEventListener: listen, getRegistration: async () => ({ update: async () => { refreshes++; }, addEventListener() {} }) } },
        location: { origin: 'https://wf.invalid', reload: () => { reloads++; } },
        addEventListener: listen, dispatchEvent: e => { for (const f of events.get(e.type) || []) f(e); },
        fetch: async () => { calls++; if (hold) await hold; return { ok: true, json: async () => ({ sha }) }; }
    };
    ctx.window = ctx;
    vm.runInNewContext(source, ctx);
    return { ctx, events, timers, intervals, store, setSha: v => { sha=v; }, setTime: v => { clock=v; }, hold: v => { hold=v; }, emit: type => { for(const f of events.get(type)||[]) f(); }, counts: () => ({ calls, reloads, refreshes }) };
}
const richProbe = update.replace('window.wfUpdate = {', 'window.wfUpdate = { _watchServiceWorker, _safeToAutoInstall, _runProgress,');
describe('active sessions survive background deployment events', () => {
    it('stages a deployed SHA without reloading on focus, visibility or controller changes', async () => {
        const h = harness(live); const a = h.ctx.wfLiveUpdate;
        await a._check(); h.setSha('new'); await a._check();
        for(let i=0;i<5;i++) { h.emit('focus'); h.emit('visibilitychange'); h.emit('controllerchange'); await a._check(); }
        expect(a.pendingSha()).toBe('new'); expect(h.counts()).toEqual({ calls: 7, reloads: 0, refreshes: 1 });
    });
    it('coalesces concurrent polls into one request and starts only one timer', async () => {
        const h=harness(live); let release; h.hold(new Promise(r=>{release=r;}));
        const a=h.ctx.wfLiveUpdate, first=a._check(); expect(a._check()).toBe(first);
        a.start(); a.start(); expect(h.intervals).toHaveLength(1); expect(h.counts().calls).toBe(1);
        release(); await first;
    });
    it('does not overwrite the running version label with the remote version', async () => {
        const h=harness(live), label={ textContent:'v7.69.24' }; h.ctx.document.getElementById=()=>label;
        await h.ctx.wfLiveUpdate._check(); expect(label.textContent).toBe('v7.69.24');
    });
    it('ignores stale pending update markers and storage failures on worker activation', async () => {
        const h=harness(richProbe); h.store.set('wf_update_pending','obsolete'); h.ctx.wfUpdate._watchServiceWorker();
        h.emit('controllerchange'); h.ctx.localStorage.getItem=()=>{throw Error('denied');}; h.emit('controllerchange');
        expect(h.counts().reloads).toBe(0);
    });
    it('defers urgent auto-install while working, editing, hidden or in a dialog', () => {
        const h=harness(richProbe), a=h.ctx.wfUpdate; expect(a._safeToAutoInstall()).toBe(false);
        h.setTime(161000); expect(a._safeToAutoInstall()).toBe(true);
        h.emit('input'); expect(a._safeToAutoInstall()).toBe(false);
        h.setTime(222000); h.ctx.document.activeElement={tagName:'INPUT'}; expect(a._safeToAutoInstall()).toBe(false);
        h.ctx.document.activeElement=null; h.ctx.document.visibilityState='hidden'; expect(a._safeToAutoInstall()).toBe(false);
        h.ctx.document.visibilityState='visible'; h.ctx.document.querySelector=()=>({}); expect(a._safeToAutoInstall()).toBe(false);
    });
    it('shares one installation task for simultaneous install requests', async () => {
        const h=harness(richProbe), a=h.ctx.wfUpdate;
        const first=a._runProgress('8.0.0'); expect(a._runProgress('8.0.0')).toBe(first);
        // Release the sole completion delay; no service-worker event can race a reload.
        for(let i=0;i<100 && !h.timers.some(t=>t.ms===700);i++) await Promise.resolve();
        expect(h.timers.some(t=>t.ms===700)).toBe(true);
        for(const t of h.timers.filter(t=>t.ms===700)) t.f();
        await first; expect(h.counts().reloads).toBe(1); h.emit('controllerchange'); expect(h.counts().reloads).toBe(1);
    });
});
