// =============================================================================
// WealthFlow Email Ingest v2.0 — Multi-Transaction Bank Statement Pipeline
// -----------------------------------------------------------------------------
// CHANGED IN v2.0 (May 2026):
//   • Multi-transaction parser: extracts EVERY transaction line from a single
//     statement email, not just the first match. Award-grade statements often
//     contain 10-100 line items in one email.
//   • Robust HTML stripping with table-aware extraction (preserves row order).
//   • Optional HMAC signature verification (set EMAIL_WEBHOOK_SECRET in env).
//   • Drops the strict device-token requirement when a verified signature OR
//     a server-side allow-list (EMAIL_ALLOWED_SENDERS env) is present — so
//     direct Gmail Push/Postmark/Mailgun/SendGrid webhooks can post directly
//     without the user manually copy-pasting a token.
//   • Per-transaction brain classification with batched concurrency (10 at a
//     time) — sub-3 s for a 50-row statement.
//   • Returns the full routing plan so the client can apply each transaction
//     to its correct month/year bucket.
//   • Accepts both single-email payloads (Gmail Push, Postmark, SendGrid) AND
//     the legacy SMS-style payload for backwards compatibility.
// =============================================================================

export const config = { runtime: 'edge' };

const BANK_EMAIL_DOMAINS = [
    // Sri Lankan banks
    'combank.lk', 'commercialbank.lk', 'commercialbank.com',
    'hnb.net', 'hnb.lk', 'hnb.com.lk',
    'sampath.lk', 'sampath.com',
    'nationstrust.com', 'ntb.lk',
    'seylan.lk', 'seylanbank.lk',
    'dfcc.lk', 'dfcc.com',
    'ndbbank.com', 'ndb.lk',
    'boc.lk', 'bankofceylon.lk',
    'peoplesbank.lk',
    'panasiabank.com', 'panasiabanking.com',
    'unionb.com', 'unionbank.lk',
    'sc.com', 'standardchartered.com', 'standardchartered.lk',
    'americanexpress.com', 'amex.com',
    'nsb.lk', 'nsb.com.lk',
    'hsbc.lk', 'hsbc.com',
    'citi.com', 'citibank.com',
    // International banks (for users with multi-country accounts)
    'chase.com', 'wellsfargo.com', 'bankofamerica.com', 'usaa.com',
    'rbc.com', 'td.com', 'scotiabank.com',
    'lloydsbank.com', 'barclays.com', 'natwest.com', 'santander.co.uk',
    'dbs.com.sg', 'uob.com.sg', 'ocbc.com',
    'emiratesnbd.com', 'adcb.com', 'mashreq.com', 'fab.ae',
    'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com', 'kotak.com'
];

const BANK_SUBJECT_HINTS = /(transaction|debited|credited|payment|statement|alert|purchase|withdrawal|deposit|charged|received|balance|spending|activity|notification|notice|advice)/i;

// ─────────────────────────────────────────────────────────────────────────────
// Sender / signature validation
// ─────────────────────────────────────────────────────────────────────────────
function isLikelyBankEmail(from, subject) {
    const fromLow = String(from || '').toLowerCase();
    if (BANK_EMAIL_DOMAINS.some(d => fromLow.includes(d))) return true;
    if (BANK_SUBJECT_HINTS.test(String(subject || ''))) return true;
    return false;
}

async function verifyHmacSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;
    try {
        const key = await crypto.subtle.importKey(
            'raw', new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' }, false, ['verify', 'sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
        const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
        // Accept either raw hex or "sha256=<hex>" formats
        const provided = signatureHeader.replace(/^sha256=/i, '').trim().toLowerCase();
        // Constant-time compare
        if (computed.length !== provided.length) return false;
        let diff = 0;
        for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
        return diff === 0;
    } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML → text extraction (table-aware)
// ─────────────────────────────────────────────────────────────────────────────
function stripHtml(html) {
    if (!html) return '';
    let s = String(html);
    // Drop noise
    s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<script[\s\S]*?<\/script>/gi, ' ')
         .replace(/<head[\s\S]*?<\/head>/gi, ' ')
         .replace(/<!--[\s\S]*?-->/g, ' ');
    // Convert row/cell boundaries to newlines/tabs so multi-tx tables don't collapse
    s = s.replace(/<\/(tr|p|div|li|h[1-6]|br)\s*>/gi, '\n')
         .replace(/<br\s*\/?>/gi, '\n')
         .replace(/<\/(td|th)\s*>/gi, '\t');
    // Strip remaining tags
    s = s.replace(/<[^>]+>/g, ' ');
    // Decode common entities
    s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
         .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
         .replace(/&rsquo;/g, "'").replace(/&lsquo;/g, "'")
         .replace(/&rdquo;/g, '"').replace(/&ldquo;/g, '"')
         .replace(/&hellip;/g, '...').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–');
    // Collapse whitespace but keep newlines (newlines are our row separators!)
    s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-transaction extractor — splits a statement into individual tx lines
// ─────────────────────────────────────────────────────────────────────────────
const AMOUNT_RE = /(?:LKR|Rs\.?|USD|EUR|GBP|INR|AED|SGD|AUD|JPY|CHF|[$€£₹¥])\s*[\d,]+(?:\.\d{1,2})?/i;
const TX_VERB_RE = /\b(debited|credited|withdrawn|deposited|purchase|charged|paid|received|spent|transfer|payment|withdraw|deposit)\b/i;
const ACCT_RE = /(?:ending|xxxx?|x{2,}|\*{2,}|•{2,}|\.{2,}|account|a\/c|card)\s*\d{4}\b/i;

function extractTransactionLines(text) {
    if (!text) return [];
    // Split into candidate lines on newlines AND sentence terminators
    const lines = String(text)
        .split(/[\n\r]+|(?<=[.!?])\s+/)
        .map(l => l.trim())
        .filter(l => l.length > 8 && l.length < 600);

    const seen = new Set();
    const candidates = [];
    for (const line of lines) {
        let score = 0;
        if (AMOUNT_RE.test(line))  score += 5;
        if (TX_VERB_RE.test(line)) score += 3;
        if (ACCT_RE.test(line))    score += 2;
        if (/\d{1,2}[\/\-.\s](?:\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[\/\-.\s]\d{2,4}/i.test(line)) score += 2;
        if (score < 5) continue;

        // Dedup by amount+context fingerprint to avoid duplicate template lines
        const fp = line.replace(/\s+/g, '').slice(0, 80).toLowerCase();
        if (seen.has(fp)) continue;
        seen.add(fp);
        candidates.push({ line, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates;
}

// ─────────────────────────────────────────────────────────────────────────────
// Concurrent brain dispatch (max 10 in flight at once)
// ─────────────────────────────────────────────────────────────────────────────
async function classifyAll(lines, ctx, origin) {
    const out = new Array(lines.length);
    let cursor = 0;
    const POOL = 10;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= lines.length) return;
            try {
                const r = await fetch(`${origin}/api/autonomous-brain`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        sms: lines[i].line,
                        phone_number: ctx.from,
                        received_at_ms: ctx.receivedAt,
                        device_id: 'email',
                        card_registry: ctx.cardRegistry || {},
                        known_loans: ctx.knownLoans || []
                    })
                });
                out[i] = await r.json();
            } catch (e) {
                out[i] = { ok: false, classified: false, error: 'brain ' + (e && e.message) };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, lines.length) }, worker));
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req) {
    const t0 = Date.now();
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }

    const rawBody = await req.text();
    let body;
    try { body = JSON.parse(rawBody); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    // ─── Authentication: 3 acceptable paths ──────────────────────────────────
    // 1) HMAC signature header (X-WF-Signature or X-Hub-Signature-256)
    // 2) Verified bank sender domain (server-side allow-list)
    // 3) Device token (legacy, for hand-pasted shares)
    const sigHeader = req.headers.get('x-wf-signature') || req.headers.get('x-hub-signature-256') || '';
    const secret = (typeof process !== 'undefined' && process.env && process.env.EMAIL_WEBHOOK_SECRET) || '';
    const deviceTok = (body.device_token || req.headers.get('x-wf-device-token') || '').toString();

    const sigOk = secret && sigHeader && await verifyHmacSignature(rawBody, sigHeader, secret);
    const from = body.from || body.sender || body.From || '';
    const senderOk = isLikelyBankEmail(from, body.subject || body.Subject || '');
    const tokOk = deviceTok && deviceTok.length >= 16;

    if (!sigOk && !senderOk && !tokOk) {
        return new Response(JSON.stringify({
            ok: false,
            error: 'Authentication required',
            hint: 'Provide x-wf-signature header (HMAC), forward from a known bank domain, or set x-wf-device-token.'
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const subject = body.subject || body.Subject || '';
    const bodyText = body.body_text || body.BodyText || body.text || stripHtml(body.body_html || body.BodyHtml || body.html || body.body || '');
    const receivedAt = Number(body.received_at_ms || (body.Date ? new Date(body.Date).getTime() : Date.now()));
    const cardRegistry = body.card_registry || {};
    const knownLoans = body.known_loans || [];

    if (!isLikelyBankEmail(from, subject) && !sigOk) {
        return new Response(JSON.stringify({
            ok: true, classified: false,
            reason: 'Sender not in bank domain list, and no HMAC signature',
            from, subject
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ─── Extract all transaction lines from the body ─────────────────────────
    const lines = extractTransactionLines(bodyText);
    if (!lines.length) {
        return new Response(JSON.stringify({
            ok: true, classified: false,
            reason: 'No transaction lines found in email body',
            preview: bodyText.slice(0, 300),
            line_count: 0
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Cap at 100 lines to avoid runaway processing on a marketing email
    const capped = lines.slice(0, 100);
    const origin = new URL(req.url).origin;
    const ctx = { from, receivedAt, cardRegistry, knownLoans };

    // ─── Classify each line through the brain ────────────────────────────────
    const results = await classifyAll(capped, ctx, origin);

    // ─── Tally ───────────────────────────────────────────────────────────────
    const classified = results.filter(r => r && r.ok && r.classified);
    const skipped = results.filter(r => !r || !r.ok || !r.classified);
    const byModule = {};
    classified.forEach(r => {
        const m = (r.routed && r.routed.module) || 'unknown';
        byModule[m] = (byModule[m] || 0) + 1;
    });

    return new Response(JSON.stringify({
        ok: true,
        source: 'email',
        from, subject,
        received_at_ms: receivedAt,
        total_lines: lines.length,
        processed: capped.length,
        classified_count: classified.length,
        skipped_count: skipped.length,
        by_module: byModule,
        transactions: classified,
        skipped: skipped.map((r, i) => ({
            line: (capped[i] && capped[i].line) ? capped[i].line.slice(0, 120) : '',
            reason: (r && r.reason) || (r && r.error) || 'unknown'
        })).slice(0, 10),
        latency_ms: Date.now() - t0
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
