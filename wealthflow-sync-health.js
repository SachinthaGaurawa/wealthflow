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
        return { kind: 'network', retry: true, text: 'This device could not reach your cloud account. That is usually a weak or filtered connection (a VPN, private relay or content blocker can cause it). WealthFlow keeps trying.' };
    }
    return { kind: 'other', retry: true, text: 'The cloud account did not accept the save. WealthFlow keeps trying.' };
}

/** The pause before the next try, after `failures` failed uploads in a row. */
export function retryDelayMs(failures) {
    const n = Math.max(1, Math.floor(Number(failures) || 1));
    return SYNC.RETRY_MS[Math.min(n, SYNC.RETRY_MS.length) - 1];
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

const VERDICTS = Object.freeze({
    server: 'This device cannot reach the WealthFlow server, the one that sends the text messages. Check the connection, and switch off any VPN, private relay or content blocker for this site.',
    google: 'This device cannot reach Google\'s cloud database, where your account is kept. A VPN, private relay, content blocker or a filtered mobile network is the usual cause. Try Wi-Fi, or switch the blocker off for this site.',
    signin: 'Your sign-in could not be renewed. Sign out and sign in again with the same Google account. Everything on this device is kept.',
    read: 'This device reached the cloud but could not read your account from it.',
    write: 'This device reached the cloud and can read your account but was not allowed to save to it. Sign out and sign in again with the same Google account.',
    data: 'The data on this device cannot be stored as it is. This is the reason changes made here never reach your other devices.',
});

/** One plain sentence for the person: the first step that failed, or "all good". */
export function verdict(rows) {
    const bad = (rows || []).find((r) => !r.ok);
    if (!bad) return { ok: true, text: 'Everything an upload needs is working on this device. If a change still does not show elsewhere, choose Try Again and check again in a minute.' };
    return { ok: false, failed: bad.id, text: (VERDICTS[bad.id] || 'One step of the upload failed.') + ' (' + bad.label + ': ' + bad.detail + ')' };
}

/** A plain-text report the person can copy and send. No account id, no token, no data from the books. */
export function reportText(rows, { build = '', online = true, when = new Date(), payload = null } = {}) {
    const lines = ['WealthFlow connection report', 'Time: ' + when.toISOString(), 'Build: ' + (build || 'n/a'), 'Browser says online: ' + (online ? 'yes' : 'no')];
    for (const r of rows || []) lines.push((r.ok ? 'OK     ' : 'FAILED ') + r.label + ' (' + r.ms + ' ms) - ' + r.detail);
    if (payload) {
        lines.push('Data size: ' + payload.bytes + ' bytes' + (payload.nearLimit ? ' (close to the account limit)' : ''));
        for (const b of payload.biggest || []) lines.push('  largest field: ' + b.key + ' ' + b.bytes + ' bytes');
        for (const p of payload.problems || []) lines.push('  cannot store: ' + (p.path || 'the whole document') + ' - ' + p.why);
    }
    lines.push(verdict(rows).text);
    return lines.join('\n');
}

const api = { SYNC, codeOf, explainPushError, retryDelayMs, bannerView, createTracker, createRetryLoop, inspectPayload, runChecks, verdict, reportText };
if (typeof window !== 'undefined') { try { window.WFSyncHealth = api; } catch (_) { /* a frozen window is not an error */ } }

export default api;
