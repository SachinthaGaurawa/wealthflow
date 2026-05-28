// =============================================================================
// WealthFlow Email Ingest Webhook v1.0
//
// Receives bank-statement emails forwarded from Gmail / iCloud filtering rules.
// Same authentication model as sms-ingest: per-device token + autonomous-brain
// classification.
//
// Setup the user does in Gmail (one time):
//   1. Open Gmail → Settings → Filters & Blocked Addresses → Create a new filter
//   2. From: "*@combank.lk OR *@sampath.lk OR *@hnb.lk OR ..." (banks)
//   3. Forward to: <webhook URL via Zapier/Make/n8n bridge>
//
// OR more simply via IFTTT/Zapier "Gmail New Email → Webhook" with body template.
//
// Input (POST JSON):
//   { subject: "Your transaction notification",
//     from: "alerts@combank.lk",
//     body_text: "Dear Customer, your A/c ...1234 has been debited LKR 2,450.00 ...",
//     body_html: "...",            // optional, used if body_text missing
//     received_at_ms: 1717000000000,
//     device_token: "..." }
//
// We strip HTML if needed, extract the transactional sentence, then delegate
// to /api/autonomous-brain just like SMS.
// =============================================================================

export const config = { runtime: 'edge' };

const BANK_EMAIL_DOMAINS = [
    'combank.lk', 'commercialbank.lk', 'hnb.net', 'hnb.lk', 'sampath.lk',
    'nationstrust.com', 'ntb.lk', 'seylan.lk', 'dfcc.lk', 'ndbbank.com',
    'ndb.lk', 'boc.lk', 'peoplesbank.lk', 'panasiabank.com', 'unionb.com',
    'sc.com', 'standardchartered.com', 'americanexpress.com',
    'amex.com', 'nsb.lk', 'hsbc.lk', 'citi.com'
];

function isLikelyBankEmail(from, subject) {
    const fromLow = String(from || '').toLowerCase();
    if (BANK_EMAIL_DOMAINS.some(d => fromLow.includes(d))) return true;
    const subjLow = String(subject || '').toLowerCase();
    return /(transaction|debited|credited|payment|statement|alert|purchase|withdrawal|deposit)/i.test(subjLow);
}

function stripHtml(html) {
    return String(html || '')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
}

// Extract the most "SMS-like" sentence from a longer email body, so the brain
// receives a single clean parse target instead of paragraphs of marketing
function extractTransactionSentence(text) {
    const sentences = String(text || '').split(/(?<=[.!?])\s+/);
    // Prefer sentences that contain both an amount AND a transaction verb
    const scored = sentences
        .map(s => {
            let score = 0;
            if (/(?:LKR|Rs\.?|USD|EUR|GBP|INR|\$|€|£|₹)\s*[\d,]+(?:\.\d{1,2})?/.test(s)) score += 5;
            if (/\b(debited|credited|withdrawn|deposited|purchase|charged|paid|received)\b/i.test(s)) score += 3;
            if (/(?:ending|xxxx?|x{2,}|\*{2,}|•{2,}|\.{2,}|account|a\/c|card)\s*\d{4}\b/i.test(s)) score += 2;
            return { s, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
    return scored.length ? scored[0].s : '';
}

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }
    let body;
    try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const from       = body.from || body.sender || '';
    const subject    = body.subject || '';
    const bodyText   = body.body_text || stripHtml(body.body_html || body.body || '');
    const receivedAt = Number(body.received_at_ms || Date.now());
    const deviceTok  = (body.device_token || req.headers.get('x-wf-device-token') || '').toString();
    const cardReg    = body.card_registry || {};

    if (!deviceTok || deviceTok.length < 16) {
        return new Response(JSON.stringify({
            ok: false, error: 'Device token required'
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    if (!isLikelyBankEmail(from, subject)) {
        return new Response(JSON.stringify({
            ok: true, classified: false,
            reason: 'Not a bank email',
            from, subject
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Extract the meaningful transaction sentence
    const smsLike = extractTransactionSentence(bodyText);
    if (!smsLike) {
        return new Response(JSON.stringify({
            ok: true, classified: false,
            reason: 'No transaction line found in email body',
            preview: bodyText.slice(0, 200)
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Delegate to brain
    const origin = new URL(req.url).origin;
    try {
        const r = await fetch(`${origin}/api/autonomous-brain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sms: smsLike,
                phone_number: from,
                received_at_ms: receivedAt,
                device_id: 'email',
                card_registry: cardReg
            })
        });
        const brain = await r.json();
        return new Response(JSON.stringify({
            ok: brain.ok || false,
            classified: brain.ok,
            source: 'email',
            from, subject,
            extracted_sentence: smsLike,
            ...brain
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } catch (e) {
        return new Response(JSON.stringify({
            ok: false, error: 'Brain unreachable: ' + e.message
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
}
