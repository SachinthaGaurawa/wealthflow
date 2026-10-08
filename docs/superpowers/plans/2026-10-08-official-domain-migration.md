# WealthFlow Official Domain Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://www.wealthflow.lk` and `info@wealthflow.lk` the sole public WealthFlow identity while preserving every legacy deep link.

**Architecture:** A shared server identity module and an early browser canonical-origin value replace independent hard-coded origins. Vercel owns HTTP host redirects; GitHub Pages uses a pre-boot fallback; every public-link producer consumes the canonical identity.

**Tech Stack:** Static HTML/JavaScript PWA, Node.js ESM serverless handlers, Vercel routing, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-official-domain-migration-design.md`

## Global Constraints

- Canonical origin is exactly `https://www.wealthflow.lk`.
- Canonical customer-facing email is exactly `info@wealthflow.lk`.
- Preserve path, query, and hash when migrating a legacy URL.
- Never rewrite bank sender, user, OAuth-provider, or GitHub automation email addresses.
- Never turn the migration into an open redirect.
- Keep same-origin API calls relative on the official deployment.
- Existing share identifiers and tenant tokens must remain valid.
- Write and observe every regression test failing before implementation.

## Review Focus

- A GitHub Pages URL with `/wealthflow`, nested path, query, and hash must lose only the deployment prefix.
- A legacy stored share URL must change host without changing its identifier or parameters.
- A malicious or unrelated external URL must never be canonicalized as WealthFlow.
- A malformed environment override must fall back to the official origin.
- A preview/local build must still call its own relative API unless it explicitly needs the public production origin.

---

### Task 1: Canonical public identity

**Files:**
- Create: `wealthflow-public-identity.mjs`
- Create: `test/public_identity_test.js`
- Modify: `tenant-links.mjs`
- Modify: `statement-store.js`

**Interfaces:**
- Produces: `OFFICIAL_ORIGIN`, `OFFICIAL_EMAIL`, `publicOrigin(env)`, `publicUrl(path, env)`, and `canonicalizeLegacyUrl(value)`.
- Consumers: server link producers in Tasks 2 and 3.

- [ ] **Step 1: Write failing identity and URL-behavior tests**

Assert the exact canonical constants, valid HTTPS override behavior, rejection of credentials/query/hash/path overrides, path joining, legacy-host normalization, and no change to arbitrary external URLs.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/public_identity_test.js`

Expected: FAIL because `wealthflow-public-identity.mjs` does not exist.

- [ ] **Step 3: Implement the shared identity module and migrate the two existing server constants**

Keep tenant token formats and statement share IDs unchanged; only their public origin changes.

- [ ] **Step 4: Run focused tests and dependent link tests**

Run: `npx vitest run test/public_identity_test.js test/loan_link_test.js test/share_admin_sdk_test.js test/share_no_thirdparty_test.js test/tenant_portal_test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: centralize WealthFlow public identity`

### Task 2: Browser links and legacy-host migration

**Files:**
- Create: `test/official_domain_browser_test.js`
- Modify: `index.html`
- Modify: `wealthflow-ai-v4.js`
- Modify: `wealthflow-route.js`
- Modify: `wealthflow-vision-ocr.js`
- Modify: `api/ai.js`
- Modify: `api/vision-scan.js`
- Modify: `.github/workflows/merchant-sync.yml`

**Interfaces:**
- Consumes: canonical origin and legacy host rules from Task 1.
- Produces: browser global `window.WF_PUBLIC_ORIGIN` and pre-boot legacy-host redirect behavior.

- [ ] **Step 1: Write failing browser and provider-attribution tests**

Exercise GitHub Pages root and nested URLs with path/query/hash, official-host no-op behavior, local/preview relative APIs, recovery/OAuth/share/Elite Report URL production, and official OpenRouter `HTTP-Referer` values.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/official_domain_browser_test.js`

Expected: FAIL with generated or redirected URLs containing the old Vercel host.

- [ ] **Step 3: Add the pre-boot redirect and migrate browser/server consumers**

Use an explicit legacy-host check and `location.replace`. Do not make ordinary official-host API fetches absolute.

- [ ] **Step 4: Run focused and existing browser/build tests**

Run: `npx vitest run test/official_domain_browser_test.js test/frontend_wiring_test.js test/share_no_thirdparty_test.js test/statement_build_test.js test/pwa_update_test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: route public links through wealthflow.lk`

### Task 3: Vercel redirects and official email

**Files:**
- Create: `test/official_identity_contract_test.js`
- Modify: `vercel.json`
- Modify: `feedback.js`
- Modify: `send-otp.js`
- Modify: `index.html`
- Modify: relevant deployment documentation and current workflow examples

**Interfaces:**
- Consumes: canonical values from Task 1.
- Produces: permanent legacy-host redirects and official customer-facing mail defaults.

- [ ] **Step 1: Write failing routing and email contract tests**

Parse `vercel.json` and assert direct permanent redirects for both legacy Vercel hosts before SPA rewrites. Exercise feedback and OTP sender selection, and assert that unrelated bank/user/bot addresses remain untouched.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx vitest run test/official_identity_contract_test.js`

Expected: FAIL because redirects are absent and old customer-facing defaults remain.

- [ ] **Step 3: Implement redirects and official sender defaults**

Place host redirects before rewrites. Preserve path and query. Use
`info@wealthflow.lk` for customer-facing defaults and fail honestly if a sender
provider rejects an unverified address.

- [ ] **Step 4: Run focused email, routing, and security tests**

Run: `npx vitest run test/official_identity_contract_test.js test/otp_recovery_test.js test/api_contract_test.js test/sensitive_paths_test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: enforce official domain and email identity`

### Task 4: Inventory guard, build, and live verification

**Files:**
- Create: `test/legacy_origin_inventory_test.js`
- Modify: any remaining production file identified by the failing inventory test
- Modify: `version.json`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a regression gate preventing reintroduction of legacy public identity.

- [ ] **Step 1: Write and run the failing production inventory test**

Reject legacy domains and obsolete customer-contact emails in shipped runtime
sources, except the explicit migration allow-list, redirect configuration, tests,
and historical release notes.

Run: `npx vitest run test/legacy_origin_inventory_test.js`

Expected: FAIL and enumerate every remaining production reference.

- [ ] **Step 2: Remove each remaining runtime reference at its owning data-flow boundary**

Do not replace test fixtures, bank sender examples, package metadata, or historical
release notes unless they are actually user-facing runtime data.

- [ ] **Step 3: Verify focused tests, full suite, build, and built-tree boot**

Run: `npm test`

Expected: all tests PASS.

Run: `node build.mjs`

Expected: build validation PASS without writing the worktree.

Run: `node test/e2e/build-boot.mjs`

Expected: built application boots successfully.

- [ ] **Step 4: Deploy preview and verify the HTTP/browser redirect matrix**

Check official apex and `www`, both Vercel legacy hosts, GitHub Pages, a nested
path, a query-bearing share link, and a hash-bearing recovery link. Confirm the
final browser URL and that generated loan, Elite Report, backup/handoff, and SMS
portal links use the official origin.

- [ ] **Step 5: Commit**

Commit message: `test: prevent legacy WealthFlow identity regressions`

- [ ] **Step 6: Open PR, review the complete diff, merge, and repeat live checks**

Attach the PR to this chat, wait for deployment, and verify the production
redirect and generated-link behavior before reporting completion.
