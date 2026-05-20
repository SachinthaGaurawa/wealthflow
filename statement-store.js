// ==================== WealthFlow → Statement Store ====================
// Stores a loan-statement HTML document and returns a TINY shareable URL.
//
// The browser sends:  POST { html, name }
// The server returns: { url, id, days, via }
//
// Strategy order (server-side — no CORS, no client auth needed):
//   1. 0x0.st          — free, NO account, ~1 year retention, direct link,
//                        works reliably from a server. PRIMARY.
//   2. tmpfiles.org    — free, no account (shorter retention) — backup.
//   3. Firestore REST  — project key write to collection `s` (?s=ID viewer).
//
// The result is always a short link (≈25–60 chars). The giant data-in-URL
// fallback that produced 191 000-char links has been removed entirely — if
// every host is unreachable we return an honest error instead of an
// unusable link.
// =====================================================================

export const config = { maxDuration: 20 };

const PROJECT_ID = 'wealthflow-6dffb';
const API_KEY = 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function randomId(n) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789';
    let s = '';
    for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
}

async function withTimeout(fn, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fn(ctrl.signal); }
    finally { clearTimeout(t); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { html, name } = req.body || {};
        if (!html || typeof html !== 'string') {
            return res.status(400).json({ error: 'Missing statement html' });
        }
        if (html.length > 4 * 1024 * 1024) {
            return res.status(413).json({ error: 'Statement too large' });
        }

        const id = randomId(8);
        const cleanName = String(name || 'Statement').replace(/[<>]/g, '').slice(0, 60);
        const expiresMs = Date.now() + 365 * 24 * 60 * 60 * 1000;

        const pageHtml = html.trim().startsWith('<')
            ? html
            : `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${cleanName} — WealthFlow</title></head><body style="margin:0;background:#0a0e1a;">${html}</body></html>`;
        const bytes = Buffer.from(pageHtml, 'utf8');

        // ── STRATEGY 1: 0x0.st (primary — free, no account, ~1yr, direct) ──
        try {
            const link = await withTimeout(async (signal) => {
                const fd = new FormData();
                fd.append('file', new Blob([bytes], { type: 'text/html' }), `${cleanName}.html`);
                const up = await fetch('https://0x0.st', {
                    method: 'POST',
                    body: fd,
                    headers: { 'User-Agent': 'WealthFlow/7.3 (+https://wealthflow-personal.vercel.app)' },
                    signal
                });
                if (!up.ok) throw new Error('0x0 status ' + up.status);
                const t = (await up.text()).trim();
                if (!t.startsWith('http')) throw new Error('0x0 bad body');
                return t;
            }, 14000);
            return res.status(200).json({ url: link, id, days: 365, via: '0x0' });
        } catch (e) { console.warn('[statement-store] 0x0 failed:', e && e.message); }

        // ── STRATEGY 2: tmpfiles.org (free, no account) ──
        try {
            const link = await withTimeout(async (signal) => {
                const fd = new FormData();
                fd.append('file', new Blob([bytes], { type: 'text/html' }), `${cleanName}.html`);
                const up = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd, signal });
                if (!up.ok) throw new Error('tmpfiles status ' + up.status);
                const j = await up.json();
                if (!j || !j.data || !j.data.url) throw new Error('tmpfiles bad body');
                return j.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
            }, 14000);
            return res.status(200).json({ url: link, id, days: 30, via: 'tmpfiles' });
        } catch (e) { console.warn('[statement-store] tmpfiles failed:', e && e.message); }

        // ── STRATEGY 3: Firestore REST (project-key write) ──
        try {
            const link = await withTimeout(async (signal) => {
                const r = await fetch(`${FS_BASE}/s?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fields: {
                            h: { stringValue: pageHtml },
                            n: { stringValue: cleanName },
                            t: { integerValue: String(Date.now()) },
                            x: { integerValue: String(expiresMs) }
                        }
                    }),
                    signal
                });
                if (!r.ok) throw new Error('firestore status ' + r.status);
                return 'https://wealthflow-personal.vercel.app/?s=' + id;
            }, 12000);
            try {
                await fetch(`${FS_BASE}/shared_statements?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { html: { stringValue: pageHtml }, loanName: { stringValue: cleanName }, expiresAt: { integerValue: String(expiresMs) } } })
                });
            } catch (_) {}
            return res.status(200).json({ url: link, id, days: 365, via: 'firestore' });
        } catch (e) { console.warn('[statement-store] firestore failed:', e && e.message); }

        // Everything failed — honest error (NEVER a giant data URL).
        return res.status(502).json({ error: 'all_hosts_failed' });
    } catch (e) {
        console.error('[statement-store] error:', e && e.message);
        return res.status(500).json({ error: 'server_error', detail: String(e && e.message) });
    }
}
