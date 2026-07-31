// =============================================================================
//  WealthFlow · resolve which GitHub repo the feedback endpoints act on
// =============================================================================
//  WHY THIS EXISTS
//
//  feedback-triage.js (files issues) and feedback-status.js (reads them back)
//  each resolved the repo the same way — GITHUB_REPO || GITHUB_REPOSITORY — and
//  on the live deployment BOTH were empty. The router fix (#42) made the triage
//  endpoint reachable at last, and the very first health check against it
//  returned `configured: { repo: false, token: true }`: the token is set, the
//  repo is not, so a real report would reach the handler and then be turned away
//  with "GITHUB_REPO is missing".
//
//  Rather than leave that to a hand-set environment variable that has been
//  missing all along, this falls back to the repo Vercel ALREADY knows the
//  deployment came from. Vercel exposes VERCEL_GIT_REPO_OWNER and
//  VERCEL_GIT_REPO_SLUG as system environment variables on every git-connected
//  deployment, so `owner/slug` is the correct repo by construction — including
//  on a fork or a preview, where it points at that fork rather than at whatever
//  a hardcoded default would have named. No secret is involved: a public repo
//  slug is not a credential.
//
//  Precedence is explicit-over-inferred: an operator who sets GITHUB_REPO to
//  something deliberately still wins. The Vercel pair is only consulted when
//  nothing was set by hand, and if it too is absent the result is '' — exactly
//  what the callers already treat as "not configured", so behaviour with the
//  vars unavailable is identical to before. Strictly additive; zero downside.
// =============================================================================

/**
 * Normalise whatever was configured into a bare "owner/repo".
 *
 * A GitHub API call built from a slightly-off string does not fail loudly — it
 * 404s, which is indistinguishable from "the token cannot see this repo". So the
 * shapes people actually paste into an environment variable are cleaned up here
 * rather than left to produce a mystery:
 *   "https://github.com/owner/repo(.git)"  ·  "/owner/repo/"  ·  " owner/repo "
 */
function normaliseRepo(value) {
    let s = String(value == null ? '' : value).trim();
    if (!s) return '';
    s = s.replace(/^git@github\.com:/i, '')
        .replace(/^[a-z]+:\/\/[^/]*github\.com\//i, '')
        .replace(/^\/+/, '')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '');
    const parts = s.split('/').filter(Boolean);
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : s;
}

/** A repo string GitHub could actually accept: exactly "owner/name". */
export function isValidRepo(repo) {
    return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(repo || ''));
}

/**
 * @param {Record<string,string|undefined>} [env]  defaults to process.env
 * @returns {string} "owner/repo", or '' when nothing identifies a repo.
 */
export function resolveRepo(env) {
    const e = env || (typeof process !== 'undefined' && process.env) || {};
    const explicit = e.GITHUB_REPO || e.GITHUB_REPOSITORY;
    if (explicit) return normaliseRepo(explicit);
    const owner = normaliseRepo(e.VERCEL_GIT_REPO_OWNER);
    const slug = normaliseRepo(e.VERCEL_GIT_REPO_SLUG);
    return owner && slug ? owner + '/' + slug : '';
}

/**
 * Which environment variable supplied the token — the NAME, never the value.
 *
 * This exists because the three names are not interchangeable in practice.
 * GITHUB_MODELS_TOKEN is issued for GitHub Models inference and carries no
 * repository permission at all; if it is the only one set, every issue-creation
 * call returns 404 while `configured.token` cheerfully reports true. Reporting
 * which variable was used turns that from an unfalsifiable guess into a fact.
 */
export const TOKEN_VARS = ['GH_PAT', 'GITHUB_TOKEN', 'GITHUB_MODELS_TOKEN'];

export function resolveToken(env) {
    const e = env || (typeof process !== 'undefined' && process.env) || {};
    for (const name of TOKEN_VARS) {
        if (e[name]) return { token: String(e[name]), source: name };
    }
    return { token: '', source: null };
}

export default { resolveRepo, isValidRepo, resolveToken, TOKEN_VARS };
