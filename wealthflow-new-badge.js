/* =============================================================================
 * wealthflow-new-badge.js — the "NEW" tag that puts itself on, and takes itself off after 7 days   (window.WFNew)
 * -----------------------------------------------------------------------------
 * The owner's rule: when a feature or an option is new to WealthFlow it wears a small NEW label, with nobody having to remember to add it, and the label goes away by itself after 7 days.
 * The AI Advisor used to carry a NEW tag that was put on by hand (index.html set its text on every launch) and never came off, so it said "new" about something that had been there for months.
 *
 * Two ways a label is earned, both ending the same way (7 days, then gone, with no one editing anything):
 *
 *   1. A screen that is NOT in BASELINE appears in the sidebar. Nothing has to be written: the first time this device sees the screen, it is stamped, and the label runs 7 days from that stamp.
 *      BASELINE is every screen that existed when this module shipped. A new screen is, by definition, not in it, so it is picked up without anyone touching this file.
 *   2. Anything else (an option in Settings, a button, a card) carries data-wf-new="YYYY-MM-DD", the day it shipped. The label runs 7 days from that day, on every device alike (a device that opens the app
 *      a month later sees nothing). This is the exact way, and the one a change should use for an option: one attribute, no script.
 *
 * What it does not do: it never hides, moves or re-words anything, it never counts as "needs attention" (the red dot on More is for real badges only), and a missing localStorage only means a new
 * screen is stamped again on the next load (the label then runs a little longer, never shorter).
 *
 * The pure rules (fresh, daysLeft, parseDay, newScreens) are exported and tested without a browser; the page part is the last function.
 * ===========================================================================*/

export const DAYS = 7;
const DAY = 86400000;

/** Every screen that existed when this module shipped (2026-10-21). A screen added later is not here, and so is new. */
export const BASELINE = [
    'dashboard', 'monthly', 'incRecv', 'income', 'loans', 'ccinstall', 'cconetime', 'cheques', 'liquidity', 'expenses', 'targets', 'dscr', 'score', 'crib', 'subscriptions', 'debtdemo', 'montecarlo',
    'cashflow3d', 'sessions', 'ai', 'settings', 'balance',
];

/** "2026-10-21" -> UTC midnight of that day in ms, or NaN for anything that is not a real calendar day. */
export function parseDay(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text == null ? '' : text).trim());
    if (!m) return NaN;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    const back = new Date(t);
    return back.getUTCFullYear() === +m[1] && back.getUTCMonth() === +m[2] - 1 && back.getUTCDate() === +m[3] ? t : NaN;
}

/**
 * Whole days still left on a label that started at `startMs` (7 on the first day, 1 on the last, 0 once it is over or when the start is not a time).
 * A start up to a day in the future still counts: the owner's clock and the date written in the source can sit a time zone apart.
 */
export function daysLeft(startMs, nowMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) return 0;
    if (nowMs < startMs - DAY) return 0;
    const left = Math.ceil((startMs + DAYS * DAY - nowMs) / DAY);
    return left > 0 ? Math.min(left, DAYS) : 0;
}

export function fresh(startMs, nowMs) { return daysLeft(startMs, nowMs) > 0; }

/** The screen ids in a list of sidebar `onclick` texts that are not in BASELINE, in the order they appear. */
export function newScreens(onclicks) {
    const out = [];
    for (const on of Array.isArray(onclicks) ? onclicks : []) {
        const m = /showPage\('([^']+)'/.exec(String(on || ''));
        if (m && !BASELINE.includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
}

const STORE_KEY = 'wf_new_seen_v1';

/** First-seen stamps for screens that carry no date of their own. localStorage, never throws; without it a stamp lasts for this page view. */
function makeStore(win) {
    let mem = {};
    const read = () => { try { const v = JSON.parse(win.localStorage.getItem(STORE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return mem; } };
    return {
        get(id) { const v = read()[id]; return Number.isFinite(v) ? v : NaN; },
        set(id, ms) {
            const all = read(); all[id] = ms; mem = all;
            try { win.localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch (_) { /* kept in memory */ }
        },
    };
}

function pillOf(el) {
    for (let i = 0; i < el.children.length; i++) if (el.children[i].classList.contains('wf-new')) return el.children[i];
    return null;
}

/** Put the label on `el` for the days left, or take it off. Returns whether it is showing. */
function mark(doc, el, startMs, nowMs) {
    const left = daysLeft(startMs, nowMs);
    const pill = pillOf(el);
    if (left <= 0) { if (pill) pill.remove(); return false; }
    if (!pill) {
        const p = doc.createElement('span');
        p.className = 'wf-new';
        p.textContent = 'NEW';
        p.setAttribute('data-left', String(left));
        p.title = left === 1 ? 'New. This label goes away tomorrow.' : 'New. This label goes away in ' + left + ' days.';
        el.appendChild(p);
    } else if (pill.getAttribute('data-left') !== String(left)) {
        pill.setAttribute('data-left', String(left));
        pill.title = left === 1 ? 'New. This label goes away tomorrow.' : 'New. This label goes away in ' + left + ' days.';
    }
    return true;
}

/** One pass over the page: dated elements, then new sidebar screens. Safe to run as often as the page changes. */
export function scan(doc, win, nowMs) {
    const store = makeStore(win);
    let showing = 0;
    doc.querySelectorAll('[data-wf-new]').forEach((el) => { if (mark(doc, el, parseDay(el.getAttribute('data-wf-new')), nowMs)) showing++; });
    doc.querySelectorAll('.sb-nav .nav-item').forEach((el) => {
        if (el.hasAttribute('data-wf-new')) return;
        const id = newScreens([el.getAttribute('onclick')])[0];
        if (!id) return;
        let start = store.get(id);
        if (!Number.isFinite(start)) { start = nowMs; store.set(id, start); }
        if (mark(doc, el, start, nowMs)) showing++;
    });
    return showing;
}

const API = { DAYS, BASELINE, parseDay, daysLeft, fresh, newScreens, scan };

if (typeof window !== 'undefined' && window.document) {
    window.WFNew = API;
    const doc = window.document;
    let timer = 0;
    const run = () => { timer = 0; try { scan(doc, window, Date.now()); } catch (e) { try { console.warn('[WFNew]', e); } catch (_) { /* quiet */ } } };
    /* A page draws its own cards when it is opened, so the page is looked at again a moment after it changes (one pass for a burst), and once an hour so a label expires on a screen left open. */
    const later = () => { if (!timer) timer = window.setTimeout(run, 400); };
    run();
    try { new window.MutationObserver(later).observe(doc.body || doc.documentElement, { childList: true, subtree: true }); } catch (_) { /* the hourly pass still runs */ }
    window.setInterval(run, 3600000);
    doc.addEventListener('visibilitychange', () => { if (!doc.hidden) later(); });
}

export default API;
