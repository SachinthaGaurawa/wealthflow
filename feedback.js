/* =============================================================================
   /api/feedback.js  —  Feedback email backup (Vercel Edge)
   ---------------------------------------------------------------------------
   The client primarily stores feedback in Firestore (so it can be fetched and
   prioritised). This endpoint is the EMAIL BACKUP path for urgent alerts.

   Sends via Resend (RESEND_API_KEY) if configured, to FEEDBACK_EMAIL_TO.
   If no key is set it returns ok:false and the client keeps the Firestore copy
   (and a local queue) — nothing breaks.

   Privacy: forwards only what the user typed plus optional basic diagnostics
   (version, device) — never financial data.
   ============================================================================ */
export const config = { runtime: 'edge' };

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') return json({ ok: true });
    if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

    let b = {};
    try { b = await req.json(); } catch (_) {}
    const type = String(b.type || 'other').slice(0, 20);
    const text = String(b.text || '').slice(0, 4000).trim();
    if (!text) return json({ ok: false, error: 'empty' }, 400);

    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const key = env.RESEND_API_KEY;
    const to = env.FEEDBACK_EMAIL_TO;
    if (!key || !to) {
        // No email configured — Firestore copy on the client is the system of record.
        return json({ ok: false, reason: 'email_not_configured' });
    }

    const subject = 'WealthFlow feedback [' + type + '] v' + (b.version || '?');
    const body =
        'Type: ' + type + '\n' +
        'Version: ' + (b.version || '?') + '\n' +
        'When: ' + (b.createdAt || new Date().toISOString()) + '\n' +
        'Device: ' + (b.ua || 'n/a') + '\n' +
        'Screen: ' + (b.screen || 'n/a') + ' · Lang: ' + (b.lang || 'n/a') + '\n' +
        '\n----- MESSAGE -----\n' + text + '\n';

    try {
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                from: env.FEEDBACK_EMAIL_FROM || 'WealthFlow <onboarding@resend.dev>',
                to: [to],
                subject,
                text: body
            })
        });
        if (!r.ok) return json({ ok: false, reason: 'send_failed', status: r.status });
        return json({ ok: true });
    } catch (e) {
        return json({ ok: false, reason: 'exception' });
    }
}
