#!/usr/bin/env node
/* INSTANT ROLLBACK THAT ROLLS BACK, AND SAYS SO ONLY WHEN PRODUCTION CHANGED.
 *
 * WHY THIS EXISTS
 * Both rollback paths in this repository (health-watchdog.yml and the browser canary in auto-release.yml) ran
 * `npx vercel rollback --yes --token=...` with no deployment. In the Vercel CLI `rollback` with no target defaults to the
 * `status` sub-command: it prints the state of any pending rollback and EXITS 0. So the workflow reported
 * "production was rolled back" while nothing had moved (found in the Codex review of PR #506; the CLI documents
 * `vercel rollback [deployment-id or url]` and `vercel rollback status` as separate things).
 *
 * WHAT IT DOES INSTEAD
 *   1. lists the READY production deployments of the project (REST API, one read);
 *   2. finds the deployment built from the bad commit and takes the one just before it (never a guess: if the bad commit
 *      has no deployment, or Vercel does not offer the older one as a target, it refuses and says why);
 *   3. asks Vercel to point production at that deployment (POST /v1/projects/{id}/rollback/{deploymentId});
 *   4. LOOKS: the live /api/version must stop serving the bad version, or the verify URL must answer 200. Only that is "verified".
 * It talks to the API with the token in a header (no `npx vercel@latest` fetched at release time with the token in its arguments).
 *
 *   VERCEL_TOKEN=... VERCEL_PROJECT_ID=prj_... [VERCEL_ORG_ID=team_...] \
 *     node autonomy/rollback.mjs --bad-sha <commit> --base https://www.wealthflow.lk --bad-version 7.69.41
 *   node autonomy/rollback.mjs --bad-sha current --verify-url https://www.wealthflow.lk/api/health     (watchdog: the newest is the bad one)
 *
 * Exit 0: production now serves something else (verified). Exit 1: nothing was rolled back (refused or failed; the reason is printed).
 * Exit 3: Vercel accepted the request but the live site was still the bad version when we stopped looking.
 * On a free (Hobby) plan Vercel only allows the PREVIOUS production deployment as a target; anything older is refused here
 * with that reason instead of being attempted.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API = 'https://api.vercel.com';

/** The fields we need from a REST or MCP deployment record (they name the id differently). Pure. */
export function normalise(d) {
    d = d || {};
    return {
        id: d.uid || d.id || '',
        url: d.url || '',
        created: Number(d.created || d.createdAt || 0),
        state: String(d.state || d.readyState || '').toUpperCase(),
        target: d.target || null,
        sha: (d.meta && d.meta.githubCommitSha) || '',
        candidate: typeof d.isRollbackCandidate === 'boolean' ? d.isRollbackCandidate : null,
    };
}

/** Which deployment production should go back to. Pure: no network, so every refusal is testable.
 *  badSha: the commit whose deployment is bad, or 'current' (the newest production deployment is the bad one). */
export function pickTarget(deployments, { badSha } = {}) {
    const list = (Array.isArray(deployments) ? deployments : []).map(normalise)
        .filter((d) => d.id && d.state === 'READY' && (d.target === 'production' || d.target === null))
        .sort((a, b) => b.created - a.created);
    if (!list.length) return { ok: false, why: 'Vercel returned no READY production deployments' };
    const wantNewest = !badSha || badSha === 'current';
    const badIdx = wantNewest ? 0 : list.findIndex((d) => d.sha === badSha);
    if (badIdx < 0) return { ok: false, why: `no READY production deployment was built from commit ${String(badSha).slice(0, 8)}, so there is nothing to step back from` };
    const target = list[badIdx + 1];
    if (!target) return { ok: false, why: 'there is no production deployment older than the bad one to go back to' };
    if (target.candidate === false) {
        return { ok: false, why: `Vercel does not offer ${target.id} as a rollback target (on the Hobby plan only the previous production deployment is allowed${badIdx > 0 ? `; ${badIdx} newer deployment(s) sit after the bad one` : ''}); roll back from the Vercel dashboard` };
    }
    return { ok: true, bad: list[badIdx], target, droppedNewer: badIdx };
}

/** Did production change? Reads what a device reads. Returns { verified, seen }. */
async function verifyLive({ base, badVersion, verifyUrl, fetchImpl, attempts, intervalMs, sleepImpl }) {
    if (!(base && badVersion) && !verifyUrl) return { verified: false, seen: null, measured: false };
    let seen = null;
    for (let i = 0; i < attempts; i++) {
        let versionOk = true; let urlOk = true;
        try {
            if (base && badVersion) {
                const r = await fetchImpl(`${base.replace(/\/+$/, '')}/api/version?_=${Date.now()}${i}`, { redirect: 'follow' });
                const j = r.ok ? await r.json() : null;
                seen = (j && j.version) || null;
                versionOk = !!seen && seen !== badVersion;
            }
            if (verifyUrl) { const r = await fetchImpl(verifyUrl, { redirect: 'follow' }); urlOk = r.status === 200; }
        } catch (e) { versionOk = false; urlOk = false; }
        if (versionOk && urlOk) return { verified: true, seen, measured: true };
        if (i < attempts - 1) await sleepImpl(intervalMs);
    }
    return { verified: false, seen, measured: true };
}

/** Roll production back one step and look at the result. Never throws; the result says what happened. */
export async function rollback(o = {}) {
    const { token, projectId, teamId, badSha, base, badVersion, verifyUrl, fetchImpl = fetch, attempts = 18, intervalMs = 10000,
        sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} } = o;
    if (!token) return { result: 'refused', why: 'no Vercel token (secret VERCEL_TOKEN)' };
    if (!projectId) return { result: 'refused', why: 'no project id (repository variable VERCEL_PROJECT_ID)' };
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const team = teamId ? `&teamId=${encodeURIComponent(teamId)}` : '';
    let deployments;
    try {
        const r = await fetchImpl(`${API}/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&state=READY&limit=20${team}`, { headers: auth });
        if (!r.ok) return { result: 'failed', why: `listing production deployments answered HTTP ${r.status}` };
        deployments = (await r.json()).deployments;
    } catch (e) { return { result: 'failed', why: `listing production deployments failed: ${String((e && e.message) || e).slice(0, 160)}` }; }

    const pick = pickTarget(deployments, { badSha });
    if (!pick.ok) return { result: 'refused', why: pick.why };
    log(`production is bad at ${pick.bad.id} (${pick.bad.sha.slice(0, 8) || 'unknown commit'}); going back to ${pick.target.id} (${pick.target.sha.slice(0, 8) || 'unknown commit'})`);

    try {
        const r = await fetchImpl(`${API}/v1/projects/${encodeURIComponent(projectId)}/rollback/${encodeURIComponent(pick.target.id)}${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`, { method: 'POST', headers: auth, body: '{}' });
        if (!(r.status >= 200 && r.status < 300)) return { result: 'failed', why: `Vercel refused the rollback request (HTTP ${r.status})`, target: pick.target.id };
    } catch (e) { return { result: 'failed', why: `the rollback request failed: ${String((e && e.message) || e).slice(0, 160)}`, target: pick.target.id }; }

    const live = await verifyLive({ base, badVersion, verifyUrl, fetchImpl, attempts, intervalMs, sleepImpl });
    const common = { target: pick.target.id, from: pick.bad.id, droppedNewer: pick.droppedNewer, seen: live.seen };
    if (live.verified) return { result: 'verified', ...common };
    return { result: 'requested', why: live.measured ? `Vercel accepted the request but the live site still looked like the bad release${live.seen ? ` (it served ${live.seen})` : ''} when we stopped looking` : 'Vercel accepted the request; there was nothing to check it against', ...common };
}

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const res = await rollback({
        token: process.env.VERCEL_TOKEN, projectId: process.env.VERCEL_PROJECT_ID, teamId: process.env.VERCEL_ORG_ID,
        badSha: arg('bad-sha'), base: arg('base'), badVersion: arg('bad-version'), verifyUrl: arg('verify-url'),
        log: (m) => console.log(`[rollback] ${m}`),
    });
    const line = { verified: 'production no longer serves the bad release', requested: res.why, refused: `nothing was rolled back: ${res.why}`, failed: `nothing was rolled back: ${res.why}` }[res.result];
    console.log(`[rollback] ${res.result}: ${line}`);
    const out = arg('out');
    if (out) fs.writeFileSync(out, JSON.stringify(res, null, 2));
    process.exit(res.result === 'verified' ? 0 : res.result === 'requested' ? 3 : 1);
}
