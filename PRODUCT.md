# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

WealthFlow serves people managing personal finances in Sri Lanka and the customers who receive securely shared financial statements through tenant links. The primary operator needs to understand cash flow, income, expenses, cards, loans, subscriptions, and imported bank statements without manually reconciling fragmented records.

## Product Purpose

WealthFlow turns financial inputs—including authorized email bank statements—into a trusted personal-finance workspace. Success means that people can reach the right financial task quickly, understand the current state at a glance, and complete sensitive actions without visual ambiguity or broken data flows.

## Positioning

WealthFlow combines a private financial operating system with autonomous statement ingestion, multi-engine classification, and securely shared customer statements in one first-party product.

## Operating Context

- Public visitors enter through the official marketing site at `https://www.wealthflow.lk/`.
- Authenticated operators use the secure application at `/app` with PIN and biometric access where supported.
- Customers open tokenized tenant workspaces under `/t/<token>` and pass the existing NIC and OTP authorization gates.
- The application handles financial dashboards, bank statements, loans, reports, SMS notifications, customer portals, and document sharing.

## Capabilities and Constraints

- Preserve all existing finance calculations, storage contracts, statement ingestion, deduplication, Text.lk notifications, and NIC/OTP security behavior while changing presentation.
- Keep marketing, secure app, and tenant portal routes and bundles distinct.
- The official origin is `https://www.wealthflow.lk` and the official contact address is `info@wealthflow.lk`.
- No emoji may be used as production interface icons; use the official vector identity and a consistent SVG icon system.
- Financial states must remain readable on desktop, tablet, and mobile, with keyboard navigation and reduced-motion support.
- Never fabricate balances, customer proof, performance results, or financial claims.

## Brand Commitments

The product name is WealthFlow. The physical SVG identity in `assets/brand/` is the visual source of truth. The user explicitly approved a premium, professional, modern FinTech direction with dark high-contrast surfaces, restrained glass effects, precise typography, fluid interaction, and quality comparable in discipline—not imitation—to Stripe, Linear, and Revolut.

## Evidence on Hand

- Existing production UI and workflows in `index.html`, `tenant.html`, `tenant-page.js`, and related modules.
- Official SVG brand assets in `assets/brand/`.
- Existing automated test suite and Playwright UI harness under `test/`.
- No approved testimonials, customer logos, or externally verified performance claims are available; future work must not invent them.

## Product Principles

1. Financial truth before decoration.
2. One clear next action per state.
3. Sensitive operations remain explicit, reversible where possible, and securely gated.
4. Fast perceived response without hiding background synchronization state.
5. A consistent first-party identity across marketing, application, reports, and customer portals.

## Accessibility & Inclusion

Meet WCAG AA contrast for core content and controls, preserve keyboard and assistive-technology navigation, respect reduced-motion and reduced-transparency preferences, and keep financial numerals legible at mobile sizes.
