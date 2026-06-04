/*  version.js  →  GET /api/version   (PWA live-update signal — PDF Phase 5)
 *
 *  Returns the CURRENT production deployment's identity. The key field is `sha`,
 *  which Vercel sets automatically to the git commit of THIS deployment
 *  (VERCEL_GIT_COMMIT_SHA). Because it changes on every single deploy, the client
 *  can detect "a new version is live" with zero manual version bumping — fixing the
 *  root cause where version.json.latest was never updated so the app never saw an
 *  update. No-cache so every poll hits the live deployment.
 */

import fs from 'node:fs';

function appVersion() {
    try {
        const j = JSON.parse(fs.readFileSync(new URL('./version.json', import.meta.url), 'utf8'));
        return j.latest || 'unknown';
    } catch (_) { return 'unknown'; }
}

export default function handler(req, res) {
    const sha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || 'dev';
    const body = {
        sha: String(sha).slice(0, 12),     // short deploy hash — changes every deploy
        version: appVersion(),             // human version from version.json
        env: process.env.VERCEL_ENV || 'development',
        ts: new Date().toISOString()
    };
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0, must-revalidate' };
    try {
        if (res && res.status) {
            res.setHeader && Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
            res.status(200).json(body);
            return;
        }
    } catch (_) {}
    return new Response(JSON.stringify(body), { status: 200, headers });
}
