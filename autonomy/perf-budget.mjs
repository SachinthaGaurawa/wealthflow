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
    /* Raised for the four defects the owner reported together: the Gmail
     * junk filter (a document-type check that only ever ran for unrecognised
     * senders), the reactive binding (each handler had to remember
     * renderDash() and several did not), live thousands separators in every
     * amount field rather than only the ones present at page load, and the
     * password vault asking what KIND of thing a password is.
     *
     * AND THIS CEILING NOW MEASURES SOMETHING THE OWNER NEVER DOWNLOADS.
     * build.mjs strips the comments out of the deployed copy: index.html ships
     * at about 1.49 MB and the modules at about 1.15 MB, roughly 28% below the
     * numbers below. The ceiling still measures the source, deliberately —
     * source is what grows, and a budget that fell every time somebody wrote a
     * comment explaining a bug would be an incentive to stop explaining bugs. */
    /* Raised again for the Liquidity & Credit Hub the owner asked to be taken
     * seriously. A pawn ticket turned out to need part payments, renewals that
     * change the rate and the term, a month-by-month history and an undo on
     * every row; the debtor ledger had no edit and no undo at all. Most of the
     * growth is the two screens and the sentences on them that say what a
     * choice will cost before it is made. */
    // Raised for a real data-loss bug: openBankVault's save handler required a
    // non-empty Bank field and silently dropped any password entry without
    // one, even though candidatesFor() tries every saved password regardless
    // of bank match. Real new logic, not drift.
    // Cloud statement custody, login catch-up and authenticated review controls
    // add 4,062 bytes to the source HTML (measured 2,035,924). The new deferred
    // cloud module adds one nonblocking request. This explicit measured increase
    // retains the two-script first-paint ceiling and under 1% size headroom.
    // Raised again for the cross-device vault sync fix: the Firestore glue for
    // `users/{uid}/vault/{bankpw,secvault}` and the two updated call sites add
    // 244 bytes (measured 2,050,244). No new script requests.
    // Raised again for the boot-time hydrate() wiring that makes isSet()/
    // exists() accurate on a device that has never opened the vault UI here
    // (measured 2,051,489). No new script requests.
    // Raised again for the mail-sync pagination fix: GET items=1 used to
    // return every pending statement's full attachment in one response
    // (up to 200, tens to hundreds of MB on a phone) — the actual root
    // cause of "the app crashes while email statements sync". runMailSync
    // now fetches, processes and releases a few statements' payloads at a
    // time instead of the whole backlog at once (measured 2,055,080). No
    // new script requests.
    // Raised for the bounded statement-review window. The modal now carries
    // explicit model capture/navigation code so one 200-row statement mounts
    // 12 heavy form rows, not all 200 (measured 2,062,845). No new script or
    // network request; the narrow headroom keeps future growth visible.
    // Raised for the iOS compositor-safe dashboard path: accessible DOM bars
    // replace two GPU-backed Chart.js canvases on mobile and async repaints are
    // coalesced until momentum scrolling is idle (measured 2,072,253). No new
    // script or request; this is a tightly ratcheted stability trade.
    // Raised for the post-cloud-sync mailbox refresh that prevents completed
    // statements remaining visibly stuck as Waiting (measured 2,073,487).
    // No new script or request; headroom remains below one kilobyte.
    // Raised 2026-09-28 for the layout-teach diagnostics wiring: the "cannot
    // read this statement" path now records a structural reason (date shapes
    // found / rows found / reconciled, never a statement figure) for the
    // Diagnostics "Copy diagnostics" button, and the standalone copy-
    // diagnostics payload includes it and the per-reason review-queue summary
    // (measured 2,076,356). No new script or request.
    // Raised again same day: the layout-teach modal's ambiguous-dates warning
    // no longer points at "Read it differently" when readings.length is 1 —
    // reachable when two tied date-order candidates produce identical rows
    // and dedupe to one entry, still flagged ambiguous, leaving the owner
    // looking for a button the modal never drew (measured 2,077,271).
    // Raised again same day: statementRetrying wiring in the Diagnostics
    // "Copy diagnostics" payload. processOneStatement()'s transient-failure
    // retry branch has written lastRetryReason/retryCount to a source on
    // every attempt since that branch existed, and nothing ever read it back
    // — a statement can sit in the server's own exponential-backoff loop
    // indefinitely with the one fact that explains it invisible to everyone
    // (measured 2,078,121).
    // Raised 2026-09-30: syncToCloud() now builds its payload through
    // _wfCloudSafe(). Firestore rejects `undefined` ANYWHERE in a document, and
    // one such field (a charge's `paidAt = undefined` when the card page
    // un-settles it) failed the whole push, and every later one, until reload —
    // the owner's diagnostics showed exactly that error from syncToCloud. The
    // sanitiser, a guard against a synchronous throw from set(), and dropping the
    // undefined at its source are this figure (measured 2,078,632). No new
    // script or request.
    // Raised 2026-09-30: callAI() now says it is asking for ADVICE (task: 'advice'). The chat engine's
    // own system prompt mentions a chart format "with JSON" and spending categories, which api/ai.js
    // read as a financial decision needing five engines to return identical words — so every chat
    // reply and every AI Insight came back HTTP 422 ("All Intelligence Engines Offline"). Two lines
    // and a comment (measured 2,078,822).
    // Raised 2026-10-01: 2,079,000 -> 2,090,000 (measured 2,086,674). The cloud push is now a read-merge-write in ONE
    // transaction (it was a merge-set, which replaces every ARRAY in the document: a device that had not yet seen a
    // record the statement worker had just filed pushed its shorter copy over it, and the record was gone for every
    // device); stamps never go backwards past anything this device has seen (a phone minutes slow lost its own edits
    // to a version it had just read); an edit made while a push is in flight is no longer marked saved; every device
    // re-reads the server on resume, on reconnecting and every half minute instead of trusting a live stream that can
    // stall without an error; and the session heartbeat no longer overwrites the cloud's session list. ~0.15% headroom.
    // Raised 2026-10-01 (bank hunt and sender rows): 2,090,000 -> 2,100,000 (measured 2,091,425). The hunt now counts the
    // addresses the owner already approved (it said "0 of your 1 banks matched" beside an approved AMEX address), and a sender
    // row says how many EMAILS it sent and where they are from the state table instead of "seen 585 times" (a count of scans).
    // ~0.4% headroom.
    // Raised 2026-10-02: 2,100,000 -> 2,120,000 (measured 2,115,313). The dashboard's two charts can be drawn as Charts or as Lists on any device
    // (the owner's switch, remembered per device), the Expense Breakdown ring's legend is an HTML legend that cannot be cut off by its card (the
    // canvas legend was drawn past the card's edge with a dozen categories), pointing at or touching a slice (or its legend row) shows its
    // amount in a card kept inside the screen, and the AI-insights context counts a loan installment once. No new script or request. ~0.2% headroom.
    // Raised 2026-10-03: 2,120,000 -> 2,130,000 (measured 2,124,185). The totals now follow what was PAID, not what was scheduled: an installment counts when it is marked paid (for the
    // amount paid), future months and unpaid items count nothing and are listed as "due, not paid" instead; the Monthly Plan page shows what was paid, what is due and every group that is in its
    // total; the Expense Breakdown is built from the same books so it adds up to Year Expenses; Upcoming Payments and Recent Activity leave out what is paid / not yet happened. No new
    // script or request. ~0.3% headroom.
    // Raised 2026-10-03: 2,130,000 -> 2,160,000 (measured 2,148,591 + headroom). DSCR, the WealthFlow Score, the Debt Demolisher, the Wealth Simulator, the 3D Cash Flow and the AI advisor's context now
    // read ONE typical month from the owner's books (the same getMonthlyData the dashboard totals with, over the last twelve complete months; debt service kept apart from living costs) and one
    // position (cash, investments, what is owed): they read the Investments list and this month's hand-typed expenses before, so the salary, the card charges, the subscriptions and the
    // installments never reached them. The Score's seven factors, DSCR's starting figures, the Debt Demolisher's extra-payment pool, the Wealth Simulator's start and monthly saving (now
    // reproducible and keeping the saving's buying power) and the 3D flow's seven groups are rebuilt on them; the pages no longer lose what the owner typed when the app repaints. No new
    // script or request. ~0.5% headroom.
    // 2026-10-02 (the phone's own mailbox review): no raise needed over the 2,160,000 above. The review that opens a mailbox statement on the device now asks the statement registry before it
    // opens (a statement the email sync or an upload already holds is shown as "Already added" and not offered) and takes the statement at Save, one lock for all three doors; measured
    // 2,154,943 with it, merged onto the Score/DSCR work. The server side is statement-guard.js and wealthflow-statement-cloud.js. No new script or request. ~0.2% headroom.
    // 2026-10-03 (the five tools, round two): 2,160,000 -> 2,166_000 (measured 2,161,221 + headroom). A month counts in the averages and in the 3D picture only when something real happened in it
    // (not merely a subscription or a card plan, which are in every month from their start), the 3D picture falls back to the latest month that has data and names the months it shows, and the
    // Wealth Simulator says what is missing instead of drawing a flat chart of zeros. No new script or request.
    // 2026-10-03 (the bank can be corrected): 2,166,000 -> 2,177_000 (measured 2,172,457 + ~0.2% headroom). The statement review screen now shows the bank it read, offers the closest bank for one tap when it could not
    // name one, and lets the owner pick or type another; the choice is re-checked against the statement registry and drives the label, the lock and the fee schedule. About 4 KB is markup and code; the rest
    // is the comments recording why a correction goes through the same path as an automatic answer. No new script or request.
    // 2026-10-03 (the upload bar is real): 2,177,000 -> 2,184_000 (measured 2,179,852 + ~0.2% headroom). The statement overlay no longer shows typed-in percentages: index.html now has the Drive download
    // helper (_wfDriveBlob, which reads a Drive file with byte progress and hands the bar on to the scan) and the Save step's three named stages (registry claim, mail claims, AI notes), and the comments say why a
    // stage with no unit holds the bar instead of inventing a number. One new module script tag (wealthflow-scan-progress.js); no new request at first paint.
    // 2026-10-03 (the Advisor reads the owner's books, on top of the upload bar): 2,184,000 -> 2,187_000 (measured 2,182,202 + ~0.2% headroom). buildFinancialContext hands the Advisor a fact sheet compiled by wealthflow-advisor-facts.js, and
    // callAI no longer throws away the prompt of a one-shot card (AI Insights, Score plan, Debt Demolisher, Wealth Simulator): both are comments recording why, plus one script tag and a few lines. No other new request.
    // 2026-10-03 (the Advisor shows what the books say before it is asked): 2,187,000 -> 2_192_000 (measured 2,191,134 + ~0.04% headroom). The "Your books today" card's container and stylesheet, the function that draws it and
    // remembers a fold, the data-aware suggestion buttons (which now escape the names they show), and one script tag; about a third of it is the comments recording why each is there.
    // 2026-10-03 (the Advisor looks up the outside world): 2,192,000 -> 2_196_000 (measured 2,193,922 + ~0.1% headroom). The page asks for a lookup before the model is asked a question about a rate, a price or a tax rule
    // (_wfResearchFor), shows where the answer was looked up (_wfAttachSources) and its stylesheet, plus one script tag; the rest is the comments recording why.
    // 2026-10-04 (rows of one statement filed by two doors are counted once): 2,196,000 -> 2_199_000 (measured 2,196,419 + ~0.1% headroom). The Save step's own duplicate check (_dupIn) now counts rows against the books
    // as they were before the upload (so three identical payments on one day stay three, and a row the books already hold is skipped), and the rows the claim says the books took while the review was open are left
    // out like the ones the review marked. Comments recording why make up most of it. No new script or request.
    // 2026-10-05 (text-message notices for investors and debtors): 2,199,000 -> 2_203_000 (measured 2,200,879 + ~0.1% headroom). The switch, phone and NIC fields in the investment and debtor forms (the investment form is rebuilt
    // from its inputs, so the four fields are carried over by hand and validated before anything is saved), the Text messages buttons, the sync hook that nudges the server after a push, and one script tag. About a third is comments.
    // 2026-10-05 (saved people, payment details and any-country numbers on top of the text-message switch): 2,203,000 -> 2_209_500 (measured 2,207,231 + ~0.1% headroom). The forms' people picker and the folded contact section
    // (the investment form is rebuilt from its inputs, so `personId` is carried over by hand), the commit step that asks one question before a shared name, number or ID changes everywhere, the Saved people buttons and one script tag.
    // About a third is comments.
    // 2026-10-05 (a debtor who pays in parts is told the balance): 2,209,500 -> 2_216_000 (measured 2,213,525 + ~0.1% headroom). The Log repayment form shows the balance that will be left (and calls out a figure larger than is owed),
    // can count a payment at once when the owner can already see the money and says what the debtor will be texted; Send balance asks first, writes one request on the debtor and refuses a second tap for ten minutes; the two confirmation
    // toasts say a text is queued. About a third is comments.
    htmlBytes: 2_216_000,
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
    /* Raised for wealthflow-reactive.js, wealthflow-money-input.js,
     * wealthflow-password-shapes.js and wealthflow-statement-identity.js — the
     * four modules the owner's four reported defects needed. Deployed, after
     * the strip, these 69 modules are about 1,147 KB rather than the 1,775 KB
     * this ceiling counts; see the note on htmlBytes for why the ceiling still
     * measures the source. */
    /* And for wealthflow-pawn.js, which now owns everything a pawn ticket
     * costs. wealthflow-liquidity.js imports and re-exports it rather than
     * keeping a second copy of the arithmetic. */
    // Measured 1,842,217 across 71 modules after cloud vault/review integration;
    // encrypted HTML intake and exact sender gates account for the other growth.
    // Raised for repairing pre-upgrade statement manifests whose missing sender
    // evidence made an owner-approved bank look unapproved forever. The same
    // change also records a SHA-256 attachment digest so repeated processing
    // can prove it received identical ciphertext. Measured on this tree; no new
    // module or browser request.
    // Raised after the autonomous statement continuation fix genuinely fired
    // the ratchet: wealthflow-statement-cloud.js now honours the worker's lease
    // delay instead of polling an in-flight statement every 750 ms. Measured
    // 1,874,076 across the same 71 modules; no module or startup request added.
    // Raised after replacing the generic statement failure toast with explicit
    // recovery guidance. Measured 1,875,235; still 71 modules and no additional
    // startup request.
    // Raised after fixing the unreachable ten-engine unanimity floor (classifySlice's
    // prompt now carries the fixed category vocabulary so cross-model agreement is
    // actually reachable) and silencing pdfjs's inapplicable Node-canvas warnings.
    // Measured 1,876,393; still 71 modules and no additional startup request.
    // Raised after review() stopped routing a per-row invalid-amount review into
    // the whole-layout re-teacher, which hit mapReviewLayout's replay guard forever
    // once any sibling row had already filed. Measured 1,877,205; still 71 modules.
    // Raised after adding reviewReasonText(): the consensus review board correctly
    // flagged that a raw code like 'invalid-transaction' reached the review screen
    // unexplained. Measured 1,879,847; still 71 modules and no additional request.
    // Raised after wiring the owner's card/account registry (Settings -> Manage
    // cards & accounts) into the autonomous pipeline's account-type determination,
    // in both the primary path and the subscription-vs-card-charge decision.
    // Measured 1,879,854; still 71 modules and no additional request.
    // Raised after adding the bank cross-check to the registry's last-4 lookup,
    // guarding against a last-4 collision between two of the owner's own
    // accounts at different banks. Measured 1,880,338; still 71 modules.
    // Raised 2026-09-28 after wiring propose()'s failure diagnostics into
    // wealthflow-layout-memory.js and wealthflow-statement-cloud.js's new
    // reviewSummary() (both feed the Diagnostics "Copy diagnostics" payload
    // in wealthflow-update-system.js). Measured 1,886,095; still 71 modules.
    // 2026-09-28: +2,581 for wealthflow-statement-cloud.js's confirmLayout() —
    // retries the one POST that actually confirms a taught layout on a
    // transient network/timeout failure, instead of forcing the owner back
    // through the whole teach modal to retry it. Measured 1,888,676.
    // 2026-09-28: +416 for confirmLayout() switching from a denylist to an
    // allowlist of retryable reasons (an automated review on the PR that
    // introduced it found two real bugs in the denylist: PDF_UNREADABLE was
    // missing, so a deterministically-unreadable PDF retried twice for no
    // benefit; and whole-statement-review-required — thrown by inspect()
    // ahead of the replay guard on the exact lost-response retry this
    // existed for — read as an ordinary permanent failure instead of
    // "may already be confirmed"). Measured 1,889,092.
    // 2026-09-28: +802 for request()'s catch normalizing a raw fetch()
    // network-level TypeError (a dropped connection/DNS failure — the Fetch
    // spec's own signal for "no network") into statement-service-unavailable.
    // Another automated-review finding on the same PR: confirmLayout()'s
    // retryable allowlist could never match an unnormalized raw TypeError,
    // so the single most common real "no network" case never retried.
    // Measured 1,889,894.
    // 2026-09-28: +1,472 for wealthflow-statement-cloud.js's retryAttemptsSummary()
    // and the runStatementSync()/sync() wiring that feeds it — the same
    // lastRetryReason surfacing the htmlBytes note above explains. Measured
    // 1,891,366.
    // 2026-09-28: main already measured 1,904,143 bytes across 72 modules after
    // the uploaded quarantine/runtime module landed, while this ratchet still
    // described the preceding 71-module tree.  The statement visibility fix
    // adds no module; this moves the stale baseline once with ~1.1% headroom.
    // 2026-09-30: 1,925,000 -> 1,933,000 (measured 1,930,072, no new module). All of it is
    // wealthflow-statement-cloud.js's review overlay and diagnostics: the months a mailbox has
    // not given us and what the search for them found; statements closed as empty, each with a
    // Reopen; and the mailbox history check — how many bank emails were found, accounted for,
    // added, refused and why, with a one-tap "Take it" for a refusal the owner's word can lift —
    // and the per-statement audit log (what each statement proved, how it arrived). Every one is
    // a way a statement that would otherwise vanish in silence is now shown, so the bytes are the
    // feature. ~0.15% headroom.
    // 2026-09-30 (merchant review): 1,933,000 -> 1,952,500 (measured 1,950,104, no new module). The merchant
    // engine could settle nothing on its own — its question to the AI board asked for a sentence and a decimal
    // that a dozen engines never repeat identically, so every merchant was held for the owner — and it only ever
    // looked at manual imports, never at the rows a statement filed. It now asks two closed fields, settles a
    // merchant on web evidence, on two witnesses that agree, or on the unanimous board; retries the web under
    // three names; tries held merchants again on a back-off; recognises the same shop by its words; and sweeps the
    // generic rows statements filed. The panel ranks the hard cases by how many transactions an answer changes.
    // ~0.1% headroom.
    // 2026-10-01 (cross-device sync, intake rules, state table, adaptive reader): 1,952,500 -> 1,975,000 (measured
    // 1,972,258, no new browser module). index.html carries the transactional push, the hybrid clock and the reconcile
    // loop (+7.7 KB); wealthflow-statement-identity.js carries intent (subject, file names AND body), the byte sniff and
    // the wider statement vocabulary; wealthflow-mail-ingest.mjs the SPF/DKIM/DMARC verdict, the trusted
    // Authentication-Results header, the attachment allowlist and the security record; wealthflow-mail-senders.mjs
    // the same-bank recognition; wealthflow-statement-cloud.js the table, per-sender status and security panels.
    // Every one is a way a forged or unwanted message is kept out, or a real statement is no longer lost in silence.
    // ~0.14% headroom.
    // 2026-10-01 (sender truth, header shapes, queue): 1,975,000 -> 1,985_000 (measured 1,977,609): index.html (hunt + sender
    // rows), wealthflow-mail-ingest.mjs (RFC 5322 address reading, several mailboxes in one From, DMARC as the From domain's own
    // verdict), wealthflow-sender-discovery.js (approved senders are matched banks), wealthflow-statement-cloud.js (the per-sender funnel accessor).
    // 2026-10-01 (false crashes, module self-heal): 1,985,000 -> 1,990_000 (measured 1,987,718): wealthflow-stability.js only. The crash
    // detector no longer re-arms its marker after the app is backgrounded (iOS was being counted as 27 "crashes, survived 0s"), a one-time
    // reset of the first generation's counts, and the page clears the app's own code caches once when a module will not link.
    // 2026-10-01 (HNB, identity vocabulary): 1,990,000 -> 1,993_000 (measured 1,990,090 + headroom): wealthflow-statement-identity.js reads its
    // vocabulary through the same normaliser as the document (entries written with a slash — 'balance b/f', 'a/c no' — could never match) and
    // gains 'account balance', 'b/f' and 'a/c'; wealthflow-merchants.js paces its AI board calls two at a time. ~0.15% headroom.
    // Raised from 1_993_000 / 214_000 for the statement registry's two doors: the upload screen's check-and-claim calls (wealthflow-ai-v4.js, wealthflow-statement-cloud.js).
    // Measured 1,997,673 total; largest module 215,954. No module or script tag added.
    // 2026-10-02 (card payments, exact to the cent): 2,000,000 -> 2_004_000 (measured 2,000,067 + headroom): wealthflow-cc-reconcile.js only. The page's
    // oldest-first card walk reads every amount as whole cents from its decimal text (no float sum, no tolerance), carries what is left in the pool and says
    // what the first unpaid charge still needs — the same rule the worker applies to the document (cc-fifo.mjs, server-side, not shipped to the page).
    // 2026-10-02 (historical sweep): no change to the ceiling above; the sweep's retry/backoff helper and padded window query (wealthflow-backfill.js) add ~1 KB inside its headroom.
    // Raised again, on top of the line above, by about 9 KB for the merchant engine in wealthflow-merchants.js: +9 KB, of which about 4 KB is
    // code (most-specific-name-wins with a declared ambiguity, the gateway/terminal wrappers stripped from a merchant's key, a line that names no shop going straight to
    // the owner without a web search or an AI call, and the email pipeline's question picked up from the filed row) and the rest is the comments recording WHY. No module
    // and no request were added: the 950-merchant list the email pipeline now uses lives in statement-merchants.mjs, which is server-only and never reaches the page.
    // 2026-10-02: 2,016,000 -> 2,019,000 (measured 2,016,087): wealthflow-statement-cloud.js only, for the phone's own mailbox review (the registry check/claim call for a mailbox item). No module or script tag added.
    // 2026-10-03 (the vault opens when the PIN is right): 2,019,000 -> 2,026_000 (measured about 2,021,000 after merging the phone's own mailbox review + headroom): wealthflow-vault.js only. unlock() derives the key from the device's own copy
    // while the cloud copy is fetched and waits for the cloud only up to a budget (it used to wait without limit, then for two more server calls in the page), and save() asks the cloud whether it
    // holds something newer before writing over it when the unlock could not hear from it. About 1.5 KB is code; the rest is the comments recording why.
    // 2026-10-03 (the bank is read, not asked): 2,026,000 -> 2,070,000 (measured 2,047,160 + ~1.1% headroom); the largest module 217,000 -> 223,000 (wealthflow-ai-v4.js, measured 220,870).
    // The growth is wealthflow-bank-detect.js (new, about 19 KB: the evidence rules for naming the issuing bank from a statement's own words, the PDF's properties, the file name, an AI reading of a scanned page, the
    // owner's cards and the mail history — most of it the comments recording why a bank is never guessed and never asked) and about 5 KB in wealthflow-ai-v4.js, which now resolves the bank in its three read paths instead of
    // opening the fifteen-button picker (the picker itself, in index.html, was removed). statement-bank-evidence.mjs is server-only and never reaches the page.
    // 2026-10-03 (the upload bar is real): 2,070,000 -> 2,091_000 (measured 2,085,531 + ~0.3% headroom); the largest module 225,000 -> 232_000 (wealthflow-ai-v4.js, measured 230,470).
    // wealthflow-scan-progress.js is new (about 11 KB, mostly the comments recording the rule: a bar position comes from counted work, never from a number chosen for a stage). The rest is the upload
    // handler reporting pages read and pages answered to it, the plan for each of its four paths, and the PDF/HTML openers saying which of "saved password / asking / unlocking / reading page N of M" they are doing.
    // 2026-10-03 (the Advisor reads the owner's books, on top of the upload bar): 2,091,000 -> 2_140_000 (measured 2,134,473 + ~0.3% headroom). wealthflow-advisor-facts.js (new, about 46 KB, roughly two thirds of it the comments recording why each rule is what it is):
    // the fact sheet the Advisor is given (the screens' own months, the books profile, loans, cash-flow runway, goals, findings as code), the multilingual "is this about money" test, and the rules that keep a name from posing as part of the sheet.
    // wealthflow-ai-v6.js grew about 4 KB for the finance protocol that tells the model to copy those figures and never do its own sums.
    // 2026-10-03 (the Advisor works a decision out): 2,140,000 -> 2_185_000 (measured 2,178,730 + ~0.3% headroom). wealthflow-advisor-scenarios.js (new, about 36 KB, over a third of it the comments recording why each rule is what it is):
    // the annuity arithmetic under "can I buy a car / take a loan / pay extra / lose my salary", the reader of those questions in English, Sinhala, Tamil and romanised Sinhala, and the block of worked figures the model is told to copy.
    // wealthflow-ai-v6.js grew a few lines to hand that block over and the facts module gained the page-clock helpers.
    // 2026-10-03 (the Advisor's answer is read back against the books): 2,185,000 -> 2_200_000 (measured 2,196,362 + ~0.2% headroom). wealthflow-advisor-check.js (new, about 17 KB, a third of it the comments recording why each rule is what it is):
    // every figure of an answer is found and looked for in what the model was given, a rounded figure matches the one it rounds, exact arithmetic on the owner's figures is accepted as worked out, one retry when a money figure
    // is not theirs, and the line shown under the answer. wealthflow-ai-v6.js grew a few lines to leave the books it used for the turn.
    // 2026-10-03 (the Advisor shows what the books say before it is asked): 2,200,000 -> 2_212_000 (measured 2,210,130 + ~0.1% headroom). wealthflow-advisor-briefing.js (new, about 13 KB, a quarter of it the comments recording why):
    // the fact sheet's findings as a short card of what is worth a look, each with the question to ask about it, and suggested questions that name the owner's own loan and goal. No model is called.
    // 2026-10-03 (the Advisor looks up the outside world): 2,212,000 -> 2_229_000 (measured 2,226,495 + ~0.1% headroom). wealthflow-advisor-research.js (new, about 15 KB, a quarter of it the comments recording why):
    // which questions are about the outside world (English, Sinhala, Tamil), the question scrubbed of anything personal, the web answer made safe, the block the model reads as data, and the line under the answer.
    // wealthflow-ai-v6.js grew a few lines to hand that block over. The server half (advisor-research.mjs / advisor-research.js) is not served to the page and is not counted here.
    // 2026-10-04 (the owner is never shut out of a statement the books only partly hold): 2,229,000 -> 2_233_000 (measured 2,230,576 + ~0.1% headroom). The upload screen's duplicate answer can now offer "Add missing rows"
    // (wealthflow-ai-v4.js: the dialog, and the re-run with the owner's word), wealthflow-statement-cloud.js carries that word to the server (`force`), and index.html passes it on the bank re-check; about a third is the comments recording why.
    // 2026-10-04 (the owner's own card is the owner's own money): 2,233,000 -> 2_243_000 (measured 2,241,110 + ~0.1% headroom). wealthflow-own-money.js (new, about 7 KB, over half of it the comments recording why a cash advance arriving in
    // the account is not income and why a number the owner has not registered is not claimed) is the one rule the email worker and the manual upload both ask; wealthflow-route.js routes a credit by it, and index.html loads it and
    // teaches the merchant memory what the owner corrected. statement-merchant-name.mjs (the worker's copy of the page's merchant isolation) is server-only and is not counted here.
    // 2026-10-05 (text-message notices): 2,243,000 -> 2_285_000 (measured 2,282,852 + ~0.1% headroom). wealthflow-sms.js (new, about 33 KB, a third of it the comments recording why: the switch and its stamp, the nudge, the one-per-delivery
    // alert, the log), wealthflow-phone.js (the one rule for a phone number, shared with the server) and wealthflow-nic.js (the Sri Lankan NIC, old and new shapes, shared with the server). The gateway client, the send engine and
    // the cron are server-only and are not counted here.
    // 2026-10-05 (saved people, payment details, any country): 2,285,000 -> 2_412_000 (measured 2,409,274 + ~0.1% headroom). wealthflow-people.js (new, about 33 KB: the people book's rules, linking, the safe propagation of a changed name, number or ID,
    // the device-contacts reader and the .vcf parser), wealthflow-people-ui.js (new, about 68 KB: the Saved people and Payment details screens, the contact fields, the picker and every error and confirmation they show),
    // wealthflow-payaccounts.js (new, about 6 KB: the owner's bank accounts and the whitelist of what a debtor or investor is shown; shared with the server) and wealthflow-phone.js grown by about 16 KB for the table of 245 countries
    // (dialling code, national lengths, time zone) that makes a number from anywhere reachable. The statement page, the PDF writer and the page's Sinhala words are served as their own files and are not counted here.
    // 2026-10-05 (a debtor who pays in parts is told the balance): 2,412,000 -> 2_415_000 (measured 2,412,254 + ~0.1% headroom). wealthflow-sms.js carries the Send balance request: the pause between two requests, the record it
    // adds and the words the message log shows when a balance could not go out in time.
    // 2026-10-05 (late-payment reminders and held-text alerts): 2,415,000 -> 2_419_000 (measured 2,416,330 + ~0.1% headroom). wealthflow-sms.js carries the reminder box and its stamp, and the alert that says texts are waiting
    // (no credit, a rejected token) so the owner hears about it on the page rather than from the debtor.
    // 2026-10-05 (people book: investors filed automatically, edits reach every record, contacts import on every device): 2,419,000 -> 2_445_000 (measured 2,442,881 + ~0.1% headroom). wealthflow-people.js carries the
    // one-rule propagation/repair, the vCard/CSV/pasted-text parsers and the per-OS detection; wealthflow-people-ui.js the contact source sheet with on-screen steps for each device; wealthflow-phone.js the input cleaner
    // (copied numbers arrive with tel: prefixes, direction marks and non-Latin digits). About a third is comments.
    totalJsBytes: 2_445_000,
    // 2026-10-03 (the bank can be corrected): 223,000 -> 225_000 (wealthflow-ai-v4.js, measured 223,296): it now remembers what the owner said about a card or account number (WFBankMemory) and hands the review screen the context it needs to turn a correction into an answer.
    // 2026-10-04: 232,000 -> 233_000 (wealthflow-ai-v4.js, measured 232,325): the "Add missing rows" dialog and the re-run of the same upload with the owner's word.
    largestModuleBytes: 233_000, // measured 232,325
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
    /* 65 -> 69. Four modules for the owner's four reported defects, and each
     * one is a file rather than an inline block for the same reason as every
     * entry above it: each owns a rule that more than one caller needs, and
     * inlining any of them into index.html would put a second copy of that rule
     * next to the first. wealthflow-statement-identity.js decides what a
     * document IS (the server plans with it, the device confirms with it);
     * wealthflow-reactive.js owns the repaint and the "what actually arrived"
     * rule (getMonthlyData and the advisor both read it);
     * wealthflow-money-input.js owns how an amount field behaves while it is
     * being typed into; wealthflow-password-shapes.js owns how a date of birth
     * can be written (the vault offers the list, the ID vault derives from it). */
    /* 69 -> 70 for wealthflow-pawn.js. A file rather than more of
     * wealthflow-liquidity.js because a pawn ticket has arithmetic of its own —
     * month-by-month accrual on a balance that changes, a term schedule with
     * more than one rate, payments allocated interest-first — and it is
     * exercised by its own test without a browser. */
    // 2026-10-03: 72 -> 73 for wealthflow-bank-detect.js (the bank of a manually uploaded statement is read from the statement; see totalJsBytes).
    // 2026-10-03: 73 -> 74 for wealthflow-scan-progress.js (the upload overlay's bar is driven by counted work; see totalJsBytes).
    // 2026-10-03: 74 -> 75 for wealthflow-advisor-facts.js (the fact sheet the AI Advisor is given; see totalJsBytes).
    // 2026-10-03: 75 -> 76 for wealthflow-advisor-scenarios.js (the arithmetic under a decision the owner asks the AI Advisor about; see totalJsBytes).
    // 2026-10-03: 76 -> 77 for wealthflow-advisor-check.js (the answer the AI Advisor gives is read back against the owner's books; see totalJsBytes).
    // 2026-10-03: 77 -> 78 for wealthflow-advisor-briefing.js (the card of what the books say today; see totalJsBytes).
    // 2026-10-03: 78 -> 79 for wealthflow-advisor-research.js (the Advisor looks up the outside world; see totalJsBytes).
    // 2026-10-04: 79 -> 80 for wealthflow-own-money.js (whose money a bank row is; see totalJsBytes).
    // 2026-10-05: 80 -> 83 for wealthflow-sms.js, wealthflow-phone.js and wealthflow-nic.js. The last two are imported by the first and by the server, not loaded by a tag of their own.
    // 2026-10-05: 83 -> 86 for wealthflow-people.js, wealthflow-people-ui.js and wealthflow-payaccounts.js. The first and the last are imported by the second (and by the server for the last), not loaded by a tag of their own.
    moduleCount: 86,   // measured 86
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
    /* 65 -> 68 for the three new browser modules. All three are
     * type="module", so they are deferred and none of them blocks first paint —
     * renderBlockingScripts below is unchanged at 2, which is the number that
     * actually decides how fast the page appears. */
    // 2026-10-03: 70 -> 71 for wealthflow-bank-detect.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-03: 71 -> 72 for wealthflow-scan-progress.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-03: 72 -> 73 for wealthflow-advisor-facts.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-03: 73 -> 74 for wealthflow-advisor-scenarios.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-03: 74 -> 75 for wealthflow-advisor-check.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-03: 75 -> 76 for wealthflow-advisor-briefing.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-03: 76 -> 77 for wealthflow-advisor-research.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-04: 77 -> 78 for wealthflow-own-money.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-05: 78 -> 79 for wealthflow-sms.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    // 2026-10-05: 79 -> 80 for wealthflow-people-ui.js — type="module", so deferred; renderBlockingScripts below is unchanged at 2.
    scriptTags: 80,              // measured 80; the progress, fact-sheet, scenario, answer-check, briefing, research, own-money, sms and people modules are nonblocking
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
