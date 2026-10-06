/* =============================================================================
 * sms-guard.mjs  —  what keeps the texting running (and the owner told) when credit is short or sign-in is down
 * -----------------------------------------------------------------------------
 * Three small, separate jobs, all pure or fully injected so they are tested without a network:
 *
 *  1. THE CREDIT RESERVE. The gateway's balance is read once per sweep. Below the reserve (SMS_CREDIT_RESERVE, 20 units unless set; 0 switches
 *     the rule off) the one kind of text nobody is waiting for, the late-payment reminder, is not put in the ledger and not sent, so what is
 *     left pays for the texts people ARE waiting for: a receipt, a closing notice, a balance somebody asked for. Nothing is dropped or
 *     rewritten: the reminders stay owed by the books and go out on the first sweep that sees the balance back at the reserve (a reminder
 *     that waited past its own shelf life expires, as it always did, rather than going out late).
 *
 *  2. THE SIGN-IN BREAKER. Before an account's texts go, the sweep asks Firebase Auth whether that sign-in may still use SMS. When Auth does not
 *     answer, an account is skipped and left exactly as it is (never switched off: not answering is not a verdict). A run that meets
 *     AUTH_TRIP_AFTER such failures in a row stops asking (the next ones would only wait out their deadlines too) and leaves the remaining
 *     accounts for the next run, which starts with the breaker closed. There is NO cached "it was allowed last time" fallback: that would let
 *     an account whose access was just taken away keep spending the balance for as long as Auth is down. Queued texts persist and go out when
 *     Auth answers again.
 *
 *  3. THE ALERT. An owner who never opens the page still has to hear about either condition. When SMS_ALERT_WEBHOOK_URL is set (an https URL:
 *     a Slack or Discord incoming webhook, or any endpoint that takes JSON) one message is posted when credit falls under the reserve and one
 *     when Auth has failed several runs in a row, at most once a day each, and the "already told" mark is cleared when the condition clears so
 *     the next occurrence is reported at once. The alert says units and counts only: no token, no number, no name.
 * ===========================================================================*/

export const CREDIT_RESERVE_DEFAULT = 20;
export const CREDIT_RESERVE_MAX = 100000;
/** A balance reading older than this is not used by a run that did not read the balance itself (the page's nudge). */
export const CREDIT_READING_TTL_MS = 30 * 3600e3;
/** The kinds of text that wait when credit is under the reserve. Everything else a person is waiting for still goes. */
export const PAUSED_WHEN_LOW = Object.freeze(['B.late']);

export const AUTH_TRIP_AFTER = 3;
export const AUTH_ALERT_AFTER_RUNS = 2;
export const ALERT_GAP_MS = 24 * 3600e3;
export const ALERT_TIMEOUT_MS = 4000;
export const SYSTEM_DOC = '_system';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The reserve in units: SMS_CREDIT_RESERVE when it is a whole number >= 0, else the default. 0 means "no reserve". */
export function creditReserve(env = {}) {
    const raw = env && env.SMS_CREDIT_RESERVE;
    if (raw === undefined || raw === null || String(raw).trim() === '') return CREDIT_RESERVE_DEFAULT;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 0) return CREDIT_RESERVE_DEFAULT;
    return Math.min(Math.floor(n), CREDIT_RESERVE_MAX);
}

/** Is the balance under the reserve? An unknown balance is never "under": not knowing must not stop the texts people are waiting for. */
export function creditPaused(units, reserve) {
    if (units === null || units === undefined || units === '') return false;
    const u = Number(units);
    return reserve > 0 && Number.isFinite(u) && u < reserve;
}

/** Does this kind of text wait while credit is under the reserve? */
export const isPausedKind = (kind) => PAUSED_WHEN_LOW.includes(String(kind || ''));

/* ── the breaker ──────────────────────────────────────────────────────────── */

/**
 * Counts consecutive "could not tell" answers from Auth within ONE run. A definite answer (allowed or not) closes the count again; once open
 * the breaker stays open for the rest of the run.
 */
export class SignInBreaker {
    constructor({ tripAfter = AUTH_TRIP_AFTER } = {}) { this.tripAfter = tripAfter; this.consecutive = 0; this.open = false; this.answered = 0; this.failed = 0; }
    record(verdict) {
        if (verdict && verdict.transient) {
            this.failed += 1; this.consecutive += 1;
            if (this.consecutive >= this.tripAfter) this.open = true;
        } else { this.answered += 1; this.consecutive = 0; }
        return this.open;
    }
}

/* ── the alert ────────────────────────────────────────────────────────────── */

/**
 * The webhook address when it is safe to post to: https, no credentials, and not an address that only means something inside a network (a
 * hostname such as localhost or *.internal, or an IP literal). Anything else is "no webhook".
 */
export function alertWebhookUrl(env = {}) {
    const raw = String((env && env.SMS_ALERT_WEBHOOK_URL) || '').trim();
    if (!raw) return '';
    let u;
    try { u = new URL(raw); } catch (_) { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';           // (the default port is reported as empty)
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || !host.includes('.')) return '';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return '';
    if (/(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(host)) return '';
    return u.toString();
}

/** Post one alert. Never throws; the answer is whether it reached the endpoint. The address itself is never logged (it is a secret in a Slack webhook). */
export async function postAlert({ env, text, extra = {}, fetchImpl = globalThis.fetch, timeoutMs = ALERT_TIMEOUT_MS }) {
    const url = alertWebhookUrl(env);
    if (!url) return { sent: false, why: 'no webhook' };
    if (typeof fetchImpl !== 'function') return { sent: false, why: 'no fetch' };
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
        const r = await fetchImpl(url, {
            method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, content: text, ...extra }), ...(ctl ? { signal: ctl.signal } : {}),
        });
        const ok = !!r && r.status >= 200 && r.status < 300;
        if (!ok) console.warn(`[WF-SMS] alert webhook answered ${r ? r.status : 'nothing'}`);
        return { sent: ok, why: ok ? '' : `status ${r ? r.status : 0}` };
    } catch (e) {
        console.warn('[WF-SMS] alert webhook failed:', String((e && e.name) || 'error').slice(0, 40));
        return { sent: false, why: 'network' };
    } finally { if (timer) clearTimeout(timer); }
}

/** The stored record with every field present and numeric, whatever an older or damaged document held. */
export function normalizeState(state) {
    const cur = state || {};
    return { credit: { alertedAt: num(cur.credit && cur.credit.alertedAt) }, auth: { runs: num(cur.auth && cur.auth.runs), alertedAt: num(cur.auth && cur.auth.alertedAt), lastAt: num(cur.auth && cur.auth.lastAt) } };
}

/**
 * Given what the previous runs recorded and what this run saw, say which alerts are due and what the record becomes.
 * `alertedAt` is only set by `markAlerted` once a post actually succeeded, so a webhook that was down is tried again on the next run.
 * @param {{credit?:{alertedAt?:number}, auth?:{runs?:number, alertedAt?:number, lastAt?:number}}} state  the stored record
 * @param {{now:number, units:(number|null), reserve:number, authDegraded:boolean, authAnswered:boolean}} seen  authAnswered: at least one definite answer came back
 */
export function decideAlerts(state, { now, units, reserve, authDegraded, authAnswered }) {
    const next = normalizeState(state);
    const alerts = [];
    if (creditPaused(units, reserve)) {
        if (now - next.credit.alertedAt >= ALERT_GAP_MS) {
            alerts.push({ key: 'credit', text: `WealthFlow SMS: the Text.lk balance is ${Math.floor(Number(units))} units, under the reserve of ${reserve}. Late-payment reminders are paused until it is topped up; receipts, closing notices and requested balances still go out.`, extra: { units: Math.floor(Number(units)), reserve } });
        }
    } else if (units !== null && units !== undefined && Number.isFinite(Number(units))) {
        next.credit.alertedAt = 0;                                   // the balance is back: the next time it falls is news again
    }
    if (authDegraded) {
        next.auth.runs += 1; next.auth.lastAt = now;
        if (next.auth.runs >= AUTH_ALERT_AFTER_RUNS && now - next.auth.alertedAt >= ALERT_GAP_MS) {
            alerts.push({ key: 'auth', text: `WealthFlow SMS: Firebase sign-in has not answered on ${next.auth.runs} sweeps in a row. Texts for the accounts that could not be re-checked are waiting, not lost, and go out as soon as it answers.`, extra: { runs: next.auth.runs } });
        }
    } else if (authAnswered) {
        next.auth.runs = 0; next.auth.alertedAt = 0;
    }
    return { alerts, next };
}

/** Record that an alert was delivered. */
export function markAlerted(next, key, now) {
    if (next[key]) next[key].alertedAt = now;
    return next;
}

export default { creditReserve, creditPaused, isPausedKind, SignInBreaker, alertWebhookUrl, postAlert, normalizeState, decideAlerts, markAlerted };
