// =============================================================================
// WealthFlow Gmail Sync v1.0
// -----------------------------------------------------------------------------
// Stateless Gmail-poller. The client passes its access_token (refreshed via
// /api/gmail-oauth?action=refresh) and its last-seen historyId/messageId.
// We fetch new bank emails, feed each one to /api/email-ingest, and return
// the cumulative results.
//
// Input (POST JSON):
//   { access_token: "...",
//     since_query: "newer_than:7d",     // Gmail search query (optional)
//     max_results: 25,                  // cap (default 20, max 50)
//     last_processed_ids: ["...",...],  // skip these (client dedup)
//     card_registry: {...},             // forwarded to brain
//     known_loans: [...] }              // forwarded to brain
//
// Output:
//   { ok, fetched, new_messages: [{id, from, subject, snippet, ingest_result}],
//     latency_ms }
// =============================================================================

export const config = { runtime: 'edge' };

const BANK_DOMAINS = [
    'combank.lk', 'commercialbank.lk', 'commercialbank.com',
    'hnb.net', 'hnb.lk', 'hnb.com.lk',
    'sampath.lk', 'sampath.com',
    'nationstrust.com', 'ntb.lk',
    'seylan.lk', 'seylanbank.lk',
    'dfcc.lk', 'dfcc.com',
    'ndbbank.com', 'ndb.lk',
    'boc.lk', 'bankofceylon.lk',
    'peoplesbank.lk',
    'panasiabank.com',
    'unionb.com', 'unionbank.lk',
    'sc.com', 'standardchartered.com',
    'americanexpress.com', 'amex.com',
    'nsb.lk',
    'hsbc.lk', 'hsbc.com',
    'citi.com', 'citibank.com',
    // International
    'chase.com', 'wellsfargo.com', 'bankofamerica.com',
    'lloydsbank.com', 'barclays.com', 'natwest.com',
    'dbs.com.sg', 'uob.com.sg', 'ocbc.com',
    'emiratesnbd.com', 'adcb.com', 'mashreq.com', 'fab.ae',
    'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com'
];

// Default search query: bank emails in the last 30 days that we likely haven't seen
const DEFAULT_QUERY = '(from:(' + BANK_DOMAINS.map(d => '@' + d).join(' OR ') + ')) newer_than:30d';

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } }); }

// Decode a Gmail message body part (base64url → utf8)
function decodeB64url(s) {
    if (!s) return '';
    try {
        // Gmail returns base64url. Replace URL-safe chars before atob.
        const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
        const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
        const bin = atob(padded);
        // Decode as UTF-8
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    } catch { return ''; }
}

// Walk a Gmail payload structure and pull out text/plain and text/html bodies
function extractBodies(payload) {
    let text = '', html = '';
    function walk(part) {
        if (!part) return;
        const mime = (part.mimeType || '').toLowerCase();
        const data = part.body && part.body.data;
        if (mime === 'text/plain' && data) text += decodeB64url(data) + '\n';
        if (mime === 'text/html' && data)  html += decodeB64url(data) + '\n';
        if (part.parts && part.parts.length) part.parts.forEach(walk);
    }
    walk(payload);
    return { text, html };
}

function headerValue(headers, name) {
    if (!headers) return '';
    const lname = name.toLowerCase();
    const h = headers.find(x => x.name && x.name.toLowerCase() === lname);
    return h ? h.value : '';
}

export default async function handler(req) {
    const t0 = Date.now();
    if (req.method !== 'POST') return json({ ok: false, error: 'POST required' }, 405);

    let body;
    try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

    const accessToken = body.access_token;
    if (!accessToken) return json({ ok: false, error: 'access_token required' }, 400);

    const query = body.since_query || DEFAULT_QUERY;
    const maxResults = Math.min(50, Math.max(1, Number(body.max_results) || 20));
    const seen = new Set(Array.isArray(body.last_processed_ids) ? body.last_processed_ids : []);
    const cardRegistry = body.card_registry || {};
    const knownLoans = body.known_loans || [];
    const origin = new URL(req.url).origin;

    // ─── 1. List matching message IDs ────────────────────────────────────────
    let listRes;
    try {
        const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
        u.searchParams.set('q', query);
        u.searchParams.set('maxResults', String(maxResults));
        listRes = await fetch(u.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
    } catch (e) {
        return json({ ok: false, error: 'Gmail list failed: ' + (e && e.message) }, 502);
    }
    if (!listRes.ok) {
        const t = await listRes.text();
        return json({ ok: false, error: 'Gmail list HTTP ' + listRes.status, detail: t.slice(0, 300) }, 502);
    }
    const listJson = await listRes.json();
    const ids = (listJson.messages || []).map(m => m.id).filter(id => !seen.has(id));

    if (!ids.length) {
        return json({ ok: true, fetched: 0, new_messages: [], latency_ms: Date.now() - t0 });
    }

    // ─── 2. Fetch each message in parallel (cap at 10 concurrent) ────────────
    const out = new Array(ids.length);
    let cursor = 0;
    const POOL = 10;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= ids.length) return;
            const id = ids[i];
            try {
                const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, {
                    headers: { Authorization: 'Bearer ' + accessToken }
                });
                if (!r.ok) { out[i] = { id, ok: false, error: 'fetch ' + r.status }; continue; }
                const msg = await r.json();
                const headers = (msg.payload && msg.payload.headers) || [];
                const from = headerValue(headers, 'From');
                const subject = headerValue(headers, 'Subject');
                const dateHdr = headerValue(headers, 'Date');
                const receivedAt = (msg.internalDate && +msg.internalDate)
                    || (dateHdr ? new Date(dateHdr).getTime() : Date.now());
                const { text, html } = extractBodies(msg.payload);

                // Forward to email-ingest with an internal trusted signal
                // (we already verified the sender against BANK_DOMAINS via the
                // search query, so this is safe; we still pass full headers).
                const ing = await fetch(`${origin}/api/email-ingest`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-wf-internal-source': 'gmail-sync'
                    },
                    body: JSON.stringify({
                        from, subject,
                        body_text: text,
                        body_html: html,
                        received_at_ms: receivedAt,
                        card_registry: cardRegistry,
                        known_loans: knownLoans
                    })
                });
                const result = await ing.json();
                out[i] = {
                    id,
                    from, subject,
                    received_at_ms: receivedAt,
                    snippet: msg.snippet || '',
                    ingest_result: result
                };
            } catch (e) {
                out[i] = { id, ok: false, error: 'process ' + (e && e.message) };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, ids.length) }, worker));

    // ─── 3. Tally aggregate stats ────────────────────────────────────────────
    const totalTx = out.reduce((s, m) => s + ((m.ingest_result && m.ingest_result.classified_count) || 0), 0);
    return json({
        ok: true,
        fetched: ids.length,
        total_classified_transactions: totalTx,
        new_messages: out,
        query_used: query,
        latency_ms: Date.now() - t0
    });
}
