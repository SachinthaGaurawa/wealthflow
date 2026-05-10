// ==================== WealthFlow → Adobe PDF Services Bridge ====================
// Implements the 3 server-side steps of the Adobe Acrobat Services flow that the
// browser cannot perform directly (CORS-blocked):
//
//   action=token        → POST https://pdf-services.adobe.io/token
//   action=getAsset     → POST https://pdf-services.adobe.io/assets
//   action=getDownload  → GET  https://pdf-services.adobe.io/assets/{assetID}
//
// The actual PUT of the PDF bytes happens directly from the browser to the S3
// pre-signed `uploadUri` returned by getAsset (S3 allows CORS PUT for unsigned-payload
// signatures). This avoids streaming the PDF through Vercel's serverless body limit.
//
// REQUIRED ENV VARS (set in Vercel dashboard):
//   ADOBE_CLIENT_ID
//   ADOBE_CLIENT_SECRET
//
// If either is missing the endpoint returns 503 with a clear message and the frontend
// hides the "Get shareable link" feature — the existing print/Web-Share path keeps working.

export const config = {
    maxDuration: 30
};

async function fetchWithTimeout(url, options, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export default async function handler(req, res) {
    // CORS — same pattern as the rest of the app's API routes
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const clientId = process.env.ADOBE_CLIENT_ID;
    const clientSecret = process.env.ADOBE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        return res.status(503).json({
            error: 'Adobe PDF Services not configured',
            details: 'Set ADOBE_CLIENT_ID and ADOBE_CLIENT_SECRET environment variables in Vercel to enable shareable PDF links. The local Print / Save PDF and Web Share features continue to work without this.',
            configured: false
        });
    }

    const { action, accessToken, assetID } = req.body || {};
    if (!action) return res.status(400).json({ error: 'Missing "action" field' });

    try {
        // ---------- ACTION 1: Get an OAuth access token ----------
        // Adobe's OAuth Server-to-Server endpoint. The token is valid for 24 hours.
        // We don't cache it server-side here (each browser request gets a fresh one)
        // so the function stays stateless and Vercel-free-tier-friendly.
        if (action === 'token') {
            const body = new URLSearchParams();
            body.append('client_id', clientId);
            body.append('client_secret', clientSecret);

            const tokenResp = await fetchWithTimeout('https://pdf-services.adobe.io/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: body.toString()
            });

            if (!tokenResp.ok) {
                const errText = await tokenResp.text().catch(() => '');
                console.error('[Adobe token] status', tokenResp.status, errText.slice(0, 300));
                return res.status(502).json({
                    error: 'Adobe authentication failed',
                    status: tokenResp.status,
                    details: errText.slice(0, 300)
                });
            }
            const data = await tokenResp.json();
            // data: { access_token, token_type, expires_in }
            return res.status(200).json({
                accessToken: data.access_token,
                expiresIn: data.expires_in,
                tokenType: data.token_type
            });
        }

        // ---------- ACTION 2: Request a pre-signed upload URI + assetID ----------
        // The browser will PUT directly to uploadUri. assetID is the handle we use for
        // the subsequent download-URI lookup.
        if (action === 'getAsset') {
            if (!accessToken) return res.status(400).json({ error: 'Missing accessToken for getAsset' });

            const assetResp = await fetchWithTimeout('https://pdf-services.adobe.io/assets', {
                method: 'POST',
                headers: {
                    'X-API-Key': clientId,
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ mediaType: 'application/pdf' })
            });

            if (!assetResp.ok) {
                const errText = await assetResp.text().catch(() => '');
                console.error('[Adobe getAsset] status', assetResp.status, errText.slice(0, 300));
                return res.status(502).json({
                    error: 'Could not allocate Adobe asset',
                    status: assetResp.status,
                    details: errText.slice(0, 300)
                });
            }
            const data = await assetResp.json();
            // data: { uploadUri, assetID }
            return res.status(200).json({
                uploadUri: data.uploadUri,
                assetID: data.assetID
            });
        }

        // ---------- ACTION 3: Get a pre-signed download URI for an uploaded asset ----------
        // After the browser PUTs the PDF to uploadUri, we ask Adobe for a download URL
        // that anyone with the link can use (no auth) — valid for ~24 hours per Adobe.
        // Endpoint: GET /assets/{assetID}  →  { downloadUri }
        if (action === 'getDownload') {
            if (!accessToken) return res.status(400).json({ error: 'Missing accessToken for getDownload' });
            if (!assetID) return res.status(400).json({ error: 'Missing assetID for getDownload' });

            const dlResp = await fetchWithTimeout(`https://pdf-services.adobe.io/assets/${encodeURIComponent(assetID)}`, {
                method: 'GET',
                headers: {
                    'X-API-Key': clientId,
                    'Authorization': `Bearer ${accessToken}`
                }
            });

            if (!dlResp.ok) {
                const errText = await dlResp.text().catch(() => '');
                console.error('[Adobe getDownload] status', dlResp.status, errText.slice(0, 300));
                return res.status(502).json({
                    error: 'Could not retrieve Adobe download URI',
                    status: dlResp.status,
                    details: errText.slice(0, 300)
                });
            }
            const data = await dlResp.json();
            // Adobe returns the download pre-signed URL in `downloadUri`.
            // The URL is opaque (long S3 signed URL) and expires after 24h.
            return res.status(200).json({
                downloadUri: data.downloadUri,
                // Adobe doesn't return an explicit expiry — S3's X-Amz-Expires defaults to ~24h
                expiresInHours: 24
            });
        }

        return res.status(400).json({ error: 'Unknown action: ' + action });
    } catch (e) {
        console.error('[adobe-pdf-share]', e);
        return res.status(500).json({ error: 'Internal error', details: e.message });
    }
}
