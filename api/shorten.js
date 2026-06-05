// ==================== WealthFlow → Ultra-Short URL Proxy ====================
// Server-side URL shortener that bypasses ALL CORS restrictions.
// Runs on Vercel as a serverless function at /api/shorten
//
// The browser sends: POST { url }
// The server returns: { short, service, original }
//
// Shortener chain (tried in order, first success wins):
//   1. is.gd       — Ultra-short URLs (e.g. https://is.gd/aBcDeF)
//   2. v.gd        — Sister service of is.gd
//   3. TinyURL     — Classic, reliable, permanent
//   4. clck.ru     — Yandex shortener, very short
//   5. ulvis.net   — Free API shortener
//   6. Da.gd       — Minimal URL shortener
//
// Privacy: Zero user data is transmitted. Only the raw URL is shortened.
// No names, no emails, no UIDs — guaranteed.

export const config = {
    maxDuration: 12
};

export default async function handler(req, res) {
    // CORS — allow any origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });

    const errors = [];

    // ── STRATEGY 1: is.gd (ultra-short, reliable) ──
    try {
        const r = await fetchWithTimeout(
            'https://is.gd/create.php?format=json&url=' + encodeURIComponent(url),
            { method: 'GET' }, 5000
        );
        if (r.ok) {
            const d = await r.json();
            if (d.shorturl && d.shorturl.startsWith('http')) {
                return res.status(200).json({ short: d.shorturl, service: 'is.gd', original: url });
            }
        }
        errors.push('is.gd: status ' + r.status);
    } catch (e) {
        errors.push('is.gd: ' + e.message);
    }

    // ── STRATEGY 2: v.gd (sister of is.gd) ──
    try {
        const r = await fetchWithTimeout(
            'https://v.gd/create.php?format=json&url=' + encodeURIComponent(url),
            { method: 'GET' }, 5000
        );
        if (r.ok) {
            const d = await r.json();
            if (d.shorturl && d.shorturl.startsWith('http')) {
                return res.status(200).json({ short: d.shorturl, service: 'v.gd', original: url });
            }
        }
        errors.push('v.gd: status ' + r.status);
    } catch (e) {
        errors.push('v.gd: ' + e.message);
    }

    // ── STRATEGY 3: TinyURL (classic, permanent) ──
    try {
        const r = await fetchWithTimeout(
            'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(url),
            { method: 'GET' }, 5000
        );
        if (r.ok) {
            const text = (await r.text()).trim();
            if (text.startsWith('http')) {
                return res.status(200).json({ short: text, service: 'tinyurl', original: url });
            }
        }
        errors.push('tinyurl: status ' + r.status);
    } catch (e) {
        errors.push('tinyurl: ' + e.message);
    }

    // ── STRATEGY 4: clck.ru (Yandex, very short) ──
    try {
        const r = await fetchWithTimeout(
            'https://clck.ru/--?url=' + encodeURIComponent(url),
            { method: 'GET' }, 5000
        );
        if (r.ok) {
            const text = (await r.text()).trim();
            if (text.startsWith('http')) {
                return res.status(200).json({ short: text, service: 'clck.ru', original: url });
            }
        }
        errors.push('clck.ru: status ' + r.status);
    } catch (e) {
        errors.push('clck.ru: ' + e.message);
    }

    // ── STRATEGY 5: da.gd (minimal, clean) ──
    try {
        const r = await fetchWithTimeout(
            'https://da.gd/s?url=' + encodeURIComponent(url),
            { method: 'GET' }, 5000
        );
        if (r.ok) {
            const text = (await r.text()).trim();
            if (text.startsWith('http')) {
                return res.status(200).json({ short: text, service: 'da.gd', original: url });
            }
        }
        errors.push('da.gd: status ' + r.status);
    } catch (e) {
        errors.push('da.gd: ' + e.message);
    }

    // ── STRATEGY 6: ulvis.net (free API) ──
    try {
        const r = await fetchWithTimeout(
            'https://ulvis.net/API/write/get?url=' + encodeURIComponent(url),
            { method: 'GET' }, 5000
        );
        if (r.ok) {
            const text = (await r.text()).trim();
            // ulvis.net returns a JSON response
            try {
                const d = JSON.parse(text);
                if (d.data && d.data.url && d.data.url.startsWith('http')) {
                    return res.status(200).json({ short: d.data.url, service: 'ulvis.net', original: url });
                }
            } catch (parseErr) {
                // If it returned plain text URL
                if (text.startsWith('http')) {
                    return res.status(200).json({ short: text, service: 'ulvis.net', original: url });
                }
            }
        }
        errors.push('ulvis.net: status ' + r.status);
    } catch (e) {
        errors.push('ulvis.net: ' + e.message);
    }

    // All strategies failed — return the original URL
    console.error('[shorten] All shorteners failed:', errors);
    return res.status(200).json({
        short: url,
        service: 'none',
        original: url,
        fallback: true,
        errors: errors
    });
}

async function fetchWithTimeout(url, options, timeoutMs = 5000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
