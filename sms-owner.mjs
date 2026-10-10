/* =============================================================================
 * sms-owner.mjs — due-date alerts the owner asked to get on their OWN phone
 * -----------------------------------------------------------------------------
 * WHY. The app's reminders (a loan instalment in 7, 3 or 1 days, a card payment, a cheque
 * about to clear) were drawn by timers in the browser, so nothing reached the owner while the
 * app was closed. This is the same set, derived on the server from the books like every other
 * notice (sms-events.mjs), sent by the same sweep and queue, so it needs no browser and no new
 * secret: a text to the number the owner typed.
 *
 * OFF UNLESS ASKED FOR. `settings.owner_sms = { enabled: true, phone, at }`. It costs units, so
 * it is the owner's switch, in the Text messages panel.
 *
 * ONE TEXT PER BAND. An item is owed one text in the band it is in (7 / 3 / 1 days, 0 = today),
 * not one for every band it passed through: a sweep that found a loan due in a day does not
 * also send the 7- and 3-day texts. Each band has its own key, so a repeat sweep sends nothing.
 *
 * Pure: `now` is passed in; no storage, no network. The window function is passed in as well
 * (sms-events.mjs owns it; importing it here would be a cycle).
 * ===========================================================================*/

import { normalizePhone, utcOffsetOf } from './wealthflow-phone.js';
import { KINDS } from './sms-templates.mjs';

export const OWNER_FIELD = 'owner_sms';
export const LOAN_BANDS = Object.freeze([7, 3, 1, 0]);
export const CARD_BANDS = Object.freeze([7, 3, 1, 0]);
export const CHEQUE_BANDS = Object.freeze([3, 1, 0]);
export const ONCE_BANDS = Object.freeze([14, 7, 3, 1, 0]);   // a one-time payment is one big rare sum: a fortnight's notice
export const BILL_BANDS = Object.freeze([3, 1, 0]);
const ONCE_RE = /^(once|one-time|onetime)$/;
const STEPS = Object.freeze({ monthly: 1, quarterly: 3, yearly: 12, annual: 12 });
const DAY = 86400000;
const LOCAL_OFFSET_MIN = 330;
const MAX_LOAN_MONTHS = 600;

const arr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const str = (v) => String(v == null ? '' : v).trim();
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The owner's switch, as stored, or null when it is off or has no usable number. */
export function ownerSettings(user) {
    const o = user && user.settings && user.settings[OWNER_FIELD];
    if (!o || o.enabled !== true) return null;
    return { phone: str(o.phone), at: num(o.at) };
}

export const ownerAlertsOn = (user) => !!ownerSettings(user);

const dayNumber = (iso) => (ISO.test(str(iso)) ? Date.parse(`${str(iso).slice(0, 10)}T00:00:00Z`) / DAY : NaN);
const isoOfDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);

/** The band an item due in `daysLeft` days is in now: the smallest band that still holds it, or -1 when it is not in any. */
export function bandFor(daysLeft, bands) {
    if (!Number.isInteger(daysLeft) || daysLeft < 0) return -1;
    let best = -1;
    for (const b of bands) if (daysLeft <= b && (best === -1 || b < best)) best = b;
    return best;
}

/** The loan's instalment due dates that matter now: [{ mk, dueISO }]. The day of the month is the start date's, clamped to the month's length. */
export function loanDues(loan, todayDay) {
    const start = str(loan && loan.start);
    const startDay = dayNumber(start);
    const months = Math.min(Math.max(0, Math.floor(num(loan && loan.duration))), MAX_LOAN_MONTHS);
    if (!Number.isFinite(startDay) || !months) return [];
    const [sy, sm, sd] = start.slice(0, 10).split('-').map(Number);
    const out = [];
    for (let i = 0; i < months; i += 1) {
        const y = sy + Math.floor((sm - 1 + i) / 12);
        const m = (sm - 1 + i) % 12;
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const dueDay = Date.UTC(y, m, Math.min(sd, last)) / DAY;
        if (dueDay <= startDay) continue;                          // the day the loan was taken is not an instalment
        if (dueDay < todayDay) continue;
        if (dueDay > todayDay + 7) break;                          // later instalments are further away still
        out.push({ mk: `${y}-${String(m + 1).padStart(2, '0')}`, dueISO: isoOfDay(dueDay) });
    }
    return out;
}

/** A one-time payment is finished once it is paid (and not reopened); a recurring bill is finished for a month once that month is on its history or has an actual figure. */
const onceDone = (sub) => (sub.paid === true || sub.completed === true) && sub.reopened !== true;
const billPaidIn = (sub, mk) => arr(sub.history).some((h) => h && h.paid !== false && (h.month === mk || str(h.date).slice(0, 7) === mk))
    || (sub.monthOverrides && typeof sub.monthOverrides[mk] === 'number');

/**
 * The due dates of a bill or one-time payment that matter now: [{ mk, dueISO, oneTime }].
 * A one-time payment has its one fixed date and is texted before it, never after (an overdue one is for the app to nag about, not for a text
 * every day); a recurring bill is looked at in this month and the next, on the cycle its first month set.
 */
export function subDues(sub, todayDay) {
    if (!sub) return [];
    const cycle = str(sub.cycle || 'monthly').toLowerCase();
    if (ONCE_RE.test(cycle)) {
        if (onceDone(sub)) return [];
        const exact = ISO.test(str(sub.dueDate).slice(0, 10)) ? str(sub.dueDate).slice(0, 10) : '';
        const made = ISO.test(str(sub.createdAt).slice(0, 10)) ? str(sub.createdAt).slice(0, 10) : '';
        let iso = exact;
        if (!iso && made && Number(sub.dueDay) >= 1) {
            const [y, m] = made.split('-').map(Number);
            iso = isoOfDay(Date.UTC(y, m - 1, Math.min(Math.floor(Number(sub.dueDay)), new Date(Date.UTC(y, m, 0)).getUTCDate())) / DAY);
        }
        const day = dayNumber(iso);
        return Number.isFinite(day) && day >= todayDay ? [{ mk: iso, dueISO: iso, oneTime: true }] : [];
    }
    const step = STEPS[cycle];
    const dueDay = Math.floor(Number(sub.dueDay));
    if (!step || !(dueDay >= 1 && dueDay <= 31)) return [];
    const made = str(sub.createdAt).slice(0, 10);
    const [ay, am] = ISO.test(made) ? made.split('-').map(Number) : [0, 0];
    if (!am && step !== 1) return [];                                 // a quarterly or yearly bill needs the month it started in
    const [ty, tm] = isoOfDay(todayDay).split('-').map(Number);
    const out = [];
    for (let k = 0; k < 2; k += 1) {
        const y = ty + Math.floor((tm - 1 + k) / 12);
        const m = (tm - 1 + k) % 12;
        if (am) { const elapsed = (y - ay) * 12 + (m + 1 - am); if (elapsed < 0 || elapsed % step) continue; }
        const mk = `${y}-${String(m + 1).padStart(2, '0')}`;
        const day = Date.UTC(y, m, Math.min(dueDay, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())) / DAY;
        if (day < todayDay || day > todayDay + 7 || billPaidIn(sub, mk)) continue;
        out.push({ mk, dueISO: isoOfDay(day), oneTime: false });
    }
    return out;
}

const paidMonth = (loan, mk) => arr(loan && loan.payments).some((p) => p && p.month === mk && p.paid);

/**
 * @param {object} user  the user's document
 * @param {number} now   epoch ms
 * @param {string} currency  3-letter code
 * @param {(ms:number, tzMin:number)=>number} nextWindow  next moment inside the sending window
 * @returns {{ events: object[], issues: object[] }}
 */
export function ownerEvents(user, now, currency, nextWindow) {
    const events = []; const issues = [];
    const mine = ownerSettings(user);
    if (!mine) return { events, issues };
    const p = normalizePhone(mine.phone);
    if (!p.ok) { issues.push({ recordKind: 'owner', recordId: 'owner', reason: mine.phone ? `phone-${p.reason}` : 'no-phone' }); return { events, issues }; }
    const tz = Number.isFinite(utcOffsetOf(p.e164)) ? utcOffsetOf(p.e164) : LOCAL_OFFSET_MIN;
    const today = Math.floor((now + tz * 60000) / DAY);                       // the owner's calendar day
    const base = { layer: 'O', recordKind: 'owner', phone: p.e164, tzMin: tz, subject: null, scheduled: true, currency };

    const push = ({ type, id, tag, label, amount, dueISO, bands, name }) => {
        const dueDay = dayNumber(dueISO);
        if (!Number.isFinite(dueDay)) return;
        const left = dueDay - today;
        const band = bandFor(left, bands);
        if (band < 0) return;
        // Owed from the start of the band's first day, and worthless once the due day is over.
        const from = (dueDay - band) * DAY - tz * 60000;
        const until = (dueDay + 1) * DAY - tz * 60000;
        events.push({
            ...base, key: `O:${type}:${id}:${tag}:d${band}`, kind: KINDS.O_DUE, recordId: `${type}:${id}`, ref: 'OWN',
            occurredAt: from, notBefore: nextWindow(Math.max(from, 0), tz), maxAgeMs: until - from,
            amount, what: type, label: str(name || label).slice(0, 24), dateISO: str(dueISO).slice(0, 10), days: left,
        });
    };

    for (const l of arr(user.loans)) {
        if (!l || !l.id || !(num(l.monthly) > 0)) continue;
        for (const d of loanDues(l, today)) {
            if (paidMonth(l, d.mk)) continue;
            push({ type: 'loan', id: l.id, tag: d.mk, name: l.name, label: 'loan', amount: num(l.monthly), dueISO: d.dueISO, bands: LOAN_BANDS });
        }
    }
    for (const c of arr(user.cconetime)) {
        if (!c || !c.id || c.paid || !(num(c.amount) > 0)) continue;
        push({ type: 'card', id: c.id, tag: str(c.deadline).slice(0, 10), name: c.desc, label: 'card', amount: num(c.amount), dueISO: c.deadline, bands: CARD_BANDS });
    }
    for (const c of arr(user.cheques)) {
        if (!c || !c.id || str(c.status) === 'cleared' || !(num(c.amount) > 0)) continue;
        push({ type: 'cheque', id: c.id, tag: str(c.release).slice(0, 10), name: c.number ? `#${str(c.number)}` : '', label: 'cheque', amount: num(c.amount), dueISO: c.release, bands: CHEQUE_BANDS });
    }
    for (const sub of arr(user.subscriptions)) {
        if (!sub || !sub.id || !(num(sub.amount) > 0)) continue;
        for (const d of subDues(sub, today)) {
            push({ type: d.oneTime ? 'once' : 'bill', id: sub.id, tag: d.mk, name: sub.name, label: 'bill', amount: num(sub.amount), dueISO: d.dueISO, bands: d.oneTime ? ONCE_BANDS : BILL_BANDS });
        }
    }
    return { events, issues };
}

export default { OWNER_FIELD, LOAN_BANDS, CARD_BANDS, CHEQUE_BANDS, ONCE_BANDS, BILL_BANDS, subDues, ownerSettings, ownerAlertsOn, bandFor, loanDues, ownerEvents };
