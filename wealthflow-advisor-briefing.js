/* =============================================================================
 * wealthflow-advisor-briefing.js — what the Advisor shows BEFORE it is asked anything
 * -----------------------------------------------------------------------------
 * Opening the Advisor used to show a greeting and the same five questions to everyone. The books already know what is worth a look today: a month that ends short,
 * a category that jumped, a goal that fell behind, a cushion that is thin. This turns the fact sheet's findings (wealthflow-advisor-facts.js, the same ones the model
 * is given) into a short card of the few things that matter, each with the question to ask about it, and into suggested questions that name the owner's own loan and goal.
 *
 * Nothing here calls a model: it is code over the fact sheet, so it is instant, free, works offline, and cannot disagree with the screens. Every figure in it is one the
 * fact sheet holds (test/advisor_briefing_test.js reads the card back through wealthflow-advisor-check.js to prove it).
 * ===========================================================================*/

import { lkr } from './wealthflow-advisor-facts.js';

export const BRIEFING_VERSION = 1;

export const RULES = {
    MAX_ITEMS: 4,
    MAX_PILLS: 3,
    EXTRA_SHARE: 0.25,         // "what if I pay extra on the loan": a quarter of its instalment, to the nearest 1,000
    STRESS_PCT: 30,            // "what if my income drops by": the fall the stress question uses
};

const list = (v) => (Array.isArray(v) ? v : []);
const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** A label cut at a word, never in the middle of one. */
const brief = (s, n) => { const t = clip(s, 400); if (t.length <= n) return t; const cut = t.slice(0, n + 1).replace(/\s+\S*$/, ''); return `${cut || t.slice(0, n)}...`; };
const pct = (n) => `${Math.round(num(n) * 10) / 10}%`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayOf = (iso) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : ''; };

/** One finding as a card line: { id, tone, title, detail, ask }. `tone` is high, medium, low, good or info. */
function itemFor(flag, f) {
    const T = f.typical || {}, L = f.liquidity || {}, D = f.debt || {};
    const id = flag.id;
    const base = { id, tone: flag.severity || 'low' };
    if (id === 'deficit') return { ...base, title: 'Spending is above income', detail: `A typical month: LKR ${lkr(T.outflow)} out against LKR ${lkr(T.income)} in, a gap of LKR ${lkr(-T.net)}.`, ask: 'My spending is above my income. What are the three biggest changes I could make?' };
    if (id === 'short-after-debt') return { ...base, title: `Each month ends LKR ${lkr(-L.freeCashPerMonth)} short after debts`, detail: `After living costs and the LKR ${lkr(D.monthlyService)} the loans and cards ask every month.`, ask: `After living costs and debt payments my month ends LKR ${lkr(-L.freeCashPerMonth)} short. What should I do about it?` };
    if (id === 'thin-savings') return { ...base, title: `Only ${pct(T.savingsRatePct)} of income is kept`, detail: `LKR ${lkr(T.net)} of LKR ${lkr(T.income)} in a typical month.`, ask: 'I keep very little of my income each month. How can I save more without feeling it?' };
    if (id === 'dsr-high' || id === 'dsr-watch') return { ...base, title: `Debt payments take ${pct(D.dsrPct)} of income`, detail: `LKR ${lkr(D.monthlyService)} of LKR ${lkr(T.income)} a month.`, ask: `My debt payments take ${pct(D.dsrPct)} of my income. Is that too much, and how do I bring it down?` };
    if (id === 'loan-below-interest') {
        const l = list(D.loans).find((x) => x.problem === 'payment-below-interest');
        const name = l ? l.name : 'A loan';
        return { ...base, title: `${name}: the balance is growing`, detail: `The instalment is smaller than the interest it earns each month.`, ask: `The instalment on ${name} is smaller than its interest. What are my options?` };
    }
    if (id === 'runway') return { ...base, title: `The balance could run out about ${dayOf(L.runwayDate)}`, detail: `The cash-flow engine projects it going below zero${L.runwayDays !== null && L.runwayDays !== undefined ? `, ${L.runwayDays} days away` : ''}.`, ask: 'My balance is projected to run out. What can I do before that date?' };
    if (id === 'cover-critical' || id === 'cover-low') return { ...base, title: `Cash covers ${L.monthsOfCover} months of spending`, detail: `A 3-month cushion would be LKR ${lkr(L.cushion3)}; the Balance page holds LKR ${lkr(L.onHand)}.`, ask: 'How do I build a proper cash cushion from where I am?' };
    if (id.startsWith('spike:')) {
        const c = list(f.categories).find((x) => x && id === `spike:${x.name}`);
        if (c) return { ...base, title: `${c.name} is up ${pct(c.changePct)} on its average`, detail: `LKR ${lkr(c.thisMonth)} this month against LKR ${lkr(c.avg3)} on average.`, ask: `Why is my ${c.name} spending up this month, and what can I do about it?` };
    }
    if (id.startsWith('goal:')) {
        const g = list(f.goals).find((x) => x && id === `goal:${x.name}`);
        if (g) return g.status === 'overdue'
            ? { ...base, title: `${g.name}: the target date has passed`, detail: `LKR ${lkr(g.remaining)} is still to save.`, ask: `My ${g.name} goal is past its date with LKR ${lkr(g.remaining)} to go. What should I do?` }
            : { ...base, title: `${g.name} is behind plan`, detail: `Saving LKR ${lkr(g.pacePerMonth)} a month; LKR ${lkr(g.neededPerMonth)} a month is needed to finish by ${g.endsOn}.`, ask: `How do I catch up on my ${g.name} goal?` };
    }
    if (id === 'outflow-rising') return { ...base, title: 'Spending is rising faster than income', detail: clip(flag.text, 140), ask: 'My spending keeps rising faster than my income. Where is it coming from?' };
    return null;
}

/** Findings the owner does not need on a card: a worst case the engine itself says is not a forecast. */
const LEFT_OUT = new Set(['runway-no-income']);

/**
 * The card: { ok, asOf, headline, stats, items }.
 * `stats` is the typical month in a few figures that add up. `items` is at most `o.max` findings, the most serious first (with no warnings it says so), then one line for what is already committed in the next 30 days.
 */
export function briefing(f, o = {}) {
    if (!f || f.ok === false || !f.typical) return { ok: false, asOf: f && f.asOf || '', headline: 'No records yet', stats: [], items: [] };
    const max = Math.max(1, Math.min(8, o.max || RULES.MAX_ITEMS));
    const T = f.typical, L = f.liquidity || {}, D = f.debt || {};
    const items = [];
    for (const flag of list(f.flags)) {
        if (!flag || typeof flag.id !== 'string' || LEFT_OUT.has(flag.id)) continue;
        const it = itemFor(flag, f);
        if (it && !items.some((x) => x.id === it.id)) items.push(it);
    }
    const serious = items.filter((i) => i.tone === 'high' || i.tone === 'medium').length;
    const out = items.slice(0, max);
    if (!serious) {
        out.unshift({ id: 'all-clear', tone: 'good', title: 'Nothing urgent in your books', detail: T.net !== null && T.net !== undefined ? `A typical month leaves LKR ${lkr(L.freeCashPerMonth !== null && L.freeCashPerMonth !== undefined ? L.freeCashPerMonth : T.net)}${L.monthsOfCover !== null && L.monthsOfCover !== undefined ? `; the Balance page covers ${L.monthsOfCover} months of spending` : ''}.` : 'No warnings were found.', ask: 'My books look fine. How can I make my money work harder?' });
        if (out.length > max) out.length = max;
    }
    if (L.committed30 > 0) {
        const next = list(L.upcoming).slice(0, 2).filter(Boolean).map((u) => `${brief(u.label, 34)} (${dayOf(u.date)})`).join(', ');
        out.push({ id: 'next-30', tone: 'info', title: `Next 30 days: LKR ${lkr(L.committed30)} already committed`, detail: next ? `Soonest: ${next}.` : 'Dated payments and instalments.', ask: 'What payments are coming up in the next 30 days, and can I cover them?' });
    }
    // Four figures that add up: income, less living costs, less what the loans and cards ask, is what is left. (The books average can show more left than this, because
    // it counts the debt payments marked paid and not the ones scheduled; the fact sheet says so, and the card shows the scheduled amount, the one that will be asked.)
    const left = L.freeCashPerMonth !== null && L.freeCashPerMonth !== undefined ? L.freeCashPerMonth : T.net;
    const debt = D.monthlyService !== null && D.monthlyService !== undefined ? D.monthlyService : T.debtService;
    const stats = [{ label: 'Typical income', value: `LKR ${lkr(T.income)}` }, { label: 'Living costs', value: `LKR ${lkr(T.living !== undefined ? T.living : T.outflow)}` }];
    if (num(debt) > 0) stats.push({ label: 'Loans and cards', value: `LKR ${lkr(debt)}` });
    stats.push({ label: 'Left each month', value: `LKR ${lkr(left)}` });
    stats.push({ label: 'On hand', value: L.onHand !== null && L.onHand !== undefined ? `LKR ${lkr(L.onHand)}` : 'not recorded' });
    const headline = serious ? `${serious} thing${serious === 1 ? '' : 's'} worth a look` : 'All clear';
    return { ok: true, asOf: f.asOf, headline, stats, items: out };
}

/**
 * Suggested questions made from the owner's own books: a "what if I pay extra" on the loan with the most owing, a stress test of their income, and the first goal.
 * (The findings themselves are on the card, so they are not repeated here.) Each is { text, ask }: `text` is what the button says, `ask` is what is sent, worded so the
 * Advisor's decision lab (wealthflow-advisor-scenarios.js) reads it. At most `o.max`, no duplicates.
 */
export function pills(f, o = {}) {
    const max = Math.max(1, Math.min(8, o.max || RULES.MAX_PILLS));
    if (!f || f.ok === false || !f.typical) return [];
    const out = [];
    const add = (text, ask) => { const t = clip(text, 70); if (t && !out.some((x) => x.text === t)) out.push({ text: t, ask: clip(ask || text, 260) }); };
    const loans = list(f.debt && f.debt.loans).filter((l) => l && l.name && num(l.monthly) > 0 && !l.problem).sort((a, c) => num(c.balance) - num(a.balance));
    if (loans.length) {
        const extra = Math.max(1000, Math.round((num(loans[0].monthly) * RULES.EXTRA_SHARE) / 1000) * 1000);
        add(`What if I pay LKR ${lkr(extra)} extra a month on ${clip(loans[0].name, 24)}?`, `What if I pay LKR ${lkr(extra)} extra a month on my ${clip(loans[0].name, 40)}?`);
    }
    if (num(f.typical.income) > 0 && f.liquidity && f.liquidity.onHand !== null && f.liquidity.onHand !== undefined) add(`How long would my money last if my income fell ${RULES.STRESS_PCT}%?`, `What if my income drops by ${RULES.STRESS_PCT}%?`);
    const goal = list(f.goals).find((g) => g && g.name && g.status !== 'complete' && num(g.remaining) > 0);
    if (goal) add(`How long will ${clip(goal.name, 24)} take at my pace?`, `How long will my ${clip(goal.name, 40)} goal take at my current pace, and what would speed it up?`);
    return out.slice(0, max);
}

/**
 * Draw the card into `el`. Text only: every name and figure goes in with textContent, so a loan called "<img onerror=...>" is shown, not run.
 * Each line's button carries its question in `data-q`, which the page's own suggestion-pill handler already sends. The title bar folds the card; `o.onToggle(collapsed)` lets the page remember that. Returns the element, or null.
 */
export function render(el, brief, doc = (typeof document !== 'undefined' ? document : null), o = {}) {
    if (!el || !doc || !brief || !brief.ok || !brief.items.length) { if (el) el.textContent = ''; return null; }
    const make = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    el.textContent = '';
    const card = make('div', `ai-brief${o.collapsed ? ' collapsed' : ''}`);
    const head = make('button', 'ai-brief-head');
    head.setAttribute('type', 'button');
    head.setAttribute('aria-expanded', o.collapsed ? 'false' : 'true');
    head.appendChild(make('span', 'ai-brief-title', 'Your books today'));
    head.appendChild(make('span', 'ai-brief-sub', brief.headline));
    head.addEventListener('click', () => {
        const nowCollapsed = card.classList.toggle('collapsed');
        head.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        if (typeof o.onToggle === 'function') { try { o.onToggle(nowCollapsed); } catch (_) {} }
    });
    card.appendChild(head);
    const body = make('div', 'ai-brief-body');
    const stats = make('div', 'ai-brief-stats');
    for (const s of brief.stats) { const c = make('div', 'ai-brief-stat'); c.appendChild(make('div', 'ai-brief-stat-l', s.label)); c.appendChild(make('div', 'ai-brief-stat-v', s.value)); stats.appendChild(c); }
    body.appendChild(stats);
    const list = make('div', 'ai-brief-items');
    for (const it of brief.items) {
        const row = make('div', `ai-brief-item ${it.tone}`);
        row.appendChild(make('span', 'ai-brief-dot'));
        const txt = make('div', 'ai-brief-text');
        txt.appendChild(make('div', 'ai-brief-item-t', it.title));
        txt.appendChild(make('div', 'ai-brief-item-d', it.detail));
        row.appendChild(txt);
        const ask = make('button', 'ai-brief-ask', 'Ask');
        ask.setAttribute('type', 'button');
        ask.setAttribute('data-q', it.ask);
        row.appendChild(ask);
        list.appendChild(row);
    }
    body.appendChild(list);
    card.appendChild(body);
    el.appendChild(card);
    return card;
}

const API = { BRIEFING_VERSION, RULES, briefing, pills, render };
if (typeof window !== 'undefined') window.WFAdvisorBriefing = API;
export default API;
