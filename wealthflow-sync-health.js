/* =============================================================================
 * wealthflow-sync-health.js — says out loud when this device's changes have not reached the account   (window.WFSyncHealth)
 * -----------------------------------------------------------------------------
 * WHY. Everything that happens to a change after it is made starts with the upload. The other devices see it only through
 * the copy in the cloud, and the text messages to debtors and tenants are derived on the SERVER from that same copy (sms-events.mjs):
 * a change that never uploads is never texted, whatever the screen says. Reported 2026-10-23: "Settle in full" and "Confirm" on the phone,
 * no text; the same two taps on the laptop, the text arrived. Same Google account, two devices that "work separately".
 *
 * What made that unfindable was that a failed upload was SILENT. The push stores its error in a variable nobody reads, the badge goes back
 * to "Online" a second later, and the retries hang off an edit, a reconnect or a successful server read, so a device whose uploads fail
 * for any reason of its own (a filtered mobile network, a sign-in the account no longer accepts, a record the cloud cannot store, more data than
 * one document can hold) keeps its changes to itself and says nothing. This file is the plain-words half of fixing that:
 *
 *   1. SAY IT.   A tracker of "changes waiting since", "uploads that failed" and why; bannerView() turns it into the notice the page shows,
 *                with the reason in words (explainPushError) and the one thing the person can do.
 *   2. RETRY IT. createRetryLoop() keeps trying with a growing pause until the account has the change. It needs no edit, no reconnect and no
 *                successful read to keep going.
 *   3. FIND IT.  runChecks() / verdict() run the steps an upload needs one by one (our own server, Google's database, the sign-in, a read, a write,
 *                the data itself) and name the first one that fails; inspectPayload() looks at what would be uploaded for what the cloud refuses.
 *
 * Pure: the clock, the timers and the network are passed in. No storage. ESM; window.WFSyncHealth.
 * ===========================================================================*/

export const SYNC = Object.freeze({
    RETRY_MS: Object.freeze([5000, 15000, 45000, 120000]),   // the pause after the 1st, 2nd, 3rd, 4th-and-later failed upload
    SHOW_AFTER_MS: 20000,          // a change still waiting this long is shown even if no upload has failed yet (a normal one takes a few seconds)
    SHOW_AFTER_FAIL_MS: 8000,      // after a failed upload, one retry is given a chance before the notice appears
    CHECK_TIMEOUT_MS: 12000,       // one step of the connection check
    DOC_LIMIT_BYTES: 1048576,      // what one Firestore document can hold
    DOC_WARN_BYTES: 900000,
    MAX_DEPTH: 20,                 // Firestore: a map or list can be nested 20 levels deep
    KEY_LIMIT_BYTES: 1500,
    AUTO_REPAIR_AFTER: 6,          // failed uploads in a row (about ten minutes of trying) before the device repairs its own connection
    AUTO_REPAIR_GAP_MS: 12 * 3600000,   // and at most once in this long
});

const s = (v) => String(v == null ? '' : v);

/** The error code of a rejected upload, without the "firestore/" prefix, or '' when there is none. */
export function codeOf(err) {
    if (err == null) return '';
    const raw = typeof err === 'string' ? err : (err.code || '');
    return s(raw).replace(/^firestore\//, '').slice(0, 60);
}

/**
 * What a failed upload means, in words a person can act on.
 * kind: 'signin' | 'network' | 'busy' | 'quota' | 'data' | 'other'. `retry` is false only when trying the same thing again cannot help.
 */
export function explainPushError(err) {
    const code = codeOf(err);
    const msg = s(err && err.message).toLowerCase();
    const has = (re) => re.test(code) || re.test(msg);
    if (has(/unauthenticated|permission-denied|auth\/|insufficient permissions|id-token|requires-recent-login/)) {
        return { kind: 'signin', retry: true, text: 'Your sign-in is no longer accepted by the account. Sign out and sign in again with the same Google account. Everything on this device is kept.' };
    }
    if (has(/invalid-argument|out-of-range|nested arrays|longer than|exceeds the maximum|unsupported field|invalid data|cannot be written|document size/)) {
        return { kind: 'data', retry: false, text: 'Something on this device is in a shape the account cannot store, or this device holds more than one account document can take. Choose Check Connection to see exactly which.' };
    }
    if (has(/resource-exhausted|quota/)) {
        return { kind: 'quota', retry: true, text: 'The cloud account has reached a usage limit for now. WealthFlow keeps trying.' };
    }
    if (has(/aborted|failed-precondition|already-exists|too much contention|all retries/)) {
        return { kind: 'busy', retry: true, text: 'Another device was saving at the same moment. WealthFlow tries again on its own.' };
    }
    if (has(/unavailable|deadline-exceeded|cancelled|network|offline|failed to fetch|timeout|timed out/)) {
        return { kind: 'network', retry: true, text: 'This device could not reach your cloud account. That is usually a weak or filtered connection, or the connection cache inside this browser being stuck. WealthFlow keeps trying. Check Connection finds which step is stuck and can repair it.' };
    }
    return { kind: 'other', retry: true, text: 'The cloud account did not accept the save. WealthFlow keeps trying.' };
}

/** The pause before the next try, after `failures` failed uploads in a row. */
export function retryDelayMs(failures) {
    const n = Math.max(1, Math.floor(Number(failures) || 1));
    return SYNC.RETRY_MS[Math.min(n, SYNC.RETRY_MS.length) - 1];
}

/* ── 0. the connection mode ───────────────────────────────────────────────── */

/**
 * HOW THIS DEVICE TALKS TO THE ACCOUNT. Firestore's default is a long-lived stream. A stream is what iCloud Private Relay, many VPNs, content blockers and
 * some mobile networks hold up or cut: sign-in and our own server answer (they are ordinary requests) while reading and saving the account time out
 * ("Reading your account did not answer in 12 seconds", code deadline-exceeded; reported 2026-10-23 with Private Relay on). The steady mode is the same
 * account over plain request-and-answer calls (Firestore "long polling"), which every one of those networks lets through. Nothing else changes: same data,
 * same rules, still live across devices.
 *
 *   steady   always on for Safari and every iPhone / iPad browser (WebKit, where Private Relay lives and streams are least reliable),
 *            and on any device where the person chose it (Check Connection offers it).
 *   fast     the default stream everywhere else, which is a little quicker on a clean network.
 *
 * The choice is made before Firestore is first used (the SDK allows no change after that), so a switch is saved and the page reloads.
 */
export const TRANSPORT_KEY = 'wf_fs_transport';

/** Safari (macOS) or any browser on iPhone / iPad: they all run WebKit. Chrome, Edge, Firefox and Opera on desktop or Android are not. */
export function isWebKitFamily(ua, maxTouchPoints = 0) {
    const u = s(ua);
    if (/iPhone|iPad|iPod/.test(u)) return true;
    if (/Macintosh/.test(u) && Number(maxTouchPoints) > 1) return true;      // iPadOS asks for the desktop site
    return /Safari\//.test(u) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|Android|SamsungBrowser/.test(u);
}

/** { steady, why } for this device. `stored` is what the person chose last ('steady', 'fast' or ''). */
export function chooseTransport({ ua = '', maxTouchPoints = 0, stored = '' } = {}) {
    if (stored === 'steady') return { steady: true, why: 'chosen' };
    if (stored === 'fast') return { steady: false, why: 'chosen' };
    if (isWebKitFamily(ua, maxTouchPoints)) return { steady: true, why: 'safari' };
    return { steady: false, why: 'default' };
}

/** The Firestore settings that make a steady connection (merged over the defaults). Auto-detect is switched off because the SDK refuses both together. */
export const STEADY_SETTINGS = Object.freeze({ experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false, merge: true });

/** One line for Check Connection and the report. */
export function transportText(t) {
    const x = t || {};
    if (x.steady) return 'steady' + (x.why === 'safari' ? ' (always on in Safari and on iPhone and iPad)' : x.why === 'chosen' ? ' (chosen on this device)' : '');
    return 'fast' + (x.why === 'chosen' ? ' (chosen on this device)' : '');
}


/* ── 0b. the offline cache ────────────────────────────────────────────────── */

/**
 * Firestore keeps a copy of the account in the browser's own database (IndexedDB) so it can answer offline, and every save goes through a queue kept in
 * that same database. WealthFlow does not need either: the books themselves are kept by the app in this browser's storage and the dirty flag re-uploads
 * them, so the cache is only a convenience. When the browser's database stalls (Safari after a killed tab, a second tab that holds the lead, a quota
 * hit), reads that the live stream already answered still work while every save waits behind the stalled queue and times out, in fast and steady mode
 * alike (reported 2026-10-23 on Safari for Mac: "Saving to your account did not answer in 12 seconds", 69 listener restarts, 4 killed tabs).
 * "Repair connection" clears that cache and runs this device without it ('off'); nothing the person owns is stored only in it.
 */
export const PERSIST_KEY = 'wf_fs_persist';

/** 'off' only when the person (or the repair) turned the offline cache off on this device; anything else is the default, on. */
export function choosePersistence(stored) { return stored === 'off' ? 'off' : 'on'; }

export function persistText(p) { return p === 'off' ? 'off on this device (nothing is lost: your books are kept in this browser and in your account)' : p === 'failed' ? 'could not start in this browser (saving still works without it)' : 'on'; }

/** True when a device that keeps failing to save should repair its own connection now: many failures in a row, of the unreachable kind, not repaired lately. */
export function shouldAutoRepair({ failures = 0, kind = '', lastRepairAt = 0, now = Date.now(), persist = 'on' } = {}) {
    if (persist === 'off') return false;                       // already running without the cache: a repair would change nothing
    if (kind !== 'network') return false;
    if (failures < SYNC.AUTO_REPAIR_AFTER) return false;
    return !lastRepairAt || now - lastRepairAt >= SYNC.AUTO_REPAIR_GAP_MS;
}

/* ── 1. say it ────────────────────────────────────────────────────────────── */

/**
 * What the page should show now. `st` is the tracker's state; `ctx` is { online, signedIn, holding, decoy }.
 * Hidden while nothing is waiting, while a restore holds the sync, and in the duress (decoy) mode, which never uploads.
 */
export function bannerView(st, ctx, now) {
    const c = ctx || {};
    const hidden = { show: false };
    if (!st || !st.dirtySince || c.decoy || c.holding) return hidden;
    const waited = Math.max(0, now - st.dirtySince);
    const failing = st.failures > 0;
    if (!(waited >= SYNC.SHOW_AFTER_MS || (failing && waited >= SYNC.SHOW_AFTER_FAIL_MS))) return hidden;
    const why = failing ? explainPushError({ code: st.code, message: st.message }) : null;
    let reason;
    if (c.signedIn === false) reason = 'You are signed out. Sign in again to save to your account.';
    else if (c.online === false) reason = 'This device has no internet connection right now.';
    else if (why) reason = why.text;
    else reason = 'Saving is taking longer than usual.';
    return {
        show: true,
        tone: c.online === false ? 'wait' : 'problem',
        title: c.online === false ? 'Waiting to save to your account' : 'Not saved to your account yet',
        reason,
        note: 'Your changes are safe on this device. Other devices, and the text messages to your debtors and tenants, only follow once they are saved to your account.',
        code: st.code || '',
        kind: why ? why.kind : 'wait',
        repairable: !!(why && why.kind === 'network' && st.failures >= 3),
        failures: st.failures,
        waitedMs: waited,
    };
}

/** The tracker. `clock` is passed in so a test can move time. */
export function createTracker(clock = Date.now) {
    const st = { dirtySince: 0, failures: 0, code: '', message: '', lastFailAt: 0, lastOkAt: 0 };
    return {
        state: st,
        /** A change is waiting. Idempotent: the first call starts the wait. */
        noteDirty(t = clock()) { if (!st.dirtySince) st.dirtySince = t; },
        /** The account holds everything this device has. */
        noteClean(t = clock()) { st.dirtySince = 0; st.failures = 0; st.code = ''; st.message = ''; st.lastOkAt = t; },
        noteFailure(err, t = clock()) {
            st.failures += 1; st.code = codeOf(err); st.message = s(err && err.message).slice(0, 200); st.lastFailAt = t;
            if (!st.dirtySince) st.dirtySince = t;
        },
        view(ctx, t = clock()) { return bannerView(st, ctx, t); },
    };
}

/* ── 2. retry it ──────────────────────────────────────────────────────────── */

/**
 * Keep trying until nothing is waiting. `attempt()` resolves true when the account has the change; `pending()` says whether anything is still
 * waiting. One attempt at a time; the pause grows after each failure (retryDelayMs) and resets on success.
 */
export function createRetryLoop({ attempt, pending, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let timer = null; let running = false; let failures = 0;
    const loop = {
        get failures() { return failures; },
        get scheduled() { return timer !== null; },
        /** Try again after `ms` (default: the pause for the failures so far). A schedule already waiting is kept, unless `ms` is sooner. */
        schedule(ms) {
            const wait = ms == null ? retryDelayMs(failures || 1) : Math.max(0, ms);
            if (timer !== null) { if (ms == null) return; clearTimer(timer); }
            timer = setTimer(() => { timer = null; loop.run(); }, wait);
        },
        reset() { failures = 0; if (timer !== null) { clearTimer(timer); timer = null; } },
        async run() {
            if (running) return false;
            if (!pending()) { failures = 0; return true; }
            running = true;
            let ok = false;
            try { ok = !!(await attempt()); } catch (_) { ok = false; } finally { running = false; }
            if (ok || !pending()) { failures = 0; return true; }
            failures += 1;
            loop.schedule();
            return false;
        },
    };
    return loop;
}

/* ── 3. find it ───────────────────────────────────────────────────────────── */

/**
 * What would be uploaded, looked at the way the cloud will look at it: [{ path, why }] for each thing it refuses, the size in bytes, and the
 * three largest top-level fields. Does not change the value.
 */
export function inspectPayload(value) {
    const problems = [];
    const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const byteLen = (str) => (enc ? enc.encode(str).length : str.length);
    const walk = (v, path, depth, inList) => {
        if (v === null || typeof v !== 'object') {
            if (typeof v === 'string' && byteLen(v) > SYNC.DOC_LIMIT_BYTES - 89) problems.push({ path, why: 'a text longer than the account allows' });
            return;
        }
        if (depth > SYNC.MAX_DEPTH) { problems.push({ path, why: 'nested more than ' + SYNC.MAX_DEPTH + ' levels deep' }); return; }
        if (Array.isArray(v)) {
            if (inList) { problems.push({ path, why: 'a list inside a list' }); return; }
            v.forEach((x, i) => walk(x, path + '[' + i + ']', depth + 1, true));
            return;
        }
        for (const k of Object.keys(v)) {
            const here = path ? path + '.' + k : k;
            if (k === '') problems.push({ path: here, why: 'an empty field name' });
            else if (/^__.*__$/.test(k)) problems.push({ path: here, why: 'a reserved field name' });
            else if (byteLen(k) > SYNC.KEY_LIMIT_BYTES) problems.push({ path: here.slice(0, 80), why: 'a field name that is too long' });
            walk(v[k], here, depth + 1, false);
            if (problems.length >= 8) return;
        }
    };
    let bytes = 0; const biggest = [];
    try {
        walk(value, '', 0, false);
        bytes = byteLen(JSON.stringify(value) || '');
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const k of Object.keys(value)) biggest.push({ key: k, bytes: byteLen(JSON.stringify(value[k]) || '') });
            biggest.sort((a, b) => b.bytes - a.bytes);
            biggest.length = Math.min(biggest.length, 3);
        }
    } catch (e) { problems.push({ path: '', why: 'could not be read: ' + s(e && e.message).slice(0, 80) }); }
    if (bytes > SYNC.DOC_LIMIT_BYTES) problems.unshift({ path: '', why: 'more than one account document can hold (' + SYNC.DOC_LIMIT_BYTES + ' bytes)' });
    return { bytes, nearLimit: bytes > SYNC.DOC_WARN_BYTES, problems, biggest };
}

const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' did not answer in ' + Math.round(ms / 1000) + ' seconds')), ms))]);

/**
 * Run the steps an upload needs, in order. Each check is { id, label, run }: run() resolves with a short detail, or rejects (or resolves
 * { ok:false, detail }) when the step fails. A step that fails does not stop the ones after it, but each is timed out on its own.
 */
export async function runChecks(checks, { timeoutMs = SYNC.CHECK_TIMEOUT_MS, onStep, clock = Date.now } = {}) {
    const out = [];
    for (const c of checks) {
        const started = clock();
        let row;
        try {
            const r = await withTimeout(Promise.resolve().then(() => c.run()), timeoutMs, c.label);
            const soft = r && typeof r === 'object' && 'ok' in r;
            row = { id: c.id, label: c.label, ok: soft ? r.ok !== false : true, detail: s(soft ? r.detail : r).slice(0, 300) };
        } catch (e) {
            const code = codeOf(e);
            row = { id: c.id, label: c.label, ok: false, detail: (code ? code + ': ' : '') + s(e && e.message).slice(0, 240) };
        }
        row.ms = Math.max(0, clock() - started);
        out.push(row);
        if (typeof onStep === 'function') { try { onStep(row, out.length); } catch (_) { /* a repaint is not the check */ } }
    }
    return out;
}

/* ── SYNC NOW, END TO END ─────────────────────────────────────────────────────────────────────────────────────────────────────
 * "Sync now" is one button for everything that can be out of date: the account (push what waits, pull what the other devices did), what came in
 * from outside the page (the transactions the phone forwarded, the text messages the server owes), and then EVERY screen that shows any of it.
 * Reported 2026-10-29: tapping it in the More sheet opened the AI Financial Advisor instead (the sheet's buttons carried an attribute the advisor
 * treats as a question), and even when it ran it repainted the page in front plus a few figures, not the rest.
 *
 * Each step is { id, label, phase:'data'|'paint', run, when?, first? }:
 *   data  steps fetch or push. A step marked `first` (the account) runs alone first, because what the others read and write is its merged result;
 *         the rest then run together, each with its own deadline, so one that hangs delays nothing else.
 *   paint steps redraw, in order, after every data step has finished, whether or not anything new arrived (a screen that is current on the
 *         day the owner wants to be sure it is current is the point). One that throws does not stop the next.
 * `when()` false (a step that has nothing to do here: no text messages in use, the advisor not in front) is skipped, not failed.
 * Nothing here knows what the steps are: the page lists them.
 */
export const REFRESH = Object.freeze({ STEP_TIMEOUT_MS: 15000 });

/**
 * @returns {Promise<{ok:boolean, rows:{id:string,label:string,phase:string,ok:boolean,skipped:boolean,detail:string,ms:number}[], failed:string[]}>}
 */
export async function runRefresh(steps, { timeoutMs = REFRESH.STEP_TIMEOUT_MS, clock = Date.now, onStep } = {}) {
    const list = (Array.isArray(steps) ? steps : []).filter((x) => x && typeof x.run === 'function');
    const rows = [];
    const one = async (st) => {
        const row = { id: s(st.id), label: s(st.label || st.id), phase: st.phase === 'paint' ? 'paint' : 'data', ok: true, skipped: false, detail: '', ms: 0 };
        const started = clock();
        try {
            if (typeof st.when === 'function' && !st.when()) { row.skipped = true; }
            else {
                const run = Promise.resolve().then(() => st.run());
                const r = await (row.phase === 'paint' ? run : withTimeout(run, timeoutMs, row.label));
                const soft = r && typeof r === 'object' && 'ok' in r;
                if (soft && r.ok === false) { row.ok = false; row.detail = s(r.detail).slice(0, 200); }
                else if (soft && r.detail) row.detail = s(r.detail).slice(0, 200);
            }
        } catch (e) { row.ok = false; row.detail = s(e && e.message).slice(0, 200); }
        row.ms = Math.max(0, clock() - started);
        rows.push(row);
        if (typeof onStep === 'function') { try { onStep(row, rows.length); } catch (_) { /* a repaint is not the refresh */ } }
        return row;
    };
    const data = list.filter((x) => x.phase !== 'paint');
    const first = data.filter((x) => x.first === true);
    const rest = data.filter((x) => x.first !== true);
    for (const st of first) await one(st);
    await Promise.all(rest.map(one));
    for (const st of list.filter((x) => x.phase === 'paint')) await one(st);
    const failed = rows.filter((r) => !r.ok).map((r) => r.label);
    return { ok: failed.length === 0, rows, failed };
}

/** The words for steps that could not finish ('' when all did): the sync itself reports its own result, so this is only for the rest. */
export function refreshNote(result) {
    const bad = ((result && result.rows) || []).filter((r) => !r.ok && r.id !== 'cloud');
    if (!bad.length) return '';
    return 'Synced, but this could not be refreshed just now: ' + bad.map((r) => r.label).join(', ') + '. It will be tried again on its own.';
}

const VERDICTS = Object.freeze({
    server: 'This device cannot reach the WealthFlow server, the one that sends the text messages. Check the connection and try again.',
    google: 'This device cannot reach Google\'s cloud database, where your account is kept. A filtered or unsteady connection is the usual cause. Try Check Connection again in steady mode, or try Wi-Fi.',
    signin: 'Your sign-in could not be renewed. Sign out and sign in again with the same Google account. Everything on this device is kept.',
    read: 'This device reached the cloud but could not read your account from it. The steady connection mode, which Check Connection can switch on, avoids long-lived streams that some networks hold up.',
    write: 'The account refused the save. Sign out and sign in again with the same Google account.',
    silent: 'The account did not answer a save within the time allowed. Reading and sign-in work, so the way in is open; the save itself is stuck. Press Repair connection below: it clears only this browser\'s connection cache, and nothing on this device or in your account is deleted.',
    stuck: 'A save sent directly to your account went through, but the same save sent through this browser\'s own connection did not. So your account and the network are fine, and what is stuck is the saving queue inside this browser (its offline cache). Press Repair connection below: it clears that cache only, and nothing on this device or in your account is deleted.',
    blocked: 'A save sent directly to your account did not go through either, although sign-in and reading did. Something on the network is holding saves back (a filter, VPN, relay or a very weak signal). Try another network, for example mobile data instead of Wi-Fi, then check again.',
    storage: 'This browser\'s own storage did not answer in time, so its saving queue cannot move. Press Repair connection below: it clears the connection cache and, if the browser still will not answer, close every other WealthFlow tab and window and open it once. Nothing on this device or in your account is deleted.',
    data: 'The data on this device cannot be stored as it is. This is the reason changes made here never reach your other devices.',
});

/** One plain sentence for the person: the first step that failed, or "all good". `repair` says the Repair connection button is the answer. */
export function verdict(rows) {
    const list = rows || [];
    const by = (id) => list.find((r) => r.id === id);
    const bad = list.find((r) => !r.ok);
    if (!bad) return { ok: true, text: 'Everything an upload needs is working on this device. If a change still does not show elsewhere, choose Try Again and check again in a minute.' };
    let key = bad.id, repair = false;
    if (bad.id === 'write') {
        const refused = /permission-denied|unauthenticated|not allowed|insufficient/i.test(bad.detail || '');
        const direct = by('direct'), storage = by('storage');
        if (refused) key = 'write';
        else if (storage && !storage.ok) { key = 'storage'; repair = true; }
        else if (direct && direct.ok) { key = 'stuck'; repair = true; }
        else if (direct && !direct.ok) key = 'blocked';
        else { key = 'silent'; repair = true; }
    } else if (bad.id === 'storage') { key = 'storage'; repair = true; }
    else if (bad.id === 'queue') { key = 'silent'; repair = true; }
    return { ok: false, failed: bad.id, repair, text: (VERDICTS[key] || 'One step of the upload failed.') + ' (' + bad.label + ': ' + bad.detail + ')' };
}

/** A plain-text report the person can copy and send. No account id, no token, no data from the books. */
export function reportText(rows, { build = '', online = true, when = new Date(), payload = null, transport = null, persist = null } = {}) {
    const lines = ['WealthFlow connection report', 'Time: ' + when.toISOString(), 'Build: ' + (build || 'n/a'), 'Browser says online: ' + (online ? 'yes' : 'no')];
    if (transport) lines.push('Connection mode: ' + transportText(transport));
    if (persist) lines.push('Offline cache: ' + persistText(persist));
    for (const r of rows || []) lines.push((r.ok ? 'OK     ' : 'FAILED ') + r.label + ' (' + r.ms + ' ms) - ' + r.detail);
    if (payload) {
        lines.push('Data size: ' + payload.bytes + ' bytes' + (payload.nearLimit ? ' (close to the account limit)' : ''));
        for (const b of payload.biggest || []) lines.push('  largest field: ' + b.key + ' ' + b.bytes + ' bytes');
        for (const p of payload.problems || []) lines.push('  cannot store: ' + (p.path || 'the whole document') + ' - ' + p.why);
    }
    lines.push(verdict(rows).text);
    return lines.join('\n');
}

const api = { SYNC, REFRESH, runRefresh, refreshNote, TRANSPORT_KEY, PERSIST_KEY, choosePersistence, persistText, shouldAutoRepair, STEADY_SETTINGS, isWebKitFamily, chooseTransport, transportText, codeOf, explainPushError, retryDelayMs, bannerView, createTracker, createRetryLoop, inspectPayload, runChecks, verdict, reportText };
if (typeof window !== 'undefined') { try { window.WFSyncHealth = api; } catch (_) { /* a frozen window is not an error */ } }

export default api;
