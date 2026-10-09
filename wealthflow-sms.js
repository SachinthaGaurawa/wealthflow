/* =============================================================================
 * wealthflow-sms.js — the page's side of the tenant text messages
 * -----------------------------------------------------------------------------
 * The server decides what is owed and sends it (sms-events.mjs / sms-engine.mjs): the
 * books are the source of truth, and nothing a page says can name a recipient, an
 * amount or a word. So this file has four small jobs and no authority:
 *
 *   1. THE SWITCH. A persistent boolean `sms_notifications_enabled` on the record, the
 *      phone number it is for, the tenant's NIC (for the statement link), and the moment
 *      it was switched on (`sms_enabled_at`), which is what keeps the past from being
 *      announced as news. applyToggle() validates and returns exactly the fields to merge.
 *   2. THE NUDGE. After a push to the cloud, if what the server cares about has changed
 *      (signatureOf), ask it to look again (/api/sms-notify). Debounced, retried with
 *      backoff, quiet when the account is not allowed to send. Missing a nudge loses
 *      nothing: the daily sweep derives the same notices from the books.
 *   3. THE ALERT. A realtime listener on users/{uid}/smsLog, the server-written mirror of
 *      the ledger, shows "Admin Alert: SMS Delivered Successfully to Tenant" when a
 *      notice goes out, once per message, and a quiet summary after time away.
 *   4. THE LOG. A panel of what was sent, what is waiting and why, and what cannot work.
 *
 * Nothing here throws into the app: a failure of any of it is a quieter page, never a
 * broken one. ESM; window.WFSms.
 * ===========================================================================*/

import { normalizePhone } from './wealthflow-phone.js';
import { phoneProblem as phoneText, idProblem, storedId, idKindOf } from './wealthflow-people.js';

/** The record fields. The server reads the same ten; a test pins that they agree (sms-events.mjs FIELDS). */
export const SMS_FIELDS = Object.freeze({
    ENABLED: 'sms_notifications_enabled',
    ENABLED_AT: 'sms_enabled_at',
    PHONE: 'phone',
    PHONE2: 'phone2',
    PHONE2_AT: 'phone2_at',
    CLOSED_AT: 'closedAt',
    NIC: 'nic',
    REQUESTS: 'sms_requests',
    REMIND: 'sms_remind_late',
    REMIND_AT: 'sms_remind_at',
});

export const CLIENT = Object.freeze({
    ENDPOINT: '/api/sms-notify',
    DEBOUNCE_MS: 2500,
    THROTTLE_RETRY_MS: 7000,                 // the server holds kicks closer together than 6 s
    RETRY_MS: Object.freeze([8000, 40000, 180000]),
    OPEN_DELAY_MS: 6000,                     // after the page opens, once the cloud copy has had time to land
    DRAIN_MS: 10 * 60000,                    // while the page is open and something is waiting
    MAX_DRAINS: 12,
    FETCH_TIMEOUT_MS: 25000,
    LOG_LIMIT: 40,
    MAX_TOASTS: 3,
});

const s = (v) => String(v == null ? '' : v);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const esc = (v) => s(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const safeStorage = (st, fn) => { try { return fn(st); } catch (_) { return null; } };

/* ── 1. the switch ────────────────────────────────────────────────────────── */

export const phoneProblem = (reason) => phoneText(reason);
export const nicProblem = (reason, kind = 'nic') => idProblem(reason, kind);

/** The SMS fields of a record, as it already has them. A form that rebuilds a record from its inputs must carry these over, or an edit silently switches the texts off. */
export function carry(prev) {
    const p = prev && typeof prev === 'object' ? prev : {};
    const out = {};
    for (const k of Object.values(SMS_FIELDS)) if (p[k] !== undefined) out[k] = p[k];
    return out;
}

/**
 * Validate what the owner entered and return the fields to merge into the record.
 *
 *   input: { enabled:boolean, phone:string, country?:string, phone2?:string, country2?:string, nic:string, idKind?:'nic'|'other' }
 *   -> { ok:true, fields }  or  { ok:false, errors:{ phone?, phone2?, nic? } }
 *
 * `phone2` is an optional second mobile number: every text goes to it as well. Left out, the record keeps the one it has; blank, it is removed.
 * It must be a real mobile number and not the first number again. `country2` is its region when it is typed without a country code (default: `country`).
 *
 * `country` is the region a number typed without a country code belongs to (default Sri Lanka). The number is stored as E.164, so it means
 * the same thing on every device, and to the server, in whatever country it is. `idKind` 'other' is a passport or national ID for somebody
 * with no Sri Lankan NIC; it is stored as "ID:AB123456".
 *
 * The switch-on stamp is set when the toggle goes from off to on and is KEPT while it stays on, so editing a record never
 * re-announces its history; switching off and on again stamps again, because what happened while it was off is not news.
 */
export function applyToggle(prev, input, now = Date.now()) {
    const p = prev && typeof prev === 'object' ? prev : {};
    if (!input || input.enabled !== true) return { ok: true, fields: { [SMS_FIELDS.ENABLED]: false }, errors: {} };
    const errors = {};
    const phoneRaw = s(input.phone).trim();
    const phone = normalizePhone(phoneRaw, input.country ? { defaultCountry: input.country } : undefined);
    if (!phone.ok) errors.phone = phoneProblem(phone.reason);
    let phone2 = null;                                          // undefined in the input: leave what the record has
    if (input.phone2 !== undefined) {
        const raw2 = s(input.phone2).trim();
        if (!raw2) phone2 = '';
        else {
            const c2 = input.country2 || input.country;
            const n2 = normalizePhone(raw2, c2 ? { defaultCountry: c2 } : undefined);
            if (!n2.ok) errors.phone2 = 'Second number: ' + phoneProblem(n2.reason);
            else if (phone.ok && n2.e164 === phone.e164) errors.phone2 = 'The second number is the same as the first. Leave it empty or enter a different number.';
            else phone2 = n2.e164;
        }
    }
    const kind = input.idKind === 'other' || idKindOf(input.nic) === 'other' ? 'other' : 'nic';
    const id = storedId(input.nic, kind);
    if (!id.ok) errors.nic = id.text;
    if (Object.keys(errors).length) return { ok: false, errors, fields: {} };
    const keep = p[SMS_FIELDS.ENABLED] === true && num(p[SMS_FIELDS.ENABLED_AT]) > 0;
    const fields = {
        [SMS_FIELDS.ENABLED]: true,
        [SMS_FIELDS.ENABLED_AT]: keep ? num(p[SMS_FIELDS.ENABLED_AT]) : now,
        [SMS_FIELDS.PHONE]: phone.e164,
        ...(phone2 === null ? {} : {
            [SMS_FIELDS.PHONE2]: phone2,
            // when this number was added: what happened before is history for it, so a number added today is not sent last month's receipts.
            // Kept while the number stays the same, restamped when it changes; 0 when there is none. Without a stamp the server counts from the switch-on.
            [SMS_FIELDS.PHONE2_AT]: phone2 ? (s(p[SMS_FIELDS.PHONE2]) === phone2 && num(p[SMS_FIELDS.PHONE2_AT]) > 0 ? num(p[SMS_FIELDS.PHONE2_AT]) : now) : 0,
        }),
        [SMS_FIELDS.NIC]: id.stored,
    };
    // Late-payment reminders (a debtor only: the caller passes the box). The moment it was ticked is kept while it stays ticked, so editing a record
    // never brings back a reminder for a day that was over before the owner asked for them.
    if (input.remindLate !== undefined) {
        const was = p[SMS_FIELDS.REMIND] === true && num(p[SMS_FIELDS.REMIND_AT]) > 0;
        fields[SMS_FIELDS.REMIND] = input.remindLate === true;
        if (input.remindLate === true) fields[SMS_FIELDS.REMIND_AT] = was ? num(p[SMS_FIELDS.REMIND_AT]) : now;
    }
    return { ok: true, errors: {}, fields };
}

/* ── closing an investment ────────────────────────────────────────────────── */

/** What an investment remembers about being closed, besides the `closedAt` stamp the server reads: the end date it had before, so re-opening puts it back. */
export const CLOSED_END_WAS = 'closedEndWas';

/**
 * The owner has been settled in full: stamp the investment closed. The stamp is the news (the server sends the investor one "fully settled" text for it,
 * once, if texts are on), and the end date is brought to today when it was empty or still ahead, so the investment moves to Ended and no more interest is
 * expected from it. The end date it had is kept (`closedEndWas`) for re-opening. Returns a NEW record; the one passed in is not changed.
 *   -> { ok:true, record } | { ok:false, reason:'already-closed'|'no-record'|'no-date' }
 */
export function closeInvestment(rec, { now = Date.now(), todayISO = '' } = {}) {
    if (!rec || typeof rec !== 'object') return { ok: false, reason: 'no-record' };
    if (num(rec[SMS_FIELDS.CLOSED_AT]) > 0) return { ok: false, reason: 'already-closed' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s(todayISO))) return { ok: false, reason: 'no-date' };
    const out = { ...rec, [SMS_FIELDS.CLOSED_AT]: now };
    const end = s(rec.end).slice(0, 10);
    if (!end || end > todayISO) { out[CLOSED_END_WAS] = end; out.end = todayISO; }
    return { ok: true, record: out };
}

/** Undo closeInvestment: the investment is running again and the end date it had comes back. A later close is news again (a new stamp, a new text). */
export function reopenInvestment(rec) {
    if (!rec || typeof rec !== 'object') return { ok: false, reason: 'no-record' };
    if (!(num(rec[SMS_FIELDS.CLOSED_AT]) > 0)) return { ok: false, reason: 'not-closed' };
    const out = { ...rec };
    delete out[SMS_FIELDS.CLOSED_AT];
    if (CLOSED_END_WAS in out) { out.end = s(out[CLOSED_END_WAS]); delete out[CLOSED_END_WAS]; }
    return { ok: true, record: out };
}

/* ── the balance on request ───────────────────────────────────────────────── */

export const BALANCE = Object.freeze({ COOLDOWN_MS: 10 * 60000, KEEP: 5 });

/** An id the server accepts (4-40 letters, digits, - and _). */
function newRequestId(now) {
    let rnd = '';
    try {
        const c = typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto : null;
        if (c) { const a = new Uint32Array(2); c.getRandomValues(a); rnd = a[0].toString(36) + a[1].toString(36); }
    } catch (_) { rnd = ''; }
    if (!rnd) rnd = Math.random().toString(36).slice(2, 12);
    return ('b' + now.toString(36) + rnd).slice(0, 32);
}

/** Milliseconds until the balance may be sent again for this record (0 when it may be sent now). A text costs a unit, and a double tap is the commonest way to spend two. */
export function balanceWaitMs(rec, now = Date.now()) {
    const reqs = Array.isArray(rec && rec[SMS_FIELDS.REQUESTS]) ? rec[SMS_FIELDS.REQUESTS] : [];
    let last = 0;
    for (const r of reqs) if (r && typeof r === 'object' && num(r.at) > last && num(r.at) <= now + 60000) last = num(r.at);
    return last > 0 ? Math.max(0, last + BALANCE.COOLDOWN_MS - now) : 0;
}

/**
 * The owner pressed "Send balance". The request is a row on the debtor, like everything else the server acts on: it derives the text
 * from the books (the confirmed balance at that moment), so nothing here names an amount or a recipient.
 *   -> { ok:true, record } | { ok:false, reason:'off'|'phone'|'wait', waitMs?, text }
 */
export function requestBalance(rec, { now = Date.now(), newId = newRequestId } = {}) {
    const r = rec && typeof rec === 'object' ? rec : {};
    if (r[SMS_FIELDS.ENABLED] !== true) return { ok: false, reason: 'off', text: 'Switch "Send SMS notifications" on for this debtor first.' };
    if (!normalizePhone(s(r[SMS_FIELDS.PHONE])).ok) return { ok: false, reason: 'phone', text: 'This debtor has no mobile number the texts can go to. Add one and save.' };
    const waitMs = balanceWaitMs(r, now);
    if (waitMs > 0) return { ok: false, reason: 'wait', waitMs, text: 'The balance was sent a moment ago. You can send it again in ' + Math.max(1, Math.ceil(waitMs / 60000)) + ' min.' };
    const kept = (Array.isArray(r[SMS_FIELDS.REQUESTS]) ? r[SMS_FIELDS.REQUESTS] : []).filter((x) => x && typeof x === 'object' && num(x.at) > 0).slice(-(BALANCE.KEEP - 1));
    return { ok: true, record: { ...r, [SMS_FIELDS.REQUESTS]: [...kept, { id: newId(now), at: now }] } };
}

const COPY = {
    A: 'Texts the investor when capital is recorded, when interest is applied, when a payment is received and, separately, when you close the investment as fully settled.',
    B: 'Texts the debtor when a loan is paid out and when a repayment is confirmed (with the balance that is left), and sends one more, separate text when the loan is fully settled and closed. Loans never carry interest, so no interest is ever calculated or sent.',
    SECOND: ' An optional second mobile number gets every one of these texts too (each text costs a unit per number).',
    PORTAL: ' Works for a mobile number in any country. With an NIC or a passport / ID number, each text carries a private link to a statement page; the person sees it only after entering that number and a one-time code sent to the mobile number above.',
};

/**
 * The markup for the switch. The mobile number and the NIC or ID belong to the person, not to the switch: they live in the contact fields
 * (wealthflow-people-ui.js), which also remember the person for next time. Every value is escaped; the ids all start with `prefix`.
 */
export function blockHtml(prefix, { layer = 'A', record = null } = {}) {
    const r = record && typeof record === 'object' ? record : {};
    const on = r[SMS_FIELDS.ENABLED] === true;
    const id = esc(prefix);
    return '<div class="fg wf-sms" data-wf-sms="' + id + '" style="border:1px solid var(--border,rgba(128,128,128,.25));border-radius:10px;padding:10px 12px;">'
        + '<label for="' + id + '_on" style="display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:600;">'
        + '<input type="checkbox" id="' + id + '_on"' + (on ? ' checked' : '') + ' style="width:18px;height:18px;">'
        + 'Send SMS notifications</label>'
        + (layer === 'B'
            ? '<label for="' + id + '_late" style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:12.5px;margin-top:8px;">'
              + '<input type="checkbox" id="' + id + '_late"' + (r[SMS_FIELDS.REMIND] === true ? ' checked' : '') + ' style="width:18px;height:18px;margin-top:1px;flex:0 0 auto;">'
              + '<span>Also remind when a payment is late. One text the day after the \u201cExpected back by\u201d date, then one a week later, at most four, only while money is still owed. Needs that date.</span></label>'
            : '')
        + '<div id="' + id + '_err" role="alert" style="color:var(--red,#e5484d);font-size:12px;margin-top:4px;"></div>'
        + '<div style="font-size:11px;color:var(--text3);margin-top:6px;line-height:1.5;">' + esc(COPY[layer === 'B' ? 'B' : 'A'] + COPY.SECOND + COPY.PORTAL) + '</div>'
        + '</div>';
}

/** What the owner entered in a block, or null when the block is not on the page. `root` is anything with querySelector. The number and the ID come from the contact fields; this reads them only if a block still carries its own. */
export function readBlock(root, prefix) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const on = root.querySelector('#' + prefix + '_on');
    if (!on) return null;
    const val = (suffix) => { const el = root.querySelector('#' + prefix + '_' + suffix); return el ? s(el.value) : ''; };
    const late = root.querySelector('#' + prefix + '_late');
    return { enabled: !!on.checked, phone: val('phone'), nic: val('nic'), hasPhone: !!root.querySelector('#' + prefix + '_phone'), ...(late ? { remindLate: !!late.checked } : {}) };
}

/** Put a validation message in the block. */
export function showBlockErrors(root, prefix, errors) {
    const el = root && root.querySelector ? root.querySelector('#' + prefix + '_err') : null;
    if (el) el.textContent = Object.values(errors || {}).join(' ');
}

/* ── 2. the nudge: when has anything the server cares about changed? ──────── */

/** Stable JSON, so the same record is the same string on every device. Long strings (a pasted note) count by length. */
function stable(v, depth = 0) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return v.length > 300 ? 's' + v.length : JSON.stringify(v);
    if (typeof v !== 'object') return JSON.stringify(v);
    if (depth > 6) return '"~"';
    if (Array.isArray(v)) return '[' + v.map((x) => stable(x, depth + 1)).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => k[0] !== '_').sort().map((k) => JSON.stringify(k) + ':' + stable(v[k], depth + 1)).join(',') + '}';
}
function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16).padStart(8, '0');
}

/**
 * A short fingerprint of everything the server derives notices from, or '' when no record has ever carried the switch.
 * Records that have the field (on OR off) count, so switching one off is a change; a payment the owner confirmed counts, so
 * confirming one is a change; an expense or a note elsewhere in the books is not.
 */
export function signatureOf(user) {
    const u = user && typeof user === 'object' ? user : {};
    const parts = [];
    const recv = u.incomeReceived && typeof u.incomeReceived === 'object' ? u.incomeReceived : {};
    for (const rec of Array.isArray(u.income) ? u.income : []) {
        if (!rec || rec[SMS_FIELDS.ENABLED] === undefined) continue;
        parts.push('I' + stable(rec));
        const prefix = s(rec.id) + '_';
        for (const k of Object.keys(recv).sort()) if (k.startsWith(prefix)) parts.push('R' + k + stable(recv[k]));
    }
    for (const rec of Array.isArray(u.debtors) ? u.debtors : []) {
        if (!rec || rec[SMS_FIELDS.ENABLED] === undefined) continue;
        parts.push('D' + stable(rec));
    }
    if (!parts.length) return '';
    parts.push('C' + s(u.settings && u.settings.currency));
    const text = parts.join('\n');
    return fnv(text, 2166136261) + fnv(text, 0x9747b28c) + '-' + text.length.toString(36);
}

/** How many records have the switch on. */
export function countOn(user) {
    const u = user && typeof user === 'object' ? user : {};
    const on = (r) => !!r && r[SMS_FIELDS.ENABLED] === true;
    return (Array.isArray(u.income) ? u.income.filter(on).length : 0) + (Array.isArray(u.debtors) ? u.debtors.filter(on).length : 0);
}

/**
 * The page's notifier. Everything it touches is injected, so every branch runs without a browser.
 *   deps: { getUser, getUid, getIdToken(forceRefresh), fetchImpl, now, storage, setTimer, clearTimer, onState, abort }
 */
export function createNotifier(deps) {
    const now = deps.now || (() => Date.now());
    const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = deps.clearTimer || ((t) => clearTimeout(t));
    const st = { timer: null, inFlight: false, disabled: false, retries: 0, throttled: 0, drains: 0, lastKickAt: 0, lastSummary: null, lastError: null, pending: null };
    const emit = () => { try { if (deps.onState) deps.onState({ disabled: st.disabled, lastSummary: st.lastSummary, lastError: st.lastError, busy: st.inFlight }); } catch (_) { /* a listener must not break the notifier */ } };
    const sigKey = (uid) => 'wf_sms_sig_' + uid;
    const readSig = (uid) => safeStorage(deps.storage, (x) => (x ? x.getItem(sigKey(uid)) : '') || '') || '';
    const writeSig = (uid, sig) => safeStorage(deps.storage, (x) => { if (x) x.setItem(sigKey(uid), sig); });

    function schedule(ms, ctx) {
        if (st.timer) clearTimer(st.timer);
        st.pending = ctx;
        st.timer = setTimer(() => { st.timer = null; const c = st.pending; st.pending = null; run(c); }, ms);
    }

    async function post(token, body) {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), CLIENT.FETCH_TIMEOUT_MS) : null;
        try {
            const r = await deps.fetchImpl(CLIENT.ENDPOINT, {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                ...(ctl ? { signal: ctl.signal } : {}),
            });
            let json = null;
            try { json = await r.json(); } catch (_) { json = null; }
            return { status: r.status, body: json };
        } finally { if (timer) clearTimeout(timer); }
    }

    /** One look. Never throws. */
    async function run(ctx = {}) {
        if (st.disabled) return { skipped: 'disabled' };
        const uid = deps.getUid();
        if (!uid) return { skipped: 'no-user' };
        if (st.inFlight) { schedule(CLIENT.DEBOUNCE_MS, ctx); return { skipped: 'busy' }; }
        const sig = ctx.sig !== undefined ? ctx.sig : signatureOf(deps.getUser());
        st.inFlight = true; emit();
        try {
            let res = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
                let token = null;
                try { token = await deps.getIdToken(attempt > 0); } catch (_) { token = null; }
                if (!token) { st.lastError = 'not signed in'; res = null; break; }
                res = await post(token, { force: !!ctx.force, reason: s(ctx.reason).slice(0, 20) });
                if (res.status !== 401) break;                          // a stale token gets one forced refresh
            }
            st.lastKickAt = now();
            if (!res) { backoff(ctx, sig); return { failed: 'no-token' }; }
            if (res.status === 403) { st.disabled = true; st.lastError = 'This account is not enabled for SMS notifications.'; return { disabled: true }; }
            if (res.status === 200 && res.body && res.body.throttled) {
                if (st.throttled < 2) { st.throttled += 1; schedule(CLIENT.THROTTLE_RETRY_MS, { ...ctx, sig }); }
                return { throttled: true };
            }
            if (res.status === 200 && res.body && res.body.ok) {
                st.retries = 0; st.throttled = 0; st.lastError = null;
                st.lastSummary = res.body.summary || null;
                writeSig(uid, sig);
                const sm = st.lastSummary || {};
                const waiting = num(sm.held) + num(sm.retry) + num(sm.remaining);
                if (waiting > 0 && st.drains < CLIENT.MAX_DRAINS) { st.drains += 1; schedule(CLIENT.DRAIN_MS, { sig, reason: 'drain' }); }
                return { ok: true, summary: st.lastSummary };
            }
            st.lastError = 'The server answered ' + res.status + '.';
            backoff(ctx, sig);
            return { failed: res.status };
        } catch (e) {
            st.lastError = 'Could not reach the server.';
            backoff(ctx, sig);
            return { failed: 'network' };
        } finally { st.inFlight = false; emit(); }
    }

    function backoff(ctx, sig) {
        if (st.retries >= CLIENT.RETRY_MS.length) return;                 // the daily sweep is the net from here
        const wait = CLIENT.RETRY_MS[st.retries];
        st.retries += 1;
        schedule(wait, { ...ctx, sig });
    }

    return {
        state: st,
        run,
        /** Call after every successful push to the cloud. Cheap when nothing relevant changed. */
        afterPush() {
            try {
                if (st.disabled) return false;
                const uid = deps.getUid();
                if (!uid) return false;
                const sig = signatureOf(deps.getUser());
                const prev = readSig(uid);
                if (sig === prev) return false;
                schedule(CLIENT.DEBOUNCE_MS, { sig, reason: 'save' });
                return true;
            } catch (_) { return false; }
        },
        /** Once when the page opens, and when it comes back to the front after a while: drain anything held. */
        onOpen(reason = 'open') {
            try {
                if (st.disabled) return false;
                const uid = deps.getUid();
                if (!uid) return false;
                const sig = signatureOf(deps.getUser());
                if (!sig && !readSig(uid)) return false;                      // this account has never used SMS: no request at all
                if (st.timer) return false;
                schedule(reason === 'open' ? CLIENT.OPEN_DELAY_MS : CLIENT.DEBOUNCE_MS, { sig, reason });
                return true;
            } catch (_) { return false; }
        },
        cancel() { if (st.timer) clearTimer(st.timer); st.timer = null; st.pending = null; },
        resetFor() { st.disabled = false; st.retries = 0; st.throttled = 0; st.drains = 0; st.lastSummary = null; st.lastError = null; },
    };
}

/* ── 3. the alert ─────────────────────────────────────────────────────────── */

export const ALERT_TITLE = 'Admin Alert: SMS Delivered Successfully to Tenant';

/** The line the page shows for one mirror document, or null when there is nothing to say. */
export function toastFor(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const where = s(doc.to);
    const ref = s(doc.ref);
    if (doc.status === 'sent') return { tone: 'success', text: s(doc.alert) || ALERT_TITLE, detail: [where && 'to ' + where, ref].filter(Boolean).join(', ') };
    if (doc.status === 'failed') return { tone: 'error', text: 'SMS could not be delivered', detail: [where && 'to ' + where, ref, doc.error && doc.error.message].filter(Boolean).join(', ') };
    return null;
}

/**
 * Decide what to announce for a snapshot of the log. Pure.
 *   rows:   mirror documents, each with its `id`
 *   memory: { seenSentAt:number, boundaryIds:Set<string>, knownFailed:Set<string>, first:boolean }
 * -> { toasts:[{tone,text,detail}], seenSentAt, boundaryIds, knownFailed }
 *
 * A delivery is announced once (by its sentAt, which only grows); after time away the first look gives one summary rather than
 * a pile. A failure is announced when it BECOMES a failure while the page is open, not for every old one on every load.
 */
export function announce(rows, memory = {}) {
    const seen = num(memory.seenSentAt);
    const boundary = new Set(memory.boundaryIds || []);
    const known = new Set(memory.knownFailed || []);
    const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && r.id !== '_status');
    // A sweep stamps every message it sends with ONE time, so several deliveries share a sentAt, and the snapshots that report them
    // arrive one write at a time. "Newer than the last one announced" alone would announce the first and swallow the rest, so the
    // ids already announced at the boundary time are remembered too.
    const isFresh = (r) => r.status === 'sent' && (num(r.sentAt) > seen || (num(r.sentAt) === seen && seen > 0 && !memory.first && !boundary.has(r.id)));
    const fresh = list.filter(isFresh).sort((a, b) => num(a.sentAt) - num(b.sentAt));
    const toasts = [];
    if (fresh.length > CLIENT.MAX_TOASTS) {
        toasts.push({ tone: 'success', text: ALERT_TITLE, detail: fresh.length + ' messages were delivered' + (memory.first ? ' since you were last here' : '') });
    } else {
        for (const r of fresh) toasts.push(toastFor(r));
    }
    let newest = seen;
    for (const r of fresh) newest = Math.max(newest, num(r.sentAt));
    const nextBoundary = newest > seen ? new Set() : boundary;
    for (const r of fresh) if (num(r.sentAt) === newest) nextBoundary.add(r.id);
    // after a reload the ids announced at the boundary time are not remembered; what the log already holds at that time was announced (or is accepted as old)
    if (memory.first && newest === seen) for (const r of list) if (r.status === 'sent' && num(r.sentAt) === seen) nextBoundary.add(r.id);
    const failedNow = list.filter((r) => r.status === 'failed');
    for (const r of failedNow) {
        const k = r.id + ':' + num(r.updatedAt);
        if (!known.has(k) && !memory.first) toasts.push(toastFor(r));
        known.add(k);
    }
    return { toasts: toasts.filter(Boolean), seenSentAt: newest, boundaryIds: nextBoundary, knownFailed: known };
}

/**
 * What the owner must be told even though nothing was delivered: texts that are WAITING for something only they can fix. Without this the
 * only sign is a quiet message log, and a debtor is never told about a payment because the account ran out of its ten units.
 *   rows:   mirror documents (not the status card); status: the status card or null; told: the problems already announced on this page
 * -> { toasts:[{tone,text,detail}], told:Set<string> }
 * A problem is announced once while it lasts; when it clears and comes back it is announced again.
 */
export const HELD_NOTICE = Object.freeze({
    credit: ['Texts are waiting for SMS credit', 'Top up your Text.lk account and they go out by themselves.'],
    auth: ['Texts are waiting: Text.lk rejected the API token', 'Check TEXTLK_API_TOKEN in the Vercel settings.'],
    sender: ['Texts are waiting for the sender ID', 'Text.lk has to approve the WealthFlow sender ID first.'],
    config: ['Texts are waiting: Text.lk is not connected', 'Add TEXTLK_API_TOKEN in the Vercel settings.'],
    unconfigured: ['Texts are waiting: Text.lk is not connected', 'Add TEXTLK_API_TOKEN in the Vercel settings and they go out by themselves.'],
    low: ['SMS credit is running low', 'When it runs out, texts are held, not lost, until you top up.'],
});

export function heldAlerts(rows, status, told = new Set()) {
    const waiting = (Array.isArray(rows) ? rows : []).filter((r) => r && r.id && r.id !== '_status' && r.status === 'queued');
    const now = new Set();
    const counts = {};
    for (const r of waiting) {
        const k = s(r.error && r.error.kind);
        const key = Object.prototype.hasOwnProperty.call(HELD_NOTICE, k) && k !== 'low' && k !== 'unconfigured' ? k : (status && status.configured === false && !k ? 'unconfigured' : '');
        if (!key) continue;
        now.add(key); counts[key] = (counts[key] || 0) + 1;
    }
    if (status && status.lowCredit === true) now.add('low');
    const toasts = [];
    for (const key of ['credit', 'auth', 'sender', 'config', 'unconfigured', 'low']) {
        if (!now.has(key) || (told instanceof Set && told.has(key))) continue;
        const [text, detail] = HELD_NOTICE[key];
        const n = counts[key];
        toasts.push({ tone: key === 'low' ? 'info' : 'error', text, detail: (n ? n + (n === 1 ? ' text is' : ' texts are') + ' waiting. ' : '') + detail + (key === 'low' && num(status && status.units) ? ' (' + num(status.units) + ' units left)' : '') });
    }
    return { toasts, told: now };
}

/**
 * Listen to the mirror and announce. Returns the unsubscribe function.
 *   deps: { firestore, uid, storage, onToast(t), onRows(rows, status), onError(e) }
 */
export function watchSmsLog(deps) {
    const key = 'wf_sms_seen_' + deps.uid;
    let memory = { seenSentAt: num(safeStorage(deps.storage, (x) => (x ? x.getItem(key) : 0))), boundaryIds: new Set(), knownFailed: new Set(), first: true, told: new Set() };
    let q;
    try {
        q = deps.firestore.collection('users').doc(deps.uid).collection('smsLog').orderBy('updatedAt', 'desc').limit(CLIENT.LOG_LIMIT);
    } catch (e) { if (deps.onError) deps.onError(e); return () => {}; }
    return q.onSnapshot((snap) => {
        try {
            const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
            const out = announce(rows, memory);
            const held = heldAlerts(rows, rows.find((r) => r.id === '_status') || null, memory.told);
            memory = { seenSentAt: out.seenSentAt, boundaryIds: out.boundaryIds, knownFailed: out.knownFailed, first: false, told: held.told };
            if (out.seenSentAt > 0) safeStorage(deps.storage, (x) => { if (x) x.setItem(key, String(out.seenSentAt)); });
            for (const t of out.toasts.concat(held.toasts)) if (deps.onToast) deps.onToast(t);
            if (deps.onRows) deps.onRows(rows.filter((r) => r.id !== '_status'), rows.find((r) => r.id === '_status') || null);
        } catch (e) { if (deps.onError) deps.onError(e); }
    }, (e) => { if (deps.onError) deps.onError(e); });
}

/* ── 4. the log panel ─────────────────────────────────────────────────────── */

const HOLD_TEXT = {
    'credit': 'Waiting for SMS credit. It will go out after the top-up.',
    'auth': 'Waiting for the gateway token to be fixed.',
    'sender': 'Waiting for the sender ID to be approved.',
    'config': 'The SMS gateway is not set up yet.',
    'cap': 'Daily sending limit reached. It will go out tomorrow.',
    'reserve': 'Paused: SMS credit is under the reserve you set. It goes out after the top-up.',
    'rate-limit': 'The gateway asked us to slow down. Trying again.',
    'network': 'Could not reach the gateway. Trying again.',
    'timeout': 'The gateway was slow to answer. Trying again.',
    'server': 'The gateway had a problem. Trying again.',
    'unknown': 'The gateway gave an unclear answer. Trying again.',
};
const ISSUE_TEXT = {
    'no-phone': 'has no phone number, so nothing is sent',
    'phone-bad-length': 'has a phone number with the wrong number of digits',
    'phone-not-a-mobile-number': 'has a phone number that is not a mobile number',
    'phone-needs-country-code': 'has a phone number with no country code',
    'phone-not-a-number': 'has a phone number with characters that are not allowed',
    'phone-misplaced-plus': 'has a phone number with a misplaced +',
    'phone-unknown-country-code': 'has a phone number with a country code that is not recognised',
    'phone-empty': 'has no phone number, so nothing is sent',
    'no-enable-stamp': 'was switched on without a date; open it and save it again',
    'future-enable-stamp': 'was switched on with a date in the future (check this device\'s clock); open it and save it again',
};

// the second number has the same ways to be wrong; the first number's texts are not held back by it
for (const k of Object.keys(ISSUE_TEXT)) {
    if (k.startsWith('phone-') && k !== 'phone-empty') ISSUE_TEXT['phone2-' + k.slice(6)] = ISSUE_TEXT[k].replace('has a phone number', 'has a second phone number') + ' (the first number still gets its texts)';
}

/** One line for the status card: what is switched on but cannot work. `nameOf(kind, id)` supplies the record's name. */
export function describeIssue(issue, nameOf) {
    const i = issue || {};
    let name = '';
    try { name = nameOf ? s(nameOf(i.recordKind, i.recordId)) : ''; } catch (_) { name = ''; }
    const who = name || (i.recordKind === 'debtor' ? 'A debtor' : 'An investment');
    return who + ' ' + (ISSUE_TEXT[i.reason] || 'cannot send texts yet');
}

/** What a refusal means for the owner, by the kind the gateway client gave it. A kind with no entry shows the gateway's own words. */
const FAIL_TEXT = {
    'destination': 'Your Text.lk account cannot send to this country or network yet. Ask Text.lk to enable it; the message is not retried until the number is changed.',
    'blocked': 'This number cannot receive texts (opted out or blocked). It is not retried.',
    'invalid-recipient': 'This is not a number the gateway can reach. Correct it on the record and save.',
};

const STATUS_WORDS = { sent: 'Sent', queued: 'Waiting', sending: 'Sending', failed: 'Failed', expired: 'Expired', cancelled: 'Cancelled' };

/** The rows of the log, newest first, as plain objects the page can draw. */
export function rowsOf(docs, nowMs = Date.now()) {
    return (Array.isArray(docs) ? docs : [])
        .filter((d) => d && d.id && d.id !== '_status')
        .sort((a, b) => num(b.occurredAt) - num(a.occurredAt))
        .map((d) => {
            let note = '';
            if (d.status === 'queued') note = HOLD_TEXT[d.error && d.error.kind] || (num(d.nextAttemptAt) > nowMs ? (d.scheduled ? 'Scheduled for the morning where the recipient is (08:00-20:00).' : 'Scheduled for a later time.') : 'Waiting to be sent.');
            else if (d.status === 'failed') note = FAIL_TEXT[d.error && d.error.kind] || s(d.error && d.error.message) || 'The gateway refused this message.';
            else if (d.status === 'expired' || (d.status === 'cancelled' && d.kind === 'B.balance')) note = d.kind === 'B.balance' ? 'The balance could not be sent within half an hour, so it was dropped rather than sent with a figure that may have moved. Press Send balance again.' : d.kind === 'B.late' ? 'The reminder could not go out for a week (no credit, an unapproved sender, or the debtor\'s sending hours), so it was dropped and the next one takes over.' : 'Held too long to still be news, so it was not sent.';
            else if (d.status === 'cancelled') note = 'Switched off or changed before it was sent.';
            else if (d.status === 'sent' && d.delivery && d.delivery.state === 'undelivered') note = 'The gateway took this text but reports it was not delivered (the number may be off, switched off or blocked by the network).' + (d.possiblyDuplicated ? ' It may also have been sent twice.' : '');
            else if (d.status === 'sent' && d.possiblyDuplicated) note = 'May have been delivered twice after a gateway timeout.';
            const delivered = d.status === 'sent' && d.delivery && d.delivery.state === 'delivered';
            const undelivered = d.status === 'sent' && d.delivery && d.delivery.state === 'undelivered';
            return {
                id: d.id, status: undelivered ? 'failed' : d.status, label: delivered ? 'Delivered' : undelivered ? 'Not delivered' : STATUS_WORDS[d.status] || s(d.status), to: s(d.to), ref: s(d.ref), body: s(d.body),
                at: num(d.sentAt) || num(d.occurredAt), note, layer: s(d.layer), second: /:2$/.test(s(d.key)),
            };
        });
}

/** The whole panel as markup. Everything is escaped. */
export function panelHtml({ rows = [], status = null, disabled = false, lastError = '', nameOf = null, fmtWhen = null } = {}) {
    const when = (ms) => { if (!ms) return ''; try { return fmtWhen ? fmtWhen(ms) : new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return ''; } };
    const colour = { sent: 'var(--green,#30a46c)', failed: 'var(--red,#e5484d)', queued: 'var(--amber,#f5a623)', sending: 'var(--amber,#f5a623)' };
    const lines = [];
    if (disabled) lines.push('SMS notifications are not enabled for this account. Ask the administrator to add your email to SMS_ALLOWED_EMAILS.');
    if (status && status.configured === false) lines.push('The SMS gateway is not connected yet: texts are queued and nothing is lost. Add TEXTLK_API_TOKEN to the deployment settings.');
    if (status && status.lowCredit) lines.push('SMS credit is running low' + (num(status.units) ? ' (' + num(status.units) + ' units left)' : '') + '. Messages are held, not dropped, when it runs out.');
    if (status && status.creditPaused === true) lines.push('Late-payment reminders are paused' + (num(status.units) ? ': only ' + num(status.units) + ' units are left' : '') + (num(status.reserve) ? ' (the reserve is ' + num(status.reserve) + ')' : '') + '. Receipts and closing notices still go out, and the reminders follow once credit is topped up.');
    for (const i of (status && Array.isArray(status.issues) ? status.issues : []).slice(0, 8)) lines.push(describeIssue(i, nameOf));
    if (lastError) lines.push(lastError);
    const notes = lines.length
        ? '<div style="background:rgba(245,166,35,.12);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:12.5px;line-height:1.6;">' + lines.map((l) => '<div>' + esc(l) + '</div>').join('') + '</div>'
        : '';
    const body = rows.length
        ? rows.map((r) => '<div style="padding:10px 0;border-top:1px solid var(--border,rgba(128,128,128,.2));">'
            + '<div style="display:flex;justify-content:space-between;gap:8px;font-size:12.5px;">'
            + '<span style="font-weight:700;color:' + (colour[r.status] || 'inherit') + ';">' + esc(r.label) + '</span>'
            + '<span style="color:var(--text3);">' + esc(when(r.at)) + '</span></div>'
            + '<div style="font-size:12px;color:var(--text3);margin-top:2px;">' + esc([r.to && 'to ' + r.to + (r.second ? ' (second number)' : ''), r.ref].filter(Boolean).join('  ')) + '</div>'
            + '<div style="font-size:12.5px;margin-top:4px;word-break:break-word;">' + esc(r.body) + '</div>'
            + (r.note ? '<div style="font-size:11.5px;color:var(--text3);margin-top:4px;">' + esc(r.note) + '</div>' : '')
            + '</div>').join('')
        : '<div style="padding:18px 0;text-align:center;color:var(--text3);font-size:13px;">No text messages yet. Switch "Send SMS notifications" on for an investment or a debtor and the notices appear here.</div>';
    return notes + body;
}

/* ── the browser glue ─────────────────────────────────────────────────────── */

/** Show the log in the app's own overlay. */
export function openPanel(win, getModel) {
    const doc = win.document;
    const overlay = doc.createElement('div');
    overlay.className = 'mo';
    const draw = () => { const host = overlay.querySelector('#_wf_sms_body'); if (host) host.innerHTML = panelHtml(getModel()); };
    overlay.innerHTML = '<div class="md" style="max-width:480px;"><div class="md-hdr"><div class="md-title">Text messages</div>'
        + '<button class="md-x" aria-label="Close" id="_wf_sms_x"><i data-wfi="x"></i></button></div><div id="_wf_sms_body" style="max-height:65vh;overflow:auto;"></div></div>';
    doc.body.appendChild(overlay);
    win.requestAnimationFrame(() => overlay.classList.add('open'));
    const close = () => { overlay.classList.remove('open'); win.setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 230); win.__wfSmsRedraw = null; };
    overlay.querySelector('#_wf_sms_x').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    try { if (win.WFIcon && win.WFIcon.paint) win.WFIcon.paint(overlay); } catch (_) { /* icons are decoration */ }
    win.__wfSmsRedraw = draw;
    draw();
    return overlay;
}

/** Wire the notifier and the listener to the running app. Safe to call more than once; never throws. */
export function boot(win) {
    const now = () => Date.now();
    const live = { uid: null, unsub: null, notifier: null, rows: [], status: null, timer: null, bound: false, told: false };
    const decoy = () => win._isDecoyMode === true;
    const storage = (() => { try { return win.localStorage; } catch (_) { return null; } })();
    const toast = (t) => { try { if (typeof win.notify === 'function') win.notify(t.text + (t.detail ? ' (' + t.detail + ')' : ''), t.tone === 'error' ? 'error' : (t.tone === 'info' ? 'info' : 'success')); } catch (_) { /* a toast is a courtesy */ } };
    const nameOf = (kind, id) => {
        try {
            const list = kind === 'debtor' ? win.appData.debtors : win.appData.income;
            const r = (list || []).find((x) => x && x.id === id);
            return r ? s(r.name || r.company) : '';
        } catch (_) { return ''; }
    };
    const model = () => ({ rows: rowsOf(live.rows, now()), status: live.status, disabled: !!(live.notifier && live.notifier.state.disabled), lastError: (live.notifier && live.notifier.state.lastError) || '', nameOf });

    function start() {
        if (decoy() || !win.currentUser || !win.currentUser.uid || !win.appData) return false;
        const uid = win.currentUser.uid;
        if (live.uid === uid) return true;
        stop();
        live.uid = uid;
        live.notifier = createNotifier({
            getUser: () => (decoy() ? null : win.appData),
            getUid: () => (decoy() ? '' : (win.currentUser && win.currentUser.uid) || ''),
            getIdToken: (force) => win.currentUser.getIdToken(!!force),
            fetchImpl: (...a) => win.fetch(...a),
            storage,
            onState: (state) => {
                if (state.disabled && !live.told) { live.told = true; toast({ tone: 'error', text: 'SMS notifications are not enabled for this account', detail: '' }); }
                if (win.__wfSmsRedraw) win.__wfSmsRedraw();
            },
        });
        try {
            live.unsub = watchSmsLog({
                firestore: win.firebase.firestore(), uid, storage, onToast: toast,
                onRows: (rows, status) => { live.rows = rows; live.status = status; if (win.__wfSmsRedraw) win.__wfSmsRedraw(); },
                onError: () => { /* the listener is the alert, not the delivery: a denied read costs the toast only */ },
            });
        } catch (_) { live.unsub = null; }
        live.notifier.onOpen('open');
        if (!live.bound) {
            live.bound = true;
            const again = () => { if (live.notifier && win.document.visibilityState !== 'hidden' && now() - (live.notifier.state.lastKickAt || 0) > CLIENT.DRAIN_MS) live.notifier.onOpen('resume'); };
            win.document.addEventListener('visibilitychange', again);
            win.addEventListener('online', again);
        }
        return true;
    }
    function stop() {
        try { if (live.unsub) live.unsub(); } catch (_) { /* already gone */ }
        if (live.notifier) live.notifier.cancel();
        live.unsub = null; live.notifier = null; live.uid = null; live.rows = []; live.status = null;
    }
    const api = {
        applyToggle, closeInvestment, reopenInvestment, carry, blockHtml, readBlock, showBlockErrors, signatureOf, countOn, SMS_FIELDS, BALANCE, balanceWaitMs, requestBalance,
        start,
        afterPush() { try { if (!live.notifier) start(); if (live.notifier) live.notifier.afterPush(); } catch (_) { /* never into the sync path */ } },
        kickNow() { if (live.notifier) return live.notifier.run({ force: true, reason: 'manual' }); return Promise.resolve({ skipped: 'not-started' }); },
        /** The log, drawn into an element the page owns (the people screens carry it as a tab). Returns the function that stops redrawing it. */
        panelInto(host) {
            start();
            const draw = () => { try { host.innerHTML = panelHtml(model()); } catch (_) { /* a stale host is not an error */ } };
            win.__wfSmsRedraw = draw;
            draw();
            return () => { if (win.__wfSmsRedraw === draw) win.__wfSmsRedraw = null; };
        },
        /** The log in its own overlay, or in the people screens when the page has them. */
        openPanel() {
            start();
            if (win.WFPeople && typeof win.WFPeople.openHub === 'function') return win.WFPeople.openHub('messages');
            return openPanel(win, model);
        },
    };
    // a signed-in page can appear at any time (login screen, a second account): look until it does, then stop looking
    live.timer = win.setInterval(() => { if (start()) { win.clearInterval(live.timer); live.timer = null; } }, 4000);
    return api;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__WF_SMS_NO_BOOT) {
    try { window.WFSms = boot(window); } catch (e) { console.warn('[WF-SMS] page side did not start:', e && e.message); }
}

export default { SMS_FIELDS, CLIENT, BALANCE, CLOSED_END_WAS, balanceWaitMs, requestBalance, applyToggle, closeInvestment, reopenInvestment, carry, blockHtml, readBlock, signatureOf, countOn, createNotifier, toastFor, announce, heldAlerts, HELD_NOTICE, watchSmsLog, rowsOf, panelHtml, describeIssue };
