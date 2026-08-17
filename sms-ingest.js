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

/** fetch with a hard deadline. An unbounded fetch inside a 60s function has no
 *  outcome to report: it neither succeeds nor fails, it just consumes the whole
 *  budget and takes the request down with it. Every call below has to resolve to
 *  a fact, because the response tells the caller what happened. */
async function fetchWithTimeout(url, init, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        return { ok: true, res: await fetch(url, { ...(init || {}), signal: ctl.signal }) };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || ctl.signal.aborted);
        return { ok: false, res: null, error: aborted ? `no answer within ${timeoutMs}ms` : String((e && e.message) || e) };
    } finally {
        clearTimeout(timer);
    }
}

function isLikelyBankSms(sender, body) {
    const s = (sender || '').toUpperCase().replace(/\s+/g, '');
    if (ALLOWED_SENDERS.some(a => s.includes(a.replace(/\s+/g, '')))) return true;
    // Fallback: body smells like a bank message (v7.6.6 — use \w* so past-tense
    // verbs match, since iOS users can't easily pass real sender from Shortcuts
    // and may set sender="iphone" or leave it blank — body content is the real
    // signal here).
    return /\b(LKR|Rs\.?|USD|EUR|GBP|INR)\s*[\d,]+\.?\d*\b/i.test(body)
        && /\b(debit\w*|credit\w*|withdr\w*|deposit\w*|purchas\w*|payment|balance|available|received|charged|spent|paid|transfer\w*|refund\w*|reversal)\b/i.test(body);
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
    const brainCall = await fetchWithTimeout(`${origin}/api/autonomous-brain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sms, phone_number: sender, received_at_ms: receivedAt,
            device_id: deviceId, location, card_registry: cardReg
        })
    }, 25000);
    if (!brainCall.ok) {
        return new Response(JSON.stringify({
            ok: false, error: 'Brain unreachable: ' + brainCall.error
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    // fetch does not throw on 4xx/5xx, so the status has to be read explicitly —
    // otherwise an error page reaches JSON.parse and is reported as "unreachable",
    // which sends the reader looking for a network fault that does not exist.
    let brain;
    try {
        brain = await brainCall.res.json();
    } catch (e) {
        return new Response(JSON.stringify({
            ok: false,
            error: `Brain answered ${brainCall.res.status} with a body that is not JSON`,
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    if (!brainCall.res.ok) {
        return new Response(JSON.stringify({
            ok: false, error: `Brain returned HTTP ${brainCall.res.status}`, detail: brain
        }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    if (!brain.ok) {
        return new Response(JSON.stringify({
            ok: false, error: 'Brain returned error', detail: brain
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // v7.6.6 — CRITICAL: push the classified result to the server-side inbox
    // so the main app picks it up next time it opens. Without this, the
    // classification result is lost (iOS Shortcuts throws away the HTTP
    // response after running the Shortcut).
    //
    // v7.69.25 — this block used to be `try { await fetch(...) } catch { log }`
    // and the response below hardcoded `inboxed: true`. Both halves were wrong,
    // and together they made the failure invisible:
    //
    //   · fetch does not reject on an HTTP error, so the catch could only ever
    //     fire on a network fault. /api/inbox-push was answering 500 on EVERY
    //     request (it referenced an undeclared `res`), and this catch never ran
    //     once.
    //   · `inboxed: true` was a literal. It described the code path taken, not
    //     the outcome — so the endpoint reported a successful hand-off of an
    //     item that had just been thrown away.
    //
    // The status is now read, and `inboxed` is derived from what the inbox
    // actually said. It is allowed to be false: the classification is in this
    // response either way, so a caller that reads the response (share-target.html)
    // still works, and one that does not (the iOS Shortcut) at least leaves a
    // truthful record.
    let inboxed = false;
    let inboxDetail = null;
    const push = await fetchWithTimeout(`${origin}/api/inbox-push`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-wf-device-token': deviceTok
        },
        body: JSON.stringify({
            brain_result: brain,
            sms: sms,
            received_at_ms: receivedAt,
            device_id: deviceId
        })
    }, 15000);

    if (!push.ok) {
        inboxDetail = `inbox-push unreachable: ${push.error}`;
    } else if (!push.res.ok) {
        let detail = '';
        try {
            const j = await push.res.json();
            detail = String((j && (j.detail || j.error)) || '');
        } catch (_) {}
        inboxDetail = `inbox-push returned HTTP ${push.res.status}${detail ? ': ' + detail : ''}`;
    } else {
        // 200 is necessary but not sufficient: inbox-push answers 200 only when
        // the write is durable, and reports `durable` explicitly. Trust the field
        // over the status code, and treat a missing field as durable so an older
        // deployment of that endpoint does not read as a failure.
        let saved = null;
        try { saved = await push.res.json(); } catch (_) {}
        if (saved && saved.durable === false) {
            inboxDetail = 'inbox-push accepted the item but could not store it durably';
        } else if (saved && saved.ok === false) {
            inboxDetail = `inbox-push reported failure: ${String(saved.error || 'unspecified')}`;
        } else {
            inboxed = true;
        }
    }
    if (!inboxed) console.error('[sms-ingest] inbox-push did not store the item:', inboxDetail);

    return new Response(JSON.stringify({
        ok: true,
        classified: true,
        device_id: deviceId,
        received_at_ms: receivedAt,
        sender,
        sms_preview: sms.slice(0, 140),
        ...brain,
        // AFTER the spread, deliberately. This is the one fact only this function
        // knows, and a `brain` payload that happened to carry the same key would
        // otherwise silently overwrite the hand-off result with its own.
        inboxed,
        ...(inboxed ? {} : { inbox_error: inboxDetail })
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
