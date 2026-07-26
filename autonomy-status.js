/*  autonomy-status.js  →  GET /api/autonomy-status
 *  ---------------------------------------------------------------------------
 *  Lets the APP tell the user the truth about its own update system.
 *
 *  Until now the only signal the user had was a version pill that read
 *  "v7.69.12 ✓ — All systems operational". It said that while the autonomous
 *  agent had been crashing on startup every two hours for months, and while ten
 *  of the version bumps behind that number contained no functional change at
 *  all. The pill was not lying on purpose; it simply had nothing real to read.
 *
 *  This endpoint is the real signal. It reports:
 *    • whether the pipeline could actually fix a bug right now,
 *    • how many model providers are reachable,
 *    • when the app last genuinely changed (not merely got a new number),
 *    • how many recent version bumps were empty.
 *
 *  The client shows a warning instead of a green tick when this says broken, so
 *  a silent failure becomes visible in the one place the user actually looks.
 *
 *  Cheap: pure local inspection, no outbound calls, no secrets echoed. Safe to
 *  poll. `?full=1` includes the per-check detail for the diagnostics panel.
 */

import { runChecks } from './autonomy/self-check.mjs';

function send(res, body, status = 200) {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
        'Access-Control-Allow-Origin': '*',
    };
    try {
        if (res && res.status) {
            if (res.setHeader) Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
            res.status(status).json(body);
            return;
        }
    } catch { /* fall through to the Response form */ }
    return new Response(JSON.stringify(body), { status, headers });
}

export default async function handler(req, res) {
    let full = false;
    try {
        const url = String((req && req.url) || '');
        full = /[?&]full=1/.test(url);
    } catch { /* ignore */ }

    let r;
    try {
        r = runChecks();
    } catch (e) {
        // Even the self-check failing is information the user deserves.
        return send(res, {
            ok: false,
            overall: 'unknown',
            canActuallyFixBugs: false,
            headline: 'Update system status could not be determined.',
            error: String((e && e.message) || e).slice(0, 300),
            checkedAt: new Date().toISOString(),
        }, 200);
    }

    const models = r.checks.find((c) => c.id === 'models');
    const lastChange = r.checks.find((c) => c.id === 'last-real-change');
    const days = lastChange?.data?.daysSinceRealChange ?? null;
    const fakes = lastChange?.data?.fakeReleasesInRecentHistory ?? 0;

    // One short sentence the UI can show verbatim. No jargon, no false comfort.
    const headline = r.overall === 'healthy'
        ? 'Automatic updates are working. Reported problems get fixed and shipped without you doing anything.'
        : r.overall === 'degraded'
            ? 'Automatic updates are working, but running below full strength.'
            : 'Automatic updates are NOT working right now. Your reports are being saved, but nothing is being fixed automatically.';

    const body = {
        ok: r.overall !== 'broken',
        overall: r.overall,                       // healthy | degraded | broken
        canActuallyFixBugs: r.canActuallyFixBugs,
        headline,
        verdict: r.verdict,
        version: lastChange?.data?.version || null,
        providers: models?.data?.count ?? 0,
        lastRealChange: lastChange?.data?.lastReal
            ? { at: lastChange.data.lastReal.at, summary: lastChange.data.lastReal.subject, daysAgo: days }
            : null,
        emptyVersionBumpsRecently: fakes,
        counts: r.counts,
        checkedAt: r.checkedAt,
    };

    if (full) {
        body.checks = r.checks.map((c) => ({
            id: c.id, status: c.status, summary: c.summary, detail: c.detail,
        }));
    }

    return send(res, body, 200);
}
