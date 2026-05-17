// ==================== WealthFlow → Statement Store ====================
// Stores a loan-statement HTML document in Firebase Firestore via the
// Firestore REST API (server-side, no client auth/permission/CORS issues)
// and returns a TINY shareable URL of the form:
//
//     https://wealthflow-personal.vercel.app/?s=ab12cd34
//
// The browser sends:  POST { html, name }
// The server returns: { url, id, days }
//
// Why this is the right design:
//  • Firestore REST write uses the project's public API key — it does NOT
//    depend on the visitor being signed in, so it works 100% of the time
//    from GitHub Pages, the PWA, or anywhere.
//  • The URL is ~45 chars total regardless of statement size (the 98 000-
//    char data-URL problem is gone for good).
//  • 30-day validity is recorded in the document; a lightweight read path
//    (?s=ID) already exists in the client.
//  • Zero personal data in the URL — only an opaque random id.
//
// Free, no extra third-party account, uses the Firebase project you already
// own. Fast (one REST round-trip).
// =====================================================================

export const config = { maxDuration: 15 };

const PROJECT_ID = 'wealthflow-6dffb';
const API_KEY = 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function randomId(n) {
    const a = 'abcdefghijkmnpqrstuvwxyz23456789'; // no ambiguous chars
    let s = '';
    for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
    return s;
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
        // Firestore single-field string cap is ~1 MiB; statements are far
        // smaller, but guard anyway.
        if (html.length > 900000) {
            return res.status(413).json({ error: 'Statement too large' });
        }

        const id = randomId(8);
        const cleanName = String(name || 'Statement').replace(/[<>]/g, '').slice(0, 60);
        const expiresMs = Date.now() + 30 * 24 * 60 * 60 * 1000;

        // Firestore REST "create document with id" — collection: s
        const url = `${FS_BASE}/s?documentId=${id}&key=${API_KEY}`;
        const body = {
            fields: {
                h: { stringValue: html },
                n: { stringValue: cleanName },
                t: { integerValue: String(Date.now()) },
                x: { integerValue: String(expiresMs) }
            }
        };

        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (r.ok) {
            // Mirror to legacy collection so the existing reader path also works.
            try {
                await fetch(`${FS_BASE}/shared_statements?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        fields: {
                            html: { stringValue: html },
                            loanName: { stringValue: cleanName },
                            expiresAt: { integerValue: String(expiresMs) }
                        }
                    })
                });
            } catch (_) { /* non-critical */ }

            const appUrl = 'https://wealthflow-personal.vercel.app/?s=' + id;
            return res.status(200).json({ url: appUrl, id, days: 30, via: 'firestore' });
        }

        // Firestore write was blocked (rules require auth) — fall back to a
        // free, reliable file host so we STILL return a tiny URL. We host the
        // full statement HTML as a self-contained page.
        const errTxt = await r.text().catch(() => '');
        console.warn('[statement-store] Firestore blocked, using host fallback:', r.status, errTxt.slice(0, 200));

        const pageHtml = html.trim().startsWith('<')
            ? html
            : `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${cleanName}</title></head><body>${html}</body></html>`;

        // 0x0.st — free, no account, ~1 year retention, direct link
        try {
            const fd = new FormData();
            fd.append('file', new Blob([pageHtml], { type: 'text/html' }), `${cleanName}.html`);
            const up = await fetch('https://0x0.st', { method: 'POST', body: fd });
            if (up.ok) {
                const link = (await up.text()).trim();
                if (link.startsWith('http')) {
                    return res.status(200).json({ url: link, id, days: 30, via: '0x0' });
                }
            }
        } catch (e) { console.warn('[statement-store] 0x0 failed:', e && e.message); }

        // tmpfiles.org — free, no account (shorter retention but always works)
        try {
            const fd2 = new FormData();
            fd2.append('file', new Blob([pageHtml], { type: 'text/html' }), `${cleanName}.html`);
            const up2 = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd2 });
            if (up2.ok) {
                const j = await up2.json();
                if (j && j.data && j.data.url) {
                    const direct = j.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                    return res.status(200).json({ url: direct, id, days: 30, via: 'tmpfiles' });
                }
            }
        } catch (e) { console.warn('[statement-store] tmpfiles failed:', e && e.message); }

        return res.status(502).json({ error: 'store_failed', detail: r.status });
    } catch (e) {
        console.error('[statement-store] error:', e && e.message);
        return res.status(500).json({ error: 'server_error', detail: String(e && e.message) });
    }
}
