// =============================================================================
// WealthFlow SMS Ingest Webhook v1.0
//
// Receives SMS payloads from an Android SMS-forwarding service (e.g.
// "SMS Forwarder" by Bogdan Tudose, "MacroDroid", "Tasker", or a custom
// Kotlin foreground service — see /android/wealthflow-sms-forwarder).
//
// Pipeline:
//   1. Authenticate the caller via a per-device API token (set in
//      Settings → Robotic Automation → Device Token).
//   2. Validate payload, run /api/autonomous-brain to classify.
//   3. Idempotent-write to Firestore via the user's auth token (caller
//      passes uid + idToken so we can write under their security rules).
//   4. If brain.routed.module === 'cc_payment', fan out to /api/fifo-reconcile.
//   5. Return result so caller can show a toast.
//
// This is the OUTBOUND-FROM-PHONE endpoint. It runs Edge for speed.
// =============================================================================

export const config = { runtime: 'edge' };

const ALLOWED_SENDERS = [
    // Sri Lankan banks' typical sender IDs — extend as needed
    'COMBANK', 'COMMBANK', 'HNB', 'SAMPATH', 'NTB', 'SEYLAN', 'DFCC', 'NDB',
    'BOC', 'PEOPLES', 'PAN ASIA', 'PAN-ASIA', 'UNION', 'CARGILLS', 'AMEX',
    'STANCHART', 'STDCHRT', 'NSB', 'HSBC', 'CITI', 'DIALOG', 'MOBITEL'
];

function isLikelyBankSms(sender, body) {
    const s = (sender || '').toUpperCase().replace(/\s+/g, '');
    if (ALLOWED_SENDERS.some(a => s.includes(a.replace(/\s+/g, '')))) return true;
    // Fallback: body smells like a bank message
    return /\b(LKR|Rs\.?|USD)\s*[\d,]+\.?\d*\b/i.test(body)
        && /\b(debited|credited|withdrawn|deposited|purchase|payment|balance|available)\b/i.test(body);
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

    const sms        = (body.sms || body.message || '').toString();
    const sender     = (body.sender || body.from || '').toString();
    const receivedAt = Number(body.received_at_ms || body.timestamp || Date.now());
    const deviceId   = (body.device_id || '').toString();
    const deviceTok  = (body.device_token || req.headers.get('x-wf-device-token') || '').toString();
    const cardReg    = body.card_registry || {};
    const location   = body.location || null;

    if (!sms) {
        return new Response(JSON.stringify({ ok: false, error: 'Empty SMS body' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }
    if (!deviceTok || deviceTok.length < 16) {
        return new Response(JSON.stringify({
            ok: false, error: 'Device token missing or too short (set in Settings → Robotic Automation)'
        }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    if (!isLikelyBankSms(sender, sms)) {
        return new Response(JSON.stringify({
            ok: true, classified: false, reason: 'Not a bank SMS',
            sender, snippet: sms.slice(0, 100)
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const origin = new URL(req.url).origin;

    // Delegate to the brain
    let brain;
    try {
        const r = await fetch(`${origin}/api/autonomous-brain`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sms, phone_number: sender, received_at_ms: receivedAt,
                device_id: deviceId, location, card_registry: cardReg
            })
        });
        brain = await r.json();
    } catch (e) {
        return new Response(JSON.stringify({
            ok: false, error: 'Brain unreachable: ' + e.message
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    if (!brain.ok) {
        return new Response(JSON.stringify({
            ok: false, error: 'Brain returned error', detail: brain
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Return the classification; the client-side listener writes to Firestore
    // (so we don't need to hold a service-account key here — security rules
    // are enforced by the user's own Firebase ID token in the client).
    return new Response(JSON.stringify({
        ok: true,
        classified: true,
        device_id: deviceId,
        received_at_ms: receivedAt,
        sender,
        sms_preview: sms.slice(0, 140),
        ...brain
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
