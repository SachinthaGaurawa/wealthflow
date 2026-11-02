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
 *   4. SEND LESS, OVER A PATH THAT CANNOT STALL.  Section "THE ACCOUNT, OVER PLAIN HTTPS" below. The saves, the reads and the "has anything changed?" check
 *                no longer go through the Firestore library's transaction runner and saving queue (see that section for what was proven wrong with them);
 *                they are plain requests with their own deadlines, and a save sends only the fields that differ from the copy the account holds.
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
    if (has(/unavailable|deadline-exceeded|cancelled|network|offline|failed to fetch|load failed|timeout|timed out|did not finish/)) {
        return { kind: 'network', retry: true, text: 'This device could not reach your cloud account in time. That is usually a weak or filtered connection. WealthFlow keeps trying, and sends only what changed. Check Connection finds which step is slow.' };
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
            const r = await withTimeout(Promise.resolve().then(() => c.run()), c.timeoutMs || timeoutMs, c.label);      // a step that sends or receives a lot says how long it may take
            const soft = r && typeof r === 'object' && 'ok' in r;
            row = { id: c.id, label: c.label, ok: soft ? r.ok !== false : true, detail: s(soft ? r.detail : r).slice(0, 300) };
        } catch (e) {
            const code = codeOf(e);
            row = { id: c.id, label: c.label, ok: false, detail: (code ? code + ': ' : '') + s(e && e.message).slice(0, 240) };
        }
        if (c.via) row.via = c.via;
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
 *         the rest then run together, each with its own deadline, so one that hangs delays nothing else; a step marked `last` (the final save) runs
 *         alone after them, because what they brought in (transactions from the phone, a device record) is only on this device until it is pushed.
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
    const last = data.filter((x) => x.last === true && x.first !== true);
    const rest = data.filter((x) => x.first !== true && x.last !== true);
    for (const st of first) await one(st);
    await Promise.all(rest.map(one));
    for (const st of last) await one(st);                                                   // after everything that can change the books, before anything is redrawn
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
    httpsRead: 'This device reached Google but reading your account did not finish. The read is one plain secure request, so something on the way is holding it up: a very weak signal, or a filter. Try another network, for example mobile data instead of Wi-Fi, then check again. Nothing on this device is lost, and it keeps trying on its own.',
    httpsWrite: 'This device reached Google and read your account, but saving to it did not finish. A save sends only what changed, as one plain secure request, so something on the way is holding it up: a very weak signal, or a filter. Try another network, for example mobile data instead of Wi-Fi, then check again. Nothing on this device is lost, and it keeps trying on its own.',
    data: 'The data on this device cannot be stored as it is. This is the reason changes made here never reach your other devices.',
});

/** One plain sentence for the person: the first step that failed, or "all good". `repair` says the Repair connection button is the answer. */
export function verdict(rows) {
    const list = rows || [];
    const by = (id) => list.find((r) => r.id === id);
    const bad = list.find((r) => !r.ok);
    if (!bad) return { ok: true, text: 'Everything an upload needs is working on this device. If a change still does not show elsewhere, choose Try Again and check again in a minute.' };
    let key = bad.id, repair = false;
    if (bad.via === 'https') {
        // Saves and reads no longer pass through this browser's own connection library, so there is no stuck queue of it to repair.
        const refused = /permission-denied|unauthenticated|not allowed|insufficient/i.test(bad.detail || '');
        key = bad.id === 'read' ? (refused ? 'signin' : 'httpsRead') : (refused ? 'write' : 'httpsWrite');
    } else if (bad.id === 'write') {
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
/** One line for the report: what the last save, read and "has anything changed?" check took, from createCloudSync().state.last. */
export function savesText(last) {
    const l = last || {};
    const part = (x, name) => x ? name + ' ' + Math.round((x.bytes || 0) / 1024) + ' KB in ' + (x.ms || 0) + ' ms' : name + ' none yet';
    return 'plain secure requests; ' + [part(l.write, 'last save'), part(l.read, 'last read'), part(l.probe, 'last check')].join('; ');
}

export function reportText(rows, { build = '', online = true, when = new Date(), payload = null, transport = null, persist = null, saves = null } = {}) {
    const lines = ['WealthFlow connection report', 'Time: ' + when.toISOString(), 'Build: ' + (build || 'n/a'), 'Browser says online: ' + (online ? 'yes' : 'no')];
    if (transport) lines.push('Connection mode: ' + transportText(transport));
    if (persist) lines.push('Offline cache: ' + persistText(persist));
    if (saves) lines.push('Saves: ' + savesText(saves));
    for (const r of rows || []) lines.push((r.ok ? 'OK     ' : 'FAILED ') + r.label + ' (' + r.ms + ' ms) - ' + r.detail);
    if (payload) {
        lines.push('Data size: ' + payload.bytes + ' bytes' + (payload.nearLimit ? ' (close to the account limit)' : ''));
        for (const b of payload.biggest || []) lines.push('  largest field: ' + b.key + ' ' + b.bytes + ' bytes');
        for (const p of payload.problems || []) lines.push('  cannot store: ' + (p.path || 'the whole document') + ' - ' + p.why);
    }
    lines.push(verdict(rows).text);
    return lines.join('\n');
}

/* ── 4. THE ACCOUNT, OVER PLAIN HTTPS ─────────────────────────────────────────────────────────────────────────────────────────
 * Reported again 2026-11-02, after #475, #476, #480 and #482 had each treated a symptom: on the owner's Mac (Safari 17.6) "Reading your account" and "Saving
 * to your account" both ended at 12 seconds with deadline-exceeded, in the fast and the steady mode, with the offline cache already off, while a save sent
 * straight to the account with the sign-in token went through in 1.2 seconds. The account, the network and the sign-in were fine; what failed was the way
 * the page used the Firestore library, and the size of what it sent through it. Two things are proven, one is a strong inference:
 *
 *   PROVEN (read in the library's own source, firebase 10.8.0, and matched to the stack in the owner's diagnostics: "INTERNAL ASSERTION FAILED: Unexpected state"
 *   twice, at transaction_runner.ts line 124 through isPermanentError):
 *     a. runTransaction treats an error as retryable only if its code is a Firestore code; any other code (every sign-in library error, "auth/network-request-failed"
 *        and the like, passes through with the name FirebaseError) makes the library's own error handler THROW, and the transaction's promise is then never settled.
 *        That is why the page needed a 30 s stopwatch around it. When the throw happens in the commit step it also fails the library's single work queue for good
 *        (async_queue_impl.ts: the queue's tail becomes a rejected promise), so every later read, save and listener restart of that page waits forever.
 *     b. Every save was a transaction that read the WHOLE account document and wrote the WHOLE document back (the owner's is 786 KB, about 1.5 MB in Firestore's wire
 *        format, and uploads are not compressed), even to record that a session was still open. The heartbeat alone did that every five minutes.
 *   INFERRED (not provable without the device): on a slow or high-latency uplink the whole-document upload is what runs past any deadline, and everything else the
 *        page asks of the library in the meantime queues behind it. The small direct save in the owner's report is the one thing that was fast.
 *
 * So the page now talks to the account the way that probe did: ordinary requests (documents:batchGet and documents:commit) with the sign-in token, each with its
 * own deadline sized to what it sends, and nothing in between that can hang. A save sends ONLY the top-level fields that differ from the copy the account held when
 * this device last read it, guarded by that copy's version, so two devices saving at once cannot overwrite each other: the second is refused, reads the newer copy,
 * merges it with the same function as always and tries again. A "has anything changed?" check asks for the version only (a few hundred bytes), so the full document
 * is read when it has changed, not every twenty seconds. The live stream stays as the quick way to hear about changes; nothing depends on it.
 *
 * The data model is untouched: the same document, the same fields, the same merge (index.html _wfApplyCloudData), so the server code that reads and writes it
 * (statement worker, text messages, backups) needs no change.
 */
export const REST = Object.freeze({
    HOST: 'https://firestore.googleapis.com',
    PROBE_TIMEOUT_MS: 15000,      // "has anything changed?" (the version only, a few hundred bytes back)
    READ_TIMEOUT_MS: 45000,       // the whole account document coming down
    WRITE_BASE_MS: 20000,         // a save gets this long ...
    WRITE_MS_PER_KB: 1000,        // ... plus a second per KB it sends (a floor of 1 KB/s, which a very weak link still beats)
    WRITE_MAX_MS: 120000,
    MAX_ATTEMPTS: 5,              // a save whose base copy moved is read again and redone this many times
    TOKEN_TIMEOUT_MS: 20000,      // renewing the sign-in token (it is a request of its own and can hang like any other)
    PRECHECK_BYTES: 40000,        // a save bigger than this first asks "is the account still the copy I merged?" (a few hundred bytes), so a megabyte is never sent to be refused
    META_KEYS: Object.freeze(['_lastModified', '_lastModifiedBy', '_writeDeviceId', '_writeTs']),   // written by every save, never compared
});

/** How long a save of `bytes` may take before it is given up on and retried. */
export function writeTimeoutMs(bytes) {
    const kb = Math.max(0, Number(bytes) || 0) / 1024;
    return Math.min(REST.WRITE_MAX_MS, Math.round(REST.WRITE_BASE_MS + kb * REST.WRITE_MS_PER_KB));
}

/* Firestore's JSON value format: {"stringValue": ...}, {"integerValue": "12"} ... It is what the library itself sends over this endpoint. */
const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Set an own property even when the name is "__proto__" (a plain assignment would change the object's prototype and silently drop the key from what is saved or read). */
function setOwn(obj, key, value) { Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true }); }

export function toValue(v, depth = 0) {
    if (depth > 60) throw new TypeError('nested too deeply to store');
    if (v === null || v === undefined) return { nullValue: 'NULL_VALUE' };
    switch (typeof v) {
        case 'boolean': return { booleanValue: v };
        case 'string': return { stringValue: v };
        case 'number':
            if (Number.isSafeInteger(v) && !Object.is(v, -0)) return { integerValue: String(v) };
            if (Number.isNaN(v)) return { doubleValue: 'NaN' };
            if (v === Infinity) return { doubleValue: 'Infinity' };
            if (v === -Infinity) return { doubleValue: '-Infinity' };
            return { doubleValue: v };
        case 'object': break;
        default: throw new TypeError('a ' + typeof v + ' cannot be stored');
    }
    if (v instanceof Date) { if (Number.isNaN(v.getTime())) throw new TypeError('an invalid date cannot be stored'); return { timestampValue: v.toISOString() }; }
    if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map((x) => toValue(x, depth + 1)) } : {} };
    if (typeof v.toDate === 'function') { const d = v.toDate(); if (d instanceof Date && !Number.isNaN(d.getTime())) return { timestampValue: d.toISOString() }; }
    if (!isPlainObj(v)) throw new TypeError('this kind of object cannot be stored');
    const fields = toFields(v, depth + 1);
    return { mapValue: Object.keys(fields).length ? { fields } : {} };
}

/** An object's own fields as Firestore fields. A field whose value is undefined or a function is left out, as the library leaves it out. */
export function toFields(obj, depth = 0) {
    const out = {};
    for (const k of Object.keys(obj || {})) {
        const x = obj[k];
        if (x === undefined || typeof x === 'function') continue;
        setOwn(out, k, toValue(x, depth + 1));
    }
    return out;
}

function parseTimestamp(t) {
    const d = new Date(String(t).replace(/(\.\d{3})\d+/, '$1'));   // Safari is not guaranteed to read more than milliseconds
    return Number.isNaN(d.getTime()) ? null : d;
}

export function fromValue(x) {
    if (x == null || typeof x !== 'object') return null;
    if ('stringValue' in x) return String(x.stringValue);
    if ('integerValue' in x) return Number(x.integerValue);
    if ('doubleValue' in x) {
        const d = x.doubleValue;
        if (typeof d === 'string') return d === 'NaN' ? NaN : d === 'Infinity' ? Infinity : d === '-Infinity' ? -Infinity : Number(d);
        return d;
    }
    if ('booleanValue' in x) return !!x.booleanValue;
    if ('nullValue' in x) return null;
    if ('timestampValue' in x) return parseTimestamp(x.timestampValue);
    if ('arrayValue' in x) return ((x.arrayValue && x.arrayValue.values) || []).map(fromValue);
    if ('mapValue' in x) return fromFields(x.mapValue && x.mapValue.fields);
    if ('referenceValue' in x) return String(x.referenceValue);
    if ('bytesValue' in x) return String(x.bytesValue);
    if ('geoPointValue' in x) return { latitude: Number(x.geoPointValue && x.geoPointValue.latitude) || 0, longitude: Number(x.geoPointValue && x.geoPointValue.longitude) || 0 };
    return null;
}

export function fromFields(fields) {
    const out = {};
    if (fields && typeof fields === 'object') for (const k of Object.keys(fields)) setOwn(out, k, fromValue(fields[k]));
    return out;
}

/** A field path for the update mask: plain names as they are, anything else in backticks (Firestore's own rule). */
export function fieldPath(segments) {
    return (Array.isArray(segments) ? segments : [segments]).map((p) => {
        const t = String(p);
        return /^[A-Za-z_][A-Za-z_0-9]*$/.test(t) ? t : '`' + t.replace(/\\/g, '\\\\').replace(/`/g, '\\`') + '`';
    }).join('.');
}

/* What "the same value" means, for deciding what to send: the same content whatever the order of a map's keys (Firestore hands maps back sorted). */
export function canonical(v) {
    if (v === null || v === undefined) return 'null';
    switch (typeof v) {
        case 'boolean': return v ? 'true' : 'false';
        case 'number': return Number.isFinite(v) ? String(v) : '"' + String(v) + '"';
        case 'string': return JSON.stringify(v);
        case 'object': break;
        default: return 'null';
    }
    if (v instanceof Date) return '"@' + v.getTime() + '"';
    if (Array.isArray(v)) { let o = '['; for (let i = 0; i < v.length; i++) o += (i ? ',' : '') + canonical(v[i]); return o + ']'; }
    const ks = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
    let o = '{'; for (let i = 0; i < ks.length; i++) o += (i ? ',' : '') + JSON.stringify(ks[i]) + ':' + canonical(v[ks[i]]);
    return o + '}';
}

/** A short fingerprint of a value (53-bit cyrb53 over its canonical text, plus its length). Equal values give equal fingerprints; collisions are ~1 in 10^15. */
export function hashOf(v) {
    const str = canonical(v);
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return str.length.toString(36) + ':' + (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function hashesOf(obj) {
    const out = {};
    for (const k of Object.keys(obj || {})) if (obj[k] !== undefined && typeof obj[k] !== 'function') setOwn(out, k, hashOf(obj[k]));
    return out;
}

/** The top-level fields of `local` whose content differs from what the account holds (`hashes`, from hashesOf the account's copy). Fields only the account has are left alone. */
export function diffKeys(local, hashes) {
    const h = hashes || {};
    return Object.keys(local || {}).filter((k) => local[k] !== undefined && typeof local[k] !== 'function' && REST.META_KEYS.indexOf(k) === -1 && hashOf(local[k]) !== h[k]);
}

/** Two update times from the account are the same moment even if one is written with trailing zeros the other leaves off. */
export function sameTime(a, b) {
    if (!a || !b) return false;
    const n = (t) => String(t).replace(/(\.\d*?)0+Z$/, '$1Z').replace(/\.Z$/, 'Z');
    return n(a) === n(b);
}

const HTTP_CODES = { 400: 'invalid-argument', 401: 'unauthenticated', 403: 'permission-denied', 404: 'not-found', 409: 'aborted', 412: 'failed-precondition', 429: 'resource-exhausted', 499: 'cancelled', 500: 'internal', 501: 'unimplemented', 502: 'unavailable', 503: 'unavailable', 504: 'deadline-exceeded' };
const STATUS_CODES = { INVALID_ARGUMENT: 'invalid-argument', FAILED_PRECONDITION: 'failed-precondition', NOT_FOUND: 'not-found', ALREADY_EXISTS: 'already-exists', PERMISSION_DENIED: 'permission-denied', UNAUTHENTICATED: 'unauthenticated', RESOURCE_EXHAUSTED: 'resource-exhausted', ABORTED: 'aborted', UNAVAILABLE: 'unavailable', DEADLINE_EXCEEDED: 'deadline-exceeded', INTERNAL: 'internal', CANCELLED: 'cancelled', OUT_OF_RANGE: 'out-of-range', UNIMPLEMENTED: 'unimplemented', DATA_LOSS: 'data-loss', UNKNOWN: 'unknown' };

/** An error answer from the account as an Error with a Firestore-style `code`, so explainPushError reads it like any other. */
export function restError(status, body) {
    const first = Array.isArray(body) ? body.find((x) => x && x.error) : body;
    const e = (first && first.error) || {};
    const err = new Error(String(e.message || ('the account answered ' + status)).slice(0, 300));
    err.code = STATUS_CODES[e.status] || HTTP_CODES[status] || 'unknown';
    err.status = status;
    return err;
}

/** `p`, or a deadline-exceeded error (network:true) if it is not settled in `ms`. Never leaves a timer behind. */
function withinMs(p, ms, what, setT = setTimeout, clearT = clearTimeout) {
    let t;
    const stop = new Promise((_, rej) => { t = setT(() => rej(Object.assign(new Error('The ' + what + ' did not finish in ' + Math.round(ms / 1000) + ' seconds.'), { code: 'deadline-exceeded', network: true })), ms); });
    return Promise.race([p, stop]).finally(() => clearT(t));
}

/** A request that never got an answer: a dropped connection, a blocked request, or the deadline. */
function noAnswer(e, timedOut, what, ms) {
    if (timedOut) return Object.assign(new Error('The ' + what + ' did not finish in ' + Math.round(ms / 1000) + ' seconds.'), { code: 'deadline-exceeded', network: true });
    return Object.assign(new Error(s(e && e.message) || 'Failed to fetch'), { code: 'unavailable', network: true });
}

/**
 * The account over plain requests. `getToken(force)` resolves the sign-in token (force = renew it); `fetchImpl` is fetch. Every request has its own deadline; a
 * 401 renews the token once and asks again. Nothing here keeps state, a queue or a connection.
 *   readDoc(path, { maskPaths? })            -> { exists, data, updateTime, bytes, ms }      (maskPaths: only those top-level fields come back; updateTime always does)
 *   commit(path, { fields, meta, serverTime, precondition, timeoutMs? }) -> { updateTime, bytes, ms }   (fields: written, every other field left as it is)
 */
/** The size of a text as it travels: UTF-8 bytes, not UTF-16 code units (Sinhala is three bytes a letter, so a character count would give a save far too little time). */
export function utf8Len(str) {
    const t = String(str);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(t).length;
    try { return unescape(encodeURIComponent(t)).length; } catch (_) { return t.length; }
}

export function createRestClient({ projectId, getToken, fetchImpl, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    if (!projectId) throw new Error('the project is not known');
    const base = REST.HOST + '/v1/projects/' + encodeURIComponent(projectId) + '/databases/(default)/documents';
    const nameOf = (path) => 'projects/' + projectId + '/databases/(default)/documents/' + path;
    async function call(suffix, bodyText, timeoutMs, what) {
        for (let pass = 0; pass < 2; pass++) {
            let token;
            try { token = await withinMs(Promise.resolve().then(() => getToken(pass > 0)), REST.TOKEN_TIMEOUT_MS, 'sign-in', setTimer, clearTimer); }
            catch (e) {
                if (e && e.network) throw e;
                // the sign-in library reports a dead network as an auth error; it is the network, not the sign-in
                if (/network|timeout|timed out|unavailable|failed to fetch|load failed/i.test(String((e && e.code) || '') + ' ' + String((e && e.message) || ''))) throw noAnswer(e, false, 'sign-in', 0);
                throw e;
            }
            const ctl = typeof AbortController === 'function' ? new AbortController() : null;
            let timedOut = false, timer = null;
            const deadline = new Promise((_, rej) => { timer = setTimer(() => { timedOut = true; try { if (ctl) ctl.abort(); } catch (_) { /* already over */ } rej(new Error('deadline')); }, timeoutMs); });
            const t0 = now();
            try {
                // text/plain keeps this a request the browser sends without a separate permission round trip for the body; the sign-in token is in the header.
                const resp = await Promise.race([fetchImpl(base + suffix + '?prettyPrint=false', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'text/plain' }, body: bodyText, cache: 'no-store', signal: ctl ? ctl.signal : undefined }), deadline]);
                const text = await Promise.race([resp.text(), deadline]);
                let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) { /* an unreadable body is reported below */ }
                if (!resp.ok) { if (resp.status === 401 && pass === 0) continue; throw restError(resp.status, json); }
                return { json, bytes: utf8Len(bodyText), received: utf8Len(text), ms: Math.max(0, now() - t0) };
            } catch (e) {
                if (e && e.code) throw e;
                throw noAnswer(e, timedOut, what, timeoutMs);
            } finally { if (timer !== null) clearTimer(timer); }
        }
        throw Object.assign(new Error('the sign-in was refused twice'), { code: 'unauthenticated' });
    }
    return {
        async readDoc(path, { maskPaths = null, timeoutMs = 0 } = {}) {
            const body = { documents: [nameOf(path)] };
            if (maskPaths) body.mask = { fieldPaths: maskPaths.map((p) => fieldPath([p])) };
            const r = await call(':batchGet', JSON.stringify(body), timeoutMs || (maskPaths ? REST.PROBE_TIMEOUT_MS : REST.READ_TIMEOUT_MS), 'read');
            const hit = (Array.isArray(r.json) ? r.json : [r.json]).find((x) => x && (x.found || x.missing));
            if (!hit) throw Object.assign(new Error('the account answered with something that could not be read'), { code: 'unavailable', network: true });
            if (hit.missing) return { exists: false, data: null, updateTime: null, bytes: r.received, ms: r.ms };
            return { exists: true, data: fromFields(hit.found.fields), updateTime: hit.found.updateTime || null, bytes: r.received, ms: r.ms };
        },
        async commit(path, { fields = {}, meta = {}, serverTime = [], precondition = null, timeoutMs = 0 } = {}) {
            const all = Object.assign({}, fields, meta);
            const write = { update: { name: nameOf(path), fields: toFields(all) }, updateMask: { fieldPaths: Object.keys(all).filter((k) => all[k] !== undefined).map((k) => fieldPath([k])) } };
            if (serverTime.length) write.updateTransforms = serverTime.map((f) => ({ fieldPath: fieldPath([f]), setToServerValue: 'REQUEST_TIME' }));
            if (precondition) write.currentDocument = precondition;
            const text = JSON.stringify({ writes: [write] });
            const r = await call(':commit', text, timeoutMs || writeTimeoutMs(utf8Len(text)), 'save');
            const wr = r.json && Array.isArray(r.json.writeResults) ? r.json.writeResults[0] : null;
            return { updateTime: (wr && wr.updateTime) || null, bytes: r.bytes, ms: r.ms };
        },
    };
}

/** A save that lost to another writer: the base copy moved (or appeared, or vanished) between this device's read and its save. Not a failure; read again and redo. */
export function isConflict(err) {
    const c = codeOf(err);
    return c === 'failed-precondition' || c === 'aborted' || c === 'already-exists' || c === 'not-found';
}

/**
 * One account document, kept in step. Holds, in memory only, which version of the document this device last merged and a fingerprint of each field as the
 * account holds it. Everything runs one at a time (a save and a read never interleave), so that state cannot be torn.
 *
 *   pull({ apply, force })   Has the account changed since this device last merged it? (a version-only request) If so, read it all and hand it to apply(data),
 *                            the page's merge. force skips the question. -> { changed, exists, bytes, ms, probeMs }
 *   push({ apply, getLocal, meta, onPlan })
 *                            Make the account hold what this device holds, sending only the fields that differ. apply(data) merges a newer copy into this
 *                            device (it is called whenever a copy is read); getLocal() is this device's whole data, taken AFTER that merge; meta() is the stamp
 *                            fields written with every save. -> { keys, bytes, ms, attempts, upToDate }
 *   read()                   Read the whole document without merging it (the first read at sign-in, which the page merges itself, then adopt()s).
 *                            -> { exists, data, updateTime, hashes, bytes, ms }
 *   adopt({ hashes, updateTime })  The page read the document itself (at sign-in) and merged it; remember that.
 *   forget()                 The account may have moved: the next pull or push reads it first.
 *
 * Why this cannot lose another device's work: a save is accepted only if the document is still exactly the version this device merged (`currentDocument.updateTime`).
 * If anything wrote in between (another device, the statement worker, the text-message service) the account refuses, this device reads the newer copy, merges it
 * with the page's one convergent function and saves again. The fields it sends are whole top-level fields (a list or a map is replaced as a whole, which is also
 * what makes a deleted key really disappear from the account), and every one of them was merged with the exact version being replaced.
 */
export function createCloudSync({ client, path, now = Date.now } = {}) {
    const st = { ver: null, hashes: {}, last: { read: null, probe: null, write: null } };
    let tail = Promise.resolve();
    const locked = (fn) => { const run = tail.then(fn); tail = run.then(() => { }, () => { }); return run; };
    const probe = async () => {
        const p = await client.readDoc(path, { maskPaths: ['_writeTs'] });
        st.last.probe = { at: now(), ms: p.ms, bytes: p.bytes };
        return p;
    };

    async function readAndApply(apply) {
        const r = await client.readDoc(path);
        st.last.read = { at: now(), ms: r.ms, bytes: r.bytes, exists: r.exists };
        if (r.exists) {
            const hashes = hashesOf(r.data);          // before apply: the merge may hand parts of this object to the page
            apply(r.data);
            st.hashes = hashes; st.ver = r.updateTime || null;
        } else { st.hashes = {}; st.ver = 'missing'; }
        return r;
    }

    return {
        state: st,
        forget() { st.ver = null; st.hashes = {}; },
        adopt({ hashes, updateTime } = {}) { st.hashes = hashes || {}; st.ver = updateTime || null; },
        read() {
            return locked(async () => {
                const r = await client.readDoc(path);
                st.last.read = { at: now(), ms: r.ms, bytes: r.bytes, exists: r.exists };
                return { exists: r.exists, data: r.data, updateTime: r.updateTime, hashes: r.exists ? hashesOf(r.data) : {}, bytes: r.bytes, ms: r.ms };
            });
        },
        pull({ apply, force = false } = {}) {
            return locked(async () => {
                let probeMs = 0;
                if (!force && st.ver && st.ver !== 'missing') {
                    const p = await probe();
                    probeMs = p.ms;
                    if (p.exists && sameTime(p.updateTime, st.ver)) return { changed: false, exists: true, bytes: p.bytes, ms: p.ms, probeMs };
                }
                const r = await readAndApply(apply);
                return { changed: true, exists: r.exists, bytes: r.bytes, ms: r.ms, probeMs };
            });
        },
        push({ apply, getLocal, meta = () => ({}) } = {}) {
            return locked(async () => {
                const t0 = now();
                for (let attempt = 1; attempt <= REST.MAX_ATTEMPTS; attempt++) {
                    if (!st.ver) await readAndApply(apply);
                    const local = getLocal();
                    const keys = diffKeys(local, st.hashes);
                    if (!keys.length) return { keys: [], bytes: 0, ms: Math.max(0, now() - t0), attempts: attempt, upToDate: true };
                    const fields = {}; let size = 0;
                    keys.forEach((k) => { setOwn(fields, k, local[k]); size += utf8Len(canonical(local[k])); });
                    if (size > REST.PRECHECK_BYTES) {
                        // A big save first confirms the account is still the copy that was merged: a few hundred bytes now, instead of a megabyte sent and refused.
                        const p = await probe();
                        const moved = st.ver === 'missing' ? p.exists : (!p.exists || !sameTime(p.updateTime, st.ver));
                        if (moved) { st.ver = null; continue; }
                    }
                    let res;
                    try {
                        res = await client.commit(path, { fields, meta: meta(), serverTime: ['_lastModified'], precondition: st.ver === 'missing' ? { exists: false } : { updateTime: st.ver } });
                    } catch (e) {
                        if (isConflict(e)) { st.ver = null; continue; }
                        throw e;
                    }
                    keys.forEach((k) => { setOwn(st.hashes, k, hashOf(local[k])); });
                    st.ver = res.updateTime || null;
                    st.last.write = { at: now(), ms: res.ms, bytes: res.bytes, keys: keys.slice(0, 12) };
                    return { keys, bytes: res.bytes, ms: Math.max(0, now() - t0), attempts: attempt, upToDate: false };
                }
                throw Object.assign(new Error('Another device kept saving at the same moment, so this save was tried again several times.'), { code: 'aborted' });
            });
        },
        /** What a save would send right now, for the connection report: { known, keys, bytes }. */
        plan(local) {
            if (!st.ver) return { known: false, keys: [], bytes: 0 };
            const keys = diffKeys(local, st.hashes);
            let bytes = 0; keys.forEach((k) => { bytes += utf8Len(canonical(local[k])); });
            return { known: true, keys, bytes };
        },
    };
}

const api = { SYNC, REFRESH, REST, utf8Len, runRefresh, refreshNote, TRANSPORT_KEY, PERSIST_KEY, choosePersistence, persistText, shouldAutoRepair, STEADY_SETTINGS, isWebKitFamily, chooseTransport, transportText, codeOf, explainPushError, retryDelayMs, bannerView, createTracker, createRetryLoop, inspectPayload, runChecks, verdict, reportText, savesText, writeTimeoutMs, toValue, toFields, fromValue, fromFields, fieldPath, canonical, hashOf, hashesOf, diffKeys, restError, sameTime, createRestClient, isConflict, createCloudSync };
if (typeof window !== 'undefined') { try { window.WFSyncHealth = api; } catch (_) { /* a frozen window is not an error */ } }

export default api;
