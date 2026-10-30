/* =============================================================================
 * wealthflow-sms-categories.js — which kinds of text message the owner wants
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-29: "which texts should come, from which sections: subscriptions, loans, investments, debtors and so on; the owner can switch each
 * one on or off, and then only the ones switched on are sent."
 *
 * ONE LIST, TWO READERS. The Settings screen draws a switch per category from CATEGORIES; the server (sms-events.mjs) drops every notice whose category
 * is off. Both read the same stored shape, so the screen can never say "off" while the server says "on":
 *
 *   settings.sms_cats = { loan: { on: false, at: 1788584400000 }, ... }
 *
 * A category with no entry is ON: nothing the owner already relies on changes the day this ships. `at` is when the switch was last touched.
 *
 * TWO GROUPS.
 *   own     texts to the owner's own verified number before something falls due (needs "Alerts to my own number" to be on):
 *           loan instalments, credit card payments, cheque release dates, one-time payments, subscriptions and bills.
 *   people  texts to the people the owner lends to or borrows from (each record also keeps its own "Send SMS notifications" box):
 *           investments, money lent (debtors), late-payment reminders.
 *
 * SWITCHING BACK ON IS NOT A BACKLOG. What happened while a "people" category was off (a repayment confirmed, interest applied) is history when it comes
 * back on, exactly as a record's own switch treats the past: only what happens from then on is texted. The "own" categories and late-payment reminders are
 * about what is still ahead or still owing, so they resume with whatever is due now.
 *
 * Pure: no storage, no clock, no network. Shared by the page and the server.
 * ===========================================================================*/

export const CATS_FIELD = 'sms_cats';

export const CATEGORIES = Object.freeze([
    { key: 'loan', group: 'own', label: 'Loan instalments', hint: 'To you, 7, 3 and 1 days before each instalment, and on the day.' },
    { key: 'card', group: 'own', label: 'Credit card payments', hint: 'To you, before a card payment you entered yourself is due.' },
    { key: 'cheque', group: 'own', label: 'Cheque release dates', hint: 'To you, 3 and 1 days before a cheque clears, and on the day.' },
    { key: 'once', group: 'own', label: 'One-time payments', hint: 'To you, from 14 days before a one-time payment is due.' },
    { key: 'bill', group: 'own', label: 'Subscriptions and bills', hint: 'To you, 3 and 1 days before a bill is due, and on the day.' },
    { key: 'investments', group: 'people', label: 'Investments', hint: 'To the investor: capital recorded, interest, receipts and the closing notice.' },
    { key: 'debtors', group: 'people', label: 'Money lent (debtors)', hint: 'To the borrower: money paid out, repayments with the balance, the balance on request and the closing notice.' },
    { key: 'late', group: 'people', label: 'Late-payment reminders', hint: 'To a borrower whose expected date has passed, only for people you ticked "remind when late" for.' },
]);

export const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((c) => c.key));

const DAY = 86400000;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const entryOf = (settings, key) => {
    const all = settings && isObj(settings[CATS_FIELD]) ? settings[CATS_FIELD] : null;
    const e = all && isObj(all[key]) ? all[key] : null;
    return e;
};

/** Is this kind of text switched on? A kind nobody has touched is on; only an explicit `on: false` turns it off. */
export function categoryOn(settings, key) {
    const e = entryOf(settings, key);
    return !(e && e.on === false);
}

/** When the owner last switched this kind ON (0 if they never touched it, or it is off). */
export function categorySince(settings, key) {
    const e = entryOf(settings, key);
    return e && e.on !== false ? num(e.at) : 0;
}

/** The settings object with this one switch changed. Never mutates its input; unknown keys are ignored. */
export function withCategory(settings, key, on, now) {
    const cur = settings && typeof settings === 'object' ? settings : {};
    if (!CATEGORY_KEYS.includes(key)) return cur;
    const all = isObj(cur[CATS_FIELD]) ? cur[CATS_FIELD] : {};
    return { ...cur, [CATS_FIELD]: { ...all, [key]: { on: on === true, at: num(now) } } };
}

/** Every category as { key, label, hint, group, on }, in the order the screen shows them. */
export function categoryList(settings) {
    return CATEGORIES.map((c) => ({ ...c, on: categoryOn(settings, c.key) }));
}

/** Which category a derived notice belongs to ('' when it belongs to none, which is never filtered). */
export function categoryOfEvent(ev) {
    const kind = String(ev && ev.kind || '');
    if (kind.startsWith('A.')) return 'investments';
    if (kind === 'B.late') return 'late';
    if (kind.startsWith('B.')) return 'debtors';
    if (kind === 'O.due') {
        const w = String(ev.what || '');
        return CATEGORY_KEYS.includes(w) ? w : '';
    }
    return '';
}

/** The category an issue about a record belongs to (so a switched-off kind does not nag about its own records). */
export function categoryOfIssue(issue) {
    const k = String(issue && issue.recordKind || '');
    return k === 'investment' ? 'investments' : k === 'debtor' ? 'debtors' : '';
}

/**
 * Keep only the notices whose category is on. For a "people" category that was switched back on, what happened before it was is history:
 * dropped (a scheduled day, like a period's interest, is judged by its day).
 */
export function filterEvents(settings, events, { graceMs = 10 * 60 * 1000 } = {}) {
    return (Array.isArray(events) ? events : []).filter((ev) => {
        const cat = categoryOfEvent(ev);
        if (!cat) return true;
        if (!categoryOn(settings, cat)) return false;
        if (cat !== 'investments' && cat !== 'debtors') return true;
        const since = categorySince(settings, cat);
        if (!(since > 0)) return true;
        const floor = ev.scheduled ? Math.floor(since / DAY) * DAY : since - graceMs;
        return num(ev.occurredAt) >= floor;
    });
}

export function filterIssues(settings, issues) {
    return (Array.isArray(issues) ? issues : []).filter((i) => { const c = categoryOfIssue(i); return !c || categoryOn(settings, c); });
}

export default { CATS_FIELD, CATEGORIES, CATEGORY_KEYS, categoryOn, categorySince, withCategory, categoryList, categoryOfEvent, categoryOfIssue, filterEvents, filterIssues };
