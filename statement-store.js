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

import { randomFillSync } from 'node:crypto';
import { fetchWithTimeout, withTimeout } from './fetch-timeout.mjs';

export const config = {
    maxDuration: 25,
    api: { bodyParser: { sizeLimit: '12mb' } }
};

const PROJECT_ID  = 'wealthflow-6dffb';
// The Firebase Web apiKey is a public project identifier, not a secret — but it is
// read from the environment here so no credential-shaped literal lives in the repo.
// That keeps the CI secret scanner strict: it can reject every AIzaSy... literal
// outright, instead of needing an allowlist that a real Gemini key could hide behind.
const API_KEY     = process.env.FIREBASE_API_KEY;

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

const FS_BASE     = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const APP_URL     = 'https://wealthflow-personal.vercel.app/';
const MAX_DOC_FS  = 900 * 1024;     // Firestore single-document soft cap
const EXPIRY_DAYS = 30;

/* This id IS the access control. `?s=<id>` is the only thing standing between
 * the public internet and someone's loan statement or Elite Report PDF, so it
 * has to be unguessable — and it was not.
 *
 * The old body was:
 *     try { require('crypto').randomFillSync(out); }
 *     catch (_) { for (...) out[i] = Math.floor(Math.random() * 256); }
 *
 * This file is ESM (package.json declares `"type": "module"`), where `require`
 * is not defined. So the try ALWAYS threw `ReferenceError: require is not
 * defined`, and every share id ever minted came from the Math.random() branch —
 * the fallback was not a fallback, it was the only path. V8's Math.random is
 * xorshift128+: not a CSPRNG, and its internal state is recoverable from a
 * modest run of outputs, so ids generated in sequence are related to one
 * another. Same masked-failure family as release-brain.js and approve-release.js
 * — only here the mask silently downgraded a security property.
 *
 * Two fixes:
 *   1. a real CSPRNG, imported the ESM way, with NO fallback. If the platform
 *      cannot produce secure bytes, minting a weak token is worse than
 *      failing the request.
 *   2. rejection sampling. `b % 58` over 0..255 is biased — 256 = 4*58 + 24, so
 *      the first 24 letters of the alphabet came up ~25% more often than the
 *      rest, shrinking the real keyspace below the nominal 58^8.
 * (`randomFillSync` is imported at the top of the file.)
 */
function randomId(n = 8) {
    const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const limit = Math.floor(256 / chars.length) * chars.length;   // 232 for 58
    const out = [];
    const buf = new Uint8Array(n);
    while (out.length < n) {
        randomFillSync(buf);
        for (let i = 0; i < buf.length && out.length < n; i++) {
            if (buf[i] < limit) out.push(chars[buf[i] % chars.length]);
        }
    }
    return out.join('');
}

// withTimeout used to be defined here, byte-for-byte identical to the copy in
// fetch-timeout.mjs. Two identical implementations of a timeout policy is one
// more than can be kept in step, so this file now imports the shared one — see
// the import at the top.

/** Never let the `key=` query parameter reach a response body or a log line. */
function _scrubKey(s) {
    return String(s == null ? '' : s).replace(/key=[^&\s"']+/gi, 'key=[redacted]').slice(0, 300);
}

/**
 * Delete one document, and REPORT WHAT HAPPENED. The previous code discarded
 * this outcome entirely, which is what let a refused delete read as a completed
 * one. Firestore's REST DELETE is idempotent, so a document that was never there
 * answers 200 and is correctly treated as gone.
 */
async function fsDeleteDoc(docPath, timeoutMs = 8000) {
    try {
        const r = await fetchWithTimeout(`${FS_BASE}/${docPath}?key=${API_KEY}`,
            { method: 'DELETE' }, timeoutMs);
        if (r.ok) return { ok: true, detail: null };
        let detail = '';
        try { const j = await r.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) {}
        return { ok: false, detail: _scrubKey(detail) || `HTTP ${r.status}` };
    } catch (e) {
        // fetchWithTimeout throws a named TimeoutError on expiry; both that and a
        // transport error mean the document's state is unknown, which is not success.
        return { ok: false, detail: _scrubKey((e && e.message) || e) };
    }
}

function wrapHtml(html, name) {
    if (html.trim().startsWith('<!') || html.trim().startsWith('<html')) return html;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name} — WealthFlow</title></head><body style="margin:0;background:#0a0e1a;">${html}</body></html>`;
}

export default async function handler(req, res) {
    if (!_requireFirebaseKey(res)) return;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    // DELETE — for the "history" panel's remove button.
    //
    // v3.1 — THIS PATH USED TO CLAIM SUCCESS IT HAD NOT ACHIEVED:
    //
    //     await fetch(`${FS_BASE}/s/${id}?key=${API_KEY}`, { method:'DELETE' }).catch(()=>{});
    //     await fetch(`${FS_BASE}/shared_statements/${id}...`, ...).catch(()=>{});
    //     return res.status(200).json({ success: true });
    //
    // Both results were discarded — `.catch(()=>{})` swallowed the throw and the
    // resolved Response was never read, so a rules rejection, a 5xx or a timeout
    // all produced `{ success: true }` with 200.
    //
    // What that costs is not a wrong number on a dashboard. `?s=<id>` is the ONLY
    // thing between the public internet and someone's loan statement or Elite
    // Report, and the caller in index.html deletes its local record of the id as
    // soon as this endpoint answers. So a failed delete meant: the document stays
    // served to anyone holding the link, the owner is told it is gone, and the id
    // is erased from the only place it was written down — leaving a permanently
    // public document that nobody can find again to remove.
    //
    // Now every delete is checked, and a partial failure is a real 502 naming
    // which target survived.
    if (req.method === 'DELETE') {
        try {
            const id = (req.query && req.query.id) || (req.body && req.body.id);
            if (!id || typeof id !== 'string' || id.length < 5) return res.status(400).json({ error: 'Invalid ID' });

            // A statement lives under `s/` (current) or `shared_statements/`
            // (legacy), so both are always attempted. Firestore's REST DELETE is
            // idempotent — removing a document that is not there answers 200 — so
            // "absent from one collection" is a success and needs no special case.
            const targets = [`s/${id}`, `shared_statements/${id}`];
            const failed = [];
            for (const t of targets) {
                const gone = await fsDeleteDoc(t);
                if (!gone.ok) failed.push({ target: t, detail: gone.detail });
            }

            if (failed.length) {
                // 502, and `success: false`. The document may still be publicly
                // reachable, so the caller must keep the id rather than forget it.
                return res.status(502).json({
                    success: false,
                    error: 'delete_incomplete',
                    id,
                    failed,
                    detail: `${failed.length} of ${targets.length} target(s) were not deleted. `
                        + 'The shared statement may still be reachable by anyone holding its link — '
                        + 'keep this id and retry.',
                });
            }
            return res.status(200).json({ success: true, deleted: targets.length });
        } catch (e) {
            // A genuine last resort: fsDeleteDoc reports its own failures, so
            // reaching here means something unexpected, and it is still not success.
            return res.status(500).json({ success: false, error: 'delete_failed', detail: _scrubKey(e && e.message) });
        }
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
