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
// Strategy order (reliability-first). Both paths are WealthFlow's own Firestore;
// there is no third-party host — a share that cannot be stored here fails and
// says so (see the note where a 0x0.st fallback used to be):
//   1. Firestore REST 's' collection (PRIMARY). PDFs chunk here when large.
//   2. Firestore REST 'shared_statements' (single-doc redundancy; HTML / small PDF)
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

// A Firestore document is capped at ~1 MiB, counting the field value plus name
// and index overhead. A base64 PDF above the single-doc threshold is split into
// sibling documents s/<id>-0 … s/<id>-<parts-1>, and a manifest s/<id> written
// LAST records how many. The manifest's existence is therefore the proof that
// every chunk landed: a reader that finds it can trust all parts are present, so
// a half-finished upload can never be read as a whole PDF (see the write order
// below). This keeps large Elite Report PDFs entirely on WealthFlow's own
// Firestore — the reason the old 0x0.st fallback existed — with no third party.
//
// '-' separates id from index deliberately: randomId()'s alphabet excludes it,
// so a chunk id can never collide with some other statement's manifest id.
const SINGLE_MAX  = 700 * 1024;     // inline in one doc at or below this many base64 chars
const CHUNK_SIZE  = 700 * 1024;     // base64 chars per chunk document
const MAX_PARTS   = 16;             // ceiling: 16 × 700 KiB ≈ 10.9 MB base64

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

/**
 * Create ONE Firestore document with a client-chosen id, and REPORT whether it
 * landed. `POST …/s?documentId=<id>` is a create, not an upsert — which is the
 * point: firestore.rules allows `create: if true` on s/ but restricts `update`
 * to the view counter, so a chunk write must be a create or the rules reject it.
 * A create against an id that already exists answers 409, surfaced here as a
 * throw rather than a silent overwrite. No result is discarded — the same
 * discipline fsDeleteDoc applies to deletes.
 */
async function fsCreateDoc(collection, docId, fields, signal) {
    const r = await fetch(`${FS_BASE}/${collection}?documentId=${docId}&key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields }),
        signal,
    });
    if (!r.ok) {
        const t = await r.text().catch(() => '');
        throw new Error(`${collection}/${docId} status ${r.status}: ${_scrubKey(t)}`);
    }
    return r;
}

/**
 * Store a base64 PDF under s/<id>, chunking across sibling documents when it is
 * too large for one. THE WRITE ORDER IS THE INTEGRITY MODEL: every chunk is
 * written first, and only once ALL of them are confirmed is the manifest s/<id>
 * written. So a reader that finds the manifest is guaranteed every part exists —
 * a half-written upload leaves orphan chunks with no manifest pointing at them,
 * which are unreachable (the id is random and only the manifest is handed out)
 * and expire on the same clock. Nothing partial is ever served as a whole PDF.
 */
async function storePdf(id, pdfBase64, meta, signal) {
    const base = {
        n: { stringValue: meta.name },
        t: { integerValue: String(meta.now) },
        x: { integerValue: String(meta.expiresMs) },
        v: { integerValue: '0' },
        kind: { stringValue: 'pdf' },
    };

    if (pdfBase64.length <= SINGLE_MAX) {
        // Small enough for one document — inline, exactly as before.
        await fsCreateDoc('s', id, { ...base, pdf: { stringValue: pdfBase64 } }, signal);
        return;
    }

    const parts = Math.ceil(pdfBase64.length / CHUNK_SIZE);
    if (parts > MAX_PARTS) throw new Error(`pdf needs ${parts} chunks, over the ${MAX_PARTS} ceiling`);

    // Chunks first, in parallel. If any rejects, Promise.all rejects and the
    // manifest below is never written — the whole point. Sibling writes that did
    // succeed become harmless orphans.
    const writes = [];
    for (let i = 0; i < parts; i++) {
        const slice = pdfBase64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        writes.push(fsCreateDoc('s', `${id}-${i}`, {
            d: { stringValue: slice },
            x: { integerValue: String(meta.expiresMs) },   // parts age out with the manifest
        }, signal));
    }
    await Promise.all(writes);

    // Manifest LAST. No payload of its own; it names the part count.
    await fsCreateDoc('s', id, {
        ...base,
        chunked: { booleanValue: true },
        parts: { integerValue: String(parts) },
    }, signal);
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
        //  PDFs go through storePdf, which stores small ones inline and chunks
        //  large ones across sibling documents — so a big Elite Report stays on
        //  WealthFlow's own Firestore instead of a third-party host. The write
        //  budget is generous because a chunked PDF is several sequential-ish
        //  writes; maxDuration is 25s.
        try {
            const link = await withTimeout(async (signal) => {
                if (isPdf) {
                    await storePdf(id, pdfBase64, { name: cleanName, now, expiresMs }, signal);
                } else {
                    const pageHtml = wrapHtml(html, cleanName);
                    if (pageHtml.length > MAX_DOC_FS) throw new Error('html exceeds firestore soft cap');
                    await fsCreateDoc('s', id, {
                        n: { stringValue: cleanName },
                        t: { integerValue: String(now) },
                        x: { integerValue: String(expiresMs) },
                        v: { integerValue: '0' },
                        kind: { stringValue: 'html' },
                        h: { stringValue: pageHtml },
                    }, signal);
                }
                // URL format:
                //   - HTML  → ?s=ID (rendered by the SPA reader)
                //   - PDF   → /api/statement-view?id=ID (direct PDF response,
                //             native rendering on iOS / Android / WhatsApp)
                return isPdf
                    ? `${APP_URL}api/statement-view?id=${id}`
                    : `${APP_URL}?s=${id}`;
            }, 22000);
            return res.status(200).json({
                url: link, id, days: EXPIRY_DAYS,
                via: 'firestore', kind: isPdf ? 'pdf' : 'html'
            });
        } catch (e) { console.warn('[statement-store] firestore s/ failed:', e && e.message); }

        // ── STRATEGY 2: Firestore 'shared_statements' (legacy/redundancy) ──
        //  A single-document redundancy path. It cannot hold a chunked PDF, so a
        //  PDF that needed chunking skips it rather than pointlessly attempting a
        //  doomed single-doc write (and burning its timeout).
        if (!(isPdf && pdfBase64.length > SINGLE_MAX)) try {
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

        // NO THIRD-PARTY FALLBACK.
        //  There used to be a Strategy 3 here that uploaded the statement — a loan
        //  statement or an Elite Report, with balances and lender details — to
        //  0x0.st, a public zero-auth file host, and returned that host's own URL.
        //  It was the server-side twin of the client-side pastebin fallbacks
        //  removed in #115, and it ran automatically whenever both Firestore
        //  writes above failed. A share that fails and says so is strictly better
        //  than one that silently succeeds somewhere the owner never chose. Large
        //  PDFs, the only reason it was reached, now chunk onto Firestore in
        //  Strategy 1, so nothing legitimate needed it.
        //
        //  `all_hosts_failed` is the literal the loan-share caller in index.html
        //  matches to raise SHARE_ALL_FAILED, so the string is preserved.
        return res.status(502).json({ error: 'all_hosts_failed' });
    } catch (e) {
        console.error('[statement-store] error:', e && e.message);
        return res.status(500).json({ error: 'server_error', detail: String(e && e.message) });
    }
}
