/*  feedback-status.js  →  GET /api/feedback-status?issues=12,15,19
 *  ---------------------------------------------------------------------------
 *  CLOSES THE FEEDBACK LOOP.
 *
 *  The user asked for one specific thing: when they report something in
 *  Settings → Feedback, the system must tell them when it is actually done.
 *  Until now nothing could: feedback went to Firestore and an optional email,
 *  /api/feedback-triage (which turns feedback into a GitHub issue the pipeline
 *  can work on) was never called by any client code, and there was no path back.
 *  The user wrote their report into a void.
 *
 *  This endpoint is the return path. The client remembers the issue number that
 *  its feedback became, then asks here whether that issue has been closed and in
 *  which release the fix shipped. When the answer is yes, the app shows
 *  "✅ Completed" against that piece of feedback.
 *
 *  Reads GitHub with the server-side token, so it works on a private repo
 *  without exposing any credential to the browser.
 *
 *  ENV: GITHUB_REPO or GITHUB_REPOSITORY, and a token in any of
 *       GH_PAT / GITHUB_TOKEN / GITHUB_MODELS_TOKEN.
 */

import { resolveRepo } from './github-repo.js';

import { fetchWithTimeout } from './fetch-timeout.mjs';
const MAX_ISSUES = 25;

function send(res, body, status = 200) {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
    try {
        if (res && res.status) {
            if (res.setHeader) Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
            res.status(status).json(body);
            return;
        }
    } catch { /* fall through */ }
    return new Response(JSON.stringify(body), { status, headers });
}

/** Parse and sanitise the `issues` query parameter into positive integers. */
export function parseIssueList(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => parseInt(String(s).trim(), 10))
        .filter((n) => Number.isInteger(n) && n > 0 && n < 10_000_000)
        .slice(0, MAX_ISSUES);
}

/**
 * Find the version a fix shipped in, from the issue's timeline of comments.
 * The agent and the release workflow both mention the version, e.g.
 * "Shipped in v7.70.0". Falls back to null rather than guessing.
 */
export function versionFromComments(comments) {
    for (const c of [...(comments || [])].reverse()) {
        const m = String(c?.body || '').match(/\bv?(\d+\.\d+\.\d+)\b/);
        if (m && /ship|releas|live|deploy|fixed|complete/i.test(String(c.body))) return m[1];
    }
    return null;
}

/** Turn a GitHub issue into the small shape the client needs. */
export function summarise(issue, comments) {
    const closed = issue?.state === 'closed';
    return {
        number: issue?.number ?? null,
        state: issue?.state || 'unknown',
        completed: closed && issue?.state_reason !== 'not_planned',
        wontFix: closed && issue?.state_reason === 'not_planned',
        title: String(issue?.title || '').slice(0, 160),
        closedAt: issue?.closed_at || null,
        shippedVersion: closed ? versionFromComments(comments) : null,
        labels: (issue?.labels || []).map((l) => String(l.name || l)).slice(0, 8),
        // Surfaced so the app can say "still being worked on" rather than nothing.
        inProgress: !closed && (issue?.labels || []).some((l) => String(l.name || l) === 'ai-working'),
        needsHuman: (issue?.labels || []).some((l) => String(l.name || l) === 'ai-stuck'),
    };
}

async function gh(repo, token, path) {
    const r = await fetchWithTimeout(`https://api.github.com/repos/${repo}${path}`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'wealthflow-feedback-status',
        },
    });
    if (!r.ok) return null;
    return r.json().catch(() => null);
}

export default async function handler(req, res) {
    if (req?.method === 'OPTIONS') return send(res, { ok: true });

    let raw = '';
    try {
        const url = String(req?.url || '');
        const m = url.match(/[?&]issues=([^&]*)/);
        raw = m ? decodeURIComponent(m[1]) : (req?.query?.issues || '');
    } catch { /* ignore */ }

    const numbers = parseIssueList(raw);
    if (!numbers.length) return send(res, { ok: true, items: [] });

    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const repo = resolveRepo(env);
    const token = env.GH_PAT || env.GITHUB_TOKEN || env.GITHUB_MODELS_TOKEN;
    if (!repo || !token) {
        // Be explicit rather than silently returning "nothing completed" — a
        // missing token must not look like "your feedback was ignored".
        return send(res, {
            ok: false,
            reason: 'not_configured',
            note: 'Set GITHUB_REPO and GH_PAT so the app can report when your feedback is done.',
            items: [],
        });
    }

    const items = [];
    for (const n of numbers) {
        const issue = await gh(repo, token, `/issues/${n}`);
        if (!issue) { items.push({ number: n, state: 'unknown', completed: false }); continue; }
        let comments = [];
        if (issue.state === 'closed' && issue.comments > 0) {
            comments = (await gh(repo, token, `/issues/${n}/comments?per_page=100`)) || [];
        }
        items.push(summarise(issue, comments));
    }

    return send(res, {
        ok: true,
        items,
        completedCount: items.filter((i) => i.completed).length,
        checkedAt: new Date().toISOString(),
    });
}
