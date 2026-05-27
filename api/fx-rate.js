// =============================================================================
// WealthFlow FX Engine v1.0
//
// Returns live exchange rates. Uses exchangerate.host (free, no API key)
// with per-pair 30-minute in-memory caching (best-effort on Edge — survives
// within a single Vercel region instance).
//
// GET /api/fx-rate?from=USD&to=LKR              → single pair
// GET /api/fx-rate?base=LKR&symbols=USD,EUR,GBP → multi-pair
// POST /api/fx-rate { amount, from, to }        → returns converted amount
// =============================================================================

export const config = { runtime: 'edge' };

const CACHE_TTL_MS = 30 * 60 * 1000;            // 30 minutes
const _cache = new Map();                        // key = `${base}|${syms}` → {ts, data}

async function fetchRates(base, symbols) {
    const key = `${base}|${(symbols || []).join(',')}`;
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
        return { ...hit.data, cached: true, cache_age_ms: Date.now() - hit.ts };
    }
    const url = symbols && symbols.length
        ? `https://api.exchangerate.host/latest?base=${base}&symbols=${symbols.join(',')}`
        : `https://api.exchangerate.host/latest?base=${base}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('FX upstream ' + r.status);
    const data = await r.json();
    _cache.set(key, { ts: Date.now(), data });
    // LRU-ish bound — drop oldest if cache too big
    if (_cache.size > 60) {
        const oldest = [..._cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) _cache.delete(oldest[0]);
    }
    return { ...data, cached: false };
}

export default async function handler(req) {
    try {
        if (req.method === 'GET') {
            const u = new URL(req.url);
            const base = (u.searchParams.get('from') || u.searchParams.get('base') || 'USD').toUpperCase();
            const to   = u.searchParams.get('to');
            const syms = u.searchParams.get('symbols');
            const symList = syms ? syms.split(',').map(s => s.trim().toUpperCase())
                          : (to ? [to.toUpperCase()] : []);

            const data = await fetchRates(base, symList);
            return new Response(JSON.stringify({
                ok: true, base: data.base, date: data.date, rates: data.rates,
                cached: data.cached, cache_age_ms: data.cache_age_ms
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (req.method === 'POST') {
            const body = await req.json();
            const amount = Number(body.amount || 0);
            const from = (body.from || 'USD').toUpperCase();
            const to   = (body.to   || 'LKR').toUpperCase();
            if (!amount || from === to) {
                return new Response(JSON.stringify({
                    ok: true, amount_in: amount, from, to, amount_out: amount, rate: 1
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            const data = await fetchRates(from, [to]);
            const rate = data.rates && data.rates[to];
            if (!rate) throw new Error('Rate not available for ' + from + '→' + to);
            return new Response(JSON.stringify({
                ok: true, amount_in: amount, from, to,
                rate, amount_out: Number((amount * rate).toFixed(2)),
                date: data.date, cached: data.cached
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: false, error: 'GET or POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
}
