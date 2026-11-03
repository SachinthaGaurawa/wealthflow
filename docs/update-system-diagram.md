# WealthFlow update system on one page

This is the whole path from "the owner types a report" to "the owner's phone runs the fix", and the safety nets around it.
Every box is something that exists in this repository today. Colour says how far to trust it:

* **green** is live and was exercised by a test or a run;
* **blue** is new in PR #506 (this work): tested, and live after that PR is released;
* **amber** is built but needs something only the owner can supply (a token or a repository variable), so it is **not** claimed as running;
* **grey, dashed** is something the research report asked for that is not possible on a free tier, with the reason.

The same picture, rendered, is `update-system-diagram.svg` / `.png` in the project files.

## 1. The whole system

```mermaid
flowchart TB
  classDef live fill:#e7f6ee,stroke:#1f9d6b,color:#0b3d2a,stroke-width:1.5px
  classDef new fill:#e3eeff,stroke:#2f6fe4,color:#0b2a66,stroke-width:2.5px
  classDef owner fill:#fff1d1,stroke:#d9922b,color:#5a3a00,stroke-width:1.5px,stroke-dasharray:6 3
  classDef never fill:#f1f1f1,stroke:#9a9a9a,color:#555,stroke-dasharray:2 4
  classDef human fill:#fde8ef,stroke:#d14a7a,color:#5a1030,stroke-width:1.5px

  subgraph A["1 · Intake · වාර්තාව ලැබීම"]
    direction LR
    A1["Settings → send feedback<br/>retry queue when offline"]:::live
    A2["/api/feedback-triage<br/>AI classifies, attaches the device's<br/>own diagnostics, opens a GitHub issue"]:::live
    A3["autonomous-discover (daily scan)<br/>proposal-intake (Firestore clusters)<br/>security-updates (dependencies)"]:::live
    A1 --> A2
    A3 ~~~ A1
  end

  subgraph B["2 · Fix agent · AI නිවැරදි කිරීම (free-tier models only)"]
    direction LR
    B1["autonomous-fix.yml<br/>issue opened · cron · manual<br/>3 attempts, then ai-stuck"]:::live
    B2["Select file → author the change<br/>(whole file or exact SEARCH/REPLACE)"]:::live
    B3["Mechanical gates<br/>structure · node --check ·<br/>sensitive-path gate"]:::live
    B4["Agent 5 security veto<br/>on a DIFFERENT provider"]:::live
    B5["Measure before / after<br/>no visible effect → back to the author<br/>(2 revisions)"]:::live
    B6["Agent 4 proving test<br/>real Vitest, red → green"]:::live
    B7["Pull request"]:::live
    B1 --> B2 --> B3 --> B4 --> B5 --> B6 --> B7
    R["LLM router: 13 providers, failover,<br/>retired models heal themselves"]:::live -.-> B2
  end

  subgraph C["3 · Gates before merge · merge වීමට පෙර ගේට්"]
    direction LR
    C1["Tests + fuzz<br/>~400 files, 11.7k tests"]:::live
    C2["Review board: 3 models<br/>unanimous PASS needed<br/>+ release score 0-100"]:::new
    C3["OPA / conftest<br/>policy rules"]:::live
    C4["Secret scan · perf budget<br/>risk gate"]:::live
    C5["Real-browser e2e<br/>update journey · diagnosis ·<br/>migrations · self-healing locators"]:::new
    C6["Guarded paths need a human<br/>(label human-approved after the last push)"]:::human
    C1 --- C2 --- C3
    C4 --- C5 --- C6
  end

  subgraph D["4 · Release · නිකුත් කිරීම"]
    direction LR
    D1["auto-merge<br/>(squash)"]:::live
    D2["auto-release gates<br/>tests on the exact commit ·<br/>production health ·<br/>substantive-change check"]:::live
    D3["release.cjs<br/>version bump · honest notes<br/>from the real commits"]:::live
    D4["Vercel deploy"]:::live
    D5["Confirm LIVE<br/>/api/version · /version.json · /app"]:::live
    D6["Browser canary<br/>real Chromium opens the live app:<br/>loads · version · files · errors ·<br/>updater present · service worker"]:::new
    D7["Red run + canary-failed issue<br/>(looked at twice before it counts)"]:::new
    D8["Instant Rollback<br/>needs VERCEL_TOKEN +<br/>CANARY_ROLLBACK=true"]:::owner
    D1 --> D2 --> D3 --> D4 --> D5 --> D6
    D6 -- "failed" --> D7 -.-> D8
  end

  subgraph E["5 · The device · උපාංගය යාවත්කාලීන වීම"]
    direction LR
    E1["sw.js + /api/version<br/>the device notices a newer build"]:::live
    E2["Dashboard notice + Settings card<br/>What's new — the choice is the owner's"]:::live
    E3["Agreement (scroll to the end)<br/>→ PIN"]:::live
    E4["Restore point first<br/>result recorded: saved / not-saved"]:::new
    E5["Real progress bar + countdown<br/>files counted n / N"]:::live
    E6["Swap · reload<br/>claim settled against what really loaded"]:::live
    E7["'What changed' popup<br/>failed target → not offered again"]:::live
    E8["Feedback marked done<br/>/api/feedback-status<br/>(the loop back to Intake)"]:::live
    E1 --> E2 --> E3 --> E4 --> E5 --> E6 --> E7 --> E8
  end

  subgraph F["6 · Safety nets · ආරක්ෂණ"]
    direction LR
    F1["pipeline-liveness<br/>a dead pipeline files an issue"]:::live
    F2["health-watchdog<br/>two failed probes → rollback"]:::owner
    F3["/api/autonomy-status<br/>+ release stall detector"]:::live
    F4["Copy diagnostics<br/>10-link chain judged on the device"]:::live
    F5["Data-migration runner<br/>proved on a copy · restore point ·<br/>reverted if the books don't check out"]:::new
    F6["Auto-backup schedule<br/>restore points"]:::live
    F1 ~~~ F2 ~~~ F3 ~~~ F4 ~~~ F5 ~~~ F6
  end

  subgraph G["7 · Asked for, not possible here · නොහැකි දේ"]
    direction LR
    G1["Vercel Rolling Releases 5%<br/>both endpoints answer 404 on this plan"]:::never
    G2["100k agents · quantum snapshot ·<br/>holographic DB · Pinecone ·<br/>Sentry Seer · E2B sandboxes"]:::never
    G3["'100% correct' from an AI judge<br/>an LLM cannot certify it"]:::never
    G1 ~~~ G2 ~~~ G3
  end

  subgraph H["Legend · සටහන"]
    direction LR
    H1["Live and exercised"]:::live
    H2["New in PR #506<br/>(tested)"]:::new
    H3["Needs something only<br/>the owner can supply"]:::owner
    H4["A person must approve"]:::human
    H5["Not possible on a free tier"]:::never
    H1 ~~~ H2 ~~~ H3 ~~~ H4 ~~~ H5
  end

  A --> B
  B --> C
  C --> D
  D -- "canary passed" --> E
  E ~~~ F
  F ~~~ G
  G ~~~ H
```

## 2. One update on the owner's phone (the iOS / Android path)

```mermaid
sequenceDiagram
  autonumber
  participant O as Owner
  participant D as Device (sw.js + update module)
  participant S as Server (/api/version, version.json)
  participant B as Backup (backupNow)
  O->>D: opens WealthFlow
  D->>S: is there a newer build? (poll + service worker)
  S-->>D: 7.70.0 (+ honest notes from the commits)
  D-->>O: "Update available" on Dashboard and in Settings
  Note over O,D: nothing installs until the owner says so
  O->>D: Update now
  D-->>O: agreement for this exact version (Agree locked until scrolled to the end)
  O->>D: Agree + PIN
  D->>B: restore point first
  B-->>D: saved / not-saved (recorded as it came out)
  loop every file of the new build
    D->>S: fetch file n of N
    D-->>O: progress bar + "about Ns remaining"
  end
  D->>D: swap and reload
  D->>D: settle the claim: what really loaded?
  alt the new build is the one running
    D-->>O: "What changed" popup, then back to the Dashboard
    D->>S: feedback marked done
  else it did not land
    D-->>O: says so, does not offer that build again
  end
```

## 3. What each Omni-Matrix idea became

| Idea in the research report | In this repository | Status |
|---|---|---|
| Agentic self-repair from feedback | issue → 5-role swarm → proving test → PR (`autonomous-fix.yml`) | live; it opened no PR on its own yet, see the report |
| LLM-as-a-Judge in CI/CD | 3-model review board, unanimous stated PASS, now with a 0-100 release score and a refusal of a PASS under 60 | live after #506; the **score is not the gate**, the unanimous PASS and the deterministic checks are |
| "Only 100% correct and safe is approved" | cannot be certified by an LLM; the gates are tests, fuzz, policy rules, secret scan, budgets, a real browser | stated honestly |
| Self-healing DOM, agentic QA | `test/e2e/heal.mjs`: ordered locators, ambiguity refused, every heal logged with the selector to use, a missing control still fails | live after #506 |
| Autonomous schema migrations with rollback | `wealthflow-migrations.js`: proved on a copy, restore point first, reverted on any failure, registry empty today | live after #506 |
| Canary / Rolling Releases, 5% first | Rolling Releases unavailable (404); a real-browser canary opens the live release, optional Instant Rollback | canary live after #506; rollback needs `VERCEL_TOKEN` and `CANARY_ROLLBACK=true` |
| Instant Rollback | `health-watchdog.yml` (two failed probes) and the canary | needs `VERCEL_TOKEN` and `HEALTH_URL` from the owner |
| 100,000 agents, quantum snapshot, holographic DB, Pinecone, Sentry Seer, E2B | none of these is possible on a free tier | not built, said plainly |
