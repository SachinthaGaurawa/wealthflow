// ============================================================================
//  WealthFlow · Unified API Router  (api/router.js)            v7.24.2
// ----------------------------------------------------------------------------
//  WHY THIS EXISTS — the fix for "all AI / all /api endpoints are down".
//
//  Every server file (feedback-triage.js, health.js, version.js, …) lives at
//  the REPO ROOT, not inside /api. Vercel's zero-config only turns files INSIDE
//  /api into Serverless Functions, so none of the root files were ever deployed
//  as functions — a POST to such a path fell through to the SPA rewrite and hit
//  index.html, and a POST to a static HTML file is answered "405 Method Not
//  Allowed". On top of that, 33 separate functions would blow past the Hobby
//  plan's 12-function limit and make the whole build fail.
//
//  This ONE function solves both problems at once:
//    • It is the SINGLE extra function Vercel builds (safe on every plan).
//    • It lazily imports the matching handler by path and delegates to it.
//    • Imports use static string literals, so Vercel bundles every handler.
//    • OPTIONS pre-flight is answered instantly (the client probes endpoints
//      with OPTIONS before using them) and errors are ALWAYS JSON.
//
//  WHY THE FILE IS NAMED router.js AND NOT [...path].js
//  ----------------------------------------------------------------------------
//  It WAS named api/[...path].js, relying on Vercel's catch-all filesystem
//  route to receive every unmatched /api/* request. It never received one.
//  On this project, `GET /api/health` returned the 1,574,601-character
//  index.html, and six hours of production runtime logs contained exactly one
//  path — /api/ai — which is served by its own real file at api/ai.js. Not a
//  single invocation of the catch-all, ever. So every endpoint that lives at
//  the repo root (feedback-triage, feedback, health, feedback-status, version,
//  market-data, …) has been dead since this file was written, and the 405 the
//  header above describes as FIXED was never actually fixed — the file that
//  claimed to fix it was itself unreachable.
//
//  The routing now does not depend on how a bracketed filename is interpreted.
//  vercel.json rewrites /api/(.*) to /api/router?path=$1 EXPLICITLY, and this
//  is an ordinary filename that cannot be misread. Rewrites are evaluated after
//  the filesystem, so /api/ai, /api/vision, /api/vision-scan and /api/verify
//  still go straight to their own files in this directory and never reach here.
//
//  There is a test that pins the rewrite to a file that exists — the failure
//  above was a routing assumption nothing verified, which is the same shape as
//  every other "machinery present, signal absent" bug in this repo.
// ============================================================================

export const config = { maxDuration: 60 }; // Hobby max; covers deep multi-engine AI

// Static import map → Vercel bundles each handler; lazy so only the matched
// module's top-level code runs per request (one bad module can't break others).
const HANDLERS = {
    'adobe-pdf-share': () => import('../adobe-pdf-share.js'),
    // ai.js and vision-scan.js live in THIS directory, not at the repo root, so
    // '../' pointed at nothing. Both are served by their own real files before a
    // request could ever reach here, which is the only reason a broken import was
    // never noticed — it was unreachable code inside an unreachable file.
    'ai': () => import('./ai.js'),
    // Server-side multi-image vision. Exists so the browser never holds a
    // provider key — it previously shipped two Gemini keys and one Groq key.
    'ai-vision': () => import('../ai-vision.js'),
    'approve-release': () => import('../approve-release.js'),
    'autonomous-brain': () => import('../autonomous-brain.js'),
    // Reports whether the autonomous update system can actually fix anything, so
    // the app can stop showing "All systems operational" while the pipeline is dead.
    'autonomy-status': () => import('../autonomy-status.js'),
    'classify-charge': () => import('../classify-charge.js'),
    'edenai': () => import('../edenai.js'),
    'feedback': () => import('../feedback.js'),
    'feedback-triage': () => import('../feedback-triage.js'),
    // The return path: tells the app when a piece of feedback has actually been
    // fixed and shipped, so the user is no longer reporting into a void.
    'feedback-status': () => import('../feedback-status.js'),
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
    'vision-scan': () => import('./vision-scan.js'),
    'vision-sms': () => import('../vision-sms.js'),
};

function setCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Max-Age', '86400');
}


// This function's own filename. The rewrite sends /api/anything here as
// /api/router?path=anything, so the URL fallback below sees "router" in the
// path — and would answer every request with "no /api/router endpoint" if it
// ever won. It cannot win while ?path= is present, but a rewrite that loses the
// query string would turn a routing bug into a wall of confident 404s, so the
// name is excluded explicitly rather than left to ordering.
const SELF = 'router';

function resolveName(req) {
    var seg = req && req.query && req.query.path;
    if (Array.isArray(seg) && seg.length) return String(seg[0]).toLowerCase();
    if (typeof seg === 'string' && seg) return seg.split('/')[0].toLowerCase();
    try {
        var path = (req.url || '').split('?')[0];
        var m = path.match(/\/api\/([^\/?]+)/);
        if (m) {
            var name = decodeURIComponent(m[1]).toLowerCase();
            if (name !== SELF) return name;
        }
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
        return res.status(404).json({
            error: 'Unknown endpoint', endpoint: name,
            reason: 'this deployment has no /api/' + name + ' endpoint.',
        });
    }

    try {
        var mod;
        try {
            mod = await load();
        } catch (importErr) {
            console.error(`[api-router] Module import missing for ${name}:`, importErr);
            return res.status(500).json({
                error: 'Endpoint file not bundled by Vercel', endpoint: name, detail: importErr.message,
                reason: 'the ' + name + ' endpoint was not included in this build.',
            });
        }

        var fn = mod && (mod.default || mod.handler || mod);
        if (typeof fn !== 'function') {
            return res.status(500).json({
                error: 'Endpoint has no valid export handler', endpoint: name,
                reason: 'the ' + name + ' endpoint is deployed but exports no handler.',
            });
        }

        return await fn(req, res);
    } catch (err) {
        console.error('[api-router] ' + name + ' failed:', err && err.stack || err);
        if (!res.headersSent) {
            res.status(500).json({
                error: 'Endpoint runtime crash', endpoint: name, detail: String(err && err.message || err),
                reason: 'the ' + name + ' endpoint crashed while handling the request.',
            });
        }
    }
}

