/* =============================================================================
 * gmail-renew.mjs — which mailboxes are about to stop being watched
 * -----------------------------------------------------------------------------
 * A Gmail watch lives SEVEN DAYS. Nothing renews it but the page: open the app
 * and it re-registers on a six-day margin. That is a real mechanism and it costs
 * nothing, but it has one hole, and the hole is the failure this pipeline keeps
 * producing — silence.
 *
 * Do not open WealthFlow for a week — a holiday, a lost phone, a fortnight when
 * the numbers are not interesting — and the watch lapses. Gmail then publishes
 * nothing, /api/gmail-hook is never invoked, and statements stop arriving. The
 * card says "Connected", because the mailbox IS connected. Nothing is broken
 * enough to report. The statements simply do not come, and the first sign is
 * the owner noticing a month later that a bank is missing.
 *
 * So a scheduled run renews what is close to lapsing, and the page keeps doing
 * exactly what it did — the two are not alternatives. The page renewal needs no
 * secret and runs while the owner is looking at the result; the schedule is the
 * backstop for the week nobody looks.
 *
 * This module is the DECISION half: which documents are due, in what order, and
 * how many at once. It touches no network and no database, so the rule can be
 * tested without either.
 * ===========================================================================*/

import { needsRenewal, daysLeft } from './gmail-watch.mjs';

/* How many mailboxes one run will renew.
 *
 * Each one is an OAuth token exchange plus a users.watch call, inside a
 * function with a 60-second ceiling. The cap is what stops a growing number of
 * accounts turning a scheduled job into a timeout that renews nothing — and
 * because the due list is ordered by urgency, a capped run does the ones
 * closest to lapsing rather than an arbitrary slice. */
export const RENEW_MAX_PER_RUN = 25;

/* How many documents the scan will read. Above the renewal cap so the ordering
 * is done over the whole store rather than over whatever came back first. */
export const RENEW_SCAN_MAX = 200;

/**
 * The mailboxes due for renewal, most urgent first.
 *
 * `docs` is [{ key, data }] straight out of the collection. A document with no
 * refresh token is not due — there is nothing to watch with, and asking Google
 * about it would be a guaranteed failure counted every single day.
 */
export function dueFrom(docs, { now = Date.now(), max = RENEW_MAX_PER_RUN } = {}) {
    const out = [];
    for (const d of Array.isArray(docs) ? docs : []) {
        if (!d || !d.key || !d.data) continue;
        if (!d.data.refresh_token) continue;
        if (!needsRenewal(d.data, now)) continue;
        out.push(d);
    }
    /* Never registered (null) sorts first: a mailbox that has never been
     * watched has been delivering nothing since the day it was connected. */
    const rank = (d) => {
        const left = daysLeft(d.data, now);
        return left === null ? -Infinity : left;
    };
    out.sort((a, b) => rank(a) - rank(b));
    return out.slice(0, Math.max(0, max));
}

/* What went wrong, in categories rather than in sentences about one mailbox.
 *
 * The response to a scheduled run ends up in a deployment log, so it carries
 * COUNTS and never an address, a token or Google's reply. "3 mailboxes need
 * reconnecting" is everything the owner can act on; which three is on their
 * own screen, where they are already signed in. */
export const RENEW_FAIL = {
    TOKEN: 'token-refused',
    GMAIL: 'gmail-refused',
    STORE: 'not-recorded',
};

/** The one sentence a mailbox's own card should show after a failed renewal. */
export const RENEW_FAIL_TEXT = {
    [RENEW_FAIL.TOKEN]: 'Gmail refused the saved token. Disconnect and connect the mailbox again.',
    [RENEW_FAIL.GMAIL]: 'Gmail refused to renew the watch. Statements will not arrive until it is registered again.',
    [RENEW_FAIL.STORE]: 'The watch was renewed but could not be recorded.',
};

/**
 * Fold per-mailbox outcomes into what the run reports.
 *
 * `ok` is about the RUN, not about every mailbox in it: a run that reached
 * Gmail and renewed what it could has done its job even when one mailbox's
 * token has been revoked. A run that renewed nothing while something was due
 * has not, and says so — the alternative is a green scheduled job over a
 * pipeline that stopped.
 */
export function renewReport({ scanned = 0, due = 0, outcomes = [] } = {}) {
    const failures = {};
    let renewed = 0;
    for (const o of Array.isArray(outcomes) ? outcomes : []) {
        if (o && o.ok) { renewed += 1; continue; }
        const why = (o && o.reason) || RENEW_FAIL.GMAIL;
        failures[why] = (failures[why] || 0) + 1;
    }
    const failed = Object.values(failures).reduce((a, b) => a + b, 0);
    return {
        ok: due === 0 || renewed > 0,
        scanned,
        due,
        renewed,
        failed,
        failures,
    };
}

export default { RENEW_MAX_PER_RUN, RENEW_SCAN_MAX, RENEW_FAIL, RENEW_FAIL_TEXT, dueFrom, renewReport };
