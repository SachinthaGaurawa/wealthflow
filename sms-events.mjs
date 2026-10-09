/* =============================================================================
 * sms-events.mjs — which text messages SHOULD exist, derived from the books
 * -----------------------------------------------------------------------------
 * THE IDEA THAT MAKES "NO MESSAGE EVER OMITTED" TRUE.
 *
 * Notifications are usually fired from the moment something happens. That design
 * loses a message whenever the moment is missed: the phone was offline, the tab was
 * closed a second after the save, the function was cold, the gateway was down for
 * an hour. Nothing remembers it was owed.
 *
 * Here the books are the only source of truth and this module is a pure function of
 * them: given the user's document and the time, it lists EVERY notice that ought to
 * have gone out, each with a deterministic key (`A:<investment>:int:2026-10`,
 * `B:<debtor>:<event>:in`). The dispatcher then sends whichever keys the ledger of
 * sent messages does not yet contain. A missed moment is not a lost message — the
 * next sweep derives it again; a repeated sweep is not a repeated message — the key
 * is already in the ledger.
 *
 * TWO LAYERS, TWO RULE SETS (the owner's matrix):
 *
 *   LAYER A — the Investments tab (`income[]`). With `sms_notifications_enabled` on:
 *     capital recorded; the interest applied each period; a receipt when the owner
 *     confirms a payment. Interest is computed here from the same cadence rules the
 *     verification queue uses (wealthflow-verify-matrix.js), so the app and the
 *     message can never disagree about WHEN a period pays.
 *
 *   LAYER B — money lent to people (`debtors[]`, Liquidity & Credit Hub). With the
 *     toggle on: capital disbursed; repayment acknowledged (with the balance that is
 *     left, so a part payment says how much remains); the balance on request, when
 *     the owner presses "Send balance" (`sms_requests`); and, when a confirmed
 *     repayment brings the balance to nothing, a closing text of its own after that
 *     receipt. An investment the owner closes as settled (`closedAt`) gets the same. INTEREST IS NEVER
 *     COMPUTED for this layer, whatever fields a record carries — `interestApplies`
 *     says so in one place and the derivation below does not even call the accrual.
 *
 * WHAT NEVER GOES OUT
 *   - History. The toggle carries the moment it was switched on; an event that
 *     happened before that (beyond a short grace for "created and switched on in the
 *     same minute") is the past, not news.
 *   - An unconfirmed repayment. The owner's rule is that nothing moves a balance until
 *     a person confirms it, and a text message saying "repayment received" about a
 *     repayment nobody has verified would be a claim the books do not make.
 *   - Anything older than MAX_AGE_MS. A "repayment received" arriving a month late
 *     is noise.
 *   - A message to a phone that is not a valid mobile number — reported as an issue so
 *     the owner sees "SMS is on but this number cannot receive", instead of silence.
 *
 * A SECOND NUMBER. A record may carry `phone2`, an optional second mobile number. Every notice is owed to both numbers, as two ledger entries
 * (the second under the same key plus `:2`), so each can be sent, held, retried and counted on its own; one number failing never costs the other
 * its text. A second number that cannot receive is reported as an issue and the first still gets everything; the same number twice is one text.
 *
 * NOTHING HERE WRITES TO THE BOOKS. An interest notice is a notice; it does not mark
 * anything received. (The owner's standing rule: income is never marked received by a
 * calendar.)
 *
 * Pure: `now` is passed in; no storage, no network.
 * ===========================================================================*/

import { paysInMonth, dueDateFor, dayOfMonth, monthKeyOf, periodMonths, parseDay } from './wealthflow-verify-matrix.js';
import { debtorSummary, EVENT } from './wealthflow-liquidity.js';
import { normalizePhone, utcOffsetOf } from './wealthflow-phone.js';
import { normalizeIdentity } from './wealthflow-nic.js';
import { KINDS, refCode, currencyOf } from './sms-templates.mjs';

/** The schema fields this feature adds to an investment or a debtor record. */
export const FIELDS = Object.freeze({
    ENABLED: 'sms_notifications_enabled',   // boolean — the persistent toggle
    ENABLED_AT: 'sms_enabled_at',           // epoch ms when it was last switched on
    PHONE: 'phone',                         // any shape; normalised to E.164 here
    PHONE2: 'phone2',                       // an optional second mobile number: every text goes to it as well
    PHONE2_AT: 'phone2_at',                 // epoch ms the second number was added or changed: what happened before is history for it, not news
    CLOSED_AT: 'closedAt',                  // epoch ms when the record was closed as fully settled (an investment the owner closed; a debtor's own closing is derived from its books)
    NIC: 'nic',                             // old or new Sri Lankan NIC; the portal's key
    REQUESTS: 'sms_requests',               // [{ id, at }] — the owner pressed "Send balance"; a debtor only
    REMIND: 'sms_remind_late',              // boolean — also text a debtor when the date they were expected to pay by has passed; a debtor only, off unless the owner ticks it
    REMIND_AT: 'sms_remind_at',             // epoch ms when that box was last ticked
});

/**
 * LATE-PAYMENT REMINDERS (opt-in, a debtor only). With `dueISO` ("expected back by") set, money still owing and the box ticked, a debtor gets at most
 * four reminders: the day after the date, then one a week later each time. Each is a SCHEDULED notice (08:00-20:00 where the debtor is), carries the
 * balance as it was when it was queued, and is good for a day only, so a reminder that could not go out is dropped rather than sent stale.
 */
export const REMINDER_OFFSETS_DAYS = Object.freeze([1, 8, 15, 22]);
export const REMINDER_WINDOW_MS = 7 * 86400000;      // a reminder is owed from its day until the next one's (a week), so one that could not go out on its day (credit, an unapproved sender) still goes on a later sweep
export const REMINDER_SHELF_MS = 7 * 86400000;

/**
 * A "send the balance now" request is good for this long. The figure is written into the text when it is queued, so a request
 * that cannot go out soon (no credit, a rejected token) is dropped rather than sent hours later with a balance that has moved.
 */
export const REQUEST_WINDOW_MS = 30 * 60 * 1000;
/** Newest requests read per debtor: a stuck key or a runaway loop on a device cannot become a stream of texts. */
export const REQUESTS_READ = 3;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

export const LAYER = Object.freeze({ A: 'A', B: 'B' });

/** Interest is computed for the Investments layer and for nothing else. */
export const interestApplies = (layer) => layer === LAYER.A;

/** Events this far before the toggle still count: a record created and switched on in the same minute, an advance logged then notified. */
export const GRACE_MS = 10 * 60 * 1000;
/** Older than this, a notice is no longer news. */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
/** How many past months of interest the derivation looks at. */
export const INTEREST_LOOKBACK_MONTHS = 3;
/** Notices that are SCHEDULED (interest) wait for the day where the RECIPIENT is (Sri Lanka's, UTC+05:30, for a Sri Lankan number): no 3 a.m. text about a monthly figure. Standard time: an hour of daylight saving still lands inside the window. */
export const LOCAL_OFFSET_MIN = 330;
export const WINDOW_START_HOUR = 8;
export const WINDOW_END_HOUR = 20;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => String(v == null ? '' : v).trim();
const isOn = (rec) => !!rec && rec[FIELDS.ENABLED] === true;

/** The next moment at or after `ms` that falls inside the sending window (08:00-20:00 Sri Lanka time). */
export function nextSendWindow(ms, offsetMin = LOCAL_OFFSET_MIN) {
    const local = new Date(ms + offsetMin * 60000);
    const h = local.getUTCHours();
    if (h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR) return ms;
    const dayStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    const startToday = dayStart + WINDOW_START_HOUR * 3600000;
    const localMs = ms + offsetMin * 60000;
    const targetLocal = localMs < startToday ? startToday : startToday + 86400000;
    return targetLocal - offsetMin * 60000;
}

/** One investment's interest for one period, the way saveIncome stores it (`monthly`), or computed from capital, rate and cadence when it is missing. */
export function periodInterest(inv) {
    const stored = num(inv && inv.monthly);
    if (stored > 0) return stored;
    const amount = num(inv && inv.amount);
    const rate = num(inv && inv.rate);
    if (!(amount > 0) || !(rate > 0)) return 0;
    const p = periodMonths(inv && inv.freq);
    return Math.round((amount * rate / 100 * p / 12) * 100) / 100;
}

function phoneIssue(rec, recordKind) {
    const p = normalizePhone(rec && rec[FIELDS.PHONE]);
    if (p.ok) return { phone: p.e164 };
    return { issue: { recordKind, recordId: str(rec && rec.id), reason: str(rec && rec[FIELDS.PHONE]) ? `phone-${p.reason}` : 'no-phone' } };
}

/**
 * The second number of a record, as E.164, or '' when there is none to send to. One that cannot receive is reported (the first number is
 * unaffected); the same number as the first is one text, not two.
 */
function secondNumber(rec, primary, recordKind, issues) {
    const raw = str(rec && rec[FIELDS.PHONE2]);
    if (!raw) return '';
    const p = normalizePhone(raw);
    if (!p.ok) { issues.push({ recordKind, recordId: str(rec && rec.id), reason: `phone2-${p.reason}` }); return ''; }
    return p.e164 === primary ? '' : p.e164;
}

/** The same notice, owed to the second number: its own ledger key, its own time zone, and (for a scheduled text) its own morning and shelf life. */
function twinFor(ev, phone2) {
    const tzMin = utcOffsetOf(phone2);
    const out = { ...ev, key: `${ev.key}:2`, phone: phone2, tzMin };
    if (ev.scheduled) {
        const open = nextSendWindow(ev.occurredAt, tzMin);
        out.notBefore = open;
        if (num(ev.maxAgeMs) > 0) out.maxAgeMs = num(ev.maxAgeMs) - (num(ev.notBefore) - ev.occurredAt) + (open - ev.occurredAt);
    }
    return out;
}

/**
 * The record's notices, and each of them again for the second number when there is one, but only those that happened since the second number
 * was added (`since`): a number added today is not sent last month's receipts. A scheduled notice (interest) is judged by its day, like the first number's.
 */
function withSecondNumber(sink, phone2, since) {
    if (!phone2) return sink;
    const news = sink.filter((ev) => ev.occurredAt >= (ev.scheduled ? Math.floor(since / 86400000) * 86400000 : since - GRACE_MS));
    return [...sink, ...news.map((ev) => twinFor(ev, phone2))];
}

/** From when the second number is owed texts: when it was added, but never before the texts were switched on, and never later than "now" (a phone with the wrong date). */
function secondSince(rec, now) {
    const at = Math.max(num(rec && rec[FIELDS.PHONE2_AT]), num(rec && rec[FIELDS.ENABLED_AT]));
    return Math.min(at, now + CLOCK_SKEW_MS);
}

/** How far ahead of the server's clock a device's "switched on at" may be: a phone with the wrong date must not hold a record's notices back for days. */
export const CLOCK_SKEW_MS = 5 * 60000;
const stampIssue = (enabledAt, now) => (!(enabledAt > 0) ? 'no-enable-stamp' : enabledAt > now + CLOCK_SKEW_MS ? 'future-enable-stamp' : '');

function eligible(occurredAt, enabledAt, now, { dayGranular = false } = {}) {
    if (!(enabledAt > 0)) return false;
    // A period's interest falls due on a DAY, not at an instant: switching the toggle on at 09:00 on the due day still means "tell them".
    const floor = dayGranular ? Math.floor(enabledAt / 86400000) * 86400000 : enabledAt - GRACE_MS;
    if (occurredAt < floor) return false;                           // history, not news
    if (now - occurredAt > MAX_AGE_MS) return false;                // too old to be news
    return true;
}

function subjectOf(rec) {
    const n = normalizeIdentity(rec && rec[FIELDS.NIC]);
    return n.ok ? { nic: n.canonical } : null;
}

/* ── LAYER A ──────────────────────────────────────────────────────────────── */

function investmentEvents(user, now, currency, out, issues) {
    const received = (user.incomeReceived && typeof user.incomeReceived === 'object') ? user.incomeReceived : {};
    const nowDate = new Date(now);
    const today = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());

    const one = (inv, sink) => {
        const enabledAt = num(inv[FIELDS.ENABLED_AT]);
        const stamp = stampIssue(enabledAt, now);
        if (stamp) { issues.push({ recordKind: 'investment', recordId: str(inv.id), reason: stamp }); return; }
        const { phone, issue } = phoneIssue(inv, 'investment');
        if (issue) { issues.push(issue); return; }
        const base = {
            layer: LAYER.A, recordKind: 'investment', recordId: str(inv.id), ref: refCode('investment', inv.id),
            currency, phone, tzMin: utcOffsetOf(phone), subject: subjectOf(inv), scheduled: false, notBefore: 0,
        };

        // (a) new capital recorded
        const createdAt = Date.parse(inv.createdAt || '');
        const capital = num(inv.amount);
        if (Number.isFinite(createdAt) && capital > 0 && eligible(createdAt, enabledAt, now)) {
            sink.push({ ...base, key: `A:${inv.id}:created`, kind: KINDS.A_CAPITAL, occurredAt: createdAt, amount: capital, ratePct: num(inv.rate), dateISO: str(inv.start).slice(0, 10) });
        }

        // (b) interest applied — one per period the source pays in
        const interest = periodInterest(inv);
        if (interestApplies(LAYER.A) && interest > 0) {
            for (let back = INTEREST_LOOKBACK_MONTHS; back >= 0; back -= 1) {
                const monthIdx = nowDate.getUTCMonth() - back;
                if (!paysInMonth(inv, nowDate.getUTCFullYear(), monthIdx)) continue;
                const due = dueDateFor(dayOfMonth(inv.day), nowDate.getUTCFullYear(), monthIdx);
                if (due.getTime() > today) continue;                       // not yet due: nothing to say yet
                const mk = monthKeyOf(due);
                const occurredAt = due.getTime();
                if (!eligible(occurredAt, enabledAt, now, { dayGranular: true })) continue;
                if (num(inv[FIELDS.CLOSED_AT]) > 0 && occurredAt > num(inv[FIELDS.CLOSED_AT])) continue;     // closed as settled: no interest falls due after that
                sink.push({
                    ...base, key: `A:${inv.id}:int:${mk}`, kind: KINDS.A_INTEREST, occurredAt, amount: interest, month: mk,
                    dateISO: due.toISOString().slice(0, 10), scheduled: true,
                    notBefore: nextSendWindow(occurredAt, base.tzMin),
                });
            }
        }

        // (d) the owner closed the investment as fully settled
        const closedAt = num(inv[FIELDS.CLOSED_AT]);
        if (closedAt > 0 && closedAt <= now + CLOCK_SKEW_MS && eligible(closedAt, enabledAt, now)) {
            sink.push({ ...base, key: `A:${inv.id}:closed:${closedAt}`, kind: KINDS.A_CLOSED, occurredAt: closedAt, amount: 0, dateISO: new Date(closedAt + base.tzMin * 60000).toISOString().slice(0, 10) });
        }

        // (c) a payment the owner confirmed. `auto` and `historical` marks are bookkeeping for pre-join months, never a payment to acknowledge.
        const prefix = `${inv.id}_`;
        for (const k of Object.keys(received)) {
            if (!k.startsWith(prefix)) continue;
            const mk = k.slice(prefix.length);
            if (!/^\d{4}-\d{2}$/.test(mk)) continue;
            const entry = received[k];
            if (!entry || typeof entry !== 'object' || entry.auto || entry.historical) continue;
            const confirmedAt = num(entry.confirmedAt) || num(entry.at);
            if (!(confirmedAt > 0) || !eligible(confirmedAt, enabledAt, now)) continue;
            const amount = num(entry.amount) > 0 ? num(entry.amount) : interest;
            if (!(amount > 0)) continue;
            sink.push({
                ...base, key: `A:${inv.id}:rcv:${mk}`, kind: KINDS.A_RECEIPT, occurredAt: confirmedAt, amount, month: mk,
                dateISO: new Date(confirmedAt + LOCAL_OFFSET_MIN * 60000).toISOString().slice(0, 10),
            });
        }
    };

    for (const inv of arr(user.income)) {
        if (!inv || !inv.id || !isOn(inv)) continue;
        // one record that cannot be read must not stop every other tenant's notices; and a record that fails half-way contributes nothing
        const sink = [];
        try { one(inv, sink); out.push(...withSecondNumber(sink, sink.length ? secondNumber(inv, sink[0].phone, 'investment', issues) : '', secondSince(inv, now))); } catch (_) { issues.push({ recordKind: 'investment', recordId: str(inv.id), reason: 'unreadable-record' }); }
    }
}

/* ── LAYER B ──────────────────────────────────────────────────────────────── */

function debtorEvents(user, now, currency, out, issues) {
    const one = (d, sink) => {
        const enabledAt = num(d[FIELDS.ENABLED_AT]);
        const stamp = stampIssue(enabledAt, now);
        if (stamp) { issues.push({ recordKind: 'debtor', recordId: str(d.id), reason: stamp }); return; }
        const { phone, issue } = phoneIssue(d, 'debtor');
        if (issue) { issues.push(issue); return; }
        const base = {
            layer: LAYER.B, recordKind: 'debtor', recordId: str(d.id), ref: refCode('debtor', d.id),
            currency, phone, tzMin: utcOffsetOf(phone), subject: subjectOf(d), scheduled: false, notBefore: 0,
        };

        // The raw events carry `at` / `confirmedAt`, which the ledger's own normaliser drops.
        const rawById = new Map(arr(d.events).filter((e) => e && e.id).map((e) => [str(e.id), e]));
        const events = debtorSummary(d, new Date(now)).events;          // normalised, oldest first, unknown kinds dropped
        let lent = 0; let repaid = 0; let outs = 0;
        for (const e of events) {
            if (!e.confirmed) continue;                                  // a claim nobody has verified is not news
            const raw = rawById.get(e.id) || {};
            const isOut = e.kind === EVENT.LENT || e.kind === EVENT.TOPUP;
            if (isOut) { lent += e.amount; outs += 1; } else repaid += e.amount;
            const balance = Math.max(0, lent - repaid);
            const day = parseDay(e.date);
            const occurredAt = Math.max(num(raw.at), num(raw.confirmedAt)) || (day ? day.getTime() : 0);
            if (!(occurredAt > 0) || !eligible(occurredAt, enabledAt, now)) continue;
            sink.push(isOut
                ? { ...base, key: `B:${d.id}:${e.id}:out`, kind: KINDS.B_DISBURSED, occurredAt, amount: e.amount, balance, dateISO: str(e.date).slice(0, 10), further: e.kind === EVENT.TOPUP || outs > 1 }
                : { ...base, key: `B:${d.id}:${e.id}:in`, kind: KINDS.B_REPAYMENT, occurredAt, amount: e.amount, balance, dateISO: str(e.date).slice(0, 10), settled: balance <= 0 });
            // The payment that brings the balance to nothing also closes the loan: that is news of its own, a text of its own, one tick after the
            // receipt so it never arrives first. Keyed by the payment, so a loan that is borrowed on again and settled again is closed again.
            if (!isOut && balance <= 0 && lent > 0) {
                sink.push({ ...base, key: `B:${d.id}:${e.id}:closed`, kind: KINDS.B_CLOSED, occurredAt: occurredAt + 1, amount: 0, balance: 0, dateISO: str(e.date).slice(0, 10) });
            }
        }
        // The owner asked for the balance to be sent: a part payment was agreed, or the person asked how much is left. The figure is the
        // CONFIRMED outstanding now (money nobody has confirmed is not in it, like every other figure here).
        const requests = arr(d[FIELDS.REQUESTS])
            .filter((r) => r && typeof r === 'object' && REQUEST_ID_RE.test(str(r.id)) && num(r.at) > 0)
            .sort((a, b) => num(b.at) - num(a.at))
            .slice(0, REQUESTS_READ);
        if (requests.length) {
            const outstanding = Math.max(0, debtorSummary(d, new Date(now)).outstanding);
            for (const r of requests) {
                const at = num(r.at);
                if (at > now + CLOCK_SKEW_MS || now - at > REQUEST_WINDOW_MS) continue;     // from the future (a wrong clock) or no longer news
                if (at < enabledAt - GRACE_MS) continue;                                    // pressed before the texts were switched on
                sink.push({
                    ...base, key: `B:${d.id}:bal:${str(r.id)}`, kind: KINDS.B_BALANCE, occurredAt: at, amount: outstanding, balance: outstanding,
                    dateISO: new Date(at + (Number.isFinite(base.tzMin) ? base.tzMin : LOCAL_OFFSET_MIN) * 60000).toISOString().slice(0, 10), maxAgeMs: REQUEST_WINDOW_MS,
                });
            }
        }
        // A late-payment reminder, when the owner asked for them for this debtor: the money is still owing, the date they were expected to pay by has passed.
        if (d[FIELDS.REMIND] === true && /^\d{4}-\d{2}-\d{2}$/.test(str(d.dueISO))) {
            const due = parseDay(str(d.dueISO));
            const remindAt = num(d[FIELDS.REMIND_AT]) > 0 ? num(d[FIELDS.REMIND_AT]) : enabledAt;
            const outstanding = Math.max(0, debtorSummary(d, new Date(now)).outstanding);
            // A repayment the owner has logged but not yet confirmed against the bank means the debtor says they have paid. Telling that person
            // "still outstanding" would be wrong in the very case the owner is in the middle of checking, so nothing is sent until it is settled
            // one way or the other (confirmed: owed again for what is really left; deleted: owed as before).
            const awaiting = events.some((e) => !e.confirmed && e.kind === EVENT.REPAYMENT);
            if (due && outstanding > 0 && !awaiting && remindAt <= now + CLOCK_SKEW_MS) {
                const tz = Number.isFinite(base.tzMin) ? base.tzMin : LOCAL_OFFSET_MIN;
                const dueStartUtc = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
                const push = (key, dayStart) => sink.push({
                    ...base, key, kind: KINDS.B_LATE, occurredAt: dayStart, amount: outstanding, balance: outstanding,
                    dateISO: str(d.dueISO), scheduled: true, notBefore: nextSendWindow(dayStart, tz), maxAgeMs: REMINDER_SHELF_MS + (nextSendWindow(dayStart, tz) - dayStart),
                });
                let inForce = 0;
                REMINDER_OFFSETS_DAYS.forEach((days, i) => {
                    const dayStart = dueStartUtc + days * 86400000 - tz * 60000;      // that day begins, where the debtor is
                    if (dayStart > now || now - dayStart >= REMINDER_WINDOW_MS) return;
                    inForce += 1;
                    push(`B:${d.id}:late:${str(d.dueISO)}:${i + 1}`, dayStart);
                });
                // All four have gone by (the owner ticked the box on a debtor who has been late for weeks): the reminder asked for is still owed, once, for the day it was asked.
                const lastDay = dueStartUtc + REMINDER_OFFSETS_DAYS[REMINDER_OFFSETS_DAYS.length - 1] * 86400000 - tz * 60000;
                if (!inForce && now >= lastDay) {
                    const asked = Math.max(enabledAt, remindAt);
                    const askedDay = Math.floor((asked + tz * 60000) / 86400000) * 86400000 - tz * 60000;
                    if (now - askedDay <= REMINDER_WINDOW_MS) push(`B:${d.id}:late:${str(d.dueISO)}:asked-${new Date(askedDay + tz * 60000).toISOString().slice(0, 10)}`, askedDay);
                }
            }
        }
        // LAYER B COMPUTES NO INTEREST. Not "skips if zero": the accrual is never reached, so a stray `rate` on a record cannot produce a notice.
    };

    for (const d of arr(user.debtors)) {
        if (!d || !d.id || !isOn(d)) continue;
        const sink = [];
        try { one(d, sink); out.push(...withSecondNumber(sink, sink.length ? secondNumber(d, sink[0].phone, 'debtor', issues) : '', secondSince(d, now))); } catch (_) { issues.push({ recordKind: 'debtor', recordId: str(d.id), reason: 'unreadable-record' }); }
    }
}

/**
 * Every notice the books say is owed, oldest first.
 * @param {object} user  the user's document: { income, incomeReceived, debtors, settings }
 * @param {number} now   epoch ms
 * @returns {{ events: object[], issues: object[] }}
 */
export function deriveEvents(user, now = Date.now()) {
    const u = user && typeof user === 'object' ? user : {};
    const currency = currencyOf(u.settings && u.settings.currency);
    const events = []; const issues = [];
    investmentEvents(u, now, currency, events, issues);
    debtorEvents(u, now, currency, events, issues);
    events.sort((a, b) => a.occurredAt - b.occurredAt || (a.key < b.key ? -1 : 1));
    return { events, issues };
}

/** Does this user have anything switched on at all? A cheap test for "should the sweep even read the document". */
export function hasSmsRecords(user) {
    const u = user || {};
    return arr(u.income).some(isOn) || arr(u.debtors).some(isOn);
}

export default { FIELDS, LAYER, interestApplies, GRACE_MS, MAX_AGE_MS, CLOCK_SKEW_MS, nextSendWindow, periodInterest, deriveEvents, hasSmsRecords };
