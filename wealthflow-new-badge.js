/* =============================================================================
 * wealthflow-new-badge.js — the "NEW" tag that puts itself on when the PERSON first sees something new, and takes itself off 7 days later   (window.WFNew)
 * -----------------------------------------------------------------------------
 * The owner's rule: when a feature or an option is new to WealthFlow it wears a small NEW label, with nobody having to remember to add it, and the label goes away by itself after 7 days.
 * Owner, 2026-11-07: the 7 days are counted from the day the USER FIRST SEES the thing, not from the day it shipped. Someone who has not opened the app for a month would otherwise come back to a feature whose label ended three weeks ago, and never learn it was new.
 * The AI Advisor used to carry a NEW tag that was put on by hand (index.html set its text on every launch) and never came off, so it said "new" about something that had been there for months.
 *
 * Two ways a label is earned, both ending the same way (7 days after the first sighting, then gone, with no one editing anything):
 *
 *   1. A screen that is NOT in BASELINE appears in the sidebar. Nothing has to be written: the first time this account sees the screen, it is stamped, and the label runs 7 days from that stamp.
 *      BASELINE is every screen that existed when this module shipped. A new screen is, by definition, not in it, so it is picked up without anyone touching this file.
 *   2. Anything else (an option in Settings, a button, a card) carries data-wf-new="YYYY-MM-DD", the day it shipped. The label starts when the element is first ON SCREEN for this person (a Settings row that has never been
 *      opened has not been seen) and runs 7 days from then, so a person who comes back after a month still gets the full week. It is one attribute, no script. An optional data-wf-new-id names the thing when the element has no id and its text may change.
 *      A thing that shipped BEFORE the person first opened WealthFlow is not new to them (a fresh install is not covered in labels): the account remembers the day it began (`since`), and only things dated on or after that day can be new.
 *
 * The first sighting is kept in two places and the EARLIEST wins: this device (localStorage) and the signed-in account (appData.newSeen, which the app's field-by-field sync carries to every device). So a thing seen on the phone on Monday has
 * three days left on the laptop on Thursday, not a fresh seven, and the books of the decoy login are never touched.
 *
 * What it does not do: it never hides, moves or re-words anything, it never counts as "needs attention" (the red dot on More is for real badges only), and a missing localStorage only means a stamp is made again on the next load (the label then runs a little longer, never shorter).
 *
 * The pure rules (fresh, daysLeft, parseDay, newScreens, mergeSeen, canBeNew) are exported and tested without a browser; the page part is the last function.
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
/** Reserved key inside the stamp map: when this account first opened WealthFlow (ms). Things dated before that day are not new to this person. */
export const SINCE = '_since';
const MAX_STAMPS = 300;

/** Two stamp maps in one, the EARLIEST first sighting winning for each key. Anything that is not a positive number is dropped. */
export function mergeSeen(a, b) {
    const out = {};
    for (const src of [a, b]) {
        if (!src || typeof src !== 'object') continue;
        for (const k of Object.keys(src)) {
            const v = src[k];
            if (typeof v === 'number' && Number.isFinite(v) && v > 0 && (!(k in out) || v < out[k])) out[k] = v;
        }
    }
    return out;
}

export function sameSeen(a, b) {
    const ka = Object.keys(a || {}), kb = Object.keys(b || {});
    return ka.length === kb.length && ka.every((k) => a[k] === (b || {})[k]);
}

/** UTC midnight of the day `ms` falls in. */
export function dayStart(ms) { return Math.floor(ms / DAY) * DAY; }

/**
 * Whether a thing that shipped on `shipMs` can be new to a person whose account began on `sinceMs`: only if it shipped on that day or later.
 * Without a known beginning nothing is new (a label that cannot be justified is not shown).
 */
export function canBeNew(shipMs, sinceMs) {
    if (!Number.isFinite(shipMs) || !Number.isFinite(sinceMs)) return false;
    return shipMs >= dayStart(sinceMs);
}

/** Keep the map small: past MAX_STAMPS the oldest stamps go (the beginning day never does). */
function trimSeen(map) {
    const keys = Object.keys(map).filter((k) => k !== SINCE);
    if (keys.length <= MAX_STAMPS) return map;
    keys.sort((x, y) => map[y] - map[x]);
    const keep = {}; if (SINCE in map) keep[SINCE] = map[SINCE];
    for (const k of keys.slice(0, MAX_STAMPS)) keep[k] = map[k];
    return keep;
}

/** First-sighting stamps kept on this device. localStorage, never throws; without it a stamp lasts for this page view. */
function makeStore(win) {
    let mem = {};
    return {
        all() { try { const v = JSON.parse(win.localStorage.getItem(STORE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (_) { return mem; } },
        put(all) { mem = all; try { win.localStorage.setItem(STORE_KEY, JSON.stringify(all)); } catch (_) { /* kept in memory */ } },
    };
}

/** The account's stamps, or null while the books are not open (signed out, locked, or the decoy books, which must never carry real data). */
function accountSeen(win) {
    try {
        if (win._isDecoyMode === true || !win.DB || typeof win.DB.getObj !== 'function') return null;
        const app = win.document.getElementById('app');
        if (!(app && app.classList.contains('show'))) return null;
        const o = win.DB.getObj('newSeen', {});
        return o && typeof o === 'object' ? o : {};
    } catch (_) { return null; }
}

function isShown(el) { try { return !!(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)); } catch (_) { return false; } }

/** A stable name for a dated thing: its own id, an explicit data-wf-new-id, or its date plus the start of its words. Letters, digits and dashes only, so it is safe as a field name in the account. */
function keyOf(el, day) {
    const slug = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const named = slug(el.getAttribute('data-wf-new-id') || el.id);
    if (named) return 'f:' + named;
    return 'f:' + day + '-' + slug(wordsOf(el));
}

/** The words of an element WITHOUT the NEW pill this module adds to it (or the name would change the moment the pill went on). */
function wordsOf(el) {
    let out = '';
    for (const n of Array.from(el.childNodes || [])) {
        if (n.nodeType === 3) out += n.textContent;
        else if (n.nodeType === 1 && !(n.classList && n.classList.contains('wf-new'))) out += ' ' + wordsOf(n);
        if (out.length > 160) break;
    }
    return out;
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

/** One pass over the page: dated things that are on screen, then new sidebar screens. Safe to run as often as the page changes. */
export function scan(doc, win, nowMs) {
    const store = makeStore(win);
    const local = store.all();
    const acct = accountSeen(win);
    const seen = mergeSeen(local, acct);
    if (!Number.isFinite(seen[SINCE])) seen[SINCE] = nowMs;
    let showing = 0;
    doc.querySelectorAll('[data-wf-new]').forEach((el) => {
        const day = el.getAttribute('data-wf-new');
        const ship = parseDay(day);
        if (!canBeNew(ship, seen[SINCE])) { mark(doc, el, NaN, nowMs); return; }
        const key = keyOf(el, day);
        let start = seen[key];
        if (!Number.isFinite(start)) {
            if (!isShown(el)) return;                 // not seen yet: the week has not started
            start = nowMs; seen[key] = start;
        }
        if (mark(doc, el, start, nowMs)) showing++;
    });
    doc.querySelectorAll('.sb-nav .nav-item').forEach((el) => {
        if (el.hasAttribute('data-wf-new')) return;
        const id = newScreens([el.getAttribute('onclick')])[0];
        if (!id) return;
        let start = seen[id];
        if (!Number.isFinite(start)) { start = nowMs; seen[id] = start; }
        if (mark(doc, el, start, nowMs)) showing++;
    });
    const next = trimSeen(seen);
    if (!sameSeen(next, local)) store.put(next);
    if (acct !== null && !sameSeen(next, acct)) { try { win.DB.set('newSeen', next); } catch (_) { /* the next pass tries again */ } }
    return showing;
}

const API = { DAYS, BASELINE, SINCE, parseDay, daysLeft, fresh, newScreens, mergeSeen, sameSeen, dayStart, canBeNew, scan };

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
    /* Opening a screen only flips a class, which the observer above does not watch: a click or a key that moves between screens is the moment a Settings row first comes on screen. */
    doc.addEventListener('click', later, true);
    doc.addEventListener('keyup', later, true);
    window.addEventListener('hashchange', later);
}

export default API;
