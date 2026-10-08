# WealthFlow Official Domain Migration Design

## Objective

Make `https://www.wealthflow.lk` the only public WealthFlow origin and
`info@wealthflow.lk` the only customer-facing WealthFlow email identity.
Visitors using a legacy hostname must arrive at the same path, query, and hash
on the official origin. Every newly generated public link must start at the
official origin.

## Observed production state

- `https://www.wealthflow.lk` serves the application.
- `https://wealthflow.lk` already returns a permanent redirect to the `www`
  hostname.
- `https://wealthflow-personal.vercel.app` still serves the application without
  redirecting.
- `https://wealthflow-peach.vercel.app` redirects to the obsolete
  `wealthflow-personal.vercel.app` hostname.
- the GitHub Pages build redirects its visitors to the obsolete Vercel hostname.
- public share links, tenant/SMS links, Elite Reports, loan statements, Drive
  authorization, AI/OCR fallbacks, and provider attribution headers contain
  independent copies of the old origin.
- customer-facing email fallbacks include `noreply@wealthflow.com`,
  `onboarding@resend.dev`, and `owner@wealthflow.app`.

## Canonical identity

- Canonical origin: `https://www.wealthflow.lk`
- Canonical contact email: `info@wealthflow.lk`
- Legacy aliases:
  - `wealthflow-personal.vercel.app`
  - `wealthflow-peach.vercel.app`
  - `sachinthagaurawa.github.io` when its path begins with `/wealthflow`

Bank sender addresses, user account addresses, OAuth provider addresses, and
GitHub automation identities are data or infrastructure identities, not
WealthFlow customer-contact identities. They must not be rewritten merely
because they contain an email address.

## Architecture

### Shared public identity

Create one small server-compatible module that owns the canonical origin,
contact email, public-origin validation, and absolute public-link construction.
Server handlers import this module instead of defining their own production
hostname. An environment override remains accepted only when it is an HTTPS
origin without credentials, query, fragment, or non-root path; the official
origin is the safe fallback.

The static browser application receives one canonical-origin value early in
the document. Cross-origin fallbacks, OAuth return links, recovery links,
share links, Elite Reports, and deletion endpoints consume that value. Normal
same-origin API requests remain relative so preview and local development keep
working.

### Redirect ownership

Vercel performs permanent host-conditioned redirects for both legacy Vercel
hosts before the SPA rewrite. The redirect preserves the requested path and
query string and lands on `https://www.wealthflow.lk`.

GitHub Pages cannot provide an application-controlled HTTP redirect to an
unrelated host. The document therefore runs a synchronous hostname guard before
Firebase, service workers, or application code. It uses `location.replace`,
removes the `/wealthflow` deployment prefix, and preserves the remaining path,
query, and hash. A canonical link identifies the official page to crawlers.

The apex `https://wealthflow.lk` remains a Vercel-managed permanent redirect to
the official `www` hostname.

### Generated URLs

All public URLs generated for the following flows use the canonical origin:

- loan-statement and shared-statement short links;
- Elite Report PDF links and their revocation calls;
- tenant/SMS customer portal links;
- recovery and browser-to-installed-app handoff links;
- Google Drive OAuth redirect URIs;
- AI/OpenRouter attribution headers and browser fallbacks;
- workflow health checks and other public callbacks.

Stored legacy share URLs remain readable. When displayed or copied again, the
application rewrites only a recognized legacy WealthFlow hostname to the
official origin; arbitrary third-party URLs are never rewritten.

### Email identity

Customer-facing From, Reply-To, support, and feedback defaults use
`info@wealthflow.lk`. Sending endpoints may still require provider credentials,
but they must fail honestly when the verified sender is unavailable rather than
silently presenting an unrelated provider domain as WealthFlow.

`info@wealthflow.lk` is configuration data as well as UI copy. The deployment
must set any provider-specific verified sender variables to this address.

## Security and compatibility

- Redirects are based on an explicit legacy-host allow-list and cannot become
  open redirects.
- Canonical URL helpers accept only HTTPS origins with no credentials.
- Existing path, query, and hash data survive redirects.
- API routes stay relative on the official site to avoid unnecessary CORS.
- Existing short-link identifiers and tenant tokens are unchanged.
- Service worker caches must not keep users on a legacy host after deployment.
- OAuth providers must list `https://www.wealthflow.lk/` as an authorized
  redirect URI before the old URI is retired.

## Verification

Automated tests cover canonical constants, override validation, generated links,
host redirect configuration, GitHub Pages path/query/hash migration, legacy
stored-link normalization, and customer-facing email defaults. A repository
inventory test rejects new production references to legacy hosts except the
explicit redirect allow-list and migration tests.

The full unit suite, production build, built-tree browser boot, and live HTTP
redirect matrix must pass. Live checks must demonstrate that both legacy Vercel
hosts redirect directly to the official domain and that GitHub Pages reaches the
official domain without first loading the application.
