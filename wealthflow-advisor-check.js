/* =============================================================================
 * wealthflow-advisor-check.js — does every figure in the Advisor's answer come from the owner's books?
 * -----------------------------------------------------------------------------
 * The Advisor is handed a fact sheet and a block of worked figures (wealthflow-advisor-facts.js, wealthflow-advisor-scenarios.js) and told to copy them. A language model
 * still sometimes writes a figure of its own: a salary it half-remembers, a total it adds up wrongly, a rate it makes up. The owner cannot tell which figure is which.
 *
 * So the answer is READ BACK, by code, against what the model was given:
 *   • every money figure, percentage, span of months or years and count of payments in the answer is found;
 *   • it is looked for in the sheet, in the worked block and in what the owner typed (a rounded figure matches the figure it rounds: "about 2.5M" matches 2,498,000);
 *   • a sum, a difference or a multiple of two such figures that is exact is accepted as arithmetic done right (62,000 x 12 = 744,000);
 *   • a sentence the model itself labels an estimate is counted as an estimate, not as a claim about the books;
 *   • anything else is "not from your books".
 * When a money figure or a percentage is not from the books, the model is asked ONCE to write the answer again from the books only, and the new answer is used only if it has
 * fewer such figures. Whatever is left is shown to the owner, so a figure that is not theirs is never passed off as theirs.
 *
 * Nothing here changes a record. It reads text and returns text and numbers.
 * ===========================================================================*/

export const CHECK_VERSION = 1;

const MULT = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, cr: 1e7 };
const SI_MULT = [[/^\s*(?:කෝටි)/, 1e7], [/^\s*(?:මිලියන)/, 1e6], [/^\s*(?:ලක්ෂ|ලක්ශ)/, 1e5]];
const SI_MULT_BEFORE = [[/(?:කෝටි)\s*$/, 1e7], [/(?:මිලියන)\s*$/, 1e6], [/(?:ලක්ෂ|ලක්ශ)\s*$/, 1e5]];
const CURRENCY_BEFORE = /(?:\blkr|\brs\.?|රු\.?|ரூ\.?)\s*[-−–]?\s*$/i;
const CURRENCY_AFTER = /^\s*(?:lkr\b|rs\b|\/=|රුපියල්|ரூபாய்)/i;
const SPAN_AFTER = /^\s*[-–]?\s*(months?|mos?\b|years?|yrs?)\b/i;
const SPAN_BEFORE = /(මාස|වසර|අවුරුදු|ආවුරුදු)\s*[:\-]?\s*$/;
const COUNT_AFTER = /^\s*(?:payments?|instal?lments?)\b/i;
const PCT_AFTER = /^\s*(?:%|percent\b|per ?cent\b|ප්‍රතිශත)/i;
const ESTIMATE = /\b(?:estimate[ds]?|estimating|approx(?:imate|imately)?|roughly|ballpark)\b|≈|~|ඇස්තමේන්තු|දළ වශයෙන්|ආසන්න/i;
const NUM_RE = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
const DERIVE_BY = [2, 3, 4, 6, 12, 24, 36, 48, 60];

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : 0; };
const alnum = /[A-Za-z0-9_]/;
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/** The text without code blocks (a chart's JSON is data for a chart, not a claim) and without the model's own follow-up list. */
function readable(text) {
    return String(text == null ? '' : text).replace(/```[\s\S]*?(?:```|$)/g, ' ').replace(/FOLLOWUPS:\s*\[[\s\S]*?\]/g, ' ');
}

/** Sentence-sized pieces with their offsets, so "is this a labelled estimate?" is decided where the figure is. */
function sentences(text) {
    const out = [];
    /* "Rs. 90,000" and "approx. 3" are not the end of a sentence (the dot is blanked, so every offset stays the same) */
    const masked = text.replace(/(?:\b(?:Rs|approx|no|vs|etc)|රු|ரூ)\./gi, (m) => m.slice(0, -1) + '\u00b7');
    const re = /[^.!?\n]+(?:(?:[.!?]+(?=\s|$))|$)|\n/g;
    let m;
    while ((m = re.exec(masked))) { if (m[0] === '\n') continue; out.push({ at: m.index, end: m.index + m[0].length, text: m[0] }); if (m[0].length === 0) re.lastIndex++; }
    return out;
}

/** How exactly a figure was written: a rounded figure stands for everything that rounds to it. Never more than 1% of the figure, never less than half a unit of its last place. */
function precisionOf(rawInt, dec, mult, value) {
    let p;
    if (dec) p = Math.pow(10, -dec.length) * mult;
    else if (mult > 1) p = mult;
    else { const z = /0+$/.exec(rawInt); p = z ? Math.pow(10, z[0].length) : 1; }
    const floor = dec ? Math.pow(10, -dec.length) * mult / 2 : 0.5;
    return Math.max(floor, Math.min(p / 2, value * 0.01));
}

/**
 * Every figure in a text: { kind: 'money' | 'pct' | 'span' | 'count' | 'plain', value, tol, text, at, estimate }.
 * `span` is in months (years are multiplied by 12). A plain number (no currency, unit or size) is only returned when `o.plain` is set.
 */
export function figuresIn(text, o = {}) {
    const t = readable(text);
    const sents = sentences(t);
    const out = [];
    NUM_RE.lastIndex = 0;
    let m;
    while ((m = NUM_RE.exec(t))) {
        const rawInt = m[1], dec = m[2] || '', at = m.index, end = at + m[0].length;
        const prev = at > 0 ? t[at - 1] : '';
        if (prev && (alnum.test(prev) || prev === '.')) continue;                                   // part of a word or a version ("v2", "x.5")
        if (/^-\d{2}(?:-\d{2})?\b/.test(t.slice(end, end + 6)) || /^\d{4}$/.test(rawInt) && /^-\d{2}/.test(t.slice(end, end + 3))) continue;   // 2026-10, 2026-10-03
        if (/^:\d{2}/.test(t.slice(end, end + 3))) continue;                                       // 12:30
        const before = t.slice(Math.max(0, at - 16), at), after = t.slice(end, end + 18);
        if (!rawInt.includes(',') && (rawInt.length > 12 || (rawInt.length > 1 && rawInt[0] === '0' && !dec))) continue;       // a phone number or an id, not an amount
        let value = parseFloat(rawInt.replace(/,/g, '') + (dec ? `.${dec}` : ''));
        if (!Number.isFinite(value)) continue;
        const sentence = sents.find((s) => at >= s.at && at < s.end);
        const estimate = !!(sentence && ESTIMATE.test(sentence.text));
        const pre = (before.match(CURRENCY_BEFORE) || [''])[0].trim();
        const suf = (after.match(/^\s*(?:%|percent\b|per ?cent\b|k\b|mn\b|m\b|million\b|thousand\b|lakhs?\b|lacs?\b|crore\b|cr\b|months?\b|years?\b|yrs?\b|\/=)/i) || [''])[0];
        const base = { text: clip(`${pre ? `${pre} ` : ''}${m[0]}${suf}`, 40), at, estimate, sentence: sentence ? clip(sentence.text, 160) : '' };

        if (PCT_AFTER.test(after)) { out.push({ ...base, kind: 'pct', value, tol: Math.max(dec ? Math.pow(10, -dec.length) / 2 : 0.5, 0) }); continue; }
        const sp = SPAN_AFTER.exec(after);
        if (sp || SPAN_BEFORE.test(before)) {
            const years = sp ? /^y/i.test(sp[1]) : /වසර|අවුරුදු|ආවුරුදු/.test(before);
            const f = years ? 12 : 1;
            out.push({ ...base, kind: 'span', value: value * f, tol: (dec ? Math.pow(10, -dec.length) / 2 : 0.5) * f });
            continue;
        }
        if (COUNT_AFTER.test(after) && value < 1000 && !dec && !rawInt.includes(',') && !CURRENCY_BEFORE.test(before)) { out.push({ ...base, kind: 'count', value, tol: 0.5 }); continue; }      // "55 payments", not "LKR 55,000 instalment"

        let mult = 1, explicit = rawInt.includes(',') || CURRENCY_BEFORE.test(before) || CURRENCY_AFTER.test(after);
        const mw = /^\s*([a-z]+)\b/i.exec(after);
        if (mw && MULT[mw[1].toLowerCase()]) { mult = MULT[mw[1].toLowerCase()]; explicit = true; }
        else { for (const [re, f] of SI_MULT) if (re.test(after)) { mult = f; explicit = true; break; } if (mult === 1) for (const [re, f] of SI_MULT_BEFORE) if (re.test(before)) { mult = f; explicit = true; break; } }
        value *= mult;
        const year = !explicit && mult === 1 && !dec && value >= 1900 && value <= 2100;
        if (!explicit && !year && value >= 10000 && mult === 1) explicit = true;
        if (!explicit && !year && mult === 1 && !dec && value >= 1000) explicit = true;
        if (!explicit) { if (o.plain) out.push({ ...base, kind: 'plain', value, tol: dec ? Math.pow(10, -dec.length) / 2 : 0.5 }); continue; }
        if (year) { if (o.plain) out.push({ ...base, kind: 'plain', value, tol: 0.5 }); continue; }
        out.push({ ...base, kind: 'money', value, tol: precisionOf(rawInt.replace(/,/g, ''), dec, mult, value) });
    }
    return out;
}

/** What the model was given, as sets of figures to look in. `parts` are texts (the fact sheet, the worked block); `owner` are things the owner typed. */
export function groundingFrom(parts, owner) {
    const g = { money: [], pct: [], span: [], count: [], any: [] };
    for (const p of Array.isArray(parts) ? parts : []) for (const f of figuresIn(p)) if (g[f.kind]) g[f.kind].push(Math.abs(f.value));
    for (const p of Array.isArray(owner) ? owner : []) for (const f of figuresIn(p, { plain: true })) { g.any.push(Math.abs(f.value)); if (g[f.kind]) g[f.kind].push(Math.abs(f.value)); }
    for (const k of Object.keys(g)) g[k] = [...new Set(g[k].map((v) => Math.round(v * 1000) / 1000))].slice(0, 1200);
    return g;
}

const near = (a, b, tol) => Math.abs(a - b) <= tol + 1e-9;
/** Words that say the model is doing arithmetic ("a year", "in all", "plus"). A figure that is only a multiple or a sum of two of the owner's by coincidence is not arithmetic unless the sentence says so. */
const ARITHMETIC = /\b(?:year(?:ly)?|annual(?:ly)?|total(?:s|led)?|in all|altogether|combined|together|sum|plus|minus|difference|half|double|twice|add(?:ed|ing)?|subtract(?:ed|ing)?)\b|[\u00d7+=]|\d\s?x\s?\d|වසරකට|අවුරුද්දකට|එකතුව|එකතු/i;

/** Is this figure one of the given ones, or exact arithmetic on them? Returns 'given', 'derived' or ''. */
function matchOf(f, g) {
    const pool = f.kind === 'span' ? g.span : f.kind === 'pct' ? g.pct : f.kind === 'count' ? g.count : g.money;
    const v = Math.abs(f.value);
    for (const a of pool) if (near(v, a, f.tol)) return 'given';
    for (const a of g.any) if (near(v, a, f.tol)) return 'given';
    if (!ARITHMETIC.test(f.sentence || '')) return '';
    // arithmetic is exact: to the unit, whatever the tolerance of a figure written in round numbers
    const exact = 1.5;
    if (f.kind === 'span') { for (const a of g.span) if (a > 0 && (near(v, a / 12, 0.05) || near(v, a * 12, 0.05))) return 'derived'; }
    if (f.kind === 'money') {
        // one figure times or over a small whole number (a year of a month, half of a total)
        for (const a of pool) for (const k of DERIVE_BY) if (near(v, a * k, exact) || near(v, a / k, exact)) return 'derived';
        // two figures added or taken from each other
        const small = pool.slice(0, 600);
        for (let i = 0; i < small.length; i++) for (let j = i; j < small.length; j++) { const a = small[i], b = small[j]; if (near(v, a + b, exact) || near(v, Math.abs(a - b), exact)) return 'derived'; }
    }
    return '';
}

/**
 * Read an answer back against the books.
 * Returns { checked, given, derived, estimates, unknown: [{ text, kind, value, sentence }], ok, counted }.
 * `counted` is false when there was nothing to check against (no sheet), in which case nothing is claimed either way.
 */
export function check(reply, parts, owner) {
    const g = groundingFrom(parts, owner);
    const have = g.money.length + g.pct.length + g.span.length + g.count.length;
    const r = { checked: 0, given: 0, derived: 0, estimates: 0, unknown: [], ok: true, counted: have > 0 };
    if (!r.counted) return r;
    const seen = new Set();
    for (const f of figuresIn(reply)) {
        if (f.kind === 'plain') continue;
        const key = `${f.kind}:${Math.round(f.value * 100) / 100}`;
        if (seen.has(key)) continue;
        seen.add(key);
        r.checked++;
        const how = matchOf(f, g);
        if (how === 'given') r.given++;
        else if (how === 'derived') r.derived++;
        else if (f.estimate) r.estimates++;
        else r.unknown.push({ text: f.text, kind: f.kind, value: Math.round(f.value * 100) / 100, sentence: f.sentence });
    }
    r.ok = r.unknown.length === 0;
    return r;
}

/** The note that goes back to the model when figures were not from the books. */
export function correctionNote(unknown) {
    const list = unknown.slice(0, 8).map((u) => `"${clip(u.text, 30).replace(/"/g, "'")}"`).join(', ');
    return `[ACCURACY CHECK by WealthFlow (not from the owner): the answer above has figures that are in neither THE OWNER'S BOOKS nor the WHAT-IF block, and the owner did not type them: ${list}. ` +
        `Write the answer again, in the same language and style. Use only figures that appear in those blocks. If a figure you need is not there, say it is not in their books instead of guessing. ` +
        `A general figure (a market rate, a rule of thumb) must be called typical, not theirs. A sum of your own must be labelled an estimate with its two source figures. Do not mention this check.]`;
}

/** The conversation as it was sent, with the first answer and the correction after it, ready for the same engines. */
export function revisionPrompt(basePrompt, reply, unknown) {
    const base = String(basePrompt || '').replace(/\s*AI:\s*$/, '');
    return `${base}\nAI: ${String(reply).trim()}\n\n${correctionNote(unknown)}\nAI:`;
}

const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });

/**
 * Check an answer; when a money figure or a percentage is not from the books, ask for it again once and keep the new answer only if it is better.
 * `grounding` is { parts: [fact sheet, worked block], owner: [what the owner typed], prompt: the prompt as sent }. `ask(prompt)` returns the model's new text.
 * Returns { reply, verdict, revised }. Never throws; with nothing to check against it returns the reply untouched and a null verdict.
 */
export async function verify(reply, grounding, ask, o = {}) {
    try {
        const g = grounding || {};
        if (typeof reply !== 'string' || !reply.trim() || !Array.isArray(g.parts)) return { reply, verdict: null, revised: false };
        const first = check(reply, g.parts, g.owner);
        if (!first.counted) return { reply, verdict: null, revised: false };
        const serious = first.unknown.filter((u) => u.kind === 'money' || u.kind === 'pct');
        if (!serious.length || typeof ask !== 'function' || !g.prompt) return { reply, verdict: first, revised: false };
        try {
            const raw = await withTimeout(ask(revisionPrompt(g.prompt, reply, serious)), o.timeoutMs || 25000);
            const text = String(raw == null ? '' : raw).replace(/FOLLOWUPS:\s*\[[\s\S]*?\]/, '').replace(/^#{1,3}\s+/gm, '').trim();
            if (text && text.length > 20) {
                const second = check(text, g.parts, g.owner);
                const seriousAfter = second.unknown.filter((u) => u.kind === 'money' || u.kind === 'pct');
                if (seriousAfter.length < serious.length) return { reply: text, verdict: second, revised: true, before: first };
            }
        } catch (_) { /* the first answer stands, with what is wrong with it shown */ }
        return { reply, verdict: first, revised: false };
    } catch (_) { return { reply, verdict: null, revised: false }; }
}

/** What to tell the owner under the answer: { tone: 'ok' | 'warn', text }, or null when there was nothing to say. */
export function chipOf(result) {
    const v = result && result.verdict;
    if (!v || !v.counted || (!v.checked && !v.unknown.length)) return null;
    if (v.unknown.length) {
        const list = v.unknown.slice(0, 4).map((u) => clip(u.text, 24)).join(', ');
        return { tone: 'warn', text: `${v.unknown.length} figure${v.unknown.length === 1 ? '' : 's'} in this answer ${v.unknown.length === 1 ? 'is' : 'are'} not from your books (${list}). Treat ${v.unknown.length === 1 ? 'it' : 'them'} as the AI's own estimate.` };
    }
    const own = v.given + v.derived;
    if (!own) return null;
    const extra = [v.derived ? `${v.derived} worked out from them` : '', v.estimates ? `${v.estimates} labelled as estimate${v.estimates === 1 ? '' : 's'}` : ''].filter(Boolean);
    return { tone: 'ok', text: `${result.revised ? 'Corrected once, then checked' : 'Checked'} against your books: ${own} figure${own === 1 ? '' : 's'}${extra.length ? ` (${extra.join(', ')})` : ''}.` };
}

const API = { CHECK_VERSION, figuresIn, groundingFrom, check, correctionNote, revisionPrompt, verify, chipOf };
if (typeof window !== 'undefined') window.WFAdvisorCheck = API;
export default API;
