// =================== Market Data Proxy v1.0 — Alpha Vantage ===================
//
// Endpoints (GET): /api/market-data?type=...&...
//   type=quote      params: symbol         → real-time stock quote
//   type=fx         params: from, to       → currency exchange rate (LKR↔USD etc.)
//   type=crypto     params: symbol         → crypto to USD (BTC, ETH, etc.)
//   type=daily      params: symbol         → 100 days OHLC
//   type=intraday   params: symbol, interval=5min|15min|60min
//   type=search     params: keywords       → symbol search
//   type=overview   params: symbol         → company fundamentals
//   type=news       params: tickers (csv)  → sentiment-tagged news
//   type=topgainers no params              → top US gainers/losers
//
// Each response is cached server-side for 5 minutes (in-memory per cold start)
// to respect the Alpha Vantage free-tier rate limit (25 requests / day).
//
// Env vars:
//   ALPHA_VANTAGE_API_KEY (required; embedded fallback for dev)
// ===============================================================================

export const config = { maxDuration: 15 };

// SECURITY: Provided in chat → rotate at alphavantage.co and set env var.
const EMBEDDED_KEY_FALLBACK = 'IQSFECPP4026SWFH';

// 5-min in-memory cache (cold-start scoped; that's fine for free-tier protection)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function cacheKey(type, params) {
    return type + ':' + JSON.stringify(params);
}

async function fetchWithTimeout(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const r = await fetch(url, { signal: controller.signal });
        return r;
    } finally { clearTimeout(timer); }
}

async function alphaCall(params, apiKey) {
    const qs = new URLSearchParams({ ...params, apikey: apiKey });
    const url = `https://www.alphavantage.co/query?${qs.toString()}`;
    const r = await fetchWithTimeout(url);
    if (!r.ok) throw new Error(`Alpha Vantage status ${r.status}`);
    const data = await r.json();
    if (data['Error Message']) throw new Error(data['Error Message']);
    if (data['Note']) throw new Error('Rate limit: ' + data['Note']);
    if (data['Information']) throw new Error('API limit: ' + data['Information']);
    return data;
}

// ---- Type handlers ----
async function getQuote(params, key) {
    const data = await alphaCall({ function: 'GLOBAL_QUOTE', symbol: params.symbol }, key);
    const q = data['Global Quote'];
    if (!q || Object.keys(q).length === 0) throw new Error('Symbol not found');
    return {
        symbol: q['01. symbol'],
        price: parseFloat(q['05. price']),
        open: parseFloat(q['02. open']),
        high: parseFloat(q['03. high']),
        low: parseFloat(q['04. low']),
        volume: parseInt(q['06. volume'], 10),
        latest_day: q['07. latest trading day'],
        previous_close: parseFloat(q['08. previous close']),
        change: parseFloat(q['09. change']),
        change_percent: q['10. change percent']
    };
}

async function getFx(params, key) {
    const data = await alphaCall({
        function: 'CURRENCY_EXCHANGE_RATE',
        from_currency: params.from,
        to_currency: params.to
    }, key);
    const r = data['Realtime Currency Exchange Rate'];
    if (!r) throw new Error('FX pair not available');
    return {
        from: r['1. From_Currency Code'],
        from_name: r['2. From_Currency Name'],
        to: r['3. To_Currency Code'],
        to_name: r['4. To_Currency Name'],
        rate: parseFloat(r['5. Exchange Rate']),
        last_refreshed: r['6. Last Refreshed'],
        bid: parseFloat(r['8. Bid Price']),
        ask: parseFloat(r['9. Ask Price'])
    };
}

async function getCrypto(params, key) {
    return await getFx({ from: params.symbol, to: params.quote || 'USD' }, key);
}

async function getDaily(params, key) {
    const data = await alphaCall({
        function: 'TIME_SERIES_DAILY',
        symbol: params.symbol,
        outputsize: 'compact'  // 100 days
    }, key);
    const ts = data['Time Series (Daily)'];
    if (!ts) throw new Error('No daily series');
    const series = Object.entries(ts).slice(0, 100).map(([date, ohlc]) => ({
        date,
        open: parseFloat(ohlc['1. open']),
        high: parseFloat(ohlc['2. high']),
        low: parseFloat(ohlc['3. low']),
        close: parseFloat(ohlc['4. close']),
        volume: parseInt(ohlc['5. volume'], 10)
    }));
    return { symbol: data['Meta Data']['2. Symbol'], series };
}

async function getIntraday(params, key) {
    const data = await alphaCall({
        function: 'TIME_SERIES_INTRADAY',
        symbol: params.symbol,
        interval: params.interval || '5min',
        outputsize: 'compact'
    }, key);
    const tsKey = Object.keys(data).find(k => k.startsWith('Time Series'));
    if (!tsKey) throw new Error('No intraday series');
    const series = Object.entries(data[tsKey]).slice(0, 100).map(([dt, ohlc]) => ({
        datetime: dt,
        open: parseFloat(ohlc['1. open']),
        high: parseFloat(ohlc['2. high']),
        low: parseFloat(ohlc['3. low']),
        close: parseFloat(ohlc['4. close']),
        volume: parseInt(ohlc['5. volume'], 10)
    }));
    return { symbol: data['Meta Data']['2. Symbol'], interval: params.interval || '5min', series };
}

async function getSearch(params, key) {
    const data = await alphaCall({
        function: 'SYMBOL_SEARCH',
        keywords: params.keywords
    }, key);
    return { matches: (data.bestMatches || []).slice(0, 10).map(m => ({
        symbol: m['1. symbol'],
        name: m['2. name'],
        type: m['3. type'],
        region: m['4. region'],
        currency: m['8. currency'],
        match_score: parseFloat(m['9. matchScore'])
    })) };
}

async function getOverview(params, key) {
    const data = await alphaCall({ function: 'OVERVIEW', symbol: params.symbol }, key);
    if (!data.Symbol) throw new Error('Overview not available');
    return {
        symbol: data.Symbol, name: data.Name, sector: data.Sector, industry: data.Industry,
        country: data.Country, exchange: data.Exchange, currency: data.Currency,
        market_cap: data.MarketCapitalization, pe_ratio: parseFloat(data.PERatio),
        peg_ratio: parseFloat(data.PEGRatio), book_value: parseFloat(data.BookValue),
        dividend_yield: parseFloat(data.DividendYield), eps: parseFloat(data.EPS),
        rev_per_share: parseFloat(data.RevenuePerShareTTM),
        profit_margin: parseFloat(data.ProfitMargin), beta: parseFloat(data.Beta),
        week52_high: parseFloat(data['52WeekHigh']), week52_low: parseFloat(data['52WeekLow']),
        ma50: parseFloat(data['50DayMovingAverage']), ma200: parseFloat(data['200DayMovingAverage']),
        target_price: parseFloat(data.AnalystTargetPrice),
        description: data.Description ? data.Description.slice(0, 800) : null
    };
}

async function getNews(params, key) {
    const args = { function: 'NEWS_SENTIMENT', sort: 'LATEST', limit: '20' };
    if (params.tickers) args.tickers = params.tickers;
    if (params.topics) args.topics = params.topics;
    const data = await alphaCall(args, key);
    return {
        items: (data.feed || []).slice(0, 20).map(it => ({
            title: it.title,
            url: it.url,
            time_published: it.time_published,
            source: it.source,
            summary: it.summary ? it.summary.slice(0, 400) : null,
            overall_sentiment_score: parseFloat(it.overall_sentiment_score),
            overall_sentiment_label: it.overall_sentiment_label,
            ticker_sentiments: (it.ticker_sentiment || []).slice(0, 5).map(t => ({
                ticker: t.ticker,
                relevance: parseFloat(t.relevance_score),
                score: parseFloat(t.ticker_sentiment_score),
                label: t.ticker_sentiment_label
            }))
        }))
    };
}

async function getTopGainers(_params, key) {
    const data = await alphaCall({ function: 'TOP_GAINERS_LOSERS' }, key);
    return {
        last_updated: data.last_updated,
        top_gainers: (data.top_gainers || []).slice(0, 10),
        top_losers: (data.top_losers || []).slice(0, 10),
        most_actively_traded: (data.most_actively_traded || []).slice(0, 10)
    };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const key = process.env.ALPHA_VANTAGE_API_KEY || EMBEDDED_KEY_FALLBACK;
    if (!key) return res.status(503).json({ error: 'ALPHA_VANTAGE_API_KEY not configured' });

    const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
    const type = params.type;
    if (!type) return res.status(400).json({ error: 'Missing "type" query param' });

    // Cache lookup
    const ck = cacheKey(type, params);
    const cached = cache.get(ck);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL) {
        return res.status(200).json({ ...cached.data, _cached: true, _ageMs: Date.now() - cached.cachedAt });
    }

    try {
        let data;
        switch (type) {
            case 'quote':       data = await getQuote(params, key); break;
            case 'fx':          data = await getFx(params, key); break;
            case 'crypto':      data = await getCrypto(params, key); break;
            case 'daily':       data = await getDaily(params, key); break;
            case 'intraday':    data = await getIntraday(params, key); break;
            case 'search':      data = await getSearch(params, key); break;
            case 'overview':    data = await getOverview(params, key); break;
            case 'news':        data = await getNews(params, key); break;
            case 'topgainers':  data = await getTopGainers(params, key); break;
            default: return res.status(400).json({ error: 'Unknown type: ' + type });
        }
        const payload = { type, data };
        cache.set(ck, { data: payload, cachedAt: Date.now() });
        return res.status(200).json({ ...payload, _cached: false });
    } catch (e) {
        return res.status(502).json({ error: String(e.message || e), type });
    }
}
