// ==================== WealthFlow → Statement Store v3.0 ====================
//
// Stores a loan statement OR an Elite Report PDF in Firestore and returns a
// TINY shareable URL that lives on the wealthflow-personal.vercel.app domain.
//
// HTML mode (loans):
//   POST { html, name }
//   → { url: "https://wealthflow-personal.vercel.app/?s=ABC123", id, days, via }
//
// PDF mode (Elite Reports):
//   POST { pdfBase64, name }
//   → { url: "https://wealthflow-personal.vercel.app/api/statement-view?id=ABC123",
//       id, days, via, kind: 'pdf' }
//   The /api/statement-view endpoint serves the PDF directly with
//   Content-Type: application/pdf so iOS Safari / Chrome / WhatsApp etc.
//   display it natively (no iframe / data: URL hacks that iOS blocks).
//
// Strategy order (reliability-first):
//   1. Firestore REST 's' collection (PRIMARY — your own infra)
//   2. Firestore REST 'shared_statements' (redundancy)
//   3. 0x0.st           (last-resort external host)
//
// =====================================================================

export const config = {
    maxDuration: 25,
    api: { bodyParser: { sizeLimit: '12mb' } }
};

const PROJECT_ID  = 'wealthflow-6dffb';
const API_KEY     = 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
const FS_BASE     = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const APP_URL     = 'https://wealthflow-personal.vercel.app/';
const MAX_DOC_FS  = 900 * 1024;     // Firestore single-document soft cap
const EXPIRY_DAYS = 30;

function randomId(n = 8) {
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const out = new Uint8Array(n);
    try { require('crypto').randomFillSync(out); }
    catch (_) { for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256); }
    return Array.from(out, b => chars[b % chars.length]).join('');
}

async function withTimeout(fn, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fn(ctrl.signal); }
    finally { clearTimeout(t); }
}

function wrapHtml(html, name) {
    if (html.trim().startsWith('<!') || html.trim().startsWith('<html')) return html;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} — WealthFlow</title></head><body style="margin:0;background:#0a0e1a;">${html}</body></html>`;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // DELETE — for the "history" panel's remove button.
    if (req.method === 'DELETE') {
        try {
            const id = (req.query && req.query.id) || (req.body && req.body.id);
            if (!id || typeof id !== 'string' || id.length < 5) return res.status(400).json({ error: 'Invalid ID' });
            await fetch(`${FS_BASE}/s/${id}?key=${API_KEY}`,                  { method: 'DELETE' }).catch(()=>{});
            await fetch(`${FS_BASE}/shared_statements/${id}?key=${API_KEY}`,  { method: 'DELETE' }).catch(()=>{});
            return res.status(200).json({ success: true });
        } catch (e) { return res.status(500).json({ error: 'delete_failed' }); }
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    try {
        const { html, name, pdfBase64 } = req.body || {};
        const isPdf = !!pdfBase64;

        if (!isPdf && (!html || typeof html !== 'string')) {
            return res.status(400).json({ error: 'Missing statement html / pdfBase64' });
        }
        if (isPdf && (typeof pdfBase64 !== 'string' || pdfBase64.length < 100)) {
            return res.status(400).json({ error: 'Invalid pdfBase64' });
        }

        // Generous size cap; per-strategy limits handled below.
        if (!isPdf && html.length > 4 * 1024 * 1024) {
            return res.status(413).json({ error: 'Statement too large' });
        }
        if (isPdf && pdfBase64.length > 10 * 1024 * 1024) {
            return res.status(413).json({ error: 'PDF too large (max ~7.5 MB)' });
        }

        const id = randomId(8);
        const cleanName = String(name || (isPdf ? 'Elite Report' : 'Statement')).replace(/[<>]/g, '').slice(0, 80);
        const now = Date.now();
        const expiresMs = now + EXPIRY_DAYS * 24 * 60 * 60 * 1000;

        // ── STRATEGY 1: Firestore 's' collection (PRIMARY) ─────────────────
        try {
            const link = await withTimeout(async (signal) => {
                const fields = {
                    n: { stringValue: cleanName },
                    t: { integerValue: String(now) },
                    x: { integerValue: String(expiresMs) },
                    v: { integerValue: '0' }
                };
                if (isPdf) {
                    fields.kind = { stringValue: 'pdf' };
                    fields.pdf  = { stringValue: pdfBase64 };  // base64
                } else {
                    const pageHtml = wrapHtml(html, cleanName);
                    if (pageHtml.length > MAX_DOC_FS) throw new Error('html exceeds firestore soft cap');
                    fields.kind = { stringValue: 'html' };
                    fields.h    = { stringValue: pageHtml };
                }
                const r = await fetch(`${FS_BASE}/s?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields }),
                    signal
                });
                if (!r.ok) {
                    const t = await r.text().catch(() => '');
                    throw new Error(`firestore-s status ${r.status}: ${t.slice(0,200)}`);
                }
                // URL format:
                //   - HTML  → ?s=ID (rendered by the SPA reader)
                //   - PDF   → /api/statement-view?id=ID (direct PDF response,
                //             native rendering on iOS / Android / WhatsApp)
                return isPdf
                    ? `${APP_URL}api/statement-view?id=${id}`
                    : `${APP_URL}?s=${id}`;
            }, 14000);
            return res.status(200).json({
                url: link, id, days: EXPIRY_DAYS,
                via: 'firestore', kind: isPdf ? 'pdf' : 'html'
            });
        } catch (e) { console.warn('[statement-store] firestore s/ failed:', e && e.message); }

        // ── STRATEGY 2: Firestore 'shared_statements' (legacy/redundancy) ──
        try {
            const link = await withTimeout(async (signal) => {
                const fields = {
                    loanName:  { stringValue: cleanName },
                    createdAt: { integerValue: String(now) },
                    expiresAt: { integerValue: String(expiresMs) }
                };
                if (isPdf) {
                    fields.kind = { stringValue: 'pdf' };
                    fields.pdf  = { stringValue: pdfBase64 };
                } else {
                    fields.html = { stringValue: wrapHtml(html, cleanName) };
                }
                const r = await fetch(`${FS_BASE}/shared_statements?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields }),
                    signal
                });
                if (!r.ok) throw new Error('shared_statements status ' + r.status);
                return isPdf
                    ? `${APP_URL}api/statement-view?id=${id}`
                    : `${APP_URL}?s=${id}`;
            }, 12000);
            return res.status(200).json({
                url: link, id, days: EXPIRY_DAYS,
                via: 'firestore-shared', kind: isPdf ? 'pdf' : 'html'
            });
        } catch (e) { console.warn('[statement-store] shared_statements failed:', e && e.message); }

        // ── STRATEGY 3: 0x0.st (last-resort external — gives non-wealthflow URL) ──
        try {
            const link = await withTimeout(async (signal) => {
                const fd = new FormData();
                if (isPdf) {
                    const buf = Buffer.from(pdfBase64, 'base64');
                    fd.append('file', new Blob([buf], { type: 'application/pdf' }), `${cleanName}.pdf`);
                } else {
                    const buf = Buffer.from(wrapHtml(html, cleanName), 'utf8');
                    fd.append('file', new Blob([buf], { type: 'text/html' }), `${cleanName}.html`);
                }
                const up = await fetch('https://0x0.st', {
                    method: 'POST', body: fd,
                    headers: { 'User-Agent': 'WealthFlow/8.0' },
                    signal
                });
                if (!up.ok) throw new Error('0x0 status ' + up.status);
                const t = (await up.text()).trim();
                if (!t.startsWith('http')) throw new Error('0x0 bad body');
                return t;
            }, 14000);
            return res.status(200).json({
                url: link, id, days: 365,
                via: '0x0', kind: isPdf ? 'pdf' : 'html'
            });
        } catch (e) { console.warn('[statement-store] 0x0 failed:', e && e.message); }

        return res.status(502).json({ error: 'all_hosts_failed' });
    } catch (e) {
        console.error('[statement-store] error:', e && e.message);
        return res.status(500).json({ error: 'server_error', detail: String(e && e.message) });
    }
}
