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
 * @param {Record<string,string|undefined>} [env]  defaults to process.env
 * @returns {string} "owner/repo", or '' when nothing identifies a repo.
 */
export function resolveRepo(env) {
    const e = env || (typeof process !== 'undefined' && process.env) || {};
    const explicit = e.GITHUB_REPO || e.GITHUB_REPOSITORY;
    if (explicit) return String(explicit);
    const owner = e.VERCEL_GIT_REPO_OWNER;
    const slug = e.VERCEL_GIT_REPO_SLUG;
    return owner && slug ? owner + '/' + slug : '';
}

export default { resolveRepo };
