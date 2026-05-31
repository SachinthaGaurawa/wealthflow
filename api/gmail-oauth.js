// =============================================================================
// WealthFlow Gmail OAuth Bridge v1.0
// -----------------------------------------------------------------------------
// Handles the Google OAuth dance so users can connect their Gmail account in
// one click. The client (wealthflow-email-sync.js) opens this endpoint with
// ?action=start which redirects to Google's consent screen. Google then
// redirects back to ?action=callback&code=... and we exchange the code for
// a refresh_token + access_token, which we return to the opener window via
// postMessage. The opener stores the refresh_token in the encrypted Vault.
//
// Env vars REQUIRED:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET
//   GOOGLE_OAUTH_REDIRECT_URI  (e.g. https://<your-app>.vercel.app/api/gmail-oauth?action=callback)
//
// Required scope:
//   https://www.googleapis.com/auth/gmail.readonly
// =============================================================================

export const config = { runtime: 'edge' };

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GOOGLE_AUTH  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';

function html(body, status = 200) {
    return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

function env(name) {
    try { return (process && process.env && process.env[name]) || ''; } catch { return ''; }
}

export default async function handler(req) {
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'start';

    const clientId     = env('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = env('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri  = env('GOOGLE_OAUTH_REDIRECT_URI') || `${url.origin}/api/gmail-oauth?action=callback`;

    if (!clientId || !clientSecret) {
        return html(`<!doctype html><meta charset="utf-8"><title>Setup needed</title>
<body style="font-family:system-ui;padding:30px;background:#0a0e1a;color:#e6e7eb;">
<h2 style="color:#f59e0b;">⚠ Server not configured</h2>
<p>Add <code>GOOGLE_OAUTH_CLIENT_ID</code> and <code>GOOGLE_OAUTH_CLIENT_SECRET</code> to your Vercel environment variables.</p>
<p>1. Visit <a style="color:#10b981" href="https://console.cloud.google.com/apis/credentials">Google Cloud Console → Credentials</a></p>
<p>2. Create an OAuth 2.0 Client ID (type: Web application)</p>
<p>3. Add redirect URI: <code>${redirectUri}</code></p>
<p>4. Enable the Gmail API for your project</p>
</body>`, 500);
    }

    // ───────── 1. START — redirect to Google consent screen ─────────
    if (action === 'start') {
        const state = url.searchParams.get('state') || crypto.randomUUID();
        const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: SCOPE,
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
            state
        });
        return Response.redirect(`${GOOGLE_AUTH}?${params}`, 302);
    }

    // ───────── 2. CALLBACK — exchange code for tokens ─────────
    if (action === 'callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state') || '';
        if (error) {
            return html(`<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui;padding:30px;background:#0a0e1a;color:#e6e7eb;text-align:center;">
<h2 style="color:#ef4444;">✗ Authorization cancelled</h2>
<p>${error}</p>
<p>You can close this window.</p>
<script>window.opener && window.opener.postMessage({type:'wf_gmail_oauth',ok:false,error:${JSON.stringify(error)}},'*');setTimeout(()=>window.close(),2000);</script>
</body>`);
        }
        if (!code) return html('<h2>Missing code</h2>', 400);

        try {
            const tokenRes = await fetch(GOOGLE_TOKEN, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    code, client_id: clientId, client_secret: clientSecret,
                    redirect_uri: redirectUri, grant_type: 'authorization_code'
                })
            });
            const tok = await tokenRes.json();
            if (!tokenRes.ok || !tok.access_token) {
                return html(`<h2>Token exchange failed</h2><pre>${JSON.stringify(tok, null, 2)}</pre>`, 400);
            }

            // Pull email address so the user can confirm "yes that's my account"
            let email = '';
            try {
                const me = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
                    headers: { Authorization: 'Bearer ' + tok.access_token }
                });
                if (me.ok) { const j = await me.json(); email = j.emailAddress || ''; }
            } catch (_) {}

            // Return the tokens to the OPENER window via postMessage.
            // The opener stores refresh_token in the encrypted Vault (local
            // storage AES-256-GCM) — we NEVER persist it server-side.
            const payload = {
                type: 'wf_gmail_oauth',
                ok: true,
                refresh_token: tok.refresh_token,
                access_token: tok.access_token,
                expires_in: tok.expires_in,
                token_type: tok.token_type,
                scope: tok.scope,
                email,
                state
            };
            return html(`<!doctype html><meta charset="utf-8">
<body style="font-family:system-ui;padding:40px;background:#0a0e1a;color:#e6e7eb;text-align:center;">
<h2 style="color:#10b981;">✓ Gmail connected</h2>
<p style="color:#94a3b8;">${email || ''}</p>
<p style="color:#94a3b8;font-size:13px;">Returning to WealthFlow…</p>
<script>
try{window.opener&&window.opener.postMessage(${JSON.stringify(payload)},'*');}catch(e){}
setTimeout(()=>{try{window.close();}catch(_){location.href='/';}},800);
</script>
</body>`);
        } catch (e) {
            return html('<h2>Error</h2><pre>' + (e && e.message) + '</pre>', 500);
        }
    }

    // ───────── 3. REFRESH — exchange refresh_token for new access_token ─────────
    if (action === 'refresh' && req.method === 'POST') {
        let body = {};
        try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
        if (!body.refresh_token) return json({ ok: false, error: 'refresh_token required' }, 400);
        try {
            const r = await fetch(GOOGLE_TOKEN, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: clientId, client_secret: clientSecret,
                    refresh_token: body.refresh_token, grant_type: 'refresh_token'
                })
            });
            const tok = await r.json();
            if (!r.ok || !tok.access_token) return json({ ok: false, error: tok.error || 'refresh failed', detail: tok }, 400);
            return json({ ok: true, access_token: tok.access_token, expires_in: tok.expires_in });
        } catch (e) {
            return json({ ok: false, error: String(e && e.message) }, 500);
        }
    }

    return html('<h2>Unknown action</h2>', 400);
}
