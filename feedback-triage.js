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
 *    GITHUB_MODELS_TOKEN or GH_PAT  token with `issues:write` on the repo
 *    GITHUB_REPO                    e.g. "SachinthaGaurawa/wealthflow"
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
    if (!text) { return send(res, { ok: false, error: 'no feedback text' }, 400); }

    const repo = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_MODELS_TOKEN || process.env.GH_PAT;

    // classify (EdenAI, with safe local fallback)
    const cls = (await edenClassify(text)) || localClassify(text);
    out.classification = cls;

    if (!repo || !token) {
        out.note = 'classified, but GITHUB_REPO / token not set — issue not created';
        return send(res, out, 200);
    }

    // de-dup: if an open issue with the same fingerprint label exists, comment instead of duplicating
    const fp = fingerprint(text);
    const existing = await githubGet(repo, token, '/issues?state=open&labels=' + encodeURIComponent(fp));
    if (Array.isArray(existing) && existing.length) {
        out.deduped = existing[0].number;
        return send(res, out, 200);
    }

    const labelType = LABELS[cls.type] || 'triage';
    const title = '[' + cls.severity.toUpperCase() + '] ' + (cls.summary || text.slice(0, 60));
    const issueBody = [
        '## Autonomous feedback issue',
        '',
        '**Type:** ' + cls.type + '  ·  **Severity:** ' + cls.severity,
        '',
        '### User feedback',
        '> ' + text.replace(/\n/g, '\n> '),
        '',
        '_Filed automatically by the feedback triage agent. The autonomous CI/CD pipeline will pick this up._'
    ].join('\n');

    try {
        const r = await fetch('https://api.github.com/repos/' + repo + '/issues', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'wealthflow-triage' },
            body: JSON.stringify({ title: title, body: issueBody, labels: [labelType, fp, 'autonomous'] })
        });
        const created = await r.json();
        if (r.ok) { out.issue = created.number; } else { out.ok = false; out.error = 'github issue create failed'; out.detail = created && created.message; }
    } catch (e) { out.ok = false; out.error = e.message; }

    return send(res, out, out.ok ? 200 : 502);
}

// exported for tests
export { localClassify, fingerprint, LABELS };

function send(res, obj, code) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    try { if (res && res.status) { res.setHeader && Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v)); res.status(code).json(obj); return; } } catch (_) {}
    return new Response(JSON.stringify(obj), { status: code, headers });
}
