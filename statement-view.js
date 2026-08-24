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
// The Firebase Web apiKey is a public project identifier, not a secret — but it is
// read from the environment here so no credential-shaped literal lives in the repo.
// That keeps the CI secret scanner strict: it can reject every AIzaSy... literal
// outright, instead of needing an allowlist that a real Gemini key could hide behind.
const API_KEY    = process.env.FIREBASE_API_KEY;

// Fail loudly, not mysteriously. This value moved from a hardcoded literal to an
// environment variable; if it is not configured, say so plainly instead of
// issuing Firestore requests with `key=undefined` and returning a confusing 400.
function _requireFirebaseKey(res) {
    if (API_KEY) return true;
    const msg = 'FIREBASE_API_KEY is not configured on this deployment. '
        + 'Set it in Vercel → Project → Settings → Environment Variables. '
        + '(It is the public Firebase Web apiKey — no longer hardcoded in the repo.)';
    try {
        if (res && res.status) { res.status(503).json({ ok: false, error: 'firebase_key_not_configured', detail: msg }); return false; }
    } catch (_) {}
    throw new Error(msg);
}

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
    if (!_requireFirebaseKey(res)) return;
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
    const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
    if (safeId !== id) {
        return res.status(400).json({ error: 'Invalid statement ID format' });
    }

    try {
        let docData = null;
        let collection = null;

        try {
            const r = await fetchWithTimeout(`${FS_BASE}/s/${safeId}?key=${API_KEY}`, { method: 'GET' }, 8000);
            if (r.ok) {
                const doc = await r.json();
                if (doc && doc.fields) { docData = doc.fields; collection = 's'; }
            }
        } catch (e) { console.warn('[statement-view] s/ fetch failed:', e.message); }

        if (!docData) {
            try {
                const r = await fetchWithTimeout(`${FS_BASE}/shared_statements/${safeId}?key=${API_KEY}`, { method: 'GET' }, 8000);
                if (r.ok) {
                    const doc = await r.json();
                    if (doc && doc.fields) { docData = doc.fields; collection = 'shared_statements'; }
                }
            } catch (e) { console.warn('[statement-view] shared_statements/ fetch failed:', e.message); }
        }

        if (!docData) {
            return res.status(404).json({ error: 'not_found', detail: 'This statement link does not exist or has been removed.' });
        }

        const expiryField = docData.x || docData.expiresAt;
        if (expiryField && expiryField.integerValue) {
            const expiryMs = parseInt(expiryField.integerValue, 10);
            if (Date.now() > expiryMs) {
                return res.status(410).json({ error: 'expired', detail: 'This statement link has expired.', expiredAt: new Date(expiryMs).toISOString() });
            }
        }

        // Shared metadata, computed BEFORE any content is touched. The kind of
        // the document decides how it is served, so it has to be read first.
        //
        // ORDERING FIX: this block used to start by extracting the HTML body and
        // returning 404 'empty' when it was absent — but a PDF document has no
        // `h`/`html` field, so every PDF (and every metadata request for one)
        // 404'd BEFORE reaching the PDF branch further down. The branded
        // /api/statement-view?id=… link the Elite Report advertised was therefore
        // dead, which is a large part of why sharing fell through to the
        // third-party host. Content is now dispatched by `kind`, and the empty
        // guard applies only to the HTML path where it belongs.
        const kind = (docData.kind && docData.kind.stringValue) || 'html';
        const isChunked = !!(docData.chunked && docData.chunked.booleanValue);
        const name = (docData.n && docData.n.stringValue) || (docData.loanName && docData.loanName.stringValue) || 'Statement';
        const createdAt = docData.t && docData.t.integerValue ? parseInt(docData.t.integerValue, 10) : null;
        const expiresAt = expiryField && expiryField.integerValue ? parseInt(expiryField.integerValue, 10) : null;
        const views = (docData.v && docData.v.integerValue) || (docData.views && docData.views.integerValue) || '0';

        if (!metaOnly) _incrementViewCount(collection, safeId, parseInt(views, 10)).catch(() => {});

        if (metaOnly) {
            return res.status(200).json({
                id: safeId, name,
                createdAt: createdAt ? new Date(createdAt).toISOString() : null,
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                views: parseInt(views, 10), collection, kind, chunked: isChunked,
                parts: isChunked ? parseInt((docData.parts && docData.parts.integerValue) || '0', 10) : undefined
            });
        }

        // ── PDF mode (Elite Report). Served as a native PDF so every browser /
        //    messenger renders it directly (no iframe / data: URL hacks that iOS
        //    Safari blocks). A large PDF is stored across sibling chunk documents
        //    s/<id>-<n> and reassembled here; a small one is inline in `pdf`. ──
        if (kind === 'pdf') {
            let pdfBase64 = (docData.pdf && docData.pdf.stringValue) || null;
            if (isChunked) {
                const parts = parseInt((docData.parts && docData.parts.integerValue) || '0', 10);
                if (!(parts > 0 && parts <= 64)) {
                    return res.status(500).json({ error: 'bad_manifest', detail: 'This statement is stored incorrectly and cannot be shown.' });
                }
                try {
                    pdfBase64 = await _assembleChunks(safeId, parts);
                } catch (e) {
                    // The manifest is written last, so its parts should all exist;
                    // a miss here means a transient read failure, not corruption.
                    // Answer with a fact and let the viewer retry.
                    console.warn('[statement-view] chunk assembly failed:', e && e.message);
                    return res.status(502).json({ error: 'chunk_unavailable', detail: 'This statement is temporarily unavailable. Please try again.' });
                }
            }
            if (pdfBase64) {
                try {
                    const pdfBuf = Buffer.from(pdfBase64, 'base64');
                    const safeFilename = String(name).replace(/[^a-zA-Z0-9_.\- ]/g, '_').slice(0, 80);
                    res.setHeader('Content-Type', 'application/pdf');
                    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}.pdf"`);
                    res.setHeader('Content-Length', pdfBuf.length);
                    res.setHeader('Cache-Control', 'public, max-age=300');
                    res.setHeader('X-Statement-Name', encodeURIComponent(name));
                    return res.status(200).send(pdfBuf);
                } catch (e) {
                    console.warn('[statement-view] PDF decode failed:', e && e.message);
                    return res.status(500).json({ error: 'pdf_decode_failed', detail: 'This statement could not be decoded.' });
                }
            }
            return res.status(404).json({ error: 'empty', detail: 'Statement content is empty.' });
        }

        // ── HTML mode (loan statements). ─────────────────────────────────────
        const rawHtml = (docData.h && docData.h.stringValue) || (docData.html && docData.html.stringValue) || '';
        if (!rawHtml) return res.status(404).json({ error: 'empty', detail: 'Statement content is empty.' });

        const isCompressed = (docData.z && docData.z.booleanValue) || (docData.compressed && docData.compressed.booleanValue);
        let html = rawHtml;
        if (isCompressed) {
            try { html = await decompressHtml(rawHtml); }
            catch (e) { console.warn('[statement-view] decompression failed, trying raw:', e.message); html = rawHtml; }
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Statement-Name', encodeURIComponent(name));
        res.setHeader('X-Statement-Views', String(parseInt(views, 10) + 1));
        return res.status(200).send(html);
    } catch (e) {
        console.error('[statement-view] error:', e.message);
        return res.status(500).json({ error: 'server_error', detail: e.message });
    }
}

async function _incrementViewCount(collection, docId, currentViews) {
    const newViews = (currentViews || 0) + 1;
    const viewField = collection === 's' ? 'v' : 'views';
    try {
        await fetchWithTimeout(
            `${FS_BASE}/${collection}/${docId}?updateMask.fieldPaths=${viewField}&key=${API_KEY}`,
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ fields: { [viewField]: { integerValue: String(newViews) } } }) },
            5000
        );
    } catch (e) { console.warn('[statement-view] view count update failed:', e.message); }
}

/**
 * Reassemble a chunked PDF: fetch s/<id>-0 … s/<id>-<parts-1> in PARALLEL and
 * concatenate their base64 slices in order. Parallel because the manifest is only
 * written once every part exists, so all reads should succeed together and there
 * is no reason to pay for them serially inside the 15s budget. Any missing or
 * empty part throws — the caller answers 502 rather than serving a truncated PDF.
 */
async function _assembleChunks(id, parts) {
    const reqs = [];
    for (let i = 0; i < parts; i++) {
        reqs.push(
            fetchWithTimeout(`${FS_BASE}/s/${id}-${i}?key=${API_KEY}`, { method: 'GET' }, 8000)
                .then(async (r) => {
                    if (!r.ok) throw new Error(`part ${i} HTTP ${r.status}`);
                    const doc = await r.json();
                    const d = doc && doc.fields && doc.fields.d && doc.fields.d.stringValue;
                    if (typeof d !== 'string' || !d) throw new Error(`part ${i} empty`);
                    return d;
                })
        );
    }
    const slices = await Promise.all(reqs);
    return slices.join('');
}

async function fetchWithTimeout(url, options, timeoutMs = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}
