/*  health.js  →  GET /api/health   (Phase 0 — the rollback signal)
 *
 *  A lightweight, no-cache health probe. Uptime monitors (e.g. the free tiers of
 *  UptimeRobot / Better Uptime / Sentry Crons) hit this; if it stops returning 200
 *  or reports degraded, that's your trigger to roll back the last deploy.
 *
 *  Returns 200 {ok:true,...} when healthy, 503 {ok:false,...} when a check fails.
 *  The Firestore check is best-effort and time-boxed so the probe stays fast and
 *  never hangs (a slow dependency must not make health itself slow).
 *
 *  ENV (all optional): WF_VERSION (else read from version.json), FIREBASE_SERVICE_ACCOUNT.
 */

import fs from 'node:fs';

function readVersion() {
    if (process.env.WF_VERSION) return process.env.WF_VERSION;
    try {
        const raw = fs.readFileSync(new URL('./version.json', import.meta.url), 'utf8');
        const j = JSON.parse(raw);
        return j.latest || 'unknown';
    } catch (_) { return 'unknown'; }
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
    ]);
}

// best-effort Firestore reachability — never throws, never hangs
async function checkFirestore() {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) return { skipped: true };
    try {
        const admin = (await import('firebase-admin')).default;
        if (!admin.apps.length) {
            admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        }
        await withTimeout(admin.firestore().collection('system').doc('manifest').get(), 2500);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

export default async function handler(req, res) {
    const body = {
        ok: true,
        service: 'wealthflow',
        version: readVersion(),
        time: new Date().toISOString(),
        checks: {}
    };

    const fsCheck = await checkFirestore();
    body.checks.firestore = fsCheck;
    if (fsCheck.ok === false) body.ok = false;   // a failed (non-skipped) check = degraded

    const code = body.ok ? 200 : 503;
    return send(res, body, code);
}

function send(res, obj, code) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0' };
    try {
        if (res && res.status) {
            res.setHeader && Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
            res.status(code).json(obj);
            return;
        }
    } catch (_) {}
    return new Response(JSON.stringify(obj), { status: code, headers });
}
