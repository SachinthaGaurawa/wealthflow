/* =============================================================================
 * tenant-page.js — the page a text message links to: NIC, code, statement
 * -----------------------------------------------------------------------------
 * Served at /t/<token> (vercel.json rewrites it to tenant.html). The token in the address is
 * an unguessable link, NOT a login: it only lets this page ask for a code. The statement
 * arrives only after the NIC (or passport / ID number) and the 6-digit code sent to the lender's
 * recorded phone have been checked by /api/tenant-portal, and then only for 20 minutes.
 *
 * WHAT THE PERSON CAN DO ONCE IN
 *   read their statement (every investment and loan their lender records for them, in English or Sinhala),
 *   see when the next payment is due, see where to pay and copy the account number in one tap,
 *   download the statement as a PDF, print it, and sign out.
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
import { makeT, detectLang, LANG_BUTTON } from './tenant-lang.js';

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
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FREQ = { monthly: 'Monthly', quarterly: 'Every 3 months', annual: 'Yearly' };
const LOAN_EVENT = { lent: 'Loan paid out', further: 'Further advance', repayment: 'Repayment' };
const english = makeT('en');

export const tokenFromPath = (pathname) => { const m = TOKEN_PATH_RE.exec(String(pathname || '')); return m ? m[1] : ''; };

export function fmtDay(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m && MONTHS[Number(m[2]) - 1] ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '-';
}
export function fmtMonth(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
    return m && MONTHS[Number(m[2]) - 1] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '-';
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
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (${t('Sri Lanka time')})`;
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

/** Cells are [text, alignRight, secondLine]: a second line under the first keeps a table of four things to three columns on a phone. */
function table(doc, caption, heads, rows) {
    return h(doc, 'div', { class: 'tp-scroll' }, h(doc, 'table', {},
        h(doc, 'caption', { text: caption }),
        h(doc, 'thead', {}, h(doc, 'tr', {}, heads.map(([label, num]) => h(doc, 'th', { scope: 'col', class: num ? 'tp-num' : null, text: label })))),
        h(doc, 'tbody', {}, rows.map((r) => h(doc, 'tr', {}, r.map(([text, num, sub]) => h(doc, 'td', { class: num ? 'tp-num' : null }, text, sub ? h(doc, 'span', { class: 'tp-sub', text: sub }) : null)))))));
}

const lenderChip = (doc, g, st, t) => (Number(st.lenderCount) > 1 && Number(g.lender) > 0 ? h(doc, 'span', { class: 'tp-chip', text: t('Lender {n}', { n: Number(g.lender) }) }) : null);

function investmentCard(doc, g, st, t) {
    const cur = g.currency;
    const next = g.nextInterest && typeof g.nextInterest === 'object' ? g.nextInterest : null;
    return h(doc, 'section', { class: 'tp-card', 'aria-label': `${t('Investment')} ${g.ref}` },
        h(doc, 'div', { class: 'tp-group-head' }, h(doc, 'h3', { text: t('Investment') }), h(doc, 'span', { class: 'tp-chip', text: g.ref }), lenderChip(doc, g, st, t)),
        h(doc, 'dl', { class: 'tp-facts' },
            fact(doc, t('Capital'), fmtMoney(g.capital, cur)),
            fact(doc, t('Rate'), t('{n}% a year', { n: g.ratePct })),
            fact(doc, t('Interest paid'), t(FREQ[g.frequency] || FREQ.monthly)),
            fact(doc, t('Interest each time'), fmtMoney(g.interestPerPeriod, cur)),
            fact(doc, t('Started'), fmtDay(g.start)),
            g.end ? fact(doc, t('Ends'), fmtDay(g.end)) : null,
            next ? fact(doc, t('Next interest due'), `${fmtDay(next.date)} (${fmtMoney(next.amount, cur)})`) : null,
            fact(doc, t('Interest received'), fmtMoney(g.totalReceived, cur))),
        Array.isArray(g.payments) && g.payments.length
            ? table(doc, t('Payments received, in {cur}', { cur }), [[t('For')], [t('Received on')], [t('Amount'), true]], g.payments.map((p) => [[fmtMonth(p.month)], [fmtDay(p.date)], [fmtNum(p.amount), true]]))
            : h(doc, 'p', { class: 'tp-note', text: t('No payments recorded yet.') }));
}

function loanCard(doc, g, st, t) {
    const cur = g.currency;
    const status = g.status === 'settled' ? [t('Settled'), 'tp-chip tp-ok'] : g.status === 'closed' ? [t('Closed'), 'tp-chip'] : [t('Open'), 'tp-chip tp-open'];
    const late = Number(g.overdueDays) > 0 ? Math.floor(Number(g.overdueDays)) : 0;
    const due = g.due ? `${fmtDay(g.due)}${late ? ` (${late === 1 ? t('1 day ago') : t('{n} days ago', { n: late })})` : ''}` : '';
    return h(doc, 'section', { class: 'tp-card', 'aria-label': `${t('Loan')} ${g.ref}` },
        h(doc, 'div', { class: 'tp-group-head' }, h(doc, 'h3', { text: t('Loan') }), h(doc, 'span', { class: 'tp-chip', text: g.ref }), lenderChip(doc, g, st, t), h(doc, 'span', { class: status[1], text: status[0] })),
        h(doc, 'dl', { class: 'tp-facts' },
            fact(doc, t('Paid out'), fmtMoney(g.lent, cur)),
            fact(doc, t('Repaid'), fmtMoney(g.repaid, cur)),
            fact(doc, t('Outstanding'), fmtMoney(g.outstanding, cur)),
            due ? fact(doc, t('Expected back by'), due, late ? 'tp-late' : null) : null),
        Array.isArray(g.events) && g.events.length
            ? table(doc, t('Movements, in {cur}', { cur }), [[t('Date')], [t('Amount'), true], [t('Balance'), true]], g.events.map((e) => [[fmtDay(e.date), false, t(LOAN_EVENT[e.kind] || '-')], [fmtNum(e.amount), true], [fmtNum(e.balance), true]]))
            : h(doc, 'p', { class: 'tp-note', text: t('Nothing recorded yet.') }));
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
        x.note ? h(doc, 'p', { class: 'tp-note', text: x.note }) : null,
        all);
}

function paymentCard(doc, st, t, actions) {
    const lenders = (Array.isArray(st.lenders) ? st.lenders : []).filter((l) => l && Array.isArray(l.accounts) && l.accounts.length);
    if (!lenders.length) return null;
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const many = Number(st.lenderCount) > 1;
    return h(doc, 'section', { class: 'tp-card tp-pay', 'aria-label': t('How to pay') },
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
 * The statement as DOM. `statement` is the server's answer; every string in it is shown as text.
 * `t` translates; `actions.copy(text, button)` is what the copy buttons call (without it there are none).
 */
export function statementView(doc, statement, t = english, actions = null) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const totals = Array.isArray(st.totals) ? st.totals : [];
    const out = [];
    if (!groups.length) out.push(h(doc, 'section', { class: 'tp-card' }, h(doc, 'p', { text: t('There is nothing to show yet. When your lender records something for you, it will appear here.') })));
    for (const tot of totals) {
        const mine = groups.filter((g) => g.currency === tot.currency);
        const hasInv = mine.some((g) => g.kind === 'investment');
        const hasLoan = mine.some((g) => g.kind === 'loan');
        out.push(h(doc, 'div', { class: 'tp-cur', text: tot.currency }));
        out.push(h(doc, 'div', { class: 'tp-totals' },
            hasInv ? h(doc, 'div', { class: 'tp-total' }, h(doc, 'span', { class: 'tp-label', text: t('Invested') }), h(doc, 'span', { class: 'tp-figure', text: fmtMoney(tot.invested, tot.currency) })) : null,
            hasInv ? h(doc, 'div', { class: 'tp-total' }, h(doc, 'span', { class: 'tp-label', text: t('Interest received') }), h(doc, 'span', { class: 'tp-figure', text: fmtMoney(tot.interestReceived, tot.currency) })) : null,
            hasLoan ? h(doc, 'div', { class: 'tp-total' }, h(doc, 'span', { class: 'tp-label', text: t('Loan outstanding') }), h(doc, 'span', { class: 'tp-figure', text: fmtMoney(tot.loanOutstanding, tot.currency) })) : null));
    }
    // where to pay comes before the records: it is what a person who has just seen their balance wants next
    const pay = paymentCard(doc, st, t, actions);
    if (pay) out.push(pay);
    for (const g of groups) out.push(g.kind === 'loan' ? loanCard(doc, g, st, t) : investmentCard(doc, g, st, t));
    if (st.truncated) out.push(h(doc, 'p', { class: 'tp-note', text: t('This statement is long, so only the first part is shown.') }));
    return out;
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
    const st = { screen: '', lang: env.lang === 'si' ? 'si' : 'en', nic: '', verified: false, busy: false, pdfBusy: false, resendAt: 0, codeExpiresAt: 0, sessionEndsAt: 0, statement: null, codeMessage: '', tick: null, els: {} };
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
    const showInfo = (text) => { if (st.els.info) { st.els.info.textContent = text || ''; st.els.info.hidden = !text; } };
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

    function mount(title, nodes, focus) {
        stopTick();
        st.busy = false;
        const brand = h(doc, 'h1', { class: 'tp-brand', text: 'WealthFlow' });
        const lang = h(doc, 'button', { class: 'tp-lang', type: 'button', id: 'tp-lang', lang: st.lang === 'si' ? 'en' : 'si', text: LANG_BUTTON[st.lang], onclick: toggleLang });
        root.replaceChildren(h(doc, 'div', { class: 'tp-top' }, brand, lang), ...nodes);
        const target = focus ? root.querySelector(focus) : root.querySelector('h2');
        if (target && typeof target.focus === 'function') target.focus();
        if (typeof doc.title === 'string') doc.title = t(title);
    }

    /** Two small bars: where in the sign-in the person is. Drawn, never read aloud (the screen's own heading says where they are). */
    const steps = (n) => h(doc, 'div', { class: 'tp-steps', 'aria-hidden': 'true' }, h(doc, 'span', { class: 'tp-on' }), h(doc, 'span', { class: n > 1 ? 'tp-on' : null }));

    function errorBox() { st.els.err = h(doc, 'p', { class: 'tp-error', role: 'alert', id: 'tp-err' }); return st.els.err; }

    function screenInvalid() {
        st.screen = 'invalid';
        st.els = {};
        mount('Link not valid', [h(doc, 'section', { class: 'tp-card' }, h(doc, 'h2', { tabindex: '-1', text: t('This link is not valid') }), h(doc, 'p', { text: t(COPY.INVALID_LINK) }))]);
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
        mount('Your WealthFlow statement', [h(doc, 'section', { class: 'tp-card' },
            steps(1),
            h(doc, 'h2', { tabindex: '-1', text: t('View your statement') }),
            h(doc, 'p', { text: t('Enter your NIC, or your passport / ID number if you have no Sri Lankan NIC. We will text a 6-digit code to the mobile number your lender has on file for you.') }),
            infoBox, form,
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
        mount('Enter your code', [h(doc, 'section', { class: 'tp-card' },
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

    async function onDownload() {
        if (st.pdfBusy) return;
        st.pdfBusy = true;
        const btn = st.els.pdf;
        if (btn) { btn.disabled = true; btn.textContent = t('Preparing...'); }
        showError('');
        showInfo('');
        const res = await api('pdf', { token }, { file: true });
        st.pdfBusy = false;
        if (st.screen !== 'statement') return;                         // signed out or timed out while it was being made
        if (btn) { btn.disabled = false; btn.textContent = t('Download PDF'); }
        if (res.blob) { saveFile(res.blob, res.name); showInfo(t('Your PDF is ready. Check your downloads.')); return; }
        if (res.status === 401) { wipe(); screenNic({ error: COPY.SESSION_ENDED }); return; }
        showError(res.status === 0 ? t(COPY.OFFLINE) : res.status === 200 ? t(COPY.PDF_FAILED) : describeFailure(res.status, res.body, t));
    }

    function screenStatement(statement, expiresAt) {
        st.screen = 'statement';
        st.els = {};
        st.nic = '';
        st.statement = statement && typeof statement === 'object' ? statement : null;
        st.sessionEndsAt = Number(expiresAt) || now() + 20 * 60000;
        const clock = h(doc, 'span', { class: 'tp-note', id: 'tp-session' });
        const out = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-out', text: t('Sign out'), onclick: onSignOut });
        const pdf = h(doc, 'button', { class: 'tp-btn', type: 'button', id: 'tp-pdf', text: t('Download PDF'), onclick: onDownload });
        const print = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-print', text: t('Print'), onclick: () => printPage() });
        st.els.pdf = pdf;
        st.els.err = h(doc, 'p', { class: 'tp-error', role: 'alert' });
        st.els.info = h(doc, 'p', { class: 'tp-info', role: 'status', id: 'tp-info', hidden: true });
        mount('Your WealthFlow statement', [
            h(doc, 'div', { class: 'tp-head' }, h(doc, 'h2', { tabindex: '-1', text: t('Your statement') }), out),
            h(doc, 'p', { class: 'tp-note', text: t('As at {when}', { when: fmtAsOf(statement && statement.asOf, t) }) }),
            clock,
            h(doc, 'div', { class: 'tp-actions' }, pdf, print),
            st.els.err,
            st.els.info,
            ...statementView(doc, statement, t, { copy: onCopy }),
            h(doc, 'p', { class: 'tp-foot', text: t('Figures are as recorded by your lender. If something looks wrong, please contact your lender.') }),
        ]);
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
        st.codeMessage = '';
        root.replaceChildren(h(doc, 'h1', { class: 'tp-brand', text: 'WealthFlow' }));
        st.els = {};
    }

    function screenLoading() {
        st.screen = 'loading';
        st.els = {};
        mount('Your WealthFlow statement', [h(doc, 'section', { class: 'tp-card' }, h(doc, 'h2', { tabindex: '-1', text: t('One moment') }), h(doc, 'p', { class: 'tp-note', role: 'status', text: t('Checking for a session on this device...') }))]);
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
