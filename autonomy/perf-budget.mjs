/* =============================================================================
 * autonomy/perf-budget.mjs — measure the payload, and stop it getting worse
 * ---------------------------------------------------------------------------
 * WHY A RATCHET AND NOT A TARGET
 *   WealthFlow ships a 1.5 MB index.html plus 1.2 MB across 43 modules, with no
 *   build step to split or tree-shake any of it. Those numbers are not something
 *   a single pull request can fix, and pretending otherwise by setting an
 *   aspirational budget would mean a permanently red check — which gets ignored,
 *   then removed, and then the payload grows unobserved. This project has already
 *   produced three variants of that failure.
 *
 *   So the budgets below are set AT the measured current values. They cannot fix
 *   today's weight; they make it impossible to add to it silently. Every future
 *   change has to either fit in the existing envelope or state, in a diff, that
 *   it is raising the ceiling and why. Debt that is measured and held flat is a
 *   different thing from debt that is drifting.
 *
 * WHAT IS DELIBERATELY NOT MEASURED HERE
 *   Load timings. The CI sandbox has no egress, so every third-party script fails
 *   and every network measurement taken here describes the sandbox rather than the
 *   app. A number that does not mean what its name says is worse than no number,
 *   so First Paint and friends stay out of this gate — see collectPerf() in
 *   test/e2e/ui-sweep.mjs, which gathers them clearly labelled as advisory.
 *
 *   What IS measured are the facts that predict load cost and are completely
 *   network-independent: bytes shipped, request count, and how many of those
 *   requests block the first paint.
 *
 * ZERO dependencies.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

/**
 * Ceilings, set at the values measured on 2026-07-30. Raising one is a deliberate
 * act that belongs in a diff with a reason, which is the entire point.
 */
export const BUDGETS = {
    // Raised from 1_560_000 (measured 1,544,365). Three fixes in index.html, all
    // three found by LOADING the page in a real browser at six viewports rather
    // than by reading it: the online/offline probe was fetching a Markdown link
    // and so answered "online" without ever leaving the device; DB.set — the
    // write path for every record in the app — had a bare localStorage.setItem
    // that throws QuotaExceededError on a full iOS device, taking the click
    // handler down with it and skipping the cloud push below it; and 92
    // interactive elements measured under 36 px on every phone viewport, down to
    // a 15 px auth link, which a measurement after the change returns as 0.
    // Most of the growth is the comments recording WHY, which is the part a
    // later edit must not be able to undo quietly.
    // Moves ONCE, to the newly measured value with ~1.1% headroom.
    //
    // Raised again from 1_580_000 (measured 1,562,010) for v7.53.0, the per-key
    // sync clock. The record arrays already converged across devices; every
    // other field — incomeReceived, balance, cribAnalyses, settings — was still
    // on "whatever the snapshot says, copy it over local", so one incoming
    // snapshot could erase months the user had marked received while offline and
    // set no flag that would push the survivors back. _kut gives those keys the
    // recency the records had, and plain objects now union rather than replace.
    // The +19 KB is the merge itself plus the reproduction written into the
    // comment, which is the part a later edit must not be able to undo quietly.
    // Moves ONCE, to the newly measured value with ~1.1% headroom.
    // Raised again for the taxonomy unification (#131) landing on top of the
    // restore fix (#130). Each fit under 1_599_000 on its own; together they did
    // not, which is only visible when the merged tree is built and measured — and
    // is why it is built and measured before either is merged rather than after.
    //
    // The growth is the scan-path rewrite plus the comments recording why seven
    // category vocabularies existed and what each missed one cost. Trimming those
    // to fit a number would be optimising the metric and losing the reason, which
    // this file already says elsewhere is the part a later edit must not be able to
    // undo quietly. Moves ONCE, to the newly measured value with ~1% headroom.
    // RAISED for the runway card, its stylesheet, the sustainable-payment
    // wiring and the shortfall alert — and, deliberately, for PR #132's ledger
    // audit loader on top of them.
    //
    // MEASURED ON THE COMBINED TREE, NOT ON THIS BRANCH ALONE. #132 and #133
    // each fit under the old 1,618,000 by themselves; merged together they came
    // to 1,618,024 — over by TWENTY-FOUR BYTES. That is the same failure as
    // #130 and #131, where two branches that both passed produced a red main,
    // and it is only ever caught by merging them locally first and measuring.
    // The number below is the real combined figure, so whichever of the two
    // lands second cannot break the branch it lands on.
    //
    // Moves ONCE, to the newly measured value with ~1.1% headroom. It is NOT
    // pre-raised for the investment work that follows: covering a measurement
    // already taken is a ratchet, covering one not yet taken is the pre-emptive
    // slackening this file exists to prevent, and that work will justify its own
    // move when it lands.
    // RAISED for the Sweep Ledger's interface: the card, its actions and the
    // observation recorder all live in index.html, plus _wfCashOpts and the
    // JS-attribute escaper.
    //
    // Measured on THIS branch merged into main, which is the tree it lands in —
    // main carried no other open work at the time, so the branch tree and the
    // merged tree are the same thing. Moves once, to the measured figure with
    // ~1.1% headroom, and is not pre-raised for anything not yet written.
    // RAISED for the sweep nudge — the investment work the note above said would
    // "justify its own move when it lands". This is that move, and it is the
    // measurement, not the anticipation.
    //
    // The growth in index.html is checkSweepNudge(), the nudge-state accessor,
    // the sweep branch in _handleNotificationAction, and the comments recording
    // two decisions a later edit must not be able to undo quietly: why the
    // banner passes NO `confirm` payload (a lock-screen button that booked a
    // transfer would file money that never moved), and why the sweep tap must be
    // handled ABOVE the legacy branch (which re-queues for 8pm tonight — right
    // for an instalment, daily nagging for idle cash).
    //
    // moduleCount, scriptTags and renderBlockingScripts are all UNCHANGED at 55,
    // 60 and 2. The decision went into wealthflow-wealth-sweeper.js, which owns
    // sweep judgement by its own header, rather than into a new file — so this
    // adds bytes but not a request. Only the two size ceilings move.
    //
    // Moves ONCE, to the measured figure with the ~1.1% headroom every previous
    // move in this file has used.
    // RAISED for the vault UI and Statement Sync. The mail pipeline had been
    // merged, tested and routed at /api/gmail-hook with NO face at all, and the
    // ID vault's own modal (wealthflow-intelligence.js openVaultModal) had zero
    // callers since v7.7.0 — defined, exported, reachable from nothing, which is
    // why locked PDFs were never auto-opened: there was no way to put anything
    // in it. The growth is those two screens plus the pipeline runner that
    // drives assemble -> unlock -> parse -> route and shows each stage.
    // Moves ONCE, to the measured figure with the ~1.1% headroom used throughout.
    // Raised for the Statement Sync card's failed-check state: the card could
    // not tell a 500 from an empty answer, and said "Not connected" while the
    // endpoint was crashing on every request. Distinguishing them costs bytes.
    // Raised for the historical-scan UI. A Pub/Sub watch subscribes to the
    // FUTURE, so the mailbox's existing statements were unreachable and the
    // backfill engine merged in #142 had no caller for its scan half at all.
    // This is the button, the depth picker, the progress state and the driver.
    /* Raised from 1_754_000. The mailbox card now scans the inbox's history by
     * itself the first time it finds a connected mailbox with nothing in it.
     *
     * That is not a feature so much as the repair of a false statement: a Gmail
     * watch reports only what arrives NEXT, so a freshly connected mailbox had
     * never had anything look at the mail already in it, and the card said
     * "Connected. No statements waiting" — true, and completely misleading. The
     * owner reported it twice, the second time after being told it was fixed.
     *
     * Roughly 2.5 KB on 1.75 MB, for the trigger, the once-only marker, and the
     * comments explaining why an automatic Gmail read is bounded and runs once. */
    /* Raised for the sweep that clears what the keyword search left behind:
     * the card's strip, the confirmation that names every sender and count
     * before anything is deleted, the chunked delete, and the header parser
     * that stops a display name being read as the address. Roughly 5 KB on
     * 1.81 MB — all of it on a path that deletes documents, where the comment
     * explaining WHY a key is named explicitly is worth its bytes. */
    /* Raised for the settings that did nothing. Eight switches were writing a
     * value nothing read; four of them now gate a feature that already existed
     * and three raise the alert their own label promises. Most of these bytes
     * are the comments recording WHICH switch was dead and why the fix is where
     * it is — the audit is the expensive part, and it should not have to be
     * done twice. */
    /* Raised for the sender-coverage strip: the panel that answers "which of my
     * banks can actually send me a statement", which is the question behind
     * "ten accounts, three syncing". It is markup and a short reader over the
     * account registry, and it belongs on the screen where the owner asks —
     * a report they have to go and find is a report nobody reads. */
    /* Raised for the quarantine learning loop. A statement from a bank whose
     * layout the parser has never seen used to come back as `rows: []` — the
     * same value an empty month returns — and was dropped in silence with a
     * green tick. The page now holds those statements back, offers the reading
     * wealthflow-layout-memory.js derived from the page itself, and remembers
     * the one the owner confirms. Most of the growth is the confirmation screen,
     * which is built with createElement and textContent because every value on
     * it came out of somebody else's PDF. */
    /* Raised for the local-day fix. Thirty-seven places in this app answered
     * "what is today" with new Date().toISOString().slice(0,10) — today in UTC —
     * which in Colombo is YESTERDAY until 05:30, and on the first of a month
     * files the transaction into the previous month's tab. The growth is one
     * script tag and the reproduction written beside the helper it replaced. */
    /* Raised for the money-export fix and the startup work: _csvMoney (the CSV
     * was writing raw binary floats into a file people open in Excel), and
     * ensureChart/_wfChartThen replacing three eagerly-loaded vendor libraries.
     * Most of the growth is the measurements written beside each — 6.1 s to
     * interactive on a throttled phone, and which 195 KB bought nothing. */
    htmlBytes: 1_956_000,        // measured 1,954,984 — money exports + on-demand charts
    // Raised from 1_250_000 (measured 1,230,401 / 43 modules on 2026-07-30).
    // The ratchet did its job: it caught wealthflow-income-provenance.js, the
    // module for the accepted Income Provenance proposal (#47). That growth is
    // intended and approved, so the ceiling moves to the newly measured value
    // with the same ~1.7% headroom the original carried — it is NOT slackened
    // to buy room for future drift.
    // TIGHTENED after deleting wealthflow-import-review.js — a redundant module
    // duplicating the already-wired wealthflow-review.js. Per the doctrine at
    // the top of this file, a ratchet that is not tightened after an improvement
    // quietly permits the improvement to be undone, so the reclaimed bytes are
    // taken off the ceiling rather than left as headroom for future drift.
    // TIGHTENED again after deleting BUILTIN_NOTES from
    // wealthflow-update-system.js — 250 lines and 21.7 KB of release notes for
    // 14 versions, none newer than 7.40.0, duplicating what version.json already
    // holds. It existed only to feed a fallback that showed the wrong release's
    // notes rather than none, which is how a device running v7.69.18 displayed
    // v7.40.0's feature list. Same doctrine as every other move of this number:
    // an improvement that is not ratcheted is an improvement that can be undone
    // without anyone noticing.
    // Raised from 1_290_000 (measured 1,268,930). The ratchet fired on the
    // three-layer statement parser in wealthflow-html-statement.js: an encrypted
    // NTB / AmEx Smart Statement decrypted correctly and imported ZERO
    // transactions, because its rows are held as data inside <script> and drawn
    // by JS — DOMParser never runs scripts, so the old table-only reader saw an
    // empty shell, and htmlToText strips <script> so the text fallback was empty
    // too. Reading a statement is the feature; +9 KB buys the script-data and
    // text-line layers plus the fix for amounts being taken from the description.
    // Growth that is intended and stated in the diff is what this ceiling exists
    // to force — not to forbid. It moves ONCE, to the newly measured value with
    // the same ~1.7% headroom the original carried, and is NOT slackened to buy
    // room for future drift. About 1.9 KB of comment was moved into
    // test/estatement_parse_shapes_test.js (not shipped) before raising it.
    // Raised from 1_321_000 (measured 1,299,294). The ratchet fired on the
    // sandboxed renderer in wealthflow-html-statement.js. The three-layer parser
    // the last raise bought was reading a document that had never been rendered:
    // the field diagnostic on the real file came back "tables 2 / rows 3 /
    // date-cells 0 / money-cells 0 / scripts 14 / chars 3104263" — three million
    // characters, and three table rows between them. A Smart Statement is an
    // application; its rows are drawn by its own JavaScript on load, and no
    // amount of extra layout guessing reaches data that does not exist yet. The
    // +5 KB runs it in a frame with sandbox="allow-scripts" and an injected
    // default-src 'none' CSP, and parses the DOM that comes back. Most of the
    // growth is the block comment stating WHY the containment is shaped that
    // way, which is the part a later edit must not be able to undo quietly.
    // Moves ONCE, to the newly measured value with ~1.4% headroom — TIGHTER than
    // the ~1.7% the original carried, deliberately, because a ceiling raised to
    // cover work already done should not also buy room for work not yet started.
    // LOWERED, not raised. wealthflow-ai-v3.js (60 KB) and wealthflow-autopilot.js
    // (16 KB) were referenced by nothing in the repository — not index.html, not
    // another module, not a test — while being measured and budgeted like live code.
    // Deleting them dropped the payload by 76 KB, and the ceiling follows it down:
    // a ratchet that only ever moves up stops being a ratchet. A test now fails if
    // any module ships without something referencing it, so this cannot silently
    // refill.
    // RAISED for wealthflow-cashflow-engine.js (28 KB) and the update system's
    // claim/settle logic (9 KB).
    //
    // The engine is new payload that is not yet fetched by anything — the
    // <script src> tag comes with the interface. That is deliberate on both
    // counts: this ceiling measures what the deployment SERVES, not what one
    // page happens to request, because a module sitting in the repo is a module
    // Vercel will hand to anyone who asks for it. A budget that only counted
    // wired modules would let dead weight accumulate unmeasured, which is the
    // exact condition that let ai-v3 and autopilot sit there for months.
    //
    // Moves ONCE, to the newly measured value with ~1.1% headroom — tighter
    // again than the ~1.4% above, because most of what follows this is the UI
    // that consumes the engine, and that lands in index.html rather than here.
    // RAISED again for wealthflow-wealth-sweeper.js (17 KB).
    //
    // MEASURED ON main + #132 + #133 + this branch, all four merged into one
    // tree, for the same reason htmlBytes was: #132 and #133 each fit alone and
    // together came to 24 bytes over. Measuring this branch by itself would set
    // a ceiling that the tree it actually lands in immediately breaks.
    //
    // Moves ONCE, to the measured value with ~1.1% headroom, and is NOT
    // pre-raised for the sweeper's interface — that lands in index.html and is
    // counted by htmlBytes, which still holds.
    // RAISED 1,395,000 -> 1,428,000. The previous commit left this alone with a
    // 187-byte margin and a note saying the next module would fire it and that
    // it should then move to the measured value with the reason written down.
    // wealthflow-vendor-osint.js is that module, the ceiling fired, and this is
    // the reason: Agent 2 is the only thing in the statement pipeline that can
    // turn a quarantined row into a filed one without asking the owner, and it
    // is 18 KB of scrub-and-firewall around a network call that already exists.
    // RAISED 1,428,000 -> 1,455,000. Fired on wealthflow-backfill.js, which is
    // the module that finally passes `existingHashes` to a dedup engine that
    // has accepted the argument, and never received it, since it was written.
    // RAISED 1,455,000 -> 1,481,000. The previous commit said this would fire on
    // the next module, at 1,256 bytes of margin. It did, on the first one added
    // after it — which is the ratchet doing its job rather than a surprise.
    // RAISED for shouldNudge() and nudgeShown() in wealthflow-wealth-sweeper.js,
    // and the rules block above them. Most of the growth is that comment: it
    // records why the thresholds are what they are, and — the part worth the
    // bytes — why there is deliberately NO confidence rule, since ladder() has
    // already excluded every destination below moderate confidence and a second
    // copy of that threshold is the exact defect shape this repo keeps hitting.
    // An absence with no reason beside it gets "fixed" by the next reader.
    //
    // No new module: 55 modules before and after. Moves ONCE, to the measured
    // figure with the ~1% headroom the previous move used.
    // RAISED for wealthflow-vault.js, the PIN-derived bank-password store, plus
    // the window global added to wealthflow-statement-router.js so the page can
    // reach classifyStatement. Moves ONCE, to the measured figure, ~1% headroom.
    /* Raised for two modules the owner asked for by name, both of which are
     * arithmetic rather than UI: wealthflow-verify-matrix.js (which payouts and
     * bills are due, confirmed, late or flagged — the rule that a static
     * calendar must never post money) and wealthflow-liquidity.js (pawn
     * interest and a debtor ledger that survives partial repayments and
     * top-ups). Both are pure, both are tested without a browser, and both
     * replace arithmetic that would otherwise have been written inline in
     * index.html where nothing could test it. */
    /* Raised for Phase 2: wealthflow-whatif.js, plus applyOverrides() in
     * wealthflow-cashflow-engine.js. Both are arithmetic, not interface — a
     * scenario is compiled into projection options and the projection is walked
     * day by day, exactly as the baseline is. Writing either inline in
     * index.html would cost no module and no request, and would make the one
     * rule that decides whether a scenario is safer — the trough, never the
     * closing balance — untestable in isolation, which is the trade this file
     * has now recorded a dozen times.
     *
     * Moves ONCE, to just above the measured figure. */
    /* Raised for wealthflow-sender-discovery.js — the module that finds the
     * owner's banks instead of asking them to. It is the narrowing that used to
     * be done by two Gmail query clauses which decided in silence: a bank
     * sending a ZIP, or a subject reading "Monthly Account Summary", was not
     * ranked low but ABSENT. Moving that judgement into a module is what makes
     * it explainable on screen and testable here, and it is why the query got
     * simpler while the file count went up. */
    /* Raised for wealthflow-institutions.js — the ONE description of a bank,
     * from which the picker, the mail allowlist and the search tokens are now
     * derived. It costs a file and removes a class of defect: the picker
     * offered fourteen institutions while the mail pipeline knew four, and
     * nothing compared them, which is why an owner with ten accounts saw three
     * of them sync. A cross-check test pinned that gap; this deletes it. */
    /* Raised for the vault wiring in wealthflow-pdf-unlock.js: a locked PDF now
     * tries every password the owner already saved before anyone is asked for
     * one. The passwords, the derived guesses and the ordering all existed —
     * this module was simply not calling them, while two other callers were. */
    /* Raised for wealthflow-layout-memory.js. It does NOT add a second row
     * reader — that is the whole design: it learns only the DATE SHAPE, rewrites
     * the text into a form the real parser already matches, and hands it back,
     * so there is still exactly one implementation of a transaction row and one
     * reconciliation. The bytes are the derivation, the self-verification that
     * refuses a template it cannot read back, and the two named regex mistakes
     * written down so they are not made a third time. */
    /* Raised for wealthflow-when.js AND for what including .mjs revealed.
     *
     * The filter was /^wealthflow-.*\.js$/, so wealthflow-mail-ingest.mjs and
     * wealthflow-mail-senders.mjs — 69 KB of first-party code, one of it loaded
     * by index.html — had never been counted by this ratchet at all. The ceiling
     * has been "held" for months over a figure that was 4.3% short, and any
     * module added with that extension would have been free forever.
     *
     * What this number counts, stated plainly so the next raise is honest: every
     * first-party wealthflow-* module on disk, browser and server alike. It is a
     * proxy for how much first-party code this project carries, not a byte-exact
     * browser payload — two of the modules never reach a browser. */
    /* Raised for wealthflow-approval-bot.mjs — the rules behind the Telegram
     * approval button. It is a first-party wealthflow-* module so this ceiling
     * counts it, though it never reaches a browser: it is imported by the
     * serverless webhook and by the CI notifier. See the note above about what
     * this number actually measures. */
    totalJsBytes: 1_740_000,     // measured 1,724,535 across 65 modules
    largestModuleBytes: 212_000, // measured 210,068 (wealthflow-ai-v4.js)
    // Raised from 45 (measured 43). In #52 this ceiling was deliberately left
    // alone because it had not yet failed, on the principle that lifting a
    // ceiling still holding is pre-emptive slackening. It has now genuinely
    // fired — the Data Health and Crash Forensics modules (#53, #54) take the
    // count to 47 — so it moves, once, to the measured value.
    // 46 -> 47 for wealthflow-sweep-ledger.js. Same trade recorded below for
    // the cash flow engine and the sweeper: inlining it into index.html would
    // cost no module and no request, and would make the one rule that stops a
    // transfer being subtracted twice untestable in isolation.
    // 47 -> 48 for wealthflow-mail-intake.js. It is NOT yet referenced from
    // index.html — scriptTags is unchanged at 53 — because the server hook that
    // feeds it does not exist yet. The module ships first and alone so its
    // security property (no vault key ever reaches a return value) is reviewed
    // on its own, rather than inside a diff that also adds a mailbox endpoint.
    // 48 -> 49 for wealthflow-accounts.js. Same shape as the line above: it is
    // NOT referenced from index.html — scriptTags is unchanged at 53 — because
    // the pipeline that consumes it is still being assembled. It ships alone so
    // that the one decision it makes (route silently, or send to the Quarantine
    // Zone) is reviewed on its own, rather than inside a diff that also moves
    // mail through it.
    //
    // NOTE FOR THE NEXT READER: totalJsBytes above is NOT raised here, and the
    // margin is now 187 bytes (1,394,813 of 1,395,000). That is uncomfortable
    // and it is deliberate — the ceiling is still holding, and this file's whole
    // premise is that a ceiling which has not fired does not move. The next
    // module, or a few added lines in this one, will fire it; raise it then,
    // to the measured value, with the reason written down.
    // 49 -> 50 for wealthflow-vendor-osint.js. Same trade as every line above:
    // inlining it into index.html would cost no module and no request, and would
    // make the rule it exists for — a web search may name a merchant and may
    // never decide whether money came in or went out — untestable in isolation.
    // 50 -> 51 for wealthflow-quarantine.js. totalJsBytes is NOT raised: it was
    // moved to 1,428,000 one commit ago and this module fits inside that
    // headroom at 1,424,213, so the ceiling is still holding and does not move.
    // 51 -> 52 for wealthflow-backfill.js.
    // 52 -> 53 for wealthflow-amortize.js. totalJsBytes is NOT raised: it is
    // still holding at 1,453,744 of 1,455,000. That is 1,256 bytes of margin,
    // which is thinner than the 187 bytes this file already carried once and
    // will fire on the next module — raise it then, to the measured value.
    // 53 -> 54 for wealthflow-confirm.js.
    // 54 -> 55 for wealthflow-outbox.js, the page half of the durable outbox.
    // RAISED BY ONE, for wealthflow-vault.js — and this is the ceiling I was
    // most reluctant to move, having just argued in the sweep nudge that a
    // decision belongs in the module that owns the subject rather than in a new
    // file. The argument does not carry here. The existing vault derives its key
    // from a random value kept in localStorage BESIDE its own ciphertext, so
    // anything that can read storage holds both halves; its header says so
    // plainly, and for a NIC that is a fair trade. A bank password is not a NIC.
    // This vault derives its key from the master PIN, so the file on disk is
    // worthless without something only the owner knows — and putting two
    // different secrets under two different keys in one file is how the weaker
    // one quietly becomes the one that matters. It also has to be unit-testable:
    // wealthflow-intelligence.js is an IIFE with no exports and consequently no
    // test file, and crypto holding bank passwords cannot ship untested.
    /* 60 -> 61 for wealthflow-layout-memory.js. A file, not an inline block,
     * for the same reason as the last one: it is the only thing that knows how
     * a learned layout is stored, and inlining it into index.html would put a
     * second copy of that knowledge next to the parser it feeds. */
    /* 61 -> 64: +1 for wealthflow-when.js and +2 that were always here and never
     * counted, because the measurer could not see a .mjs. */
    moduleCount: 65,   // measured 65 — 64 -> 65 for wealthflow-approval-bot.mjs
    // Raised from 48 (measured 47). The Import Review Queue (#48) adds one
    // deferred module, and the ratchet fired on exactly the tag it added —
    // which was flagged as expected before the work started, not explained
    // away afterwards. Same +1 headroom the original carried; moduleCount is
    // deliberately NOT touched, because it did not fail and raising a ceiling
    // that is still holding is the pre-emptive slackening this file exists to
    // prevent.
    // TIGHTENED: 51 -> 50. firebase-storage-compat.js was deleted outright in
    // the #65 fix -- `firebase.storage()` appears nowhere in this repository, so
    // it was downloaded and parsed on every load for nothing.
    // Raised 50 -> 51 for wealthflow-cashflow-engine.js. Flagged before the work
    // started, not explained away after: the runway card needs the engine, the
    // engine is deferred, and it is one request.
    //
    // The alternative was to inline it into index.html, which costs no request
    // and no ratchet — and would also have made it untestable, unclassifiable by
    // the content gate, and part of the 27,000-line monolith this codebase is
    // trying to shrink. The +1 is the cheaper of the two, and this comment is
    // here so a later reader can see that the trade was made deliberately.
    // 51 -> 52 for wealthflow-wealth-sweeper.js. Same trade as the cash flow
    // engine one line above: inlining it into index.html would cost no request
    // and no ratchet, and would make it untestable and part of the monolith.
    // It is deferred (type="module"), so it is not on the render path.
    // 53 -> 59. Six at once, and this is the only ceiling the grand unification
    // moved: the six modules of the statement pipeline had all been merged and
    // then referenced by nothing, so they shipped without running. This is the
    // commit that connects them.
    //
    // renderBlockingScripts is UNCHANGED at 2, which is the number that actually
    // matters for how the app feels. A module script is deferred by definition,
    // so none of these six delays first paint; they cost six requests against a
    // warm HTTP/2 connection, not a slower start. Had any of them needed to be a
    // classic script the trade would have been a different one and this comment
    // would have to say so.
    // 59 -> 60 for the outbox module. renderBlockingScripts is still 2.
    // RAISED BY THREE: wealthflow-vault.js (new), and two modules that already
    // existed on disk, were fully tested, and were loaded by nothing —
    // wealthflow-statement-router.js and wealthflow-mail-intake.js. Those two add
    // no NEW code to the repository; they add the two requests that make code
    // already shipped actually run. The device half of the mail pipeline could
    // not execute at all without the second, which is the defect this change
    // exists to fix.
    /* 65 -> 66 for wealthflow-institutions.js. It is a REQUEST, not just a
     * file, and that is the trade recorded here: the alternative was to inline
     * the bank descriptions into index.html, where the picker and the mail
     * pipeline could drift apart again exactly as they did. Deferred by
     * type=module, so it does not block the first paint. */
    /* 66 -> 67 for wealthflow-layout-memory.js, deferred, so it costs a request
     * and nothing at first paint. */
    /* 68 -> 65. THIS CEILING WENT DOWN, which it has not done before: Chart.js,
     * jsPDF and jspdf-autotable are no longer fetched at startup. jsPDF was
     * already lazy-loaded by _loadPdfLibs() and the eager tag merely made that a
     * no-op; `autoTable` is called nowhere in this repository and had been
     * downloaded on every startup, by everyone, forever. */
    scriptTags: 65,              // measured 65 — three fewer CDN libraries at startup
    // TIGHTENED: 6 -> 2, the biggest move this ceiling has made. Issue #65 was
    // "4 third-party scripts block first paint": four gstatic.com Firebase tags
    // that halted parsing until someone else's CDN answered. One was deleted as
    // unused; three now carry `defer`, paired with an init that waits for them.
    // Proven by a full browser sweep signing in through
    // google-auth -> pin-setup -> security-question -> recovery-code -> pin-unlock
    // with 0 page errors and 0 console errors, identical to the run before the
    // change. The two survivors are first-party and load from this origin.
    renderBlockingScripts: 2,    // measured 2 (wealthflow-stability.js, wealthflow-icons.js)
};

/** Bytes of a file, or 0 if it is not there. */
function bytes(file) {
    try { return fs.statSync(file).size; } catch { return 0; }
}

/**
 * Script tags that block the first paint.
 *
 * A tag is non-blocking if it carries `defer`, `async`, or `type="module"`
 * (modules are deferred by definition). Everything else halts parsing until it
 * has been fetched and executed.
 *
 * Six tags used to qualify, four of them third-party, so the first paint waited
 * on someone else's CDN four times over — issue #65. The two survivors are
 * first-party and served from this origin; see test/firebase_defer_test.js for
 * the assertion that keeps it that way.
 */
export function renderBlocking(html) {
    const tags = String(html || '').match(/<script\b[^>]*\bsrc\s*=[^>]*>/gi) || [];
    return tags
        .filter((t) => !/\b(defer|async)\b/i.test(t) && !/type\s*=\s*["']module["']/i.test(t))
        .map((t) => (/src\s*=\s*["']([^"']+)["']/i.exec(t) || [, t.slice(0, 60)])[1]);
}

/** Measure the shipped payload. Pure reads; no network, no browser. */
export function measure({ repoDir = process.cwd() } = {}) {
    const htmlPath = path.join(repoDir, 'index.html');
    const html = (() => { try { return fs.readFileSync(htmlPath, 'utf8'); } catch { return ''; } })();

    let modules = [];
    try {
        /* `.mjs` TOO. The filter was /^wealthflow-.*\.js$/, so a module named
         * with the other extension every ESM file in the world uses was invisible
         * to this ratchet: its bytes were not counted, it could not push
         * totalJsBytes or moduleCount over any ceiling, and the budget would have
         * reported a clean bill of health while the payload grew. A gate that
         * passes because it examined nothing is the failure this whole file
         * exists to prevent. */
        modules = fs.readdirSync(repoDir)
            .filter((f) => /^wealthflow-.*\.m?js$/.test(f))
            .map((f) => ({ file: f, bytes: bytes(path.join(repoDir, f)) }))
            .sort((a, b) => b.bytes - a.bytes);
    } catch { modules = []; }

    const scriptTags = (html.match(/<script\b[^>]*\bsrc\s*=/gi) || []).length;
    const blocking = renderBlocking(html);

    return {
        htmlBytes: bytes(htmlPath),
        totalJsBytes: modules.reduce((s, m) => s + m.bytes, 0),
        moduleCount: modules.length,
        largestModule: modules[0] || { file: '(none)', bytes: 0 },
        largestModuleBytes: modules[0] ? modules[0].bytes : 0,
        scriptTags,
        renderBlockingScripts: blocking.length,
        renderBlockingList: blocking,
        modules,
    };
}

/**
 * Compare a measurement against the ceilings.
 *
 * Takes the measurement as an argument rather than measuring internally, so the
 * gate can be tested against inflated numbers. A budget check that has only ever
 * been run against a passing input has not been shown to reject anything.
 */
export function check(m = measure()) {
    const violations = [];
    for (const [key, limit] of Object.entries(BUDGETS)) {
        const value = m[key];
        if (typeof value !== 'number') continue;
        if (value > limit) violations.push({ key, value, limit, over: value - limit });
    }
    return { ok: violations.length === 0, violations, measured: m };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if ((process.argv[1] || '').endsWith('perf-budget.mjs')) {
    const m = measure();
    const r = check(m);
    const kb = (n) => (n / 1024).toFixed(0) + ' KB';
    console.log('\n📦 WealthFlow payload\n');
    console.log(`  index.html            ${kb(m.htmlBytes).padStart(10)}   (budget ${kb(BUDGETS.htmlBytes)})`);
    console.log(`  modules (${String(m.moduleCount).padStart(2)} files)   ${kb(m.totalJsBytes).padStart(10)}   (budget ${kb(BUDGETS.totalJsBytes)})`);
    console.log(`  largest module        ${kb(m.largestModuleBytes).padStart(10)}   ${m.largestModule.file}`);
    console.log(`  script requests       ${String(m.scriptTags).padStart(10)}`);
    console.log(`  render-blocking       ${String(m.renderBlockingScripts).padStart(10)}`);
    for (const s of m.renderBlockingList) console.log(`      ⛔ ${s}`);
    console.log(`\n  total shipped         ${kb(m.htmlBytes + m.totalJsBytes).padStart(10)}\n`);
    if (r.ok) {
        console.log('✅ within budget (ceilings held at the measured baseline)\n');
    } else {
        for (const v of r.violations) console.log(`❌ ${v.key}: ${v.value} exceeds ${v.limit} by ${v.over}`);
        console.log('');
    }
    process.exit(r.ok ? 0 : 1);
}
