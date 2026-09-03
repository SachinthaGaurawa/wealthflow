/* =============================================================================
 * wealthflow-when.js — what day is it HERE
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 *
 * Thirty-seven places in this app answered "what is today" with
 *
 *     new Date().toISOString().slice(0, 10)
 *
 * which is today IN UTC. The owner is in Colombo, UTC+05:30. Reproduced in a
 * real browser with the clock frozen at 01:00 on 1 August:
 *
 *     local clock                       Sat Aug 01 2026 01:00:00 GMT+0530
 *     new Date().toISOString()          2026-07-31T19:30:00.000Z
 *     ...slice(0, 10)   ->              2026-07-31      <-- what the app used
 *     local getFullYear/Month/Date ->   2026-08-01      <-- what the owner sees
 *
 * So a receipt scanned at one in the morning is filed under YESTERDAY, and on
 * the first of a month it is filed under the PREVIOUS MONTH'S TAB. That is five
 * and a half hours of every day — 23% of the clock — and it contradicts the one
 * promise this app is built on: every transaction lands in its correct month.
 *
 * It is silent. Nothing throws, nothing is missing, the number is simply in the
 * wrong bucket, and the owner would find it by noticing a month that does not
 * add up — months later, with no way to tell which rows moved.
 *
 * Users west of Greenwich get the mirror image: UTC runs AHEAD of them, so their
 * evening transactions are filed under TOMORROW. This is not a Sri Lanka bug; it
 * is a bug everywhere except the UK in winter, which is where it was written.
 *
 * WHY A MODULE AND NOT A HELPER IN EACH FILE
 *
 * index.html already had the correct answer — `today()`, using the local
 * getters — and thirty-seven other places had the wrong one. Two notions of
 * "now" in one codebase is precisely how they drift, so there is now exactly
 * one, and every caller reads it. It is deliberately dependency-free and tiny
 * so that it can be loaded before anything else.
 *
 * WHAT IS DELIBERATELY *NOT* CHANGED
 *
 * Code that builds its Dates with Date.UTC() and reads them back with
 * toISOString() is internally consistent and correct — wealthflow-cashflow-
 * engine.js works entirely in UTC day boundaries on purpose. Gmail search
 * windows (wealthflow-backfill.js, wealthflow-sender-discovery.js) are UTC by
 * the API's definition. Server timestamps stay ISO instants. Only the question
 * "which calendar day is it for the person holding the phone" moves here.
 * ===========================================================================*/

const p2 = (n) => (String(n).length < 2 ? '0' + n : String(n));

/** A Date for `v`, or null. Accepts a Date, an epoch ms number, or a string. */
function asDate(v) {
    if (v == null) return new Date();
    const d = (v instanceof Date) ? v : new Date(v);
    return isFinite(d.getTime()) ? d : null;
}

/**
 * 'YYYY-MM-DD' for the calendar day this moment falls on WHERE THE DEVICE IS.
 *
 * getFullYear/getMonth/getDate are the local-calendar accessors; toISOString()
 * is the UTC one. That single difference is the whole bug.
 */
export function ymd(v) {
    const d = asDate(v);
    if (!d) return '';
    return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/** 'YYYY-MM' for the month this moment falls in, locally. */
export function ym(v) {
    const d = asDate(v);
    if (!d) return '';
    return d.getFullYear() + '-' + p2(d.getMonth() + 1);
}

/** Today, here. */
export function today() { return ymd(new Date()); }

/** This month, here. */
export function thisMonth() { return ym(new Date()); }

/**
 * Local midnight for this moment, as a Date.
 *
 * Day arithmetic against `new Date(new Date().toISOString().slice(0,10))` is an
 * off-by-one waiting to happen: that expression parses a bare date string as UTC
 * midnight, so "days until" is measured from a different instant than the one
 * the owner calls the start of today.
 */
export function startOfDay(v) {
    const d = asDate(v);
    if (!d) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Whole days from `a` to `b`, counted in local calendar days.
 *
 * Counted from local midnight to local midnight rather than by dividing a
 * millisecond difference, so a day containing a daylight-saving change is still
 * one day. Sri Lanka has no DST; most of this app's future users do.
 */
export function daysBetween(a, b) {
    const A = startOfDay(a); const B = startOfDay(b);
    if (!A || !B) return null;
    return Math.round((B - A) / 86400000);
}

/** Whole days from today until `v`, negative once it is past. */
export function daysUntil(v) { return daysBetween(new Date(), v); }

/**
 * The IANA zone the device is in ('Asia/Colombo'), or '' if it cannot be read.
 *
 * Sent alongside a date hint to the vision API, which runs on a server in UTC
 * and would otherwise have to guess — and guessed UTC, which is how a receipt
 * with no printed date came back stamped the wrong day.
 */
export function zone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) { return ''; }
}

export const WHEN = { ymd, ym, today, thisMonth, startOfDay, daysBetween, daysUntil, zone };

/* Attached for the classic (non-module) scripts. They are all `defer`red and
 * this is a module — both run after parsing, in document order — so a caller
 * that reads it inside a function, which is every caller, always finds it. */
try { if (typeof window !== 'undefined') window.WFWhen = WHEN; } catch (_) {}
