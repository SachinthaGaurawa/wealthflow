/*  feedback-triage.js  →  POST /api/feedback-triage   (Blueprint Phase 1)
 *
 *  Turns raw user feedback into a structured, actionable GitHub Issue automatically,
 *  so the autonomous pipeline can pick it up. Flow:
 *    user feedback text → EdenAI NLP classify (bug | ui | feature | other) + severity
 *                       → open a well-formatted GitHub Issue (labelled) via the
 *                         GitHub API, with a stable fingerprint to avoid duplicates.
 *
 *  ENV:
 *    EDENAI_API_KEY                 EdenAI (free tier) for classification
 *    GH_PAT / GITHUB_TOKEN /        token with `issues:write` on the repo
 *      GITHUB_MODELS_TOKEN          (any one)
 *    GITHUB_REPO or                 e.g. "SachinthaGaurawa/wealthflow"
 *      GITHUB_REPOSITORY
 *
 *  NOTE ON WHY THIS FILE MATTERED BUT DID NOTHING:
 *    This endpoint has existed all along and is the ONLY path by which user
 *    feedback becomes something the autonomous pipeline can act on — but no
 *    client code ever called it. Feedback went to Firestore plus an optional
 *    email and stopped there. wealthflow-update-system.js now POSTs here on
 *    every submission, and remembers the returned issue number so the app can
 *    report back when the work is finished (see /api/feedback-status).
 *
 *  Safety: input is length-capped and the model output is strictly parsed/validated
 *  (never trusted as code). If EdenAI is unavailable it falls back to a local
 *  keyword classifier so a feedback item is NEVER lost.
 */

const MAX_LEN = 2000;

const LABELS = { bug: 'bug', crash: 'bug', ui: 'ui/ux', feature: 'enhancement', security: 'security', other: 'triage' };

// local fallback classifier (used if EdenAI is unreachable) — keeps feedback flowing
function localClassify(text) {
    const t = (text || '').toLowerCase();
    if (/(leak|password|hack|breach|exposed|other user|privacy)/.test(t)) return { type: 'security', severity: 'critical' };
    if (/(crash|freeze|froze|white screen|black screen|stuck|won'?t open|broke)/.test(t)) return { type: 'crash', severity: 'critical' };
    if (/(bug|error|wrong|incorrect|fail|doesn'?t work|not working)/.test(t)) return { type: 'bug', severity: 'high' };
    if (/(slow|lag|ugly|confusing|hard to|unprofessional|kid|design|layout|color|font)/.test(t)) return { type: 'ui', severity: 'medium' };
    if (/(add|please|wish|would be|feature|option|support for|can you)/.test(t)) return { type: 'feature', severity: 'low' };
    return { type: 'other', severity: 'low' };
}

async function edenClassify(text) {
    const key = process.env.EDENAI_API_KEY;
    if (!key) return null;
    const prompt = [
        'Classify this app user feedback. Reply ONLY with compact JSON:',
        '{"type":"bug|crash|ui|feature|security|other","severity":"critical|high|medium|low","summary":"<=12 words"}',
        'Feedback: ' + text
    ].join('\n');
    try {
        const r = await fetch('https://api.edenai.run/v2/text/chat', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ providers: 'openai', text: prompt, temperature: 0, max_tokens: 120 })
        });
        if (!r.ok) return null;
        const data = await r.json();
        const out = data && (data.openai || Object.values(data)[0]);
        const raw = out && (out.generated_text || out.message || '');
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (!m) return null;
        const parsed = JSON.parse(m[0]);
        // strict validation — never trust the model blindly
        const types = ['bug', 'crash', 'ui', 'feature', 'security', 'other'];
        const sevs = ['critical', 'high', 'medium', 'low'];
        if (!types.includes(parsed.type) || !sevs.includes(parsed.severity)) return null;
        return { type: parsed.type, severity: parsed.severity, summary: String(parsed.summary || '').slice(0, 120) };
    } catch (_) { return null; }
}

function fingerprint(text) {
    const words = (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2).slice(0, 8);
    return 'fb-' + words.join('-').slice(0, 60);
}

async function githubGet(repo, token, path) {
    const r = await fetch('https://api.github.com/repos/' + repo + path, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'wealthflow-triage' }
    });
    return r.ok ? r.json() : null;
}

export default async function handler(req, res) {
    const out = { ok: true };
    let body = req && req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};
    const text = String(body.text || body.feedback || '').trim().slice(0, MAX_LEN);
    const diagnostics = body.diagnostics && typeof body.diagnostics === 'object' ? body.diagnostics : null;
    // The client has always sent this; nothing here ever read it, so every
    // screenshot a user attached was transmitted and then thrown away.
    const image = typeof body.image === 'string' ? body.image : '';
    const repo = process.env.GITHUB_REPO || process.env.GITHUB_REPOSITORY;
    const token = process.env.GH_PAT || process.env.GITHUB_TOKEN || process.env.GITHUB_MODELS_TOKEN;

    // Booleans only — never a value, never a prefix, never a length. Enough to tell
    // "the deployment has no token" apart from "the token is wrong" from a browser,
    // without turning a diagnostic into a credential leak.
    //
    // Computed BEFORE the empty-text check on purpose: a POST with no text now
    // files nothing, creates nothing, and answers the one question that otherwise
    // needs a real bug report to ask — is this deployment able to file at all?
    // A zero-side-effect health check for the whole pipeline.
    out.configured = { repo: !!repo, token: !!token };

    // Every non-2xx this endpoint returns carries a `reason` the app can show the
    // user verbatim. This one was the exception, which meant an empty report was
    // rejected in a shape the client had nothing to display.
    if (!text) {
        out.ok = false;
        out.error = 'no_text';
        out.reason = 'the report arrived with no text in it.';
        return send(res, out, 400);
    }

    // classify (EdenAI, with safe local fallback)
    const cls = (await edenClassify(text)) || localClassify(text);
    out.classification = cls;

    if (!repo || !token) {
        // THE SILENT DROP THIS ENDPOINT USED TO PERFORM.
        //
        // It returned HTTP 200 with ok:true and a `note` nobody read, so the app
        // showed a success confirmation for a request that created nothing. A
        // user's bug report was accepted, classified, and dropped — and every
        // signal available said it worked.
        //
        // Reporting success for work not done is the failure this project keeps
        // finding in itself: a test job that ran no tests and exited 0, an
        // auto-merge gate keyed to a label nothing applied, a schedule six times
        // over its allowance. Machinery present, signal absent, everything green.
        //
        // 503 is deliberate: the request was valid and the server is simply not
        // configured to fulfil it. That is a server-side gap the caller can neither
        // cause nor fix by retrying, and it must never read as success.
        out.ok = false;
        out.error = 'not_configured';
        const missing = [];
        if (!repo) missing.push('GITHUB_REPO');
        if (!token) missing.push('a GitHub token');
        out.reason = 'This deployment cannot file issues: ' + missing.join(' and ')
            + ' is missing from the server environment. Your feedback was saved locally and will be retried.';
        return send(res, out, 503);
    }

    // de-dup: if an open issue with the same fingerprint label exists, comment instead of duplicating
    const fp = fingerprint(text);
    const existing = await githubGet(repo, token, '/issues?state=open&labels=' + encodeURIComponent(fp));
    if (Array.isArray(existing) && existing.length) {
        // NOT a drop: this feedback is already tracked by an open issue, so the
        // user's report is represented. Named explicitly so it can never be
        // confused with the not-configured case above.
        out.deduped = existing[0].number;
        out.reason = 'Already tracked by issue #' + existing[0].number + '.';
        return send(res, out, 200);
    }

    const labelType = LABELS[cls.type] || 'triage';
    const title = '[' + cls.severity.toUpperCase() + '] ' + (cls.summary || text.slice(0, 60));
    const issueBody = [
        '## Autonomous feedback issue',
        '',
        '**Type:** ' + cls.type + '  ·  **Severity:** ' + cls.severity +
            (body.version ? '  ·  **App version:** ' + String(body.version).slice(0, 20) : ''),
        '',
        '### User feedback',
        '> ' + text.replace(/\n/g, '\n> '),
        '',
        // The "send system diagnosis" tick used to attach only the user-agent and
        // screen size. It now sends the recorded errors, stack traces and health
        // snapshot, and they are rendered here so the fix agent can read them —
        // otherwise the diagnostics would be collected and then discarded.
        diagnosticsSection(diagnostics),
        // A screenshot shows what the user was actually looking at, which is
        // often the whole report. It goes after the diagnosis so the readable
        // parts come first and the base64 is last.
        imageSection(image),
        '_Filed automatically by the feedback triage agent. The autonomous pipeline picks this up ' +
        'on the `issues: opened` trigger, so work starts within minutes._'
    ].filter(Boolean).join('\n');

    try {
        const r = await fetch('https://api.github.com/repos/' + repo + '/issues', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'wealthflow-triage' },
            body: JSON.stringify({ title: title, body: issueBody, labels: [labelType, fp, 'autonomous', 'user-feedback'] })
        });
        const created = await r.json();
        if (r.ok) {
            out.issue = created.number;
            out.reason = 'Filed as issue #' + created.number + '.';
        } else {
            out.ok = false;
            out.error = 'github_create_failed';
            out.status = r.status;
            out.detail = (created && created.message) || '';
            // 401/403 means the token exists but cannot write here — a different
            // problem from a missing token, and one `configured` alone cannot show.
            out.reason = r.status === 401 || r.status === 403
                ? 'The GitHub token is present but not authorised to create issues on ' + repo + '.'
                : 'GitHub refused to create the issue (HTTP ' + r.status + '): ' + String(out.detail).slice(0, 160);
        }
    } catch (e) {
        out.ok = false;
        out.error = 'network';
        out.reason = 'Could not reach GitHub: ' + String(e.message).slice(0, 160);
    }

    return send(res, out, out.ok ? 200 : 502);
}


/** Marker the fix agent looks for to find an attached screenshot. */
export const IMAGE_MARKER = 'wf-feedback-image';

/**
 * Characters of the 65,536-byte issue body reserved for an attached screenshot.
 *
 * GitHub REJECTS a body over 65,536 characters outright, so an oversized image
 * would not merely fail to attach — it would lose the entire report, text and
 * diagnostics included. The budget leaves ample room for the feedback, the
 * diagnosis table and the stack traces.
 */
export const IMAGE_BUDGET = 44000;

/**
 * Render an attached screenshot so the fix agent can actually see it.
 *
 * THE BUG THIS FIXES
 *   The client has always captured a screenshot, downscaled it to 900px, and
 *   sent it as `image` in the payload — the attach button, the preview and the
 *   remove control are all there and all work. This endpoint simply never read
 *   the field. The image was transmitted on every report and discarded on
 *   arrival, so the AI genuinely never saw a single screenshot: the one piece of
 *   evidence that shows what the user was actually looking at.
 *
 * WHY THE IMAGE IS EMBEDDED AS A DATA URL RATHER THAN A MARKDOWN IMAGE
 *   GitHub does not render `data:` URIs in markdown, so `![](data:image/…)`
 *   would display nothing however well-formed. The purpose here is machine
 *   consumption: the fix agent reads the issue BODY as text, extracts this
 *   block, and can pass it to the vision endpoint. It stays inside <details> so
 *   a human reading the issue is not scrolled past 40,000 characters of base64,
 *   and the note explains how to view it.
 */
export function imageSection(image) {
    const src = typeof image === 'string' ? image.trim() : '';
    if (!src) return '';

    // Only real, self-contained raster data. Anything else — a remote URL, an
    // SVG (which can carry script), a malformed prefix — is refused rather than
    // pasted into an issue body that an autonomous agent will later read.
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) {
        return ['### Screenshot', '', '_An attachment was sent but was not a valid inline PNG/JPEG/WebP, so it was not attached._', ''].join('\n');
    }

    const approxKb = Math.round((src.length * 3) / 4 / 1024);
    if (src.length > IMAGE_BUDGET) {
        // Refusing beats truncating: half a base64 string is not an image, and
        // silently attaching a corrupt one wastes a vision call to learn that.
        return [
            '### Screenshot',
            '',
            `_A screenshot was attached (~${approxKb} KB) but exceeds the ${Math.round(IMAGE_BUDGET / 1024)} KB that fits in a GitHub issue body alongside the report, so it was not embedded. The full copy is in the Firestore \`feedback\` document._`,
            '',
        ].join('\n');
    }

    return [
        '### Screenshot',
        '',
        `_Attached by the user (~${approxKb} KB). Paste the data URL below into a browser address bar to view it._`,
        '',
        `<!-- ${IMAGE_MARKER} -->`,
        '<details><summary>Screenshot data URL (for the fix agent\'s vision pass)</summary>',
        '',
        '```',
        src,
        '```',
        '',
        '</details>',
        '',
    ].join('\n');
}

/**
 * Render the client's diagnostics into readable markdown.
 * Everything is length-capped: an issue body over 65,536 characters is rejected
 * by GitHub, which would silently lose the whole report.
 */
export function diagnosticsSection(d) {
    if (!d || typeof d !== 'object') return '';
    const L = ['### System diagnosis', ''];

    const facts = [
        ['App page', d.activePage], ['Device', d.ua], ['Screen', d.screen],
        ['Viewport', d.viewport], ['DPR', d.dpr], ['Language', d.lang],
        ['Timezone', d.tz], ['Installed as app', d.standalone], ['Online', d.online],
        ['DOM nodes', d.domNodes],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (facts.length) {
        L.push('| | |', '|---|---|');
        for (const [k, v] of facts) L.push('| ' + k + ' | ' + String(v).slice(0, 200) + ' |');
        L.push('');
    }

    if (d.detectedIssues && d.detectedIssues.length) {
        L.push('**The app detected these problems itself:**', '');
        for (const i of d.detectedIssues.slice(0, 12)) {
            const sev = (i && i.severity) ? i.severity.toUpperCase() : 'INFO';
            const msg = (i && (i.message || i.msg || i.title)) || JSON.stringify(i);
            L.push('- `' + sev + '` ' + String(msg).slice(0, 300));
        }
        L.push('');
    }

    if (d.errorSummary) {
        const es = d.errorSummary;
        L.push('**Error log:** ' + (es.total || 0) + ' total, ' + (es.fromThisBuild || 0) + ' on this build.', '');
        if (es.uniqueMessages && es.uniqueMessages.length) {
            for (const m of es.uniqueMessages.slice(0, 10)) L.push('- ' + String(m).slice(0, 250));
            L.push('');
        }
    }

    if (d.errors && d.errors.length) {
        L.push('<details><summary>Recent errors with stack traces</summary>', '');
        for (const e of d.errors.slice(0, 6)) {
            L.push('```', String(e.msg || '').slice(0, 300), String(e.stack || '').slice(0, 800), '```');
            L.push('_page: ' + (e.page || '?') + ' · build: ' + (e.ver || '?') + '_', '');
        }
        L.push('</details>', '');
    }

    if (d.health) {
        let h = '';
        try { h = JSON.stringify(d.health, null, 1).slice(0, 4000); } catch (_) { h = '(unserialisable)'; }
        L.push('<details><summary>Health snapshot</summary>', '', '```json', h, '```', '</details>', '');
    }

    if (d._trimmed) L.push('_(diagnostics were trimmed on the device to keep the payload small)_', '');
    return L.join('\n');
}

// exported for tests
export { localClassify, fingerprint, LABELS };

function send(res, obj, code) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    try { if (res && res.status) { res.setHeader && Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v)); res.status(code).json(obj); return; } } catch (_) {}
    return new Response(JSON.stringify(obj), { status: code, headers });
}
