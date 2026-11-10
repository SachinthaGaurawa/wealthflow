/*  autonomy-status.js  →  GET /api/autonomy-status
 *  ---------------------------------------------------------------------------
 *  Lets the APP tell the user the truth about its own update system.
 *
 *  WHAT WAS WRONG (found 2026-11-04 on issue #514)
 *    This endpoint imported autonomy/self-check.mjs, a CI tool that reads a git
 *    checkout: `.github/workflows`, the test folder, `git log`. Vercel does not
 *    ship those, and the router's lazy import did not even bundle the module, so
 *    every call answered HTTP 500 "Endpoint file not bundled by Vercel". Every
 *    feedback report therefore said "agent: unknown" and "release: unknown" and
 *    the app could not say whether the update system worked.
 *
 *  WHAT IT READS NOW
 *    The one place the real evidence lives: GitHub. The fix agent and the release
 *    both run there, so their last runs ARE the answer.
 *      • the last finished runs of "Autonomous fix agent" and "Auto Release",
 *      • the newest commit that was not a version stamp (when the app last
 *        genuinely changed),
 *      • how many open issues the agent gave up on (`ai-stuck`).
 *    It never imports repo files, so there is nothing to forget to bundle, and it
 *    never answers 500: a failure to read GitHub is reported as `unknown`.
 *
 *  WHAT IT DOES NOT CLAIM
 *    A run that ended "no change made" is a successful run, so run results cannot
 *    show that the AI models are alive. `canActuallyFixBugs` is therefore `null`
 *    unless the agent's recent runs are failing, and the headline says so.
 *
 *  Cheap and safe to poll: four GitHub reads, each bounded, no secrets echoed.
 *  `?full=1` adds the per-check detail for the diagnostics panel.
 */

import { resolveRepo } from './github-repo.js';
import { fetchWithTimeout } from './fetch-timeout.mjs';

const READ_MS = 7000;
const DAY = 86_400_000;
const STALE_CHANGE_DAYS = 21;

function send(res, body, status = 200) {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0, must-revalidate',
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

/** Runs that actually ran: a cancelled or skipped run says nothing about health. */
function decisive(runs) {
    return (runs || []).filter((r) => r && (r.conclusion === 'success' || r.conclusion === 'failure' || r.conclusion === 'timed_out'));
}

/** Newest commit that was not a version stamp or a merchants refresh. */
export function lastRealChange(commits, now = Date.now()) {
    for (const c of commits || []) {
        const msg = String((c && c.commit && c.commit.message) || '').split('\n')[0];
        if (/^release: /i.test(msg) || /^chore\(merchants\)/i.test(msg)) continue;
        const at = c && c.commit && c.commit.author && c.commit.author.date;
        const t = Date.parse(at || '');
        if (!Number.isFinite(t)) continue;
        return { at: new Date(t).toISOString(), summary: msg.slice(0, 90), daysAgo: Math.max(0, Math.floor((now - t) / DAY)) };
    }
    return null;
}

/**
 * The verdict, from evidence alone. Pure, so it can be tested without a network.
 * @param {{ agentRuns?:any[], releaseRuns?:any[], commits?:any[], stuck?:number|null, unread?:string[] }} ev
 */
export function judge(ev = {}, now = Date.now()) {
    const unread = ev.unread || [];
    const agent = decisive(ev.agentRuns);
    const release = decisive(ev.releaseRuns);
    const failing = [];

    // The agent is dead when its last three real runs all failed. A single red run is noise.
    const lastAgent = agent.slice(0, 3);
    const agentDown = lastAgent.length >= 3 && lastAgent.every((r) => r.conclusion !== 'success');
    if (agentDown) failing.push({ id: 'agent', summary: 'The last 3 runs of the fix agent failed (' + (lastAgent[0].html_url || 'see Actions') + ').' });

    const lastRelease = release[0] || null;
    const releaseDown = !!lastRelease && lastRelease.conclusion !== 'success';
    if (releaseDown) failing.push({ id: 'release', summary: 'The latest Auto Release run did not succeed (' + (lastRelease.html_url || 'see Actions') + '), so fixes may not reach the app.' });

    const change = lastRealChange(ev.commits, now);
    const stuck = Number.isFinite(ev.stuck) ? ev.stuck : null;
    if (stuck > 0) failing.push({ id: 'stuck', summary: stuck + ' open report(s) are marked ai-stuck: the agent tried and handed them to a person.' });

    const noEvidence = !agent.length && !release.length && !change;
    let overall;
    if (noEvidence && unread.length) overall = 'unknown';
    else if (agentDown) overall = 'broken';
    else if (releaseDown || stuck > 0 || (change && change.daysAgo > STALE_CHANGE_DAYS) || unread.length) overall = 'degraded';
    else overall = 'healthy';

    const headline = overall === 'unknown'
        ? 'The server could not read GitHub just now, so the update system could not be checked from here.'
        : overall === 'broken'
            ? 'Automatic fixing is NOT working: the last runs of the fix agent failed. Your reports are saved, but nothing is being fixed automatically.'
            : overall === 'degraded'
                ? 'The fix agent and the release ran, but something needs attention: ' + failing.map((f) => f.summary).join(' ')
                : 'The last fix-agent and release runs on GitHub succeeded. Whether the AI models can write a fix for a given report is shown on that report.';
    return {
        overall,
        failing,
        canActuallyFixBugs: agentDown ? false : null,
        releaseFailing: releaseDown,
        stuckIssues: stuck,
        lastRealChange: change,
        agent: lastAgent[0] ? { at: lastAgent[0].created_at || null, conclusion: lastAgent[0].conclusion } : null,
        release: lastRelease ? { at: lastRelease.created_at || null, conclusion: lastRelease.conclusion } : null,
        headline,
    };
}

async function gh(repo, token, path, fetchImpl) {
    const r = await fetchImpl('https://api.github.com/repos/' + repo + path, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'wealthflow-autonomy-status' },
    }, READ_MS);
    if (!r.ok) throw new Error('GitHub ' + r.status);
    return r.json();
}

/** Collect the evidence. Each read can fail alone; failures are listed, never thrown. */
export async function collect(env, fetchImpl = fetchWithTimeout) {
    const repo = resolveRepo(env);
    const token = env.GH_PAT || env.GITHUB_TOKEN || env.GITHUB_MODELS_TOKEN || '';
    if (!repo || !token) return { unread: ['no GitHub repository or token is configured on the server'] };
    const ev = { unread: [] };
    const tasks = [
        ['agent runs', '/actions/workflows/autonomous-fix.yml/runs?per_page=20&status=completed', (d) => { ev.agentRuns = d.workflow_runs || []; }],
        ['release runs', '/actions/workflows/auto-release.yml/runs?per_page=10&status=completed', (d) => { ev.releaseRuns = d.workflow_runs || []; }],
        ['commits', '/commits?per_page=40', (d) => { ev.commits = Array.isArray(d) ? d : []; }],
        ['stuck reports', '/issues?labels=ai-stuck&state=open&per_page=50', (d) => { ev.stuck = Array.isArray(d) ? d.filter((i) => !i.pull_request).length : null; }],
    ];
    await Promise.all(tasks.map(async ([name, path, take]) => {
        try { take(await gh(repo, token, path, fetchImpl)); }
        catch (e) { ev.unread.push(name + ': ' + String((e && e.message) || e).slice(0, 80)); }
    }));
    return ev;
}

export default async function handler(req, res) {
    let full = false;
    try { full = /[?&]full=1/.test(String((req && req.url) || '')); } catch { /* ignore */ }

    let v;
    let ev = { unread: [] };
    try {
        ev = await collect((typeof process !== 'undefined' && process.env) || {});
        v = judge(ev);
    } catch (e) {
        // Even a failure here is information the user deserves, and it must not be a 500.
        return send(res, {
            ok: true, overall: 'unknown', canActuallyFixBugs: null, source: 'github',
            headline: 'Update system status could not be determined.',
            error: String((e && e.message) || e).slice(0, 200), checkedAt: new Date().toISOString(),
        });
    }

    const body = {
        ok: v.overall !== 'broken',
        overall: v.overall,                       // healthy | degraded | broken | unknown
        source: 'github',
        canActuallyFixBugs: v.canActuallyFixBugs,
        headline: v.headline,
        verdict: v.headline,
        failing: v.failing,
        releaseFailing: v.releaseFailing,
        stuckIssues: v.stuckIssues,
        lastRealChange: v.lastRealChange,
        emptyVersionBumpsRecently: null,          // needs file lists per commit; not measured here
        providers: null,                          // model keys live in GitHub Actions, not here
        counts: { ok: 0, warn: v.failing.length, broken: v.overall === 'broken' ? 1 : 0 },
        checkedAt: new Date().toISOString(),
    };
    if (full) {
        body.checks = [
            { id: 'agent', status: v.agent ? (v.canActuallyFixBugs === false ? 'broken' : 'ok') : 'unknown', summary: v.agent ? 'Last fix-agent run: ' + v.agent.conclusion + ' at ' + v.agent.at : 'No finished fix-agent run found.', detail: '' },
            { id: 'release', status: v.release ? (v.releaseFailing ? 'broken' : 'ok') : 'unknown', summary: v.release ? 'Last release run: ' + v.release.conclusion + ' at ' + v.release.at : 'No finished release run found.', detail: '' },
            { id: 'stuck', status: v.stuckIssues > 0 ? 'warn' : 'ok', summary: (v.stuckIssues == null ? 'Unknown' : v.stuckIssues) + ' open report(s) marked ai-stuck.', detail: '' },
            { id: 'last-real-change', status: v.lastRealChange ? 'ok' : 'unknown', summary: v.lastRealChange ? 'Last genuine change: ' + v.lastRealChange.daysAgo + ' day(s) ago: ' + v.lastRealChange.summary : 'No genuine change found.', detail: '' },
            ...(ev.unread || []).map((u) => ({ id: 'unread', status: 'warn', summary: 'Could not read ' + u, detail: '' })),
        ];
    }
    return send(res, body, 200);
}
