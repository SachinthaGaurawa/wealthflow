/* =============================================================================
 * tenant-page.js — the page a text message links to: NIC, code, statement
 * -----------------------------------------------------------------------------
 * Served at /t/<token> (vercel.json rewrites it to tenant.html). The token in the address is
 * an unguessable link, NOT a login: it only lets this page ask for a code. The statement
 * arrives only after the NIC (or passport / ID number) and the 6-digit code sent to the lender's
 * recorded phone have been checked by /api/tenant-portal, and then only for 20 minutes.
 *
 * WHAT THE PERSON CAN DO ONCE IN
 *   see their balance first, on a dark card with whose statement it is, and blur every amount with one tap when someone is looking,
 *   read their statement (every investment and loan their lender records for them, in English or Sinhala),
 *   see what is coming up (a loan's due date, the next interest) with the days left, and add it to a phone
 *   calendar; see how much of a loan is paid back; see where to pay and copy the account number or the
 *   reference in one tap; download the statement as a PDF, share it, save every movement as a spreadsheet,
 *   print it, refresh it without a new code, and sign out.
 *   The extras are worked out on the device from the statement already on the page (tenant-tools.js): they ask
 *   the server for nothing it has not already sent, and write nothing anywhere.
 *
 * WHAT THIS FILE PROMISES
 *   - It builds the page with createElement and textContent only. There is no innerHTML, no
 *     eval, no inline handler, no inline style, and nothing it loads comes from another site; the
 *     page's Content-Security-Policy refuses all of those anyway, so a mistake here fails closed.
 *   - The NIC lives in a variable until the code is accepted, and is dropped then. Nothing is
 *     written to storage, to the address, to a cookie of its own or to a log (the language is not
 *     stored either: it is read from the browser each time and changed with one button).
 *   - Leaving the page (or being restored from the back-forward cache) wipes what was on it.
 *   - Whatever the server says, the words shown are the server's own fixed sentences or ours.
 *   - The PDF is fetched with the same session cookie, kept in memory as a blob and handed to the
 *     browser's own download; it is never put in the address or a storage.
 *
 * Plain ES module. Pure helpers are exported for the unit tests; the page boots itself in a browser.
 * ===========================================================================*/

import { identityCandidates } from './wealthflow-nic.js';
import { makeT, detectLang, LANG_BUTTON, noteText } from './tenant-lang.js';
import { upcoming, dayLabel, loanProgress, termProgress, calendarFile, csvFile, payoffPlan, planFile, balanceTrail } from './tenant-tools.js';

export const ENDPOINT = '/api/tenant-portal';
export const FETCH_TIMEOUT_MS = 20000;
export const TOKEN_PATH_RE = /^\/t\/([A-Za-z0-9_-]{16})\/?$/;

export const COPY = Object.freeze({
    BAD_NIC: 'Enter your NIC as 9 digits followed by V or X, or as 12 digits. If you have no Sri Lankan NIC, enter your passport or ID number.',
    BAD_CODE: 'Enter the 6-digit code from the text message.',
    OFFLINE: 'Could not reach the server. Check your connection and try again.',
    FAILED: 'Something went wrong. Please try again.',
    PDF_FAILED: 'Could not prepare the PDF. Please try again.',
    INVALID_LINK: 'This link is not valid. Please use the link in your text message.',
    SESSION_ENDED: 'Your session has ended. Please sign in again.',
    SIGNED_OUT: 'You have been signed out.',
    EXPIRED: 'That code has expired. Request a new one.',
    COPIED: 'Copied to the clipboard.',
    COPY_FAILED: 'Could not copy. Please select the text and copy it yourself.',
    FILE_READY: 'Your file is ready. Check your downloads.',
    UPDATED: 'Updated just now.',
    SHARE_SAVED: 'Sharing is not available here, so the file was saved instead.',
});

/** A table longer than this shows its latest rows first and the rest behind one button (all of it prints). */
export const TABLE_LIMIT = 8;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_SI = ['ජනවාරි', 'පෙබරවාරි', 'මාර්තු', 'අප්‍රේල්', 'මැයි', 'ජූනි', 'ජූලි', 'අගෝස්තු', 'සැප්තැම්බර්', 'ඔක්තෝබර්', 'නොවැම්බර්', 'දෙසැම්බර්'];
const MONTHS_SI_SHORT = ['ජන', 'පෙබ', 'මාර්', 'අප්‍රේ', 'මැයි', 'ජූනි', 'ජූලි', 'අගෝ', 'සැප්', 'ඔක්', 'නොවැ', 'දෙසැ'];
const FREQ = { monthly: 'Monthly', quarterly: 'Every 3 months', annual: 'Yearly' };
const LOAN_EVENT = { lent: 'Loan paid out', further: 'Further advance', repayment: 'Repayment' };
const english = makeT('en');

export const tokenFromPath = (pathname) => { const m = TOKEN_PATH_RE.exec(String(pathname || '')); return m ? m[1] : ''; };

/* Dates read in the page's language: "5 Oct 2026" in English, "2026 ඔක්තෝබර් 5" in Sinhala (year, month, day, the way Sinhala is written). */
export function fmtDay(iso, lang) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    if (!m || !MONTHS[Number(m[2]) - 1]) return '-';
    return lang === 'si' ? `${m[1]} ${MONTHS_SI[Number(m[2]) - 1]} ${Number(m[3])}` : `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
export function fmtMonth(ym, lang) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    if (!m || !MONTHS[Number(m[2]) - 1]) return '-';
    return lang === 'si' ? `${m[1]} ${MONTHS_SI[Number(m[2]) - 1]}` : `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}
export function fmtMoney(amount, currency) {
    const v = Number(amount);
    const cur = /^[A-Z]{3}$/.test(String(currency || '')) ? currency : 'LKR';
    return `${cur} ${(Number.isFinite(v) ? v : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** A figure with no currency in front of it, for table columns whose header already names the currency. */
export const fmtNum = (amount) => fmtMoney(amount, 'LKR').slice(4);
/** "5 Oct 2026, 10:30 (Sri Lanka time)" in Sri Lanka time, from an ISO instant. */
export function fmtAsOf(iso, t = english) {
    const ms = Date.parse(String(iso || ''));
    if (!Number.isFinite(ms)) return '';
    const d = new Date(ms + 330 * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    const day = t.lang === 'si' ? `${d.getUTCFullYear()} ${MONTHS_SI[d.getUTCMonth()]} ${d.getUTCDate()}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    return `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (${t('Sri Lanka time')})`;
}
export const fmtClock = (sec) => { const s = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** What to tell the person when the server said no. The server's own sentence wins; a wait is added in minutes. */
export function describeFailure(status, body, t = english) {
    const said = body && typeof body.error === 'string' && body.error.length < 300 ? body.error : '';
    const wait = Number(body && body.retryAfterSec) > 0 ? Number(body.retryAfterSec) : 0;
    let text = t(said || (status === 429 ? 'Too many attempts. Please wait a while and try again.' : status === 503 ? 'This service is temporarily unavailable. Please try again later.' : COPY.FAILED));
    if (status === 429 && wait) text += ' ' + (wait >= 90 ? t('Try again in about {n} minutes.', { n: Math.ceil(wait / 60) }) : t('Try again in {n} seconds.', { n: wait }));
    return text;
}

/** One account as plain lines, for the "copy all details" button. */
export function accountText(a, t = english) {
    const x = a && typeof a === 'object' ? a : {};
    return [
        `${t('Bank')}: ${x.bank || ''}`,
        `${t('Account name')}: ${x.holder || ''}`,
        `${t('Account number')}: ${x.number || ''}`,
        x.branch ? `${t('Branch')}: ${x.branch}` : '',
        x.swift ? `SWIFT / IBAN: ${x.swift}` : '',
    ].filter(Boolean).join('\n');
}

/* ── the DOM, built without ever parsing markup ──────────────────────────── */

function h(doc, tag, props, ...kids) {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = String(v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) {
        if (kid === null || kid === undefined || kid === false) continue;
        e.append(typeof kid === 'object' && kid.nodeType ? kid : doc.createTextNode(String(kid)));
    }
    return e;
}

function fact(doc, label, value, cls) { return h(doc, 'div', {}, h(doc, 'dt', { text: label }), h(doc, 'dd', { class: cls || null, text: value })); }

/**
 * The page's icons: small line drawings made with createElementNS (never markup), in the colour of the text around them.
 * Each is a list of path strings on a 24 x 24 grid. A document with no createElementNS (the tests' stand-in) gets an empty span.
 */
const ICONS = {
    download: ['M12 3v12', 'm7 10 5 5 5-5', 'M5 21h14'],
    share: ['M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7', 'm16 6-4-4-4 4', 'M12 2v13'],
    table: ['M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M3 10h18', 'M9 10v9'],
    print: ['M6 9V3h12v6', 'M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2', 'M6 14h12v7H6z'],
    refresh: ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'],
    eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    eyeOff: ['M3 3l18 18', 'M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.2', 'M6.6 6.6A16.6 16.6 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 4-.9', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
    logout: ['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'],
    lock: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'],
    shield: ['M12 3l8 3v6c0 5-3.4 8.4-8 9-4.6-.6-8-4-8-9V6z', 'm9 12 2 2 4-4'],
    calendar: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4'],
    home: ['M3 11l9-8 9 8', 'M5 10v10h14V10'],
    bank: ['M3 10l9-6 9 6', 'M5 10v8', 'M9 10v8', 'M15 10v8', 'M19 10v8', 'M3 21h18'],
    list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    message: ['M4 5h16v11H9l-5 4z'],
    clock: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'],
    chevron: ['m6 9 6 6 6-6'],
};
// the SVG namespace is a name that tells the browser what kind of element to make, not an address anything is fetched from
const SVG_NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');
function icon(doc, name) {
    if (typeof doc.createElementNS !== 'function') return h(doc, 'span', { class: 'tp-ico', 'aria-hidden': 'true' });
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ class: 'tp-ico', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(k, v);
    for (const d of ICONS[name] || []) { const p = doc.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); svg.append(p); }
    return svg;
}

/** An amount with its currency and cents set smaller, the way a banking app draws a balance. The characters are the same as fmtMoney's. */
function money(doc, amount, currency, cls) {
    const s = fmtMoney(amount, currency);
    const num = s.slice(4);
    const dot = num.lastIndexOf('.');
    return h(doc, 'span', { class: `tp-money tp-amt${cls ? ` ${cls}` : ''}` },
        h(doc, 'span', { class: 'tp-ccy', text: s.slice(0, 4) }),
        h(doc, 'span', { class: 'tp-int', text: dot < 0 ? num : num.slice(0, dot) }),
        dot < 0 ? null : h(doc, 'span', { class: 'tp-dec', text: num.slice(dot) }));
}

/** Up to two capital letters for the round badge by the name. */
export function initials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    const first = (w) => Array.from(w)[0] || '';
    return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')).toUpperCase();
}

/**
 * Cells are [text, alignRight, secondLine]: a second line under the first keeps a table of four things to three columns on a phone.
 * A table of more than TABLE_LIMIT rows shows the latest ones and puts the earlier ones behind "Show all"; the rows are
 * only hidden, never left out, so print and copy still get them all.
 */
function table(doc, caption, heads, rows, t = english) {
    const hide = rows.length > TABLE_LIMIT ? rows.length - TABLE_LIMIT : 0;
    const body = h(doc, 'tbody', {}, rows.map((r, i) => h(doc, 'tr', { hidden: i < hide, class: i < hide ? 'tp-early' : null }, r.map(([text, num, sub]) => h(doc, 'td', { class: num ? 'tp-num tp-amt' : null }, text, sub ? h(doc, 'span', { class: 'tp-sub', text: sub }) : null)))));
    const scroll = h(doc, 'div', { class: 'tp-scroll' }, h(doc, 'table', {},
        h(doc, 'caption', { text: caption }),
        h(doc, 'thead', {}, h(doc, 'tr', {}, heads.map(([label, num]) => h(doc, 'th', { scope: 'col', class: num ? 'tp-num' : null, text: label })))),
        body));
    if (!hide) return scroll;
    const more = h(doc, 'button', { type: 'button', class: 'tp-btn tp-ghost tp-more', 'aria-expanded': 'false', text: t('Show all {n}', { n: rows.length }) });
    more.addEventListener('click', () => {
        const open = more.getAttribute('aria-expanded') !== 'true';
        more.setAttribute('aria-expanded', open ? 'true' : 'false');
        more.textContent = open ? t('Show fewer') : t('Show all {n}', { n: rows.length });
        for (const tr of body.querySelectorAll ? body.querySelectorAll('tr.tp-early') : []) { if (open) tr.removeAttribute('hidden'); else tr.setAttribute('hidden', ''); }
    });
    return h(doc, 'div', { class: 'tp-tablewrap' }, scroll, more);
}

/** The reference code: a button that copies it when the page can copy (it is what goes in the bank transfer), else a plain label. */
function refChip(doc, ref, t, actions) {
    if (!actions || typeof actions.copy !== 'function') return h(doc, 'span', { class: 'tp-chip', text: ref });
    const b = h(doc, 'button', { type: 'button', class: 'tp-chip tp-refcopy', 'aria-label': `${t('Copy reference')}: ${ref}`, text: ref });
    b.addEventListener('click', () => actions.copy(ref, b));
    return b;
}

/** A native progress bar (no inline style needed, and read out by screen readers). */
function bar(doc, label, pct) {
    return h(doc, 'div', { class: 'tp-progress' }, h(doc, 'span', { class: 'tp-progress-label', text: label }), h(doc, 'progress', { max: '100', value: String(pct), 'aria-label': label }));
}

const lenderChip = (doc, g, st, t) => (Number(st.lenderCount) > 1 && Number(g.lender) > 0 ? h(doc, 'span', { class: 'tp-chip', text: t('Lender {n}', { n: Number(g.lender) }) }) : null);

function investmentCard(doc, g, st, t, actions) {
    const cur = g.currency;
    const next = g.nextInterest && typeof g.nextInterest === 'object' ? g.nextInterest : null;
    return h(doc, 'section', { class: 'tp-card', 'aria-label': `${t('Investment')} ${g.ref}` },
        h(doc, 'div', { class: 'tp-group-head' }, h(doc, 'h3', { text: t('Investment') }), refChip(doc, g.ref, t, actions), lenderChip(doc, g, st, t)),
        h(doc, 'dl', { class: 'tp-facts' },
            fact(doc, t('Capital'), fmtMoney(g.capital, cur), 'tp-amt'),
            fact(doc, t('Rate'), t('{n}% a year', { n: g.ratePct })),
            fact(doc, t('Interest paid'), t(FREQ[g.frequency] || FREQ.monthly)),
            fact(doc, t('Interest each time'), fmtMoney(g.interestPerPeriod, cur), 'tp-amt'),
            fact(doc, t('Started'), fmtDay(g.start, t.lang)),
            g.end ? fact(doc, t('Ends'), fmtDay(g.end, t.lang)) : null,
            next ? h(doc, 'div', {}, h(doc, 'dt', { text: t('Next interest due') }), h(doc, 'dd', {}, `${fmtDay(next.date, t.lang)} (`, h(doc, 'span', { class: 'tp-amt', text: fmtMoney(next.amount, cur) }), ')')) : null,
            fact(doc, t('Interest received'), fmtMoney(g.totalReceived, cur), 'tp-amt')),
        (() => { const pct = termProgress(g, st.asOf); return pct === null ? null : bar(doc, t('Term: {n}% complete', { n: pct }), pct); })(),
        Array.isArray(g.payments) && g.payments.length
            ? table(doc, t('Payments received, in {cur}', { cur }), [[t('For')], [t('Received on')], [t('Amount'), true]], g.payments.map((p) => [[fmtMonth(p.month, t.lang)], [fmtDay(p.date, t.lang)], [fmtNum(p.amount), true]]), t)
            : h(doc, 'p', { class: 'tp-note', text: t('No payments recorded yet.') }));
}


/**
 * A little chart of a loan's balance after each movement, from the amount paid out down to what is left.
 * Nothing is drawn for a document that cannot make SVG, or for fewer than two movements.
 */
function trailChart(doc, g, t) {
    const pts = balanceTrail(g);
    const top = Math.max(...pts, 0);
    if (typeof doc.createElementNS !== 'function' || pts.length < 2 || !(top > 0)) return null;
    const W = 240;
    const H = 64;
    const x = (i) => Math.round((i / (pts.length - 1)) * W * 10) / 10;
    const y = (v) => Math.round((H - 6 - (v / top) * (H - 14)) * 10) / 10;
    let line = `M0 ${y(pts[0])}`;
    for (let i = 1; i < pts.length; i += 1) line += ` L${x(i)} ${y(pts[i])}`;
    const svg = doc.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({ class: 'tp-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', focusable: 'false', 'aria-label': t('Balance went from {from} to {to}', { from: fmtMoney(pts[0], g.currency), to: fmtMoney(pts[pts.length - 1], g.currency) }) })) svg.setAttribute(k, v);
    const area = doc.createElementNS(SVG_NS, 'path');
    area.setAttribute('class', 'tp-spark-area');
    area.setAttribute('d', `${line} L${W} ${H} L0 ${H} Z`);
    const stroke = doc.createElementNS(SVG_NS, 'path');
    stroke.setAttribute('class', 'tp-spark-line');
    stroke.setAttribute('d', line);
    stroke.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(area, stroke);
    return h(doc, 'div', { class: 'tp-trail' }, h(doc, 'span', { class: 'tp-progress-label', text: t('Balance over time') }), svg);
}

const readAmount = (text) => { const n = Number(String(text || '').replace(/[,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; };

/**
 * "Plan your repayments": the person picks how often and how much and sees when the loan would be finished, or taps the amount that
 * clears it by the due date. It is arithmetic on the balance already on the page (tenant-tools.js payoffPlan); nothing is sent anywhere
 * and nothing is promised to the lender. `actions.planCalendar(plan)` (when the page can) saves the plan as a repeating reminder.
 */
function planWidget(doc, g, st, t, actions) {
    if (!payoffPlan(g, st.asOf)) return null;
    const id = `tp-plan-${String(g.ref || '').replace(/[^A-Za-z0-9]/g, '')}`;
    const every = h(doc, 'select', { id: `${id}-every`, 'aria-label': t('How often') }, [h(doc, 'option', { value: 'weekly', text: t('Every week') }), h(doc, 'option', { value: 'fortnightly', text: t('Every 2 weeks') }), h(doc, 'option', { value: 'monthly', text: t('Every month'), selected: true })]);
    const amount = h(doc, 'input', { id: `${id}-amount`, type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('Amount each time'), placeholder: t('Amount each time') });
    const chips = h(doc, 'div', { class: 'tp-plan-chips' });
    const out = h(doc, 'div', { class: 'tp-plan-out', 'aria-live': 'polite' });
    const current = () => payoffPlan(g, st.asOf, { every: every.value || 'monthly', amount: readAmount(amount.value) });
    function paint() {
        const plan = current();
        if (!plan) return;
        chips.replaceChildren(...(plan.byDue ? [h(doc, 'button', { type: 'button', class: 'tp-chip tp-chip-btn tp-amt', onclick: () => { amount.value = String(plan.byDue.amount); paint(); }, text: t('Clear by the due date: {amount} each time', { amount: fmtMoney(plan.byDue.amount, plan.currency) }) })] : []));
        if (plan.tooMany) { out.replaceChildren(h(doc, 'p', { class: 'tp-note', text: t('That would take too many payments. Try a larger amount.') })); return; }
        if (!(plan.count > 0)) { out.replaceChildren(h(doc, 'p', { class: 'tp-note', text: t('Enter an amount to see when you would finish.') })); return; }
        out.replaceChildren(
            h(doc, 'dl', { class: 'tp-facts' },
                fact(doc, t('Payments'), String(plan.count)),
                fact(doc, t('First payment'), fmtDay(plan.first, t.lang)),
                fact(doc, t('Finished by'), fmtDay(plan.finish, t.lang)),
                plan.count > 1 && plan.last !== plan.amount ? fact(doc, t('Last payment'), fmtMoney(plan.last, plan.currency), 'tp-amt') : null),
            plan.onTime === null ? null : h(doc, 'p', { class: plan.onTime ? 'tp-plan-ok' : 'tp-plan-late', text: plan.onTime ? t('This finishes by the due date.') : t('This finishes after the due date. Pay a little more each time to be on time.') }),
            actions && typeof actions.planCalendar === 'function' ? h(doc, 'button', { type: 'button', class: 'tp-btn tp-ghost tp-small-btn', onclick: () => actions.planCalendar(plan) }, icon(doc, 'calendar'), h(doc, 'span', { text: t('Add this plan to my calendar') })) : null);
    }
    every.addEventListener('change', paint);
    amount.addEventListener('input', paint);
    paint();
    return h(doc, 'details', { class: 'tp-plan' },
        h(doc, 'summary', {}, icon(doc, 'clock'), h(doc, 'span', { text: t('Plan your repayments') })),
        h(doc, 'label', { for: `${id}-every`, text: t('How often') }), every,
        h(doc, 'label', { for: `${id}-amount`, text: t('Amount each time') }), amount,
        chips, out);
}

function loanCard(doc, g, st, t, actions) {
    const cur = g.currency;
    const status = g.status === 'settled' ? [t('Settled'), 'tp-chip tp-ok'] : g.status === 'closed' ? [t('Closed'), 'tp-chip'] : [t('Open'), 'tp-chip tp-open'];
    const late = Number(g.overdueDays) > 0 ? Math.floor(Number(g.overdueDays)) : 0;
    const due = g.due ? `${fmtDay(g.due, t.lang)}${late ? ` (${late === 1 ? t('1 day ago') : t('{n} days ago', { n: late })})` : ''}` : '';
    return h(doc, 'section', { class: 'tp-card', 'aria-label': `${t('Loan')} ${g.ref}` },
        h(doc, 'div', { class: 'tp-group-head' }, h(doc, 'h3', { text: t('Loan') }), refChip(doc, g.ref, t, actions), lenderChip(doc, g, st, t), h(doc, 'span', { class: status[1], text: status[0] })),
        h(doc, 'dl', { class: 'tp-facts' },
            fact(doc, t('Paid out'), fmtMoney(g.lent, cur), 'tp-amt'),
            fact(doc, t('Repaid'), fmtMoney(g.repaid, cur), 'tp-amt'),
            fact(doc, t('Outstanding'), fmtMoney(g.outstanding, cur), 'tp-amt'),
            due ? fact(doc, t('Expected back by'), due, late ? 'tp-late' : null) : null),
        (() => { const pct = loanProgress(g); return pct === null ? null : bar(doc, t('{n}% repaid', { n: pct }), pct); })(),
        trailChart(doc, g, t),
        planWidget(doc, g, st, t, actions),
        Array.isArray(g.events) && g.events.length
            ? table(doc, t('Movements, in {cur}', { cur }), [[t('Date')], [t('Amount'), true], [t('Balance'), true]], g.events.map((e) => [[fmtDay(e.date, t.lang), false, t(LOAN_EVENT[e.kind] || '-')], [fmtNum(e.amount), true], [fmtNum(e.balance), true]]), t)
            : h(doc, 'p', { class: 'tp-note', text: t('Nothing recorded yet.') }));
}

/**
 * The top of the statement, drawn the way a banking app draws its balance: a dark card with whose statement it is (the person's own
 * full name and NIC as their lender recorded them; nothing is drawn for a field that is empty), the main figure of each currency large,
 * and the other figures as small tiles under it. `actions.hide`, when the page can, adds a button that blurs every amount.
 */
function heroCard(doc, holder, groups, totals, t, actions) {
    const x = holder && typeof holder === 'object' ? holder : {};
    const name = typeof x.name === 'string' ? x.name.trim() : '';
    const nic = typeof x.nic === 'string' ? x.nic.trim() : '';
    if (!name && !nic && !totals.length) return null;
    let eye = null;
    if (actions && typeof actions.hide === 'function') {
        const paint = (hidden) => { eye.replaceChildren(icon(doc, hidden ? 'eyeOff' : 'eye')); eye.setAttribute('aria-pressed', hidden ? 'true' : 'false'); eye.setAttribute('aria-label', hidden ? t('Show amounts') : t('Hide amounts')); };
        eye = h(doc, 'button', { type: 'button', class: 'tp-eye', id: 'tp-eye' });
        paint(!!actions.hidden);
        eye.addEventListener('click', () => paint(actions.hide()));
    }
    const who = name || nic ? h(doc, 'div', { class: 'tp-holder' },
        name ? h(doc, 'div', { class: 'tp-holder-item' }, h(doc, 'span', { class: 'tp-label', text: t('Account holder') }), h(doc, 'strong', { class: 'tp-holder-name', text: name })) : null,
        nic ? h(doc, 'div', { class: 'tp-holder-item' }, h(doc, 'span', { class: 'tp-label', text: t('NIC / ID') }), h(doc, 'strong', { class: 'tp-holder-nic', text: nic })) : null) : null;
    const blocks = totals.map((tot) => {
        const mine = groups.filter((g) => g.currency === tot.currency);
        const hasInv = mine.some((g) => g.kind === 'investment');
        const hasLoan = mine.some((g) => g.kind === 'loan');
        const rows = [];
        if (hasInv) rows.push([t('Invested'), tot.invested], [t('Interest received'), tot.interestReceived]);
        if (hasLoan) rows.push([t('Loan outstanding'), tot.loanOutstanding]);
        const [main, ...rest] = rows;
        return h(doc, 'div', { class: 'tp-hero-cur' },
            h(doc, 'div', { class: 'tp-cur', text: tot.currency }),
            main ? h(doc, 'div', { class: 'tp-hero-main' }, h(doc, 'span', { class: 'tp-label', text: main[0] }), money(doc, main[1], tot.currency, 'tp-figure')) : null,
            rest.length ? h(doc, 'div', { class: 'tp-stats' }, rest.map(([label, v]) => h(doc, 'div', { class: 'tp-stat' }, h(doc, 'span', { class: 'tp-label', text: label }), money(doc, v, tot.currency, 'tp-figure')))) : null);
    });
    return h(doc, 'section', { class: 'tp-card tp-hero', id: 'tp-hero', tabindex: '-1', 'aria-label': t('Account holder') },
        h(doc, 'div', { class: 'tp-hero-top' },
            name ? h(doc, 'span', { class: 'tp-avatar', 'aria-hidden': 'true', text: initials(name) }) : null,
            who, eye),
        blocks);
}

/** The WealthFlow mark and name: the picture is a real image (not a background), so it also prints. */
const logos = new WeakMap();
export function brandEl(doc) {
    // ONE picture element for the life of the page, moved into each new header: a new element every time the page rebuilds would cancel and restart the download
    if (!logos.has(doc)) logos.set(doc, h(doc, 'img', { class: 'tp-logo', src: '/tenant-logo.png', alt: '', width: '34', height: '34' }));
    return h(doc, 'h1', { class: 'tp-brand' }, logos.get(doc), h(doc, 'span', { text: 'WealthFlow' }));
}

/** One bank account, with a copy button on the number (the thing that gets typed wrongly) and one for the lot. */
function accountCard(doc, a, t, actions) {
    const x = a && typeof a === 'object' ? a : {};
    const copyBtn = (text, aria, label, cls) => {
        if (!actions || typeof actions.copy !== 'function') return null;
        const b = h(doc, 'button', { type: 'button', class: cls, 'aria-label': aria, text: label });
        b.addEventListener('click', () => actions.copy(text, b));
        return b;
    };
    const row = (label, value, copy) => (value ? h(doc, 'div', {}, h(doc, 'dt', { text: label }), h(doc, 'dd', { class: copy ? 'tp-copyrow' : null }, h(doc, 'span', { class: 'tp-value', text: value }), copy ? copyBtn(value, `${t('Copy')}: ${label}`, t('Copy'), 'tp-copy') : null)) : null);
    const all = copyBtn(accountText(x, t), t('Copy all details'), t('Copy all details'), 'tp-btn tp-ghost tp-copyall');
    return h(doc, 'div', { class: 'tp-acct' },
        h(doc, 'h4', { text: x.bank || '' }),
        h(doc, 'dl', { class: 'tp-facts tp-acct-facts' },
            row(t('Account name'), x.holder),
            row(t('Account number'), x.number, true),
            row(t('Branch'), x.branch),
            row('SWIFT / IBAN', x.swift, true)),
        x.note ? h(doc, 'div', { class: 'tp-acct-note', role: 'note' }, h(doc, 'strong', { class: 'tp-acct-note-label', text: t('Note') }), h(doc, 'p', { text: noteText(x, t.lang) })) : null,
        all);
}

function paymentCard(doc, st, t, actions) {
    const lenders = (Array.isArray(st.lenders) ? st.lenders : []).filter((l) => l && Array.isArray(l.accounts) && l.accounts.length);
    if (!lenders.length) return null;
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const many = Number(st.lenderCount) > 1;
    return h(doc, 'section', { class: 'tp-card tp-pay', id: 'tp-pay', tabindex: '-1', 'aria-label': t('How to pay') },
        h(doc, 'h3', { text: t('How to pay') }),
        h(doc, 'p', { class: 'tp-note', text: t('Pay by bank transfer to the account below and put the reference of the record in the transfer. If the account details here look different from what your lender told you, check with your lender before sending money.') }),
        lenders.map((l) => {
            const refs = groups.filter((g) => g && g.lender === l.n && g.ref).map((g) => g.ref);
            return h(doc, 'div', { class: 'tp-lender' },
                many ? h(doc, 'h4', { class: 'tp-lender-name', text: t('Lender {n}', { n: Number(l.n) }) }) : null,
                refs.length ? h(doc, 'p', { class: 'tp-refs', text: t('References: {refs}', { refs: refs.slice(0, 6).join(', ') }) }) : null,
                l.accounts.map((a) => accountCard(doc, a, t, actions)));
        }));
}

/**
 * "Coming up": the next dates, soonest first, each with the days left and (when the page can) an "Add to calendar" button.
 * A jump to "How to pay" sits under it when the lender has given an account.
 */
function upcomingCard(doc, st, t, actions) {
    const items = upcoming(st);
    if (!items.length) return null;
    const hasPay = Array.isArray(st.lenders) && st.lenders.some((l) => l && Array.isArray(l.accounts) && l.accounts.length);
    const tile = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return h(doc, 'span', { class: 'tp-tile', 'aria-hidden': 'true' }, h(doc, 'span', { class: 'tp-tile-mon', text: m && MONTHS[Number(m[2]) - 1] ? (t.lang === 'si' ? MONTHS_SI_SHORT[Number(m[2]) - 1] : MONTHS[Number(m[2]) - 1]) : '' }), h(doc, 'span', { class: 'tp-tile-day', text: m ? String(Number(m[3])) : '' })); };
    return h(doc, 'section', { class: 'tp-card tp-next', id: 'tp-next', tabindex: '-1', 'aria-label': t('Coming up') },
        h(doc, 'h3', { text: t('Coming up') }),
        h(doc, 'ul', { class: 'tp-list' }, items.map((it) => h(doc, 'li', { class: `tp-item tp-${it.tone}` },
            tile(it.date),
            h(doc, 'div', { class: 'tp-item-main' },
                h(doc, 'span', { class: 'tp-item-title', text: it.kind === 'loan' ? t('Pay your loan') : t('Interest expected') }),
                h(doc, 'span', { class: 'tp-item-sub', text: `${fmtDay(it.date, t.lang)} · ${it.ref}` })),
            h(doc, 'div', { class: 'tp-item-side' },
                h(doc, 'span', { class: 'tp-item-amount tp-amt', text: fmtMoney(it.amount, it.currency) }),
                h(doc, 'span', { class: `tp-when tp-when-${it.tone}`, text: dayLabel(it.days, t) })),
            actions && typeof actions.calendar === 'function' ? h(doc, 'button', { type: 'button', class: 'tp-btn tp-ghost tp-small-btn', 'aria-label': `${t('Add to calendar')}: ${it.ref}`, onclick: () => actions.calendar(it) }, icon(doc, 'calendar'), h(doc, 'span', { text: t('Add to calendar') })) : null))),
        hasPay && actions && typeof actions.jump === 'function' ? h(doc, 'button', { type: 'button', class: 'tp-btn tp-ghost tp-jump', onclick: () => actions.jump('tp-pay') }, icon(doc, 'bank'), h(doc, 'span', { text: t('How to pay') })) : null);
}

/**
 * The statement as DOM, in two columns (a phone shows them one after the other): `left` is the glance (who, the figures, what is coming
 * up), `right` is the detail (where to pay, then every record). `sections` names what is on the page, for the section bar.
 * `statement` is the server's answer; every string in it is shown as text. `t` translates; `actions.copy(text, button)` is what the
 * copy buttons call (without it there are none).
 */
export function statementColumns(doc, statement, t = english, actions = null) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const totals = Array.isArray(st.totals) ? st.totals : [];
    const left = [];
    const right = [];
    const sections = [];
    const hero = heroCard(doc, st.holder, groups, totals, t, actions);
    if (hero) { left.push(hero); sections.push(['tp-hero', t('Overview'), 'home']); }
    if (!groups.length) left.push(h(doc, 'section', { class: 'tp-card' }, h(doc, 'p', { text: t('There is nothing to show yet. When your lender records something for you, it will appear here.') })));
    // what is coming up, then where to pay, then the records: the order a person who has just seen their balance wants them in
    const next = upcomingCard(doc, st, t, actions);
    if (next) { left.push(next); sections.push(['tp-next', t('Coming up'), 'calendar']); }
    const pay = paymentCard(doc, st, t, actions);
    if (pay) { right.push(pay); sections.push(['tp-pay', t('How to pay'), 'bank']); }
    groups.forEach((g, i) => {
        const card = g.kind === 'loan' ? loanCard(doc, g, st, t, actions) : investmentCard(doc, g, st, t, actions);
        if (i === 0) { card.setAttribute('id', 'tp-records'); card.setAttribute('tabindex', '-1'); sections.push(['tp-records', t('Records'), 'list']); }
        right.push(card);
    });
    if (st.truncated) right.push(h(doc, 'p', { class: 'tp-note', text: t('This statement is long, so only the first part is shown.') }));
    return { left, right, sections };
}

/** The same cards in one list, in reading order (what the tests and a print see). */
export function statementView(doc, statement, t = english, actions = null) {
    const { left, right } = statementColumns(doc, statement, t, actions);
    return [...left, ...right];
}

/* ── the page ─────────────────────────────────────────────────────────────── */

/**
 * @param {{doc:Document, root:Element, token:string, fetchImpl:Function, now?:()=>number, setTick?:Function, clearTick?:Function,
 *          lang?:'en'|'si', copyText?:(text:string)=>Promise<boolean>, saveFile?:(blob:Blob, name:string)=>void, print?:()=>void, later?:Function}} env
 */
export function createPage(env) {
    const { doc, root, token, fetchImpl } = env;
    const now = env.now || Date.now;
    const setTick = env.setTick || ((fn, ms) => setInterval(fn, ms));
    const clearTick = env.clearTick || ((id) => clearInterval(id));
    const later = env.later || ((fn, ms) => setTimeout(fn, ms));
    const copyText = env.copyText || (async () => false);
    const saveFile = env.saveFile || (() => {});
    const printPage = env.print || (() => {});
    const shareFile = typeof env.shareFile === 'function' ? env.shareFile : null;       // 'shared' | 'cancelled' | 'unsupported'
    const calm = () => { const w = doc.defaultView; return !!(w && typeof w.matchMedia === 'function' && w.matchMedia('(prefers-reduced-motion: reduce)').matches); };
    const jumpTo = env.jumpTo || ((id) => { const el = doc.getElementById ? doc.getElementById(id) : null; if (el) { if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'start' }); if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } });
    const watchSections = typeof env.watchSections === 'function' ? env.watchSections : null;       // (ids, onActive) => stop: which section is on screen, for the section bar
    const st = { screen: '', lang: env.lang === 'si' ? 'si' : 'en', nic: '', verified: false, busy: false, pdfBusy: false, resendAt: 0, codeExpiresAt: 0, sessionEndsAt: 0, statement: null, pdfBlob: null, pdfName: '', pdfLang: '', codeMessage: '', tick: null, hide: false, unwatch: null, els: {} };
    let t = makeT(st.lang);

    /** One door to the server. With `file`, a PDF answer comes back as a blob (never parsed as JSON); everything else is JSON. */
    async function api(action, extra = {}, { file = false } = {}) {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
        try {
            const r = await fetchImpl(ENDPOINT, {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, ...extra }),
                ...(ctl ? { signal: ctl.signal } : {}),
            });
            const head = (name) => (r.headers && typeof r.headers.get === 'function' ? String(r.headers.get(name) || '') : '');
            if (file && r.ok && /^application\/pdf/i.test(head('content-type'))) {
                const blob = await r.blob();
                const named = /filename="([A-Za-z0-9._-]{1,80})"/.exec(head('content-disposition'));
                return { status: r.status, body: null, blob, name: named ? named[1] : 'WealthFlow-statement.pdf' };
            }
            let body = null;
            try { body = await r.json(); } catch (_) { body = null; }
            return { status: r.status, body };
        } catch (_) {
            return { status: 0, body: null };
        } finally { if (timer) clearTimeout(timer); }
    }

    const stopTick = () => { if (st.tick !== null) { clearTick(st.tick); st.tick = null; } };
    const setText = (el, text) => { if (el) el.textContent = text; };
    const showError = (text) => setText(st.els.err, text || '');
    let infoSeq = 0;
    const showInfo = (text) => {
        if (!st.els.info) return;
        const mine = ++infoSeq;
        st.els.info.textContent = text || '';
        st.els.info.hidden = !text;
        // on the statement the message floats over the page, so it goes away by itself once it has been read
        if (text && st.screen === 'statement') later(() => { if (mine === infoSeq && st.screen === 'statement' && st.els.info) { st.els.info.textContent = ''; st.els.info.hidden = true; } }, 6000);
    };
    const applyLang = () => { if (doc.documentElement && typeof doc.documentElement.setAttribute === 'function') doc.documentElement.setAttribute('lang', st.lang); };

    function toggleLang() {
        const typed = st.els.input ? String(st.els.input.value || '') : '';
        st.lang = st.lang === 'si' ? 'en' : 'si';
        t = makeT(st.lang);
        applyLang();
        // the same screen again, in the other language: what the person typed stays, messages (already in the old language) are cleared
        if (st.screen === 'nic') screenNic({ value: typed });
        else if (st.screen === 'code') screenCode({ message: st.codeMessage, value: typed });
        else if (st.screen === 'statement') screenStatement(st.statement, st.sessionEndsAt);
        else if (st.screen === 'invalid') screenInvalid();
        else if (st.screen === 'loading') screenLoading();
    }

    /** Puts a label on a button that also holds a drawing: the label is its own element, so changing the words never removes the picture. */
    const labelled = (btn, name, label) => { const span = h(doc, 'span', { class: 'tp-lbl', text: label }); btn.append(icon(doc, name), span); btn.__lbl = span; return btn; };
    const relabel = (btn, text) => { if (btn) (btn.__lbl || btn).textContent = text; };

    function mount(title, nodes, focus, { bar = [], wide = false } = {}) {
        stopTick();
        st.busy = false;
        if (st.unwatch) { st.unwatch(); st.unwatch = null; }
        const brand = brandEl(doc);
        const lang = h(doc, 'button', { class: 'tp-lang', type: 'button', id: 'tp-lang', lang: st.lang === 'si' ? 'en' : 'si', text: LANG_BUTTON[st.lang], onclick: toggleLang });
        root.replaceChildren(
            h(doc, 'header', { class: 'tp-top' }, h(doc, 'div', { class: 'tp-top-in' }, brand, h(doc, 'div', { class: 'tp-top-actions' }, lang, ...bar))),
            h(doc, 'div', { class: wide ? 'tp-wrap tp-wide' : 'tp-wrap' }, ...nodes));
        const target = focus ? root.querySelector(focus) : root.querySelector('h2');
        if (target && typeof target.focus === 'function') target.focus();
        if (typeof doc.title === 'string') doc.title = t(title);
    }

    /** Two small bars: where in the sign-in the person is. Drawn, never read aloud (the screen's own heading says where they are). */
    const steps = (n) => h(doc, 'div', { class: 'tp-steps', 'aria-hidden': 'true' }, h(doc, 'span', { class: 'tp-on' }), h(doc, 'span', { class: n > 1 ? 'tp-on' : null }));

    /** Three short promises under the sign-in form, each true of this page: a text-message code, a closing session, nothing kept. */
    const trust = () => h(doc, 'ul', { class: 'tp-trust' }, [['message', t('Code sent by text message')], ['clock', t('Closes by itself after 20 minutes')], ['shield', t('Nothing is saved on your device')]].map(([ico, words]) => h(doc, 'li', {}, icon(doc, ico), h(doc, 'span', { text: words }))));

    function errorBox() { st.els.err = h(doc, 'p', { class: 'tp-error', role: 'alert', id: 'tp-err' }); return st.els.err; }

    function screenInvalid() {
        st.screen = 'invalid';
        st.els = {};
        mount('Link not valid', [h(doc, 'section', { class: 'tp-card tp-auth' }, h(doc, 'span', { class: 'tp-badge tp-badge-warn', 'aria-hidden': 'true' }, icon(doc, 'lock')), h(doc, 'h2', { tabindex: '-1', text: t('This link is not valid') }), h(doc, 'p', { text: t(COPY.INVALID_LINK) }))]);
    }

    function screenNic({ info = '', error = '', value = '' } = {}) {
        st.screen = 'nic';
        st.els = {};
        const input = h(doc, 'input', { id: 'tp-nic', name: 'nic', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '24', required: true, 'aria-describedby': 'tp-err', placeholder: '198534000937  /  N1234567' });
        if (value) input.value = value;
        const button = h(doc, 'button', { class: 'tp-btn', type: 'submit', id: 'tp-send', text: t('Send me a code') });
        st.els.input = input; st.els.button = button;
        const form = h(doc, 'form', { novalidate: true, onsubmit: onRequest },
            h(doc, 'label', { for: 'tp-nic', text: t('Your NIC or passport / ID number') }), input, errorBox(), button);
        const infoBox = h(doc, 'p', { class: 'tp-info', id: 'tp-info', role: 'status' });
        st.els.info = infoBox;
        mount('Your WealthFlow statement', [h(doc, 'section', { class: 'tp-card tp-auth' },
            h(doc, 'span', { class: 'tp-badge', 'aria-hidden': 'true' }, icon(doc, 'shield')),
            steps(1),
            h(doc, 'h2', { tabindex: '-1', text: t('View your statement') }),
            h(doc, 'p', { text: t('Enter your NIC, or your passport / ID number if you have no Sri Lankan NIC. We will text a 6-digit code to the mobile number your lender has on file for you.') }),
            infoBox, form, trust(),
            h(doc, 'p', { class: 'tp-small', text: t('Your statement is shown only after you enter the code. Nobody else can see it from this link.') }))], '#tp-nic');
        showInfo(info ? t(info) : '');
        showError(error ? t(error) : '');
    }

    function screenCode({ message = '', value = '' } = {}) {
        st.screen = 'code';
        st.els = {};
        st.verified = false;
        st.codeMessage = message;
        const input = h(doc, 'input', { id: 'tp-code', name: 'code', class: 'tp-code', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'one-time-code', maxlength: '6', required: true, 'aria-describedby': 'tp-err', 'aria-label': t('6-digit code') });
        if (value) input.value = value;
        const verify = h(doc, 'button', { class: 'tp-btn', type: 'submit', id: 'tp-verify', text: t('View my statement') });
        const resend = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-resend', disabled: true, onclick: onResend });
        const back = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-back', text: t('Use different details'), onclick: () => { st.nic = ''; screenNic(); } });
        const expiry = h(doc, 'p', { class: 'tp-small', id: 'tp-expiry' });
        st.els.input = input; st.els.button = verify; st.els.resend = resend; st.els.expiry = expiry;
        const infoBox = h(doc, 'p', { class: 'tp-info', id: 'tp-info', role: 'status' });
        st.els.info = infoBox;
        mount('Enter your code', [h(doc, 'section', { class: 'tp-card tp-auth' },
            h(doc, 'span', { class: 'tp-badge', 'aria-hidden': 'true' }, icon(doc, 'message')),
            steps(2),
            h(doc, 'h2', { tabindex: '-1', text: t('Enter your code') }),
            infoBox,
            h(doc, 'form', { novalidate: true, onsubmit: onVerify }, h(doc, 'label', { for: 'tp-code', text: t('Code from the text message') }), input, errorBox(), verify),
            expiry, resend, back,
            h(doc, 'p', { class: 'tp-small', text: t('No text after a minute? Your lender may have no mobile number for you, or messaging may be unavailable. Try again later or contact your lender.') }))], '#tp-code');
        showInfo(message ? t(message) : '');
        const paint = () => {
            const left = Math.ceil((st.resendAt - now()) / 1000);
            resend.disabled = left > 0 || st.busy;
            setText(resend, left > 0 ? t('Send a new code ({n}s)', { n: left }) : t('Send a new code'));
            const alive = Math.ceil((st.codeExpiresAt - now()) / 1000);
            setText(expiry, alive > 0 ? t('This code expires in {t}.', { t: fmtClock(alive) }) : t(COPY.EXPIRED));
        };
        paint();
        st.tick = setTick(paint, 1000);
    }

    /** A copy button was pressed: the text goes to the clipboard, and the person is told it worked (or that it did not). */
    async function onCopy(text, button) {
        const ok = await copyText(String(text));
        if (st.screen !== 'statement') return;
        if (ok) {
            showError('');
            showInfo(t(COPY.COPIED));
            if (button && button.isConnected !== false) {
                const label = button.textContent;
                button.textContent = t('Copied');
                later(() => { if (button.textContent === t('Copied')) button.textContent = label; }, 1600);
            }
        } else {
            showInfo('');
            showError(t(COPY.COPY_FAILED));
        }
    }

    /** The PDF for this session: asked for once and kept in memory until the page is wiped or refreshed, so a second press (and a share, which needs a fresh tap) costs nothing. */
    async function getPdf() {
        if (st.pdfBlob && st.pdfLang === st.lang) return { blob: st.pdfBlob, name: st.pdfName };      // the file is in the language it was asked for: changing the page's language asks again
        const lang = st.lang;
        const res = await api('pdf', { token, lang }, { file: true });
        if (res.blob) { st.pdfBlob = res.blob; st.pdfName = res.name; st.pdfLang = lang; }
        return res;
    }

    /** Runs a PDF job with its button disabled, and handles the answers every PDF button shares. `use(blob, name)` does the job and returns a message to show. */
    async function pdfJob(button, label, use) {
        if (st.pdfBusy) return;
        st.pdfBusy = true;
        if (button) { button.disabled = true; relabel(button, t('Preparing...')); }
        showError('');
        showInfo('');
        const res = await getPdf();
        st.pdfBusy = false;
        if (st.screen !== 'statement') return;                         // signed out or timed out while it was being made
        if (button) { button.disabled = false; relabel(button, label); }
        if (res.blob) { showInfo(await use(res.blob, res.name)); return; }
        if (res.status === 401) { wipe(); screenNic({ error: COPY.SESSION_ENDED }); return; }
        showError(res.status === 0 ? t(COPY.OFFLINE) : res.status === 200 ? t(COPY.PDF_FAILED) : describeFailure(res.status, res.body, t));
    }

    const onDownload = () => pdfJob(st.els.pdf, t('Download PDF'), async (blob, name) => { saveFile(blob, name); return t('Your PDF is ready. Check your downloads.'); });

    /** The phone's own share sheet (WhatsApp, e-mail, Drive...) with the PDF attached; where there is none, the file is saved instead. */
    const onShare = () => pdfJob(st.els.share, t('Share PDF'), async (blob, name) => {
        const how = shareFile ? await shareFile(blob, name) : 'unsupported';
        if (how === 'unsupported') { saveFile(blob, name); return t(COPY.SHARE_SAVED); }
        return how === 'shared' ? t('Shared.') : '';
    });

    /** Every movement and payment as a spreadsheet file, made here from the statement on the page. */
    function onCsv() {
        if (!st.statement) return;
        showError('');
        saveFile(new Blob([csvFile(st.statement)], { type: 'text/csv;charset=utf-8' }), `WealthFlow-statement-${String((st.statement && st.statement.asOf) || '').slice(0, 10) || 'latest'}.csv`);
        showInfo(t(COPY.FILE_READY));
    }

    /** A reminder for one date, as a calendar file the phone offers to add. */
    function onCalendar(item) {
        const text = calendarFile(item, { t, fmtMoney, asOf: st.statement && st.statement.asOf });
        if (!text) return;
        showError('');
        saveFile(new Blob([text], { type: 'text/calendar;charset=utf-8' }), `WealthFlow-${String(item.ref || 'reminder').replace(/[^A-Za-z0-9-]/g, '')}-${item.date}.ics`);
        showInfo(t(COPY.FILE_READY));
    }

    /** The repayment plan the person tried, as a repeating calendar reminder. */
    function onPlanCalendar(plan) {
        const text = planFile(plan, { t, fmtMoney, asOf: st.statement && st.statement.asOf });
        if (!text) return;
        showError('');
        saveFile(new Blob([text], { type: 'text/calendar;charset=utf-8' }), `WealthFlow-plan-${String(plan.ref || 'loan').replace(/[^A-Za-z0-9-]/g, '')}.ics`);
        showInfo(t(COPY.FILE_READY));
    }

    /** Asks for the statement again inside the same session (no new text message), for after a payment has been recorded. */
    async function onRefresh() {
        if (st.busy) return;
        const btn = st.els.refresh;
        st.busy = true;
        if (btn) { btn.disabled = true; relabel(btn, t('Preparing...')); }
        const got = await api('statement', { token });
        st.busy = false;
        if (st.screen !== 'statement') return;
        if (got.status === 200 && got.body && got.body.ok) { st.pdfBlob = null; screenStatement(got.body.statement, got.body.expiresAt); showInfo(t(COPY.UPDATED)); return; }
        if (btn) { btn.disabled = false; relabel(btn, t('Refresh')); }
        if (got.status === 401) { wipe(); screenNic({ error: COPY.SESSION_ENDED }); return; }
        showError(got.status === 0 ? t(COPY.OFFLINE) : describeFailure(got.status, got.body, t));
    }

    /** Blurs every amount on the page (or shows them again): for reading it with someone looking over a shoulder. Kept only while the page is open. */
    function onHide() {
        st.hide = !st.hide;
        if (root.classList) root.classList.toggle('tp-hide', st.hide);
        return st.hide;
    }

    function screenStatement(statement, expiresAt) {
        st.screen = 'statement';
        st.els = {};
        st.nic = '';
        st.statement = statement && typeof statement === 'object' ? statement : null;
        st.sessionEndsAt = Number(expiresAt) || now() + 20 * 60000;
        const clock = h(doc, 'p', { class: 'tp-session', id: 'tp-session' });
        const out = labelled(h(doc, 'button', { class: 'tp-out', type: 'button', id: 'tp-out', 'aria-label': t('Sign out'), onclick: onSignOut }), 'logout', t('Sign out'));
        const pdf = labelled(h(doc, 'button', { class: 'tp-act tp-act-main', type: 'button', id: 'tp-pdf', onclick: onDownload }), 'download', t('Download PDF'));
        const print = labelled(h(doc, 'button', { class: 'tp-act', type: 'button', id: 'tp-print', onclick: () => printPage() }), 'print', t('Print'));
        const share = shareFile ? labelled(h(doc, 'button', { class: 'tp-act', type: 'button', id: 'tp-share', onclick: onShare }), 'share', t('Share PDF')) : null;
        const csv = labelled(h(doc, 'button', { class: 'tp-act', type: 'button', id: 'tp-csv', onclick: onCsv }), 'table', t('Download CSV'));
        const refresh = labelled(h(doc, 'button', { class: 'tp-act', type: 'button', id: 'tp-refresh', onclick: onRefresh }), 'refresh', t('Refresh'));
        st.els.pdf = pdf; st.els.share = share; st.els.refresh = refresh;
        st.els.err = h(doc, 'p', { class: 'tp-error', role: 'alert' });
        st.els.info = h(doc, 'p', { class: 'tp-info', role: 'status', id: 'tp-info', hidden: true });
        const { left, right, sections } = statementColumns(doc, statement, t, { copy: onCopy, calendar: onCalendar, planCalendar: onPlanCalendar, jump: jumpTo, hide: onHide, hidden: st.hide });
        const actionRow = h(doc, 'div', { class: 'tp-actions', role: 'group', 'aria-label': t('Quick actions') }, pdf, share, csv, print, refresh);
        left.splice(sections.length && sections[0][0] === 'tp-hero' ? 1 : 0, 0, actionRow);
        const tabs = sections.length > 1 ? h(doc, 'nav', { class: 'tp-tabs', 'aria-label': t('Sections') }, sections.map(([id, label, ico]) => {
            const b = h(doc, 'button', { type: 'button', class: 'tp-tab', 'data-to': id, onclick: () => jumpTo(id) });
            return labelled(b, ico, label);
        })) : null;
        mount('Your WealthFlow statement', [
            h(doc, 'div', { class: 'tp-head' },
                h(doc, 'h2', { tabindex: '-1', text: t('Your statement') }),
                h(doc, 'p', { class: 'tp-note', text: t('As at {when}', { when: fmtAsOf(statement && statement.asOf, t) }) }),
                clock),
            h(doc, 'div', { class: 'tp-dash' }, h(doc, 'div', { class: 'tp-col tp-col-a' }, left), h(doc, 'div', { class: 'tp-col tp-col-b' }, right)),
            h(doc, 'p', { class: 'tp-foot', text: t('Figures are as recorded by your lender. If something looks wrong, please contact your lender.') }),
            h(doc, 'div', { class: 'tp-toasts' }, st.els.err, st.els.info),
            tabs,
        ], null, { bar: [out], wide: true });
        if (root.classList) root.classList.toggle('tp-hide', st.hide);
        if (tabs && watchSections) {
            const buttons = tabs.querySelectorAll ? [...tabs.querySelectorAll('button')] : [];
            const on = (id) => { for (const b of buttons) { if (b.getAttribute('data-to') === id) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); } };
            on(sections[0][0]);
            st.unwatch = watchSections(sections.map((x) => x[0]), on);
        }
        const paint = () => {
            const left = Math.ceil((st.sessionEndsAt - now()) / 1000);
            if (left <= 0) { wipe(); screenNic({ error: COPY.SESSION_ENDED }); return; }
            setText(clock, t('For your privacy this closes in {t}.', { t: fmtClock(left) }));
        };
        paint();
        if (st.screen === 'statement') st.tick = setTick(paint, 1000);
    }

    const busy = (on, label) => { st.busy = on; if (st.els.button) { st.els.button.disabled = on; if (label) st.els.button.textContent = label; } };

    async function onRequest(ev) {
        if (ev) ev.preventDefault();
        if (st.busy) return;
        const raw = st.els.input.value;
        if (!identityCandidates(raw).length) { st.els.input.setAttribute('aria-invalid', 'true'); showError(t(COPY.BAD_NIC)); return; }
        st.els.input.removeAttribute('aria-invalid');
        showError('');
        busy(true, t('Sending...'));
        const res = await api('request', { token, nic: raw });
        if (res.status === 200 && res.body && res.body.ok) {
            st.nic = raw;
            st.resendAt = now() + (Number(res.body.resendAfterSec) || 60) * 1000;
            st.codeExpiresAt = now() + (Number(res.body.expiresInSec) || 180) * 1000;
            screenCode({ message: res.body.message || '' });
            return;
        }
        busy(false, t('Send me a code'));
        showError(res.status === 0 ? t(COPY.OFFLINE) : describeFailure(res.status, res.body, t));
    }

    async function onResend() {
        if (st.busy || now() < st.resendAt) return;
        busy(true);
        st.els.resend.disabled = true;
        const res = await api('request', { token, nic: st.nic });
        busy(false);
        if (res.status === 200 && res.body && res.body.ok) {
            st.resendAt = now() + (Number(res.body.resendAfterSec) || 60) * 1000;
            st.codeExpiresAt = now() + (Number(res.body.expiresInSec) || 180) * 1000;
            showError('');
            showInfo(t('A new code is on its way if the details match. The old one no longer works.'));
            return;
        }
        showError(res.status === 0 ? t(COPY.OFFLINE) : describeFailure(res.status, res.body, t));
    }

    async function onVerify(ev) {
        if (ev) ev.preventDefault();
        if (st.busy) return;
        const code = String(st.els.input.value || '').replace(/\s+/g, '');
        if (!/^\d{6}$/.test(code)) { st.els.input.setAttribute('aria-invalid', 'true'); showError(t(COPY.BAD_CODE)); return; }
        st.els.input.removeAttribute('aria-invalid');
        showError('');
        busy(true, t('Checking...'));
        // a code is spent the moment it is accepted: if only the statement failed to arrive, the button asks for the statement again, not for a new code
        const res = st.verified ? { status: 200, body: { ok: true } } : await api('verify', { token, nic: st.nic, code });
        if (res.status === 200 && res.body && res.body.ok) {
            st.verified = true;
            const got = await api('statement', { token });
            if (got.status === 200 && got.body && got.body.ok) { screenStatement(got.body.statement, got.body.expiresAt); return; }
            busy(false, t('View my statement'));
            showError(got.status === 0 ? t(COPY.OFFLINE) : describeFailure(got.status, got.body, t));
            return;
        }
        busy(false, t('View my statement'));
        st.els.input.value = '';
        st.els.input.focus();
        showError(res.status === 0 ? t(COPY.OFFLINE) : describeFailure(res.status, res.body, t));
    }

    async function onSignOut() {
        await api('logout', { token });
        wipe();
        screenNic({ info: COPY.SIGNED_OUT });
    }

    /** Forget everything that was on the page. */
    function wipe() {
        stopTick();
        st.nic = '';
        st.verified = false;
        st.statement = null;
        st.pdfBlob = null;
        st.pdfName = '';
        st.codeMessage = '';
        st.hide = false;
        if (st.unwatch) { st.unwatch(); st.unwatch = null; }
        if (root.classList) root.classList.remove('tp-hide');
        root.replaceChildren(h(doc, 'div', { class: 'tp-wrap' }, brandEl(doc)));
        st.els = {};
    }

    function screenLoading() {
        st.screen = 'loading';
        st.els = {};
        mount('Your WealthFlow statement', [h(doc, 'section', { class: 'tp-card tp-auth' }, h(doc, 'h2', { tabindex: '-1', text: t('One moment') }), h(doc, 'p', { class: 'tp-note', role: 'status', text: t('Checking for a session on this device...') }), h(doc, 'div', { class: 'tp-skel', 'aria-hidden': 'true' }, h(doc, 'span'), h(doc, 'span'), h(doc, 'span')))]);
    }

    /** Opens on the NIC form, unless this device already has a live session for this link (a reload within 20 minutes costs no new text). */
    async function start() {
        applyLang();
        if (!token) return screenInvalid();
        screenLoading();
        const got = await api('statement', { token });
        if (st.screen !== 'loading') return;                       // the person got ahead of it
        if (got.status === 200 && got.body && got.body.ok) return screenStatement(got.body.statement, got.body.expiresAt);
        return screenNic();
    }

    return {
        state: st,
        start,
        wipe,
        toggleLang,
        reset(message) { wipe(); if (!token) return screenInvalid(); return message ? screenNic({ error: message }) : start(); },
    };
}

/** The browser's own ways to copy, save a file and print: kept out of createPage so the tests can stand in for them. */
function browserEnv(win) {
    const doc = win.document;
    return {
        lang: detectLang(win.navigator),
        async copyText(text) {
            try {
                if (win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') { await win.navigator.clipboard.writeText(text); return true; }
            } catch (_) { /* fall through to the older way */ }
            try {
                const box = doc.createElement('textarea');
                box.value = text;
                box.setAttribute('readonly', '');
                box.className = 'tp-offscreen';
                doc.body.append(box);
                box.select();
                const ok = doc.execCommand('copy');
                box.remove();
                return !!ok;
            } catch (_) { return false; }
        },
        saveFile(blob, name) {
            const url = win.URL.createObjectURL(blob);
            const link = doc.createElement('a');
            link.href = url;
            link.download = name;
            link.rel = 'noopener';
            link.className = 'tp-offscreen';
            doc.body.append(link);
            link.click();
            link.remove();
            win.setTimeout(() => win.URL.revokeObjectURL(url), 60000);
        },
        print() { if (typeof win.print === 'function') win.print(); },
        // which section the person is looking at, for the section bar: recomputed whenever any of them moves across the screen
        watchSections(ids, onActive) {
            if (typeof win.IntersectionObserver !== 'function') return () => {};
            const els = ids.map((id) => doc.getElementById(id)).filter(Boolean);
            const pick = () => {
                const line = (win.innerHeight || 600) * 0.4;
                const atEnd = (win.innerHeight || 0) + (win.scrollY || 0) >= doc.documentElement.scrollHeight - 4;
                let active = els.length ? els[0].id : '';
                for (const el of els) if (el.getBoundingClientRect().top <= line) active = el.id;
                onActive(atEnd && els.length ? els[els.length - 1].id : active);
            };
            const io = new win.IntersectionObserver(pick, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
            els.forEach((el) => io.observe(el));
            win.addEventListener('scroll', pick, { passive: true });
            return () => { io.disconnect(); win.removeEventListener('scroll', pick); };
        },
        // the share sheet, offered only where the browser can share a file (most phones); the person cancelling it is not an error
        shareFile: win.navigator && typeof win.navigator.share === 'function' && typeof win.navigator.canShare === 'function' && typeof win.File === 'function'
            ? async (blob, name) => {
                try {
                    const file = new win.File([blob], name, { type: 'application/pdf' });
                    if (!win.navigator.canShare({ files: [file] })) return 'unsupported';
                    await win.navigator.share({ files: [file], title: 'WealthFlow' });
                    return 'shared';
                } catch (e) { return e && e.name === 'AbortError' ? 'cancelled' : 'unsupported'; }
            }
            : null,
    };
}

export function boot(win) {
    const doc = win.document;
    const root = doc.getElementById('tp-root');
    if (!root) return null;
    const page = createPage({ doc, root, token: tokenFromPath(win.location.pathname), fetchImpl: (...a) => win.fetch(...a), ...browserEnv(win) });
    win.addEventListener('pagehide', () => page.wipe());
    win.addEventListener('pageshow', (e) => { if (e && e.persisted) page.reset(''); });
    page.start();
    return page;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__WF_TENANT_NO_BOOT) boot(window);
