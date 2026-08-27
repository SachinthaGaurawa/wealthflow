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
    // GOOGLE DRIVE — both handlers have existed since 26 July and neither was
    // ever registered here, so every call the app made to them fell through to
    // the not-found path. That is why the health snapshot reads
    //   "drive": { "connected": false, "everGranted": true }
    // The consent popup is client-side and works, so the owner granted access;
    // the server-side code exchange at /api/drive-auth had nowhere to land, so
    // the connection could never complete. Drive backup has never worked once.
    //
    // Identical shape to the 405 bug in test/api_routing_test.js: a real handler
    // at the repo root that nothing dispatched to. test/api_contract_test.js now
    // fails if any client-called endpoint has no handler, or any root handler is
    // unreachable — this class cannot come back silently.
    'drive-auth': () => import('../drive-auth.js'),
    'drive-config': () => import('../drive-config.js'),
    'edenai': () => import('../edenai.js'),
    'feedback': () => import('../feedback.js'),
    'feedback-triage': () => import('../feedback-triage.js'),
    // The return path: tells the app when a piece of feedback has actually been
    // fixed and shipped, so the user is no longer reporting into a void.
    'feedback-status': () => import('../feedback-status.js'),
    'fifo-reconcile': () => import('../fifo-reconcile.js'),
    'fx-rate': () => import('../fx-rate.js'),
    // Gmail Pub/Sub push. Stores encrypted statement PDFs for the device to
    // open; holds no vault key and never decrypts. Verifies the push's OIDC
    // token before doing anything, because this URL is public.
    'gmail-hook': () => import('../gmail-hook.js'),
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

// ── Node ⇄ Web calling-convention bridge ─────────────────────────────────────
//  Vercel builds ONE function from this directory and it is a NODE function:
//  this file's default export is `handler(req, res)`, vercel.json gives it a
//  maxDuration, and setCors(res) on its first line would throw on every single
//  request if Vercel were passing a Web `Request` instead. /api/health and
//  /api/version answer correctly in production, so the invocation is
//  unambiguously Node's (req, res).
//
//  Twelve of the handlers in HANDLERS are nevertheless written against the Web
//  Fetch API — `req.headers.get()`, `await req.json()`, `new URL(req.url)`,
//  `return new Response(...)` — because each declares
//  `export const config = { runtime: 'edge' }` at the top of its own file.
//  THAT EXPORT IS DEAD METADATA. Vercel reads `config` only from files it builds
//  as functions, and these live at the repo root, which is the entire reason
//  this router exists. The declaration was never honoured and nothing said so.
//
//  What the mismatch actually did, measured by driving every route through this
//  file with a faithful Node req/res rather than assumed:
//    · inbox-push / inbox-pull / inbox-ack → 500, `res is not defined`
//    · ios-shortcut                        → 500, `Invalid URL`
//    · the other eight                     → NO ANSWER AT ALL. The handler built
//      a Response and returned it; `return await fn(req, res)` handed that value
//      to Vercel's Node launcher, which ignores a return value and waits for
//      `res` to be written. Nothing ever wrote it, so the request sat until
//      maxDuration and died as FUNCTION_INVOCATION_TIMEOUT — sixty seconds of
//      silence for a handler that had computed the right answer in milliseconds.
//
//  Same family as every other defect in this repo's history: the machinery was
//  all present and correct, and the JOIN between two halves was asserted by
//  nobody. test/api_contract_test.js checked that every route EXISTS; it could
//  not see that the two sides disagreed about how to call each other.
//
//  The discriminator is the handler's own arity, which is how Vercel itself
//  tells the conventions apart: `handler(req, res)` is Node, `handler(req)` is
//  Web. Arity-2 handlers are passed the untouched Node objects, so the 21
//  endpoints that already worked are bit-for-bit unaffected by this bridge.

/** `handler(req)` is a Web handler; `handler(req, res)` is a Node one. */
function isWebHandler(fn) { return fn.length < 2; }

function firstHeader(v) {
    if (Array.isArray(v)) return v.length ? String(v[0]) : '';
    return (v === undefined || v === null) ? '' : String(v);
}

/* Headers that a re-serialised body would make wrong, or that describe the hop
 * rather than the message. content-length matters most: Vercel may hand us an
 * already-parsed req.body, and JSON.stringify of it need not be the same byte
 * length the client sent — passing the stale value through truncates the body. */
const DROP_REQUEST_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'keep-alive']);

function webHeaders(nodeHeaders) {
    const h = new Headers();
    for (const k of Object.keys(nodeHeaders || {})) {
        if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
        const v = nodeHeaders[k];
        for (const one of (Array.isArray(v) ? v : [v])) {
            if (one === undefined || one === null) continue;
            // A header name Headers refuses is not worth failing the request over.
            try { h.append(k, String(one)); } catch (_) {}
        }
    }
    return h;
}

/** The URL the CLIENT asked for, absolute — not the rewritten /api/router one.
 *  sms-ingest and autonomous-brain build sibling calls from `new URL(req.url)
 *  .origin`, and inbox-pull reads searchParams, so both the origin and the
 *  client's own query string have to survive the rewrite. */
function clientUrl(req, name) {
    const proto = firstHeader(req.headers['x-forwarded-proto']).split(',')[0].trim() || 'https';
    const host = (firstHeader(req.headers['x-forwarded-host'])
        || firstHeader(req.headers.host)).split(',')[0].trim();
    let url;
    try { url = new URL('/api/' + name, proto + '://' + (host || 'localhost')); }
    catch (_) { url = new URL('/api/' + name, 'https://localhost'); }
    const raw = String(req.url || '');
    const q = raw.indexOf('?');
    if (q >= 0) {
        for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) {
            if (k !== SELF_QUERY_KEY) url.searchParams.append(k, v);
        }
    }
    // Vercel also exposes the merged query as req.query; fold in anything the
    // raw URL did not already carry rather than trusting one source alone.
    const parsed = (req.query && typeof req.query === 'object') ? req.query : {};
    for (const k of Object.keys(parsed)) {
        if (k === SELF_QUERY_KEY || url.searchParams.has(k)) continue;
        for (const v of (Array.isArray(parsed[k]) ? parsed[k] : [parsed[k]])) {
            url.searchParams.append(k, String(v));
        }
    }
    return url.toString();
}

/** The request body as text, whatever Vercel already did to it. */
async function rawBody(req) {
    const b = req.body;
    if (typeof b === 'string') return b;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(b)) return b.toString('utf8');
    if (b !== undefined && b !== null) return JSON.stringify(b);   // Vercel parsed it for us
    if (typeof req[Symbol.asyncIterator] !== 'function') return '';
    const chunks = [];
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks).toString('utf8');
}

/** A REAL Web Request built from the Node one — not a hand-rolled shim, so
 *  `.json()`, `.text()`, `.formData()` and `.headers.get()` all behave exactly
 *  as the handler expects. That includes THROWING on a malformed body: every one
 *  of these handlers wraps `await req.json()` in a try/catch to answer 400, and
 *  a shim that swallowed the parse error would turn a bad request into a
 *  confidently wrong success. */
async function toWebRequest(req, name) {
    const method = String(req.method || 'GET').toUpperCase();
    const init = { method, headers: webHeaders(req.headers) };
    if (method !== 'GET' && method !== 'HEAD') init.body = await rawBody(req);
    return new Request(clientUrl(req, name), init);
}

function isWebResponse(v) {
    if (!v || typeof v !== 'object') return false;
    if (typeof Response === 'function' && v instanceof Response) return true;
    // Duck-typed fallback so a Response from a different realm still routes.
    return typeof v.status === 'number' && !!v.headers
        && typeof v.headers.forEach === 'function' && typeof v.arrayBuffer === 'function';
}

/** Write a Web Response into the Node response. */
async function sendWebResponse(webRes, res) {
    const body = Buffer.from(await webRes.arrayBuffer());
    const cookies = typeof webRes.headers.getSetCookie === 'function' ? webRes.headers.getSetCookie() : [];
    webRes.headers.forEach((value, key) => {
        const k = String(key).toLowerCase();
        // content-length is recomputed from the buffer; content-encoding would
        // claim the body is still compressed after arrayBuffer() decoded it;
        // set-cookie is handled separately because forEach comma-joins it, which
        // is invalid for cookies.
        if (k === 'content-length' || k === 'content-encoding' || k === 'set-cookie') return;
        try { res.setHeader(key, value); } catch (_) {}
    });
    if (cookies.length) { try { res.setHeader('Set-Cookie', cookies); } catch (_) {} }
    res.status(webRes.status);
    res.end(body);
}


// This function's own filename. The rewrite sends /api/anything here as
// /api/router?path=anything, so the URL fallback below sees "router" in the
// path — and would answer every request with "no /api/router endpoint" if it
// ever won. It cannot win while ?path= is present, but a rewrite that loses the
// query string would turn a routing bug into a wall of confident 404s, so the
// name is excluded explicitly rather than left to ordering.
const SELF = 'router';

// The query key vercel.json's rewrite uses to carry the requested endpoint
// (`/api/(.*)` → `/api/router?path=$1`). Named once because clientUrl() has to
// strip exactly this key back out when it rebuilds the URL the client asked for
// — leaving it in would hand handlers a phantom `?path=` they never sent.
const SELF_QUERY_KEY = 'path';

function resolveName(req) {
    var seg = req && req.query && req.query[SELF_QUERY_KEY];
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

        var answered = function () { return !!(res.writableEnded || res.headersSent); };

        var out = isWebHandler(fn)
            ? await fn(await toWebRequest(req, name))
            : await fn(req, res);

        if (isWebResponse(out)) {
            if (answered()) {
                // Both conventions used at once. The written response has already
                // gone out and a second one cannot be sent, so record the
                // ambiguity rather than dropping it in silence.
                console.error('[api-router] ' + name + ' wrote to res AND returned a Response; the Response was dropped.');
                return;
            }
            return await sendWebResponse(out, res);
        }

        if (!answered()) {
            // The exact failure this bridge exists to end: the handler came back
            // without answering, so the request would sit until maxDuration and
            // die as FUNCTION_INVOCATION_TIMEOUT with nothing anywhere saying why.
            // A 500 naming the endpoint is worse for nobody and readable by
            // everybody.
            console.error('[api-router] ' + name + ' returned without writing a response');
            return res.status(500).json({
                error: 'Endpoint produced no response', endpoint: name,
                reason: 'the ' + name + ' endpoint returned without answering the request.',
            });
        }
        return;
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

