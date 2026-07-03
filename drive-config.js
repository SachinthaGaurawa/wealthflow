/*  drive-config.js  →  GET /api/drive-config
 *  ---------------------------------------------------------------------------
 *  Serves NON-SECRET, browser-safe Google Picker configuration to the client.
 *
 *  WHY THIS EXISTS
 *  The Google Picker needs an App ID (the Cloud project number) and, OPTIONALLY,
 *  a developer key (a *browser* API key). As of 2025+ the developer key is
 *  optional when an OAuth token is supplied, so WealthFlow runs the Picker
 *  token-only by default. If you want the extra API-key quota tracking (or a
 *  specific enterprise config requires it), create a DEDICATED browser API key
 *  in the SAME Cloud project as your OAuth client (1020193373377), restrict it
 *  by HTTP referrer to your domain(s), enable ONLY "Google Picker API" and
 *  "Google Drive API" on it, then set it as the GOOGLE_PICKER_KEY env var in
 *  Vercel. This endpoint will hand it to the client and the Picker will use it.
 *
 *  SECURITY
 *  This endpoint NEVER returns WealthFlow_API_Key (the server-side Gemini/Vision
 *  billing key) or any secret. A Picker developer key is inherently public (it
 *  is embedded in the client page); its protection is HTTP-referrer restriction,
 *  not secrecy. If GOOGLE_PICKER_KEY is unset, developerKey comes back "" and the
 *  client runs the Picker token-only — which is the recommended, zero-exposure
 *  path.
 *
 *  ENV (optional):
 *    GOOGLE_PICKER_KEY   – dedicated, referrer-restricted browser key (optional)
 *    GOOGLE_PICKER_APP_ID / GOOGLE_OAUTH_PROJECT_NUMBER – override the App ID
 * ---------------------------------------------------------------------------
 */

export default function handler(req, res) {
    // Read-only config probe — GET/HEAD only.
    const method = (req && req.method) || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
        try { res.setHeader('Allow', 'GET, HEAD'); } catch (_) {}
        return res.status(405).json({ ok: false, error: 'method not allowed' });
    }

    // Never let a CDN cache a per-deploy config value.
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } catch (_) {}

    const appId =
        process.env.GOOGLE_PICKER_APP_ID ||
        process.env.GOOGLE_OAUTH_PROJECT_NUMBER ||
        '1020193373377';

    // Optional dedicated browser Picker key. NOT the Gemini/Vision key.
    const developerKey = (process.env.GOOGLE_PICKER_KEY || '').trim();

    return res.status(200).json({
        ok: true,
        appId: String(appId),
        developerKey,                 // "" ⇒ client runs the Picker token-only
        tokenOnly: developerKey === '',
        scope: 'https://www.googleapis.com/auth/drive.file'
    });
}
