// =============================================================================
// WealthFlow SMS Ingest Webhook v1.1
//
// v1.1 changes:
//  • GET request → returns health-check JSON (so users can verify the URL
//    works in their browser before configuring it in Shortcuts/forwarder)
//  • More forgiving validation — accepts missing/empty fields, returns
//    clear errors so users can debug from the Shortcuts app
//  • Detects when token was placed in URL or Key-only fields
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
    // v7.6.4 — GET health-check: users can visit this URL in browser
    // to confirm the endpoint is reachable from their iPhone.
    if (req.method === 'GET') {
        return new Response(JSON.stringify({
            ok: true,
            service: 'WealthFlow SMS Ingest',
            version: '1.1',
            status: 'healthy',
            ts: new Date().toISOString(),
            message: 'Endpoint is reachable. To submit an SMS, send a POST with JSON body { sms, sender, received_at_ms, device_id } and header x-wf-device-token.'
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
        });
    }

    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }
    let body;
    try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({
            ok: false,
            error: 'Invalid JSON body',
            hint: 'In iOS Shortcuts, set Request Body to "JSON" then add fields: sms (Shortcut Input), sender (Sender variable), device_id ("iphone").'
        }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const sms        = (body.sms || body.message || body.text || '').toString();
    const sender     = (body.sender || body.from || '').toString();
    const receivedAt = Number(body.received_at_ms || body.timestamp || Date.now());
    const deviceId   = (body.device_id || '').toString();
    // v7.6.4 — accept device token from multiple places (header, body, or
    // even mis-placed in "key" by users who entered both key+value in the
    // Key field of iOS Shortcuts).
    let deviceTok = (
        body.device_token
        || req.headers.get('x-wf-device-token')
        || req.headers.get('X-Wf-Device-Token')
        || ''
    ).toString().trim();
    // If user typed "x-wf-device-token: TOKEN" into a single field, strip prefix
    if (/^x-wf-device-token\s*:/i.test(deviceTok)) {
        deviceTok = deviceTok.replace(/^x-wf-device-token\s*:\s*/i, '').trim();
    }

    const cardReg    = body.card_registry || {};
    const location   = body.location || null;

    if (!sms) {
        return new Response(JSON.stringify({
            ok: false,
            error: 'Empty SMS body',
            hint: 'Make sure your Shortcut Request Body includes field "sms" with value "Shortcut Input" (the magic variable, not literal text).'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    if (!deviceTok || deviceTok.length < 16) {
        return new Response(JSON.stringify({
            ok: false,
            error: 'Device token missing or too short',
            received_token_length: deviceTok.length,
            hint: 'In iOS Shortcuts → Headers, you need TWO SEPARATE fields: Key=x-wf-device-token and Value=YOUR_TOKEN. Do not put the whole "key: value" string in one field.'
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
