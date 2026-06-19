// ============================================================================
//  WealthFlow · Unified API Router  (api/[...path].js)        v7.24.0
// ----------------------------------------------------------------------------
//  WHY THIS EXISTS — the fix for "all AI / all /api endpoints are down".
//
//  Every server file (ai.js, vision.js, vision-scan.js, …) lives at the REPO
//  ROOT, not inside /api. Vercel's zero-config only turns files INSIDE /api
//  into Serverless Functions, so none of the root files were ever deployed as
//  functions — a POST to /api/ai fell through to the SPA catch-all and came
//  back as a static "405 / non-JSON" page. On top of that, 29 separate
//  functions would blow past the Hobby plan's 12-function limit and make the
//  whole build fail.
//
//  This ONE catch-all function solves both problems at once:
//    • It is the SINGLE function Vercel builds (1 ≪ 12 — safe on every plan).
//    • It lazily imports the matching root handler by path and delegates to it,
//      so /api/ai, /api/vision, /api/vision-scan … all work unchanged.
//    • Imports use static string literals, so Vercel bundles every handler.
//    • OPTIONS pre-flight is answered instantly (the client probes endpoints
//      with OPTIONS before using them) and errors are ALWAYS JSON — never a
//      stray HTML 405 again.
// ============================================================================

export const config = { maxDuration: 60 }; // Hobby max; covers deep multi-engine AI

// Static import map → Vercel bundles each handler; lazy so only the matched
// module's top-level code runs per request (one bad module can't break others).
const HANDLERS = {
    'adobe-pdf-share': () => import('../adobe-pdf-share.js'),
    'ai': () => import('../ai.js'),
    'approve-release': () => import('../approve-release.js'),
    'autonomous-brain': () => import('../autonomous-brain.js'),
    'edenai': () => import('../edenai.js'),
    'feedback': () => import('../feedback.js'),
    'feedback-triage': () => import('../feedback-triage.js'),
    'fifo-reconcile': () => import('../fifo-reconcile.js'),
    'fx-rate': () => import('../fx-rate.js'),
    'health': () => import('../health.js'),
    'inbox-ack': () => import('../inbox-ack.js'),
    'inbox-pull': () => import('../inbox-pull.js'),
    'inbox-push': () => import('../inbox-push.js'),
    'ios-shortcut': () => import('../ios-shortcut.js'),
    'market-data': () => import('../market-data.js'),
    'merchant-search': () => import('../merchant-search.js'),
    'predict-wealth': () => import('../predict-wealth.js'),
    'release-brain': () => import('../release-brain.js'),
    'send-otp': () => import('../send-otp.js'),
    'share-upload': () => import('../share-upload.js'),
    'shorten': () => import('../shorten.js'),
    'sms-ingest': () => import('../sms-ingest.js'),
    'statement-store': () => import('../statement-store.js'),
    'statement-view': () => import('../statement-view.js'),
    'verify-otp': () => import('../verify-otp.js'),
    'version': () => import('../version.js'),
    'vision': () => import('../vision.js'),
    'vision-scan': () => import('../vision-scan.js'),
    'vision-sms': () => import('../vision-sms.js'),
};

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
}


function resolveName(req) {
    var seg = req && req.query && req.query.path;
    if (Array.isArray(seg) && seg.length) return String(seg[0]).toLowerCase();
    if (typeof seg === 'string' && seg) return seg.split('/')[0].toLowerCase();
    try {
        var path = (req.url || '').split('?')[0];                 
        var m = path.match(/\/api\/([^\/?]+)/);
        if (m) return decodeURIComponent(m[1]).toLowerCase();
    } catch (_) {}
    return '';
}

export default async function handler(req, res) {
    setCors(res);
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }

    var name = resolveName(req);
    if (!name || name === 'index') {
        return res.status(200).json({ ok: true, service: 'wealthflow-api', router: 'v7.24.1', endpoints: Object.keys(HANDLERS).length });
    }

    var load = HANDLERS[name];
    if (!load) {
        return res.status(404).json({ error: 'Unknown endpoint', endpoint: name });
    }

    try {
        var mod;
        try {
            mod = await load();
        } catch (importErr) {
            console.error(`[api-router] Module import missing for ${name}:`, importErr);
            return res.status(500).json({ error: 'Endpoint file not bundled by Vercel', endpoint: name, detail: importErr.message });
        }

        var fn = mod && (mod.default || mod.handler || mod);
        if (typeof fn !== 'function') {
            return res.status(500).json({ error: 'Endpoint has no valid export handler', endpoint: name });
        }
        
        return await fn(req, res);
    } catch (err) {
        console.error('[api-router] ' + name + ' failed:', err && err.stack || err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Endpoint runtime crash', endpoint: name, detail: String(err && err.message || err) });
        }
    }
}

