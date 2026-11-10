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
 *  "[OK] Completed" against that piece of feedback.
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

/**
 * The release a fix reached the owner's phone in: the FIRST release published at or after the moment the issue was closed
 * (the agent's pull request closes it when it merges, and the release is cut after that merge). '' pieces stay null rather than guessed.
 * A closed issue with no later release is "merged, release not out yet", which is not the same as shipped.
 * @param {Array<{tag_name?:string, name?:string, published_at?:string, created_at?:string, draft?:boolean}>} releases
 */
export function releaseAfter(releases, closedAt) {
    const t = Date.parse(closedAt || '');
    if (!Number.isFinite(t)) return null;
    let best = null;
    for (const r of releases || []) {
        if (!r || r.draft) continue;
        const v = String(r.tag_name || r.name || '').match(/(\d+\.\d+\.\d+)/);
        const at = Date.parse(r.published_at || r.created_at || '');
        if (!v || !Number.isFinite(at) || at < t - 60_000) continue;
        if (!best || at < best.at) best = { version: v[1], at };
    }
    return best ? { version: best.version, at: new Date(best.at).toISOString() } : null;
}

/** Release commits ("release: v7.69.48 — automatic release") as the {tag_name, published_at} list releaseAfter reads. */
export function releasesFromCommits(commits) {
    const out = [];
    for (const c of commits || []) {
        const msg = String(c?.commit?.message || '');
        const m = msg.match(/^release:\s*v?(\d+\.\d+\.\d+)/i);
        if (!m) continue;
        out.push({ tag_name: 'v' + m[1], published_at: c?.commit?.committer?.date || c?.commit?.author?.date || '' });
    }
    return out;
}

/** Turn a GitHub issue into the small shape the client needs. `releases` (optional) is the repository's release list. */
export function summarise(issue, comments, releases) {
    const closed = issue?.state === 'closed';
    const done = closed && issue?.state_reason !== 'not_planned';
    const shipped = done ? releaseAfter(releases, issue?.closed_at) : null;
    return {
        // One word for the app to show: fixed (closed as done), declined (closed as not planned), working, stuck, or waiting.
        status: done ? 'fixed' : closed ? 'declined'
            : (issue?.labels || []).some((l) => String(l.name || l) === 'ai-stuck') ? 'stuck'
                : (issue?.labels || []).some((l) => String(l.name || l) === 'ai-working') ? 'working' : 'waiting',
        shippedAt: shipped ? shipped.at : null,
        releasePending: done && !shipped && Array.isArray(releases),
        number: issue?.number ?? null,
        state: issue?.state || 'unknown',
        completed: closed && issue?.state_reason !== 'not_planned',
        wontFix: closed && issue?.state_reason === 'not_planned',
        title: String(issue?.title || '').slice(0, 160),
        closedAt: issue?.closed_at || null,
        shippedVersion: done ? (shipped ? shipped.version : (Array.isArray(releases) ? null : versionFromComments(comments))) : null,
        labels: (issue?.labels || []).map((l) => String(l.name || l)).slice(0, 8),
        // Surfaced so the app can say "still being worked on" rather than nothing.
        inProgress: !closed && (issue?.labels || []).some((l) => String(l.name || l) === 'ai-working'),
        needsHuman: (issue?.labels || []).some((l) => String(l.name || l) === 'ai-stuck'),
    };
}

/** `texts` query: a JSON array of the owner's own words (at most five, 120 characters each). */
export function parseSnippets(raw) {
    let list = [];
    try { list = JSON.parse(String(raw || '[]')); } catch { return []; }
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string' && x.trim().length >= 8).slice(0, 5).map((x) => {
        const raw = x.trim().slice(0, 120);
        // GitHub's search treats punctuation as syntax: keep letters, marks and digits of any script, first eight words.
        const q = raw.replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
        return { raw, q };
    }).filter((x) => x.q.length >= 6);
}

/** The newest user-feedback issue whose body quotes these words, or null. Never throws. */
async function findIssueByText(repo, token, q) {
    try {
        const query = encodeURIComponent(`repo:${repo} is:issue label:user-feedback in:body "${q}"`);
        const r = await gh(repo, token, '', `https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=1`);
        const hit = r && Array.isArray(r.items) && r.items[0];
        return hit && Number.isInteger(hit.number) ? hit.number : null;
    } catch { return null; }
}

async function gh(repo, token, path, absolute) {
    const r = await fetchWithTimeout(absolute || `https://api.github.com/repos/${repo}${path}`, {
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
    let snippets = [];
    try {
        const url = String(req?.url || '');
        const m = url.match(/[?&]texts=([^&]*)/);
        const rawTexts = m ? decodeURIComponent(m[1]) : (req?.query?.texts || '');
        snippets = parseSnippets(rawTexts);
    } catch { /* ignore */ }
    if (!numbers.length && !snippets.length) return send(res, { ok: true, items: [] });

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

    // A report whose issue number this device no longer has (signed out, cleared storage, sent from another phone) is found again by its
    // own words: the issue body quotes the owner's text verbatim under "User feedback".
    const matches = [];
    const wanted = [...numbers];
    for (const sn of snippets) {
        const found = await findIssueByText(repo, token, sn.q);
        matches.push({ text: sn.raw, number: found });
        if (found && !wanted.includes(found)) wanted.push(found);
    }

    const issues = [];
    for (const n of wanted.slice(0, MAX_ISSUES)) issues.push({ n, issue: await gh(repo, token, `/issues/${n}`) });
    // The repository publishes versions as commits named "release: vX.Y.Z" that touch version.json (it has no GitHub Releases), so the
    // releases are read from there: one request for everything since the oldest closing.
    const closedTimes = issues.map((x) => Date.parse(x.issue?.closed_at || '')).filter(Number.isFinite);
    let releases;
    if (closedTimes.length) {
        const since = new Date(Math.min(...closedTimes) - 5 * 60_000).toISOString();
        const commits = await gh(repo, token, `/commits?path=version.json&since=${encodeURIComponent(since)}&per_page=100`);
        if (Array.isArray(commits)) releases = releasesFromCommits(commits);
    }
    const items = [];
    for (const { n, issue } of issues) {
        if (!issue) { items.push({ number: n, state: 'unknown', completed: false, status: 'unknown' }); continue; }
        let comments = [];
        if (issue.state === 'closed' && issue.comments > 0 && !Array.isArray(releases)) {
            comments = (await gh(repo, token, `/issues/${n}/comments?per_page=100`)) || [];
        }
        items.push(summarise(issue, comments, releases));
    }

    return send(res, {
        ok: true,
        matches,
        items,
        completedCount: items.filter((i) => i.completed).length,
        fixedCount: items.filter((i) => i.status === 'fixed').length,
        checkedAt: new Date().toISOString(),
    });
}
