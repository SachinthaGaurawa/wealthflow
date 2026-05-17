// ==================== WealthFlow → Statement Store v2.0 ====================
// Stores a loan-statement HTML document in Firestore and returns a TINY
// shareable URL (~50 chars).
//
// The browser sends:  POST { html, name }
// The server returns: { url, id, days, via }
//
// Strategy order (reliability-first):
//   1. Firestore REST (PRIMARY — YOUR OWN infrastructure, always available)
//      → Writes to collection 's' with 8-char random ID
//      → URL: https://wealthflow-personal.vercel.app/?s=AbCdEfGh
//      → 30-day expiry stored in document, cleaned up by TTL policy
//
//   2. Firestore 'shared_statements' (REDUNDANCY — same infra, backup collection)
//
//   3. 0x0.st (LAST RESORT — free external service, may be unavailable)
//
// The giant data-in-URL fallback that produced 191,000-char links is
// PERMANENTLY REMOVED. If every strategy fails we return an honest error.
//
// Privacy: Zero personal data (no names, emails, UIDs) in stored documents.
// =====================================================================

export const config = { maxDuration: 25 };

const PROJECT_ID  = 'wealthflow-6dffb';
const API_KEY     = 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
const FS_BASE     = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const APP_URL     = 'https://wealthflow-personal.vercel.app/';
const MAX_HTML    = 900 * 1024;   // 900KB limit (Firestore doc limit is 1MB)
const EXPIRY_DAYS = 30;

// Cryptographically random short ID (62^8 = 218 trillion combinations)
function randomId(n = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const arr = new Uint8Array(n);
    require('crypto').randomFillSync(arr);
    return Array.from(arr, b => chars[b % chars.length]).join('');
}

// Promise-race with timeout
async function withTimeout(fn, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fn(ctrl.signal); }
    finally { clearTimeout(t); }
}

// Compress HTML with gzip for smaller Firestore documents
async function compressHtml(html) {
    const { gzip } = await import('zlib');
    const { promisify } = await import('util');
    const gzipAsync = promisify(gzip);
    const compressed = await gzipAsync(Buffer.from(html, 'utf8'), { level: 9 });
    return compressed.toString('base64');
}

// Build a self-contained HTML page wrapper if needed
function wrapHtml(html, name) {
    if (html.trim().startsWith('<!') || html.trim().startsWith('<html')) return html;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} — WealthFlow</title></head><body style="margin:0;background:#0a0e1a;">${html}</body></html>`;
}

export default async function handler(req, res) {
    // CORS
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
            return res.status(413).json({ error: 'Statement too large (max 4MB)' });
        }

        const id = randomId(8);
        const cleanName = String(name || 'Statement').replace(/[<>]/g, '').slice(0, 60);
        const now = Date.now();
        const expiresMs = now + EXPIRY_DAYS * 24 * 60 * 60 * 1000;
        const pageHtml = wrapHtml(html, cleanName);

        // Determine storage approach based on size
        let storeHtml = pageHtml;
        let compressed = false;

        // Try to compress for smaller Firestore document size
        try {
            if (pageHtml.length > 10000) { // Only compress if > 10KB
                const compressedData = await compressHtml(pageHtml);
                // Only use compression if it actually saves space
                if (compressedData.length < pageHtml.length * 0.9) {
                    storeHtml = compressedData;
                    compressed = true;
                }
            }
        } catch (e) {
            console.warn('[statement-store] compression skipped:', e.message);
            // Fall through — store uncompressed
        }

        // Check if the document would exceed Firestore's 1MB limit
        const docSizeEstimate = storeHtml.length + 200; // +200 for metadata fields
        if (docSizeEstimate > MAX_HTML) {
            // If compressed version is still too big, try storing without compression
            // (the raw HTML might be smaller than base64-encoded gzip in rare cases)
            if (compressed && pageHtml.length < MAX_HTML) {
                storeHtml = pageHtml;
                compressed = false;
            } else {
                return res.status(413).json({
                    error: 'Statement too large for storage',
                    detail: `Document size ${Math.round(docSizeEstimate / 1024)}KB exceeds ${Math.round(MAX_HTML / 1024)}KB limit`
                });
            }
        }

        // ── STRATEGY 1: Firestore REST — 's' collection (PRIMARY) ──────────
        // Your own infrastructure. Most reliable. Always available.
        // Produces: ?s=AbCdEfGh (~50 chars total)
        try {
            const result = await withTimeout(async (signal) => {
                const docBody = {
                    fields: {
                        h: { stringValue: storeHtml },
                        n: { stringValue: cleanName },
                        t: { integerValue: String(now) },
                        x: { integerValue: String(expiresMs) },
                        v: { integerValue: '0' }  // view counter
                    }
                };
                // Add compression flag if compressed
                if (compressed) {
                    docBody.fields.z = { booleanValue: true };
                }

                const r = await fetch(`${FS_BASE}/s?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(docBody),
                    signal
                });

                if (!r.ok) {
                    const errText = await r.text().catch(() => '');
                    throw new Error(`Firestore 's' status ${r.status}: ${errText.slice(0, 200)}`);
                }

                return APP_URL + '?s=' + id;
            }, 15000);

            console.log(`[statement-store] ✅ Firestore 's' success: ${result} (${storeHtml.length} bytes, compressed=${compressed})`);

            // Also write to 'shared_statements' for backward compatibility (fire-and-forget)
            _writeBackupCollection(id, storeHtml, cleanName, expiresMs, compressed).catch(() => {});

            return res.status(200).json({
                url: result,
                id,
                days: EXPIRY_DAYS,
                via: 'firestore',
                compressed,
                chars: result.length
            });
        } catch (e) {
            console.warn('[statement-store] Firestore s/ failed:', e.message);
        }

        // ── STRATEGY 2: Firestore REST — 'shared_statements' collection ────
        // Same infrastructure, different collection. Handles edge cases where
        // collection 's' has restrictive rules but 'shared_statements' is open.
        try {
            const result = await withTimeout(async (signal) => {
                const docBody = {
                    fields: {
                        html: { stringValue: storeHtml },
                        loanName: { stringValue: cleanName },
                        createdAt: { integerValue: String(now) },
                        expiresAt: { integerValue: String(expiresMs) },
                        views: { integerValue: '0' }
                    }
                };
                if (compressed) {
                    docBody.fields.compressed = { booleanValue: true };
                }

                const r = await fetch(`${FS_BASE}/shared_statements?documentId=${id}&key=${API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(docBody),
                    signal
                });

                if (!r.ok) throw new Error('shared_statements status ' + r.status);
                return APP_URL + '?s=' + id;
            }, 12000);

            console.log(`[statement-store] ✅ Firestore shared_statements success: ${result}`);
            return res.status(200).json({
                url: result,
                id,
                days: EXPIRY_DAYS,
                via: 'firestore-shared',
                compressed,
                chars: result.length
            });
        } catch (e) {
            console.warn('[statement-store] Firestore shared_statements failed:', e.message);
        }

        // ── STRATEGY 3: 0x0.st (LAST RESORT — external, may be unavailable) ──
        try {
            const link = await withTimeout(async (signal) => {
                const fd = new FormData();
                const bytes = Buffer.from(pageHtml, 'utf8');
                fd.append('file', new Blob([bytes], { type: 'text/html' }), `${cleanName}.html`);
                const up = await fetch('https://0x0.st', {
                    method: 'POST',
                    body: fd,
                    headers: { 'User-Agent': 'WealthFlow/8.0 (+https://wealthflow-personal.vercel.app)' },
                    signal
                });
                if (!up.ok) throw new Error('0x0 status ' + up.status);
                const t = (await up.text()).trim();
                if (!t.startsWith('http')) throw new Error('0x0 bad response body');
                return t;
            }, 14000);

            console.log('[statement-store] ✅ 0x0.st success:', link);
            return res.status(200).json({ url: link, id, days: 365, via: '0x0', chars: link.length });
        } catch (e) {
            console.warn('[statement-store] 0x0.st failed:', e.message);
        }

        // ── ALL FAILED — honest error (NEVER a giant data URL) ──
        console.error('[statement-store] ❌ All strategies failed');
        return res.status(502).json({
            error: 'all_hosts_failed',
            detail: 'Could not store the statement. Please try again in a moment.'
        });

    } catch (e) {
        console.error('[statement-store] fatal error:', e && e.message);
        return res.status(500).json({ error: 'server_error', detail: String(e && e.message) });
    }
}

// Fire-and-forget backup write to shared_statements collection
async function _writeBackupCollection(id, html, name, expiresMs, compressed) {
    try {
        const docBody = {
            fields: {
                html: { stringValue: html },
                loanName: { stringValue: name },
                expiresAt: { integerValue: String(expiresMs) }
            }
        };
        if (compressed) {
            docBody.fields.compressed = { booleanValue: true };
        }
        await fetch(`${FS_BASE}/shared_statements?documentId=${id}&key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(docBody)
        });
    } catch (_) { /* non-critical backup */ }
}
