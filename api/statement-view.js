// ==================== WealthFlow → Statement View API ====================
// Server-side statement retriever. Returns the stored HTML directly.
//
// GET /api/statement-view?id=AbCdEfGh
//   → 200 with HTML body (Content-Type: text/html) if found & not expired
//   → 404 if not found
//   → 410 if expired
//
// This allows the statement viewer to work even if the Firebase client SDK
// fails to load on the viewer's device (slow connection, blocked, etc.)
//
// Also handles:
//   - Decompression of gzip-compressed HTML
//   - Expiry validation
//   - View counter increment (fire-and-forget)
//   - JSON metadata mode: GET /api/statement-view?id=X&meta=1
// =====================================================================

export const config = { maxDuration: 15 };

const PROJECT_ID = 'wealthflow-6dffb';
const API_KEY    = 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

async function decompressHtml(base64Data) {
    const { gunzip } = await import('zlib');
    const { promisify } = await import('util');
    const gunzipAsync = promisify(gunzip);
    const buffer = Buffer.from(base64Data, 'base64');
    const decompressed = await gunzipAsync(buffer);
    return decompressed.toString('utf8');
}

export default async function handler(req, res) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

    const id = req.query.id;
    const metaOnly = req.query.meta === '1';

    if (!id || typeof id !== 'string' || id.length < 4 || id.length > 20) {
        return res.status(400).json({ error: 'Invalid or missing statement ID' });
    }

    // Sanitize ID — only allow alphanumeric
    const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
    if (safeId !== id) {
        return res.status(400).json({ error: 'Invalid statement ID format' });
    }

    try {
        // Try collection 's' first, then 'shared_statements'
        let docData = null;
        let collection = null;

        // ── Try 's' collection (primary) ──
        try {
            const r = await fetchWithTimeout(
                `${FS_BASE}/s/${safeId}?key=${API_KEY}`,
                { method: 'GET' },
                8000
            );
            if (r.ok) {
                const doc = await r.json();
                if (doc && doc.fields) {
                    docData = doc.fields;
                    collection = 's';
                }
            }
        } catch (e) {
            console.warn('[statement-view] s/ fetch failed:', e.message);
        }

        // ── Fallback: try 'shared_statements' ──
        if (!docData) {
            try {
                const r = await fetchWithTimeout(
                    `${FS_BASE}/shared_statements/${safeId}?key=${API_KEY}`,
                    { method: 'GET' },
                    8000
                );
                if (r.ok) {
                    const doc = await r.json();
                    if (doc && doc.fields) {
                        docData = doc.fields;
                        collection = 'shared_statements';
                    }
                }
            } catch (e) {
                console.warn('[statement-view] shared_statements/ fetch failed:', e.message);
            }
        }

        if (!docData) {
            return res.status(404).json({
                error: 'not_found',
                detail: 'This statement link does not exist or has been removed.'
            });
        }

        // ── Check expiry ──
        const expiryField = docData.x || docData.expiresAt;
        if (expiryField && expiryField.integerValue) {
            const expiryMs = parseInt(expiryField.integerValue, 10);
            if (Date.now() > expiryMs) {
                return res.status(410).json({
                    error: 'expired',
                    detail: 'This statement link has expired.',
                    expiredAt: new Date(expiryMs).toISOString()
                });
            }
        }

        // ── Extract HTML ──
        const rawHtml = (docData.h && docData.h.stringValue) || (docData.html && docData.html.stringValue) || '';
        if (!rawHtml) {
            return res.status(404).json({ error: 'empty', detail: 'Statement content is empty.' });
        }

        // ── Decompress if needed ──
        const isCompressed = (docData.z && docData.z.booleanValue) || (docData.compressed && docData.compressed.booleanValue);
        let html = rawHtml;
        if (isCompressed) {
            try {
                html = await decompressHtml(rawHtml);
            } catch (e) {
                console.warn('[statement-view] decompression failed, trying raw:', e.message);
                html = rawHtml; // Maybe it wasn't actually compressed
            }
        }

        // ── Get metadata ──
        const name = (docData.n && docData.n.stringValue) || (docData.loanName && docData.loanName.stringValue) || 'Statement';
        const createdAt = docData.t && docData.t.integerValue ? parseInt(docData.t.integerValue, 10) : null;
        const expiresAt = expiryField && expiryField.integerValue ? parseInt(expiryField.integerValue, 10) : null;
        const views = (docData.v && docData.v.integerValue) || (docData.views && docData.views.integerValue) || '0';

        // ── Increment view counter (fire-and-forget) ONLY for actual views ──
        if (!metaOnly) {
            _incrementViewCount(collection, safeId, parseInt(views, 10)).catch(() => {});
        }

        // ── Return response ──
        if (metaOnly) {
            return res.status(200).json({
                id: safeId,
                name,
                createdAt: createdAt ? new Date(createdAt).toISOString() : null,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                views: parseInt(views, 10),
                compressed: !!isCompressed,
                size: html.length,
                collection
            });
        }

        // Return full HTML
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300'); // Cache for 5 min
        res.setHeader('X-Statement-Name', encodeURIComponent(name));
        res.setHeader('X-Statement-Views', String(parseInt(views, 10) + 1));
        return res.status(200).send(html);

    } catch (e) {
        console.error('[statement-view] error:', e.message);
        return res.status(500).json({ error: 'server_error', detail: e.message });
    }
}

// Increment view count in Firestore (fire-and-forget, non-blocking)
async function _incrementViewCount(collection, docId, currentViews) {
    const newViews = (currentViews || 0) + 1;
    const viewField = collection === 's' ? 'v' : 'views';

    try {
        await fetchWithTimeout(
            `${FS_BASE}/${collection}/${docId}?updateMask.fieldPaths=${viewField}&key=${API_KEY}`,
            {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fields: {
                        [viewField]: { integerValue: String(newViews) }
                    }
                })
            },
            5000
        );
    } catch (e) {
        // Non-critical — don't block the response
        console.warn('[statement-view] view count update failed:', e.message);
    }
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}
