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

        const analyticsMode = req.query.analytics === '1';
        
        // ── Increment view counter and log analytics ──
        if (!metaOnly && !analyticsMode) {
            const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
            const ua = req.headers['user-agent'] || '';
            _incrementViewCount(collection, safeId, ip, ua).catch(() => {});
        }

        // ── Return Analytics Logs ──
        if (analyticsMode) {
            const rawLogs = (docData.vl && docData.vl.arrayValue && docData.vl.arrayValue.values) ||
                            (docData.viewLogs && docData.viewLogs.arrayValue && docData.viewLogs.arrayValue.values) || [];
            
            const logs = rawLogs.map(v => {
                const f = v.mapValue?.fields || {};
                return {
                    time: parseInt(f.t?.integerValue || '0', 10),
                    ip: f.ip?.stringValue || 'Unknown',
                    os: f.os?.stringValue || 'Unknown',
                    browser: f.br?.stringValue || 'Unknown',
                    device: f.dv?.stringValue || 'Unknown',
                    country: f.co?.stringValue || 'Unknown',
                    city: f.ci?.stringValue || 'Unknown',
                    flag: f.fl?.stringValue || '🌍'
                };
            }).sort((a, b) => b.time - a.time);

            return res.status(200).json({
                id: safeId,
                name,
                views: parseInt(views, 10),
                uniqueViewers: new Set(logs.map(l => l.ip)).size,
                logs
            });
        }

        // ── Return Meta response ──
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
// Increment view count and log viewer details in Firestore (fire-and-forget, non-blocking)
async function _incrementViewCount(collection, docId, ip, ua) {
    const viewField = collection === 's' ? 'v' : 'views';
    const logsField = collection === 's' ? 'vl' : 'viewLogs';
    
    try {
        const geo = await getGeo(ip);
        const { os, browser, device } = parseUA(ua);
        
        const ipStr = String(ip.split(',')[0]).trim();
        
        const logEntry = {
            mapValue: {
                fields: {
                    t: { integerValue: String(Date.now()) },
                    ip: { stringValue: ipStr || 'Unknown' },
                    os: { stringValue: os },
                    br: { stringValue: browser },
                    dv: { stringValue: device },
                    co: { stringValue: geo.country },
                    ci: { stringValue: geo.city },
                    fl: { stringValue: geo.flag }
                }
            }
        };

        const dbPath = `projects/${PROJECT_ID}/databases/(default)/documents/${collection}/${docId}`;
        
        await fetchWithTimeout(
            `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default):commit?key=${API_KEY}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    writes: [
                        {
                            transform: {
                                document: dbPath,
                                fieldTransforms: [
                                    {
                                        fieldPath: viewField,
                                        increment: { integerValue: "1" }
                                    },
                                    {
                                        fieldPath: logsField,
                                        appendMissingElements: { values: [logEntry] }
                                    }
                                ]
                            }
                        }
                    ]
                })
            },
            6000
        );
    } catch (e) {
        console.warn('[statement-view] view count update failed:', e.message);
    }
}

async function getGeo(ip) {
    const ipStr = (ip || '').split(',')[0].trim();
    if (!ipStr || ipStr === '127.0.0.1' || ipStr === '::1') return { country: 'Local', city: 'Local', flag: '🏠' };
    try {
        const r = await fetchWithTimeout(`https://ipwho.is/${ipStr}`, {}, 3000);
        const data = await r.json();
        if (data.success) {
            return {
                country: data.country || 'Unknown',
                city: data.city || 'Unknown',
                flag: data.flag && data.flag.emoji ? data.flag.emoji : '🌍'
            };
        }
    } catch(e){}
    return { country: 'Unknown', city: 'Unknown', flag: '🌍' };
}

function parseUA(ua) {
    if (!ua) return { os: 'Unknown', browser: 'Unknown', device: 'Desktop' };
    const str = ua.toLowerCase();
    let os = 'Unknown';
    if (str.includes('win')) os = 'Windows';
    else if (str.includes('mac') && !str.includes('iphone') && !str.includes('ipad')) os = 'macOS';
    else if (str.includes('iphone') || str.includes('ipad')) os = 'iOS';
    else if (str.includes('android')) os = 'Android';
    else if (str.includes('linux')) os = 'Linux';
    
    let browser = 'Unknown';
    if (str.includes('edg/')) browser = 'Edge';
    else if (str.includes('chrome/') || str.includes('crios/')) browser = 'Chrome';
    else if (str.includes('firefox/') || str.includes('fxios/')) browser = 'Firefox';
    else if (str.includes('safari/')) browser = 'Safari';

    const device = (os === 'iOS' || os === 'Android' || str.includes('mobile')) ? 'Mobile' : 'Desktop';
    return { os, browser, device };
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
