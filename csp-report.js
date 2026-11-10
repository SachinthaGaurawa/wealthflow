/*  csp-report.js  →  POST /api/csp-report
 *  ---------------------------------------------------------------------------
 *  Where a browser says "I refused to load / run something because of the Content-Security-Policy".
 *
 *  WHY IT EXISTS. vercel.json now sends a Content-Security-Policy for the whole app. A policy written from reading the
 *  code can still miss a host that only one rare screen uses; with enforcement and no reporting, that screen would break
 *  for a real person and nobody would know. Each refusal arrives here and becomes one `[WF-CSP]` log line, which the
 *  daily health check reads like every other `[WF-…]` marker, so a missed host is found by the system and not by a user.
 *
 *  WHAT IT WILL NOT DO. It stores nothing, answers nothing but 204, and logs only the DIRECTIVE and the origin + path of
 *  the blocked address — never a query string (it can carry a token), never the page's own query, never the sample text of
 *  an inline script (it can carry money figures). Every logged value is reduced to a short safe alphabet first, so a hostile
 *  report cannot forge a log line. At most LOG_PER_MINUTE lines per minute leave one instance; the rest are counted.
 */

const MAX_BODY = 8 * 1024;
export const LOG_PER_MINUTE = 20;

let windowStart = 0;
let logged = 0;
let dropped = 0;

/** Keep a short, log-safe slice of a value: no whitespace, no control characters, no query or fragment. */
export function safe(value, max = 120) {
    let s = String(value == null ? '' : value);
    s = s.split(/[?#]/)[0];
    s = s.replace(/[^A-Za-z0-9:/._@+*=-]/g, '').slice(0, max);
    return s || '-';
}

/** The fields worth keeping from either report format (report-uri and Reporting API), as one record. */
export function readReport(body) {
    let r = body;
    if (Array.isArray(r)) r = r.find((x) => x && (x.type === 'csp-violation' || x.body)) || r[0];
    if (r && r['csp-report']) r = r['csp-report'];
    else if (r && r.body && typeof r.body === 'object') r = r.body;
    if (!r || typeof r !== 'object') return null;
    const directive = r['effective-directive'] || r.effectiveDirective || r['violated-directive'] || r.violatedDirective || '';
    const blocked = r['blocked-uri'] || r.blockedURL || r.blockedUri || '';
    const doc = r['document-uri'] || r.documentURL || r.documentUri || '';
    if (!directive && !blocked) return null;
    let docPath = '-';
    try { docPath = new URL(String(doc)).pathname; } catch (_) { docPath = safe(doc, 60); }
    return { directive: safe(directive, 40), blocked: safe(blocked), doc: safe(docPath, 60) };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).end(); }
    let body = req.body;
    try {
        if (typeof body === 'string') body = body.length > MAX_BODY ? null : JSON.parse(body);
        else if (Buffer.isBuffer(body)) body = body.length > MAX_BODY ? null : JSON.parse(body.toString('utf8'));
        else if (body && JSON.stringify(body).length > MAX_BODY) body = null;
    } catch (_) { body = null; }

    const rec = readReport(body);
    if (rec) {
        const now = Date.now();
        if (now - windowStart > 60_000) {
            if (dropped > 0) console.error('[WF-CSP] ' + dropped + ' more report(s) in the last minute were not logged');
            windowStart = now; logged = 0; dropped = 0;
        }
        if (logged < LOG_PER_MINUTE) {
            logged += 1;
            console.error('[WF-CSP] blocked ' + rec.directive + ' ' + rec.blocked + ' on ' + rec.doc);
        } else dropped += 1;
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(204).end();
}
