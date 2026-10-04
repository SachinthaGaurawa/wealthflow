/* =============================================================================
 * advisor-research.mjs — what the world says, for the one question that needs it
 * -----------------------------------------------------------------------------
 * The Advisor knows the owner's books exactly (wealthflow-advisor-facts.js) and the world only as of when its model was trained. "What is the fixed deposit rate now?",
 * "is the policy rate going down?", "what is the tax on a lump sum?" are questions about the OUTSIDE, and a model that answers them from memory gives a figure that was
 * true once. This module looks the question up on the web and hands back a short list of sources, each with the page it came from and what it says, so the Advisor can
 * answer from them, cite them, and say when it found nothing.
 *
 * Providers, in the order they are tried, each only when its key is set: Tavily (TAVILY_API_KEY), Brave Search (BRAVE_API_KEY), Serper (SERPER_API_KEY), and Gemini with
 * Google Search grounding (the project's Gemini key). The same keys merchant-search.js already reads. The first one that returns something wins; none configured, or all
 * failed, is an honest "not available" and never an error: the Advisor then says the figure could not be looked up and may be out of date.
 *
 * What leaves the server, and what does not: only the search query, with figures, emails, phone numbers and links taken out of it again here (the page does it first). The
 * owner's books, balances and names are never sent. What comes back is untrusted web text: it is stripped of markup and of anything that could pose as the Advisor's own
 * delimiters, cut to a length, and handed to the model as data (wealthflow-advisor-research.js says so before and after it).
 *
 * Pure but for the injected `fetcher`, `now`, `log`: nothing here reads the environment except through the `env` it is given.
 * ===========================================================================*/

import { geminiGenerate, geminiKeyOf } from './gemini-client.mjs';
import { fetchWithTimeout } from './fetch-timeout.mjs';

export const RESEARCH_VERSION = 1;
export const RULES = Object.freeze({
    MAX_SOURCES: 5,
    MAX_QUERY: 160,
    SNIPPET: 280,
    TITLE: 110,
    PROVIDER_MS: 4500,        // one provider
    DEADLINE_MS: 9000,        // the whole lookup, every provider included
    CACHE_MS: 15 * 60 * 1000,
    CACHE_MAX: 100,
    RATE_WINDOW_MS: 10 * 60 * 1000,
    RATE_MAX: 30,             // lookups per caller per window: a person asking questions, not a script spending the search credits
});

/** Anything that came from the open web, made safe to put in front of a model and on a page. */
export function cleanText(s, max = RULES.SNIPPET) {
    return String(s == null ? '' : s)
        .replace(/<[^>]*>/g, ' ')                                           // markup (Brave marks matches with <strong>)
        .replace(/&(?:nbsp|#160);/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&(?:#39|apos);/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ')                // control characters and line breaks
        .replace(/={3,}/g, '=')                                             // a run of "=" is how the Advisor's own blocks open and close
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

/** The host of an http(s) address, without "www."; '' for anything else (javascript:, data:, a bare word). */
export function hostOf(url) {
    try {
        const u = new URL(String(url));
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
        return u.hostname.replace(/^www\./i, '').toLowerCase();
    } catch (_) { return ''; }
}

/** The query, with anything personal taken out once more: figures of four or more digits, emails, links, phone numbers. */
export function scrubQuery(q) {
    return cleanText(q, 600)
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
        .replace(/\b(?:lkr|rs\.?|රු\.?)\s*[\d,]+(?:\.\d+)?(?:\s*(?:k|m|mn|lakh|lakhs|crore))?\b/gi, ' ')
        .replace(/\b\d+(?:\.\d+)?\s*(?:k|m|mn|million|lakhs?|crore)\b/gi, ' ')
        .replace(/\b\d+(?:,\d+)+(?:\.\d+)?\b|\b\d{4,}(?:\.\d+)?\b/g, (m) => (/^(?:19|20)\d{2}$/.test(m) ? m : ' '))
        .replace(/\+?\d[\d\s().-]{7,}\d/g, ' ')   // a year is not personal; a salary is
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, RULES.MAX_QUERY);
}

/** Keys the providers need, from the environment given. Names only: never a value. */
export function configured(env = (typeof process !== 'undefined' && process.env) || {}) {
    const out = [];
    if (env.TAVILY_API_KEY) out.push('tavily');
    if (env.BRAVE_API_KEY) out.push('brave');
    if (env.SERPER_API_KEY) out.push('serper');
    if (geminiKeyOf(env)) out.push('gemini');
    return out;
}

const arr = (v) => (Array.isArray(v) ? v : []);

/** One result, made safe, or null when it has no usable address or nothing to say. */
function source(title, url, snippet, date) {
    const host = hostOf(url);
    if (!host) return null;
    const t = cleanText(title, RULES.TITLE), s = cleanText(snippet, RULES.SNIPPET);
    if (!t && !s) return null;
    return { title: t || host, url: String(url).slice(0, 400), host, snippet: s, date: cleanText(date, 40) };
}

/** Dedupe by address (ignoring a trailing slash and the fragment), keep the first MAX_SOURCES, number them from 1. */
export function finish(list) {
    const seen = new Set(), out = [];
    for (const s of list) {
        if (!s) continue;
        const key = s.url.replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ n: out.length + 1, ...s });
        if (out.length >= RULES.MAX_SOURCES) break;
    }
    return out;
}

/* ── the providers: each turns its own answer into [{ title, url, host, snippet, date }] ── */

export function fromTavily(d) {
    return finish(arr(d && d.results).map((r) => source(r && r.title, r && r.url, r && r.content, r && r.published_date)));
}
export function fromBrave(d) {
    return finish(arr(((d && d.web) || {}).results).map((r) => source(r && r.title, r && r.url, r && r.description, (r && (r.page_age || r.age)) || '')));
}
export function fromSerper(d) {
    const out = [];
    const box = d && d.answerBox;
    if (box && (box.link || box.url)) out.push(source(box.title, box.link || box.url, box.answer || box.snippet || '', ''));
    for (const r of arr(d && d.organic)) out.push(source(r && r.title, r && r.link, r && r.snippet, r && r.date));
    return finish(out);
}

/**
 * Gemini with Google Search grounding. The answer comes with the pages it was grounded on (groundingChunks) and which sentence rests on which page (groundingSupports):
 * the sentences become the notes, each followed by the numbers of its sources. An answer with NO grounding is not research, whatever it says: it is the model's memory
 * again, so it is refused here.
 */
export function fromGemini(result) {
    const g = result && result.grounding;
    const chunks = arr(g && g.groundingChunks).map((c) => c && c.web);
    const mine = chunks.map((w) => {
        const host = w ? hostOf(w.uri) : '';
        if (!host) return null;
        const t = cleanText(w.title, RULES.TITLE);
        return { title: t || host, url: String(w.uri).slice(0, 400), host: /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) ? t.toLowerCase().replace(/^www\./, '') : host, snippet: '', date: '' };
    });
    const sources = finish(mine);
    if (!sources.length) return { sources: [], notes: '' };
    const keyOf = (u) => String(u).replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
    const numberOf = new Map();                                              // a page's place in the chunk list -> its number in the finished list
    mine.forEach((s, i) => { const hit = s && sources.find((x) => keyOf(x.url) === keyOf(s.url)); if (hit) numberOf.set(i, hit.n); });
    const lines = [];
    for (const sup of arr(g && g.groundingSupports)) {
        const text = cleanText(sup && sup.segment && sup.segment.text, 400);
        const refs = [...new Set(arr(sup && sup.groundingChunkIndices).map((i) => numberOf.get(i)).filter(Boolean))].sort((a, b) => a - b);
        if (text && refs.length) lines.push(`${text} ${refs.map((n) => `[${n}]`).join('')}`);
    }
    const whole = cleanText(result && result.text, 900);
    return { sources, notes: lines.length ? lines.slice(0, 8).join('\n') : (whole ? `${whole} ${sources.map((x) => `[${x.n}]`).join('')}` : '') };
}

/* ── the lookup ── */

async function viaTavily(q, key, fetcher) {
    const r = await fetcher('https://api.tavily.com/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ api_key: key, query: q, search_depth: 'basic', max_results: 6, include_answer: false }),
    }, RULES.PROVIDER_MS);
    if (!r.ok) throw Object.assign(new Error(`tavily ${r.status}`), { status: r.status });
    return { sources: fromTavily(await r.json()), notes: '' };
}
async function viaBrave(q, key, fetcher) {
    const r = await fetcher(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=6&country=lk&search_lang=en`, {
        headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
    }, RULES.PROVIDER_MS);
    if (!r.ok) throw Object.assign(new Error(`brave ${r.status}`), { status: r.status });
    return { sources: fromBrave(await r.json()), notes: '' };
}
async function viaSerper(q, key, fetcher) {
    const r = await fetcher('https://google.serper.dev/search', {
        method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl: 'lk', hl: 'en', num: 6 }),
    }, RULES.PROVIDER_MS);
    if (!r.ok) throw Object.assign(new Error(`serper ${r.status}`), { status: r.status });
    return { sources: fromSerper(await r.json()), notes: '' };
}
async function viaGemini(q, key, fetcher, generate) {
    const prompt = `Use Google Search to answer this question about Sri Lanka with current facts: ${q}\nWrite at most six short factual lines. Give each figure exactly as published, with the date it applies to and who published it. If you cannot find a published figure, say that and do not estimate.`;
    const result = await generate({ key, parts: [{ text: prompt }], tools: [{ google_search: {} }], temperature: 0, maxOutputTokens: 900, deadlineMs: RULES.PROVIDER_MS + 2500, attemptMs: RULES.PROVIDER_MS + 2000, fetcher });
    return fromGemini(result);
}

function runnersFor(query, env, fetcher, generate) {
    return {
        tavily: () => viaTavily(query, env.TAVILY_API_KEY, fetcher),
        brave: () => viaBrave(query, env.BRAVE_API_KEY, fetcher),
        serper: () => viaSerper(query, env.SERPER_API_KEY, fetcher),
        gemini: () => viaGemini(query, geminiKeyOf(env), fetcher, generate),
    };
}

/** An error message for a report, with every key value and any `key=` in an address taken out. */
function redact(message, env) {
    let m = cleanText(message, 160).replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1…');
    for (const v of Object.values(env || {})) if (typeof v === 'string' && v.length >= 8) m = m.split(v).join('…');
    return m.slice(0, 100);
}

/**
 * Ask EVERY configured provider one fixed public question and say, for each, whether it gave pages (and from which sites), how long it took, or why not. This is how the
 * owner (and the next engineer) can see which provider actually works with the real key, which a lookup that stops at the first answer never shows. Nothing personal is
 * involved: the question is the same one every time. Never throws; never returns a key.
 */
export const PROBE_QUESTION = 'Central Bank of Sri Lanka overnight policy rate';
export async function probe(o = {}) {
    const { env = (typeof process !== 'undefined' && process.env) || {}, fetcher = fetchWithTimeout, generate = geminiGenerate, now = Date.now } = o;
    const names = configured(env);
    const runners = runnersFor(PROBE_QUESTION, env, fetcher, generate);
    const results = await Promise.all(names.map(async (name) => {
        const t0 = now();
        try {
            const got = await runners[name]();
            const list = (got && got.sources) || [];
            const r = { name, ok: list.length > 0, sources: list.length, hosts: list.slice(0, 3).map((s) => s.host), ms: now() - t0 };
            if (!r.ok) r.error = 'answered with no pages';
            return r;
        } catch (e) {
            return { name, ok: false, sources: 0, hosts: [], ms: now() - t0, error: redact(e && e.message, env) || 'failed' };
        }
    }));
    return { query: PROBE_QUESTION, at: new Date(now()).toISOString(), results };
}

/**
 * Look the question up. Never throws. Returns { ok, via, query, at, sources, notes } or { ok: false, reason } where reason is
 * `no-question`, `not-configured`, `empty` (a provider answered with nothing usable), `failed` or `timeout`.
 */
export async function search(question, o = {}) {
    const { env = (typeof process !== 'undefined' && process.env) || {}, fetcher = fetchWithTimeout, generate = geminiGenerate, now = Date.now, log = () => {} } = o;
    const query = scrubQuery(question);
    if (query.length < 3) return { ok: false, reason: 'no-question' };
    const names = configured(env);
    if (!names.length) return { ok: false, reason: 'not-configured', query };
    const startedAt = now();
    const runners = runnersFor(query, env, fetcher, generate);
    let reason = 'empty';
    for (const name of names) {
        if (now() - startedAt > RULES.DEADLINE_MS - 1500) { reason = 'timeout'; break; }
        try {
            const got = await runners[name]();
            if (got && got.sources && got.sources.length) {
                return { ok: true, via: name, query, at: new Date(now()).toISOString(), sources: got.sources, notes: String(got.notes || '').split('\n').map((l) => cleanText(l, 420)).filter(Boolean).slice(0, 8).join('\n') };
            }
        } catch (e) {
            reason = e && (e.name === 'AbortError' || /timeout|deadline/i.test(String(e && e.message))) ? 'timeout' : 'failed';
            try { log(`[research] ${name} ${reason}: ${cleanText(e && e.message, 120)}`); } catch (_) { /* a log is advice */ }
        }
    }
    return { ok: false, reason, query };
}

/* ── the cache and the per-caller limit: a person asking questions, not a script spending the search credits ── */

export function makeLimiter(rules = RULES) {
    const cache = new Map(), hits = new Map();
    return {
        cached(key, at) { const e = cache.get(key); if (e && at - e.at < rules.CACHE_MS) return e.value; if (e) cache.delete(key); return null; },
        keep(key, value, at) {
            if (!value || !value.ok) return;                               // a failure is not worth remembering: the next try may work
            cache.set(key, { at, value });
            while (cache.size > rules.CACHE_MAX) cache.delete(cache.keys().next().value);
        },
        allow(who, at) {
            const list = (hits.get(who) || []).filter((t) => at - t < rules.RATE_WINDOW_MS);
            if (list.length >= rules.RATE_MAX) { hits.set(who, list); return false; }
            list.push(at); hits.set(who, list);
            if (hits.size > 2000) hits.delete(hits.keys().next().value);
            return true;
        },
    };
}

const API = { RESEARCH_VERSION, RULES, cleanText, hostOf, scrubQuery, configured, finish, fromTavily, fromBrave, fromSerper, fromGemini, search, probe, makeLimiter };
export default API;
