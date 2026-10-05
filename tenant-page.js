/* =============================================================================
 * tenant-page.js — the page a text message links to: NIC, code, statement
 * -----------------------------------------------------------------------------
 * Served at /t/<token> (vercel.json rewrites it to tenant.html). The token in the address is
 * an unguessable link, NOT a login: it only lets this page ask for a code. The statement
 * arrives only after the NIC and the 6-digit code sent to the lender's recorded phone have been
 * checked by /api/tenant-portal, and then only for 20 minutes.
 *
 * WHAT THIS FILE PROMISES
 *   - It builds the page with createElement and textContent only. There is no innerHTML, no
 *     eval, no inline handler, no inline style, and nothing it loads comes from another site; the
 *     page's Content-Security-Policy refuses all of those anyway, so a mistake here fails closed.
 *   - The NIC lives in a variable until the code is accepted, and is dropped then. Nothing is
 *     written to storage, to the address, to a cookie of its own or to a log.
 *   - Leaving the page (or being restored from the back-forward cache) wipes what was on it.
 *   - Whatever the server says, the words shown are the server's own fixed sentences or ours.
 *
 * Plain ES module. Pure helpers are exported for the unit tests; the page boots itself in a browser.
 * ===========================================================================*/

import { normalizeNic } from './wealthflow-nic.js';

export const ENDPOINT = '/api/tenant-portal';
export const FETCH_TIMEOUT_MS = 20000;
export const TOKEN_PATH_RE = /^\/t\/([A-Za-z0-9_-]{16})\/?$/;

export const COPY = Object.freeze({
    BAD_NIC: 'Enter your NIC as 9 digits followed by V or X, or as 12 digits.',
    BAD_CODE: 'Enter the 6-digit code from the text message.',
    OFFLINE: 'Could not reach the server. Check your connection and try again.',
    FAILED: 'Something went wrong. Please try again.',
    INVALID_LINK: 'This link is not valid. Please use the link in your text message.',
    SESSION_ENDED: 'Your session has ended. Please sign in again.',
    SIGNED_OUT: 'You have been signed out.',
    EXPIRED: 'That code has expired. Request a new one.',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FREQ = { monthly: 'Monthly', quarterly: 'Every 3 months', annual: 'Yearly' };
const LOAN_EVENT = { lent: 'Loan paid out', further: 'Further advance', repayment: 'Repayment' };

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
/** "5 Oct 2026, 10:30" in Sri Lanka time, from an ISO instant. */
export function fmtAsOf(iso) {
    const t = Date.parse(String(iso || ''));
    if (!Number.isFinite(t)) return '';
    const d = new Date(t + 330 * 60000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} (Sri Lanka time)`;
}
export const fmtClock = (sec) => { const s = Math.max(0, Math.floor(Number(sec) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** What to tell the person when the server said no. The server's own sentence wins; a wait is added in minutes. */
export function describeFailure(status, body) {
    const said = body && typeof body.error === 'string' && body.error.length < 300 ? body.error : '';
    const wait = Number(body && body.retryAfterSec) > 0 ? Number(body.retryAfterSec) : 0;
    let text = said || (status === 429 ? 'Too many attempts. Please wait a while and try again.' : status === 503 ? 'This service is temporarily unavailable. Please try again later.' : COPY.FAILED);
    if (status === 429 && wait) text += wait >= 90 ? ` Try again in about ${Math.ceil(wait / 60)} minutes.` : ` Try again in ${wait} seconds.`;
    return text;
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

function fact(doc, label, value) { return h(doc, 'div', {}, h(doc, 'dt', { text: label }), h(doc, 'dd', { text: value })); }

/** Cells are [text, alignRight, secondLine]: a second line under the first keeps a table of four things to three columns on a phone. */
function table(doc, caption, heads, rows) {
    return h(doc, 'div', { class: 'tp-scroll' }, h(doc, 'table', {},
        h(doc, 'caption', { text: caption }),
        h(doc, 'thead', {}, h(doc, 'tr', {}, heads.map(([label, num]) => h(doc, 'th', { scope: 'col', class: num ? 'tp-num' : null, text: label })))),
        h(doc, 'tbody', {}, rows.map((r) => h(doc, 'tr', {}, r.map(([text, num, sub]) => h(doc, 'td', { class: num ? 'tp-num' : null }, text, sub ? h(doc, 'span', { class: 'tp-sub', text: sub }) : null)))))));
}

function investmentCard(doc, g) {
    const cur = g.currency;
    return h(doc, 'section', { class: 'tp-card', 'aria-label': `${g.title} ${g.ref}` },
        h(doc, 'div', { class: 'tp-group-head' }, h(doc, 'h3', { text: g.title }), h(doc, 'span', { class: 'tp-chip', text: g.ref })),
        h(doc, 'dl', { class: 'tp-facts' },
            fact(doc, 'Capital', fmtMoney(g.capital, cur)),
            fact(doc, 'Rate', `${g.ratePct}% a year`),
            fact(doc, 'Interest paid', FREQ[g.frequency] || FREQ.monthly),
            fact(doc, 'Interest each time', fmtMoney(g.interestPerPeriod, cur)),
            fact(doc, 'Started', fmtDay(g.start)),
            g.end ? fact(doc, 'Ends', fmtDay(g.end)) : null,
            fact(doc, 'Interest received', fmtMoney(g.totalReceived, cur))),
        g.payments.length
            ? table(doc, `Payments received, in ${cur}`, [['For'], ['Received on'], ['Amount', true]], g.payments.map((p) => [[fmtMonth(p.month)], [fmtDay(p.date)], [fmtNum(p.amount), true]]))
            : h(doc, 'p', { class: 'tp-note', text: 'No payments recorded yet.' }));
}

function loanCard(doc, g) {
    const cur = g.currency;
    const status = g.status === 'settled' ? ['Settled', 'tp-chip tp-ok'] : g.status === 'closed' ? ['Closed', 'tp-chip'] : ['Open', 'tp-chip'];
    return h(doc, 'section', { class: 'tp-card', 'aria-label': `${g.title} ${g.ref}` },
        h(doc, 'div', { class: 'tp-group-head' }, h(doc, 'h3', { text: g.title }), h(doc, 'span', { class: 'tp-chip', text: g.ref }), h(doc, 'span', { class: status[1], text: status[0] })),
        h(doc, 'dl', { class: 'tp-facts' },
            fact(doc, 'Paid out', fmtMoney(g.lent, cur)),
            fact(doc, 'Repaid', fmtMoney(g.repaid, cur)),
            fact(doc, 'Outstanding', fmtMoney(g.outstanding, cur))),
        g.events.length
            ? table(doc, `Movements, in ${cur}`, [['Date'], ['Amount', true], ['Balance', true]], g.events.map((e) => [[fmtDay(e.date), false, LOAN_EVENT[e.kind] || '-'], [fmtNum(e.amount), true], [fmtNum(e.balance), true]]))
            : h(doc, 'p', { class: 'tp-note', text: 'Nothing recorded yet.' }));
}

/** The statement as DOM. `statement` is the server's answer; every string in it is shown as text. */
export function statementView(doc, statement) {
    const st = statement && typeof statement === 'object' ? statement : {};
    const groups = Array.isArray(st.groups) ? st.groups : [];
    const totals = Array.isArray(st.totals) ? st.totals : [];
    const out = [];
    if (!groups.length) out.push(h(doc, 'section', { class: 'tp-card' }, h(doc, 'p', { text: 'There is nothing to show yet. When your lender records something for you, it will appear here.' })));
    for (const t of totals) {
        const mine = groups.filter((g) => g.currency === t.currency);
        const hasInv = mine.some((g) => g.kind === 'investment');
        const hasLoan = mine.some((g) => g.kind === 'loan');
        out.push(h(doc, 'div', { class: 'tp-cur', text: t.currency }));
        out.push(h(doc, 'div', { class: 'tp-totals' },
            hasInv ? h(doc, 'div', { class: 'tp-total' }, h(doc, 'span', { class: 'tp-label', text: 'Invested' }), h(doc, 'span', { class: 'tp-figure', text: fmtMoney(t.invested, t.currency) })) : null,
            hasInv ? h(doc, 'div', { class: 'tp-total' }, h(doc, 'span', { class: 'tp-label', text: 'Interest received' }), h(doc, 'span', { class: 'tp-figure', text: fmtMoney(t.interestReceived, t.currency) })) : null,
            hasLoan ? h(doc, 'div', { class: 'tp-total' }, h(doc, 'span', { class: 'tp-label', text: 'Loan outstanding' }), h(doc, 'span', { class: 'tp-figure', text: fmtMoney(t.loanOutstanding, t.currency) })) : null));
    }
    for (const g of groups) out.push(g.kind === 'loan' ? loanCard(doc, g) : investmentCard(doc, g));
    if (st.truncated) out.push(h(doc, 'p', { class: 'tp-note', text: 'This statement is long, so only the first part is shown.' }));
    return out;
}

/* ── the page ─────────────────────────────────────────────────────────────── */

/**
 * @param {{doc:Document, root:Element, token:string, fetchImpl:Function, now?:()=>number, setTick?:Function, clearTick?:Function}} env
 */
export function createPage(env) {
    const { doc, root, token, fetchImpl } = env;
    const now = env.now || Date.now;
    const setTick = env.setTick || ((fn, ms) => setInterval(fn, ms));
    const clearTick = env.clearTick || ((id) => clearInterval(id));
    const st = { screen: '', nic: '', verified: false, busy: false, resendAt: 0, codeExpiresAt: 0, sessionEndsAt: 0, tick: null, els: {} };

    async function api(action, extra = {}) {
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

    function mount(title, nodes, focus) {
        stopTick();
        st.busy = false;
        const brand = h(doc, 'h1', { class: 'tp-brand', text: 'WealthFlow' });
        root.replaceChildren(brand, ...nodes);
        const target = focus ? root.querySelector(focus) : root.querySelector('h2');
        if (target && typeof target.focus === 'function') target.focus();
        if (typeof doc.title === 'string') doc.title = title;
    }

    function errorBox() { st.els.err = h(doc, 'p', { class: 'tp-error', role: 'alert', id: 'tp-err' }); return st.els.err; }

    function screenInvalid() {
        st.screen = 'invalid';
        st.els = {};
        mount('Link not valid', [h(doc, 'section', { class: 'tp-card' }, h(doc, 'h2', { tabindex: '-1', text: 'This link is not valid' }), h(doc, 'p', { text: COPY.INVALID_LINK }))]);
    }

    function screenNic({ info = '', error = '' } = {}) {
        st.screen = 'nic';
        st.els = {};
        const input = h(doc, 'input', { id: 'tp-nic', name: 'nic', type: 'text', inputmode: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '16', required: true, 'aria-describedby': 'tp-err', placeholder: 'e.g. 198534000937' });
        const button = h(doc, 'button', { class: 'tp-btn', type: 'submit', id: 'tp-send', text: 'Send me a code' });
        st.els.input = input; st.els.button = button;
        const form = h(doc, 'form', { novalidate: true, onsubmit: onRequest },
            h(doc, 'label', { for: 'tp-nic', text: 'Your NIC number' }), input, errorBox(), button);
        const infoBox = h(doc, 'p', { class: 'tp-info', id: 'tp-info', role: 'status' });
        st.els.info = infoBox;
        mount('Your WealthFlow statement', [h(doc, 'section', { class: 'tp-card' },
            h(doc, 'h2', { tabindex: '-1', text: 'View your statement' }),
            h(doc, 'p', { text: 'Enter your NIC. We will text a 6-digit code to the mobile number your lender has on file for you.' }),
            infoBox, form,
            h(doc, 'p', { class: 'tp-small', text: 'Your statement is shown only after you enter the code. Nobody else can see it from this link.' }))], '#tp-nic');
        showInfo(info);
        showError(error);
    }

    function screenCode({ message = '' } = {}) {
        st.screen = 'code';
        st.els = {};
        st.verified = false;
        const input = h(doc, 'input', { id: 'tp-code', name: 'code', class: 'tp-code', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'one-time-code', maxlength: '6', required: true, 'aria-describedby': 'tp-err', 'aria-label': '6-digit code' });
        const verify = h(doc, 'button', { class: 'tp-btn', type: 'submit', id: 'tp-verify', text: 'View my statement' });
        const resend = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-resend', disabled: true, onclick: onResend });
        const back = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-back', text: 'Use a different NIC', onclick: () => { st.nic = ''; screenNic(); } });
        const expiry = h(doc, 'p', { class: 'tp-small', id: 'tp-expiry' });
        st.els.input = input; st.els.button = verify; st.els.resend = resend; st.els.expiry = expiry;
        const infoBox = h(doc, 'p', { class: 'tp-info', id: 'tp-info', role: 'status' });
        st.els.info = infoBox;
        mount('Enter your code', [h(doc, 'section', { class: 'tp-card' },
            h(doc, 'h2', { tabindex: '-1', text: 'Enter your code' }),
            infoBox,
            h(doc, 'form', { novalidate: true, onsubmit: onVerify }, h(doc, 'label', { for: 'tp-code', text: 'Code from the text message' }), input, errorBox(), verify),
            expiry, resend, back,
            h(doc, 'p', { class: 'tp-small', text: 'No text after a minute? Your lender may have no mobile number for you, or messaging may be unavailable. Try again later or contact your lender.' }))], '#tp-code');
        showInfo(message);
        const paint = () => {
            const left = Math.ceil((st.resendAt - now()) / 1000);
            resend.disabled = left > 0 || st.busy;
            setText(resend, left > 0 ? `Send a new code (${left}s)` : 'Send a new code');
            const alive = Math.ceil((st.codeExpiresAt - now()) / 1000);
            setText(expiry, alive > 0 ? `This code expires in ${fmtClock(alive)}.` : COPY.EXPIRED);
        };
        paint();
        st.tick = setTick(paint, 1000);
    }

    function screenStatement(statement, expiresAt) {
        st.screen = 'statement';
        st.els = {};
        st.nic = '';
        st.sessionEndsAt = Number(expiresAt) || now() + 20 * 60000;
        const clock = h(doc, 'span', { class: 'tp-note', id: 'tp-session' });
        const out = h(doc, 'button', { class: 'tp-btn tp-ghost', type: 'button', id: 'tp-out', text: 'Sign out', onclick: onSignOut });
        st.els.err = h(doc, 'p', { class: 'tp-error', role: 'alert' });
        mount('Your WealthFlow statement', [
            h(doc, 'div', { class: 'tp-head' }, h(doc, 'h2', { tabindex: '-1', text: 'Your statement' }), out),
            h(doc, 'p', { class: 'tp-note', text: `As at ${fmtAsOf(statement && statement.asOf)}` }),
            clock,
            st.els.err,
            ...statementView(doc, statement),
            h(doc, 'p', { class: 'tp-foot', text: 'Figures are as recorded by your lender. If something looks wrong, please contact your lender.' }),
        ]);
        const paint = () => {
            const left = Math.ceil((st.sessionEndsAt - now()) / 1000);
            if (left <= 0) { wipe(); screenNic({ error: COPY.SESSION_ENDED }); return; }
            setText(clock, `For your privacy this closes in ${fmtClock(left)}.`);
        };
        paint();
        if (st.screen === 'statement') st.tick = setTick(paint, 1000);
    }

    const busy = (on, label) => { st.busy = on; if (st.els.button) { st.els.button.disabled = on; if (label) st.els.button.textContent = label; } };

    async function onRequest(ev) {
        if (ev) ev.preventDefault();
        if (st.busy) return;
        const raw = st.els.input.value;
        if (!normalizeNic(raw).ok) { st.els.input.setAttribute('aria-invalid', 'true'); showError(COPY.BAD_NIC); return; }
        st.els.input.removeAttribute('aria-invalid');
        showError('');
        busy(true, 'Sending...');
        const res = await api('request', { token, nic: raw });
        if (res.status === 200 && res.body && res.body.ok) {
            st.nic = raw;
            st.resendAt = now() + (Number(res.body.resendAfterSec) || 60) * 1000;
            st.codeExpiresAt = now() + (Number(res.body.expiresInSec) || 180) * 1000;
            screenCode({ message: res.body.message || '' });
            return;
        }
        busy(false, 'Send me a code');
        showError(res.status === 0 ? COPY.OFFLINE : describeFailure(res.status, res.body));
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
            showInfo('A new code is on its way if the details match. The old one no longer works.');
            return;
        }
        showError(res.status === 0 ? COPY.OFFLINE : describeFailure(res.status, res.body));
    }

    async function onVerify(ev) {
        if (ev) ev.preventDefault();
        if (st.busy) return;
        const code = String(st.els.input.value || '').replace(/\s+/g, '');
        if (!/^\d{6}$/.test(code)) { st.els.input.setAttribute('aria-invalid', 'true'); showError(COPY.BAD_CODE); return; }
        st.els.input.removeAttribute('aria-invalid');
        showError('');
        busy(true, 'Checking...');
        // a code is spent the moment it is accepted: if only the statement failed to arrive, the button asks for the statement again, not for a new code
        const res = st.verified ? { status: 200, body: { ok: true } } : await api('verify', { token, nic: st.nic, code });
        if (res.status === 200 && res.body && res.body.ok) {
            st.verified = true;
            const got = await api('statement', { token });
            if (got.status === 200 && got.body && got.body.ok) { screenStatement(got.body.statement, got.body.expiresAt); return; }
            busy(false, 'View my statement');
            showError(got.status === 0 ? COPY.OFFLINE : describeFailure(got.status, got.body));
            return;
        }
        busy(false, 'View my statement');
        st.els.input.value = '';
        st.els.input.focus();
        showError(res.status === 0 ? COPY.OFFLINE : describeFailure(res.status, res.body));
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
        root.replaceChildren(h(doc, 'h1', { class: 'tp-brand', text: 'WealthFlow' }));
        st.els = {};
    }

    function screenLoading() {
        st.screen = 'loading';
        st.els = {};
        mount('Your WealthFlow statement', [h(doc, 'section', { class: 'tp-card' }, h(doc, 'h2', { tabindex: '-1', text: 'One moment' }), h(doc, 'p', { class: 'tp-note', role: 'status', text: 'Checking for a session on this device...' }))]);
    }

    /** Opens on the NIC form, unless this device already has a live session for this link (a reload within 20 minutes costs no new text). */
    async function start() {
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
        reset(message) { wipe(); if (!token) return screenInvalid(); return message ? screenNic({ error: message }) : start(); },
    };
}

export function boot(win) {
    const doc = win.document;
    const root = doc.getElementById('tp-root');
    if (!root) return null;
    const page = createPage({ doc, root, token: tokenFromPath(win.location.pathname), fetchImpl: (...a) => win.fetch(...a) });
    win.addEventListener('pagehide', () => page.wipe());
    win.addEventListener('pageshow', (e) => { if (e && e.persisted) page.reset(''); });
    page.start();
    return page;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && !globalThis.__WF_TENANT_NO_BOOT) boot(window);
