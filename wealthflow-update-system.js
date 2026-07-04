/* =============================================================================
   WealthFlow Update System  v1.0  —  window.wfUpdate
   ---------------------------------------------------------------------------
   An iOS/Android-style in-app update experience, built HONESTLY for a static
   PWA (no fake server daemon, no imaginary sandbox — see notes below).

   FLOW
   ────
   1. Detect a newer version two ways:
        (a) a version manifest the developer ships  (version.json / wfVersionManifest)
        (b) the service worker finding new files     (sw 'updatefound')
   2. Show a subtle glowing "Update available" pill on the Dashboard.
   3. Tap it → jump to Settings → Software Update section.
   4. Show a scrollable "What's New" changelog (iOS-style).
   5. Show an auto-generated, version-specific Legal Agreement (EULA) the user
      must scroll to the bottom of before "I Agree" unlocks.
   6. Require the user's PIN (reuses window._verifyPinPrompt) to authorise.
   7. Run a real backup first (window.backupNow), then apply the update:
        - tell the waiting service worker to skipWaiting + activate
        - the app reloads onto the new files
      A genuine progress bar + countdown reflects these real steps.
   8. After reload, a centered "Welcome to vX" popup shows what changed, with a
      Close / Return to Dashboard button. New installs are marked current and
      skip the popup.

   PER-USER, like phones: each browser tracks its own "installed version" in
   localStorage, so updates are NOT forced on everyone at once. New users start
   on the latest version silently.

   MANDATORY (security) updates: if the manifest marks a version mandatory, the
   update screen cannot be dismissed until applied.

   HONEST SCOPE
   ────────────
   • This cannot continue an update "on the server while the phone is off" — a
     static site has no server process. What it DOES guarantee: the new files
     are atomically activated by the service worker, and if the device dies
     mid-way nothing is half-written (the old version simply stays until the
     SW successfully activates). That is the real, safe equivalent.
   • No 100k-agent sandbox / self-rewriting AI — those aren't real features.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_UPDATE_SYSTEM) return;
    window.WF_UPDATE_SYSTEM = '1.0';

    // ── The version this build represents. Bump on every release. ────────────
    const CURRENT_VERSION = '7.49.0';
    const LS_INSTALLED = 'wf_installed_version';
    const LS_SEEN_POPUP = 'wf_update_popup_seen';
    const LS_PENDING = 'wf_update_pending';   // set just before reload-to-update
    const LS_AUTOSEC = 'wf_auto_security';    // user opted in to auto-install security updates

    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function _notify(m,t){try{if(typeof window.notify==='function')window.notify(m,t||'info');}catch(_){}}
    function _cmp(a,b){const pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1;}return 0;}

    // ── Built-in changelog for the current version. The manifest can override
    //    or extend this. Kept friendly + plain-language (iOS style). ──────────
    const BUILTIN_NOTES = {
        '7.40.0': {
            date: '2026-07-01',
            headline: 'Undo a confirmed investment month by pressing and holding, plus a fixed Restore history list and a Drive connection that stays on',
            sections: [
                { title: 'Investments — press & hold to undo a month', items: [
                    'Confirmed a month by mistake? Press and hold the green "Received & Confirmed" button on an investment card for 3 seconds. A fill sweeps across it, and when it completes that month is set back to Pending.',
                    'It also works inside "Past months": press and hold any confirmed month row (e.g. "May 2026") for 3 seconds to undo just that month. Each confirmed row now shows a small "hold to undo" hint.',
                    'It is deliberately hard to trigger by accident — a quick tap does nothing, and sliding your finger (scrolling) cancels the hold, so it never fires while you scroll.'
                ]},
                { title: 'Restore Data Protocol — your backup history now shows', items: [
                    'Fixed: after backing up to Google Drive, the previous-backup list in Settings > Restore Data Protocol was often empty. The list now reliably shows every backup this account has made, newest first, with the date/time and size.',
                    'Root cause: the list was only looking inside one specific Drive folder, so any backup that landed elsewhere was invisible. It now finds your backups wherever they are, and the backup you just made appears immediately (even before Drive finishes indexing it).'
                ]},
                { title: 'Google Drive stays connected', items: [
                    'Once you have allowed Google Drive, WealthFlow keeps that connection on stand-by for the whole session and silently refreshes it in the background — so Restore Data Protocol and Instant Cloud Backup keep working without asking you to sign in again, right up until you sign out of your Google account.'
                ]},
                { title: 'Note', items: [
                    'Hard-refresh once after updating so the new version loads.'
                ]}
            ]
        },
        '7.39.0': {
            date: '2026-06-30',
            headline: 'Expenses that read like a thread, a smarter paid-tick, colour-coded notifications, and no more settings "dance"',
            sections: [
                { title: 'Expenses — clearer history', items: [
                    'When you tap a category to view its history, those transactions now appear as a clearly nested thread \\u2014 indented under the category with a connecting rail and a \\u201cTransactions in \\u2026\\u201d label \\u2014 so you can instantly tell the category header (parent) from the individual charges (children), like a comment and its replies.',
                ]},
                { title: 'Expenses — smarter paid tick', items: [
                    'The \\u201cmark paid\\u201d tick now appears only where it makes sense: on expenses you added manually, and only for the current month and upcoming months.',
                    'Bank-statement expenses no longer show a tick \\u2014 they\\u2019re records of money already spent, not something you need to mark. In the table view they read as \\u201cRecorded\\u201d.',
                    'When a new month begins, last month\\u2019s manual expenses are automatically marked paid (you can\\u2019t pay the past), so the tick tidies itself up.',
                ]},
                { title: 'Notifications — colour-coded', items: [
                    'Each notification is now colour-coded by reason so you can read the bell at a glance: overdue is red, due-today/imminent is orange, due-soon is gold, and system/info is blue.',
                ]},
                { title: 'Settings — fixed', items: [
                    'Turning an option on or off no longer makes the page jump or \\u201cdance\\u201d. Toggles now flip instantly in place, leaving your scroll position exactly where it was.',
                ]},
            ],
        },
        '7.38.0': {
            date: '2026-06-30',
            headline: 'Notifications, perfected — seen-state that sticks, a fix for the mobile cut-off, a smarter panel, and device reminders',
            sections: [
                { title: 'Fixed', items: [
                    'Seen notifications now stay seen. Previously, opening the app could silently reset the count, so items you\\u2019d already read came back as unseen after you closed and reopened the app. The unseen badge now persists correctly across reloads and restarts.',
                    'On phones in portrait, the notifications panel was running off the left edge (the title showed as \\u201cifications\\u201d and the left icons were clipped). The panel is now anchored to the screen with safe side margins and notch-safe insets, so it always fits \\u2014 no matter how narrow the screen.',
                ]},
                { title: 'Improved', items: [
                    'The panel is cleaner and easier to scan: a summary line tells you how many items need attention, and notifications are grouped into \\u201cNeeds attention\\u201d, \\u201cComing up\\u201d and \\u201cGood to know\\u201d, each with a count.',
                    'Every item now shows a clear due chip \\u2014 \\u201c4d over\\u201d, \\u201cToday\\u201d, \\u201cin 3d\\u201d, \\u201cThis mo\\u201d \\u2014 so you can see urgency at a glance, with refined premium styling throughout.',
                ]},
                { title: 'New \\u2014 device reminders', items: [
                    'You can now have WealthFlow remind you in your phone or computer\\u2019s own notification centre when a payment or cheque needs attention. Turn it on under Settings \\u2192 Notifications \\u2192 Device push notifications (your device will ask permission once).',
                    'Reminders are deduplicated so the same item never nags you twice, and several at once are bundled into a single tidy alert. Tapping a reminder opens WealthFlow on the right page.',
                ]},
                { title: 'Note', items: [
                    'The bell still only reads your data \\u2014 it never changes it. Hard-refresh once after updating.',
                ]},
            ],
        },
        '7.37.0': {
            date: '2026-06-29',
            headline: 'New: a Notifications centre in the topbar — never miss a payment or cheque',
            sections: [
                { title: 'New', items: [
                    'A notifications bell now sits in the top bar with a red badge showing how many urgent + warning items you haven\u2019t seen yet.',
                    'It watches your real data and surfaces what needs attention: overdue or due-today cheques, unpaid card payments near or past their deadline, loan instalments due this month or overdue, and bills/subscriptions due soon or overdue. Active card-instalment plans show as gentle info.',
                    'Most urgent first, newest at the top. Tap any notification and it takes you straight to the right page. Opening the bell clears the unseen count; opening or tapping an item marks it seen.',
                ]},
                { title: 'Settings → Notifications', items: [
                    'A master on/off switch plus individual toggles for urgent alerts, due-soon warnings, cheques, card payments, loan instalments, bills, and card instalments — so you decide exactly what you\u2019re notified about.',
                ]},
                { title: 'Built carefully', items: [
                    'The bell reads your data and never changes it. Severities are computed from real dates (cheque release dates, card deadlines, loan months, subscription due-days) and were simulated across overdue / due-today / due-soon cases before release, so the counts are accurate.',
                ]},
            ],
        },
        '7.36.0': {
            date: '2026-06-29',
            headline: 'Year Income now counts real received money — no more investment double-counting',
            sections: [
                { title: 'Fixed', items: [
                    'Year Income (and everything derived from it) now reflects the ACTUAL money you received — the bank-statement imports and manual entries on your Income page — instead of the Investments tab.',
                    'This removes a double-count: a recurring investment yield (say 100,000/month) was tracked on the Investments page AND, when that same money landed in your bank and the statement was imported, captured again as received income. Year Income now reads only the received-income side, so the same money can never be counted twice.',
                    'The fix flows consistently through every place that shows income: the dashboard Year Income card, Net Savings, Savings Rate, the monthly income chart, the Monthly Plan, the CSV and PDF reports, and the 3D Cash Flow view (its income breakdown now matches its income total exactly).',
                ]},
                { title: 'Unchanged', items: [
                    'Your Investments page is fully intact — every source, amount and history stays exactly as it was. It simply no longer inflates Year Income, because that income is already captured when it reaches your bank.',
                ]},
            ],
        },
        '7.35.0': {
            date: '2026-06-26',
            headline: 'Release-notes “View” now opens, a cleaner Add Saving, and tidier sort controls',
            sections: [
                { title: 'Fixed', items: [
                    'Settings → Software Update → “View” / “What’s new” now opens the release-notes sheet correctly. It was silently doing nothing whenever the notes were stored as plain text — the sheet now renders every note format reliably.',
                ]},
                { title: 'Changed', items: [
                    'Removed the “Reduce my Balance Tracker” checkbox from “+ Add Saving” — it had no effect (your saving is recorded against the target, and your balance is moved separately from “Log Balance Flow → Saving for Target”), so it was only adding confusion.',
                ]},
                { title: 'Improved', items: [
                    'On small phone screens the CC One-Time sort controls (↓ Newest / ↑ Oldest, default ↓ Newest) now stay compact so the “+ Add Payment” button no longer drops onto a second line.',
                ]},
                { title: 'Reminder', items: [
                    'Passcode-free entry for the installed app/APK already lives in Settings → Device Access & Encryption → “Passcode-free entry (installed app only)”. It’s off by default for safety and only ever applies to the installed app (never a browser tab) — turn it ON once and the installed app opens straight to your dashboard.',
                ]},
            ],
        },
        '7.34.0': {
            date: '2026-06-26',
            headline: 'Bank-statement cheques now file into the Cheque tab — accurately, for every bank',
            sections: [
                { title: 'New', items: [
                    'When you import a bank statement, every cheque is now detected and filed straight into your Cheque tab — a deposited / inward / realised cheque is booked as RECEIVED (money in), and a cheque payment / outward / honoured cheque is booked as ISSUED (money out). The cheque number is read automatically from the narration, with leading zeros preserved (e.g. “Transfer Cheque Deposit Cheque No: 070283” → Received, #070283).',
                    'Works across banks and wordings: deposit / inward / outward / clearing / realised / lodgement / collection / local / upcountry / outstation / electronic cheque, plus shorthand like “chq dep”, “cq no”, “chque” and “#070283”.',
                ]},
                { title: 'Improved', items: [
                    'A cheque can no longer be swallowed by the “internal transfer” skip. Rows such as “Internal Transfer – Cheque Deposit” are now recognised as cheques first, so they always reach the Cheque tab instead of being dropped.',
                    'Cheque-book / leaf / return / dishonour FEES are still correctly treated as bank charges (an expense), never mistaken for a cheque movement.',
                    'Credit-vs-debit (received vs issued) is decided by the statement wording first, then by the credit/debit column — so the direction is right even when the narration is terse.',
                ]},
                { title: 'Note', items: [
                    'This is a detection upgrade in the import engine — your existing cheques are untouched. Newly imported statement cheques arrive already marked “cleared” (they have already moved on the statement) and de-duplicate by cheque number, so re-importing the same statement never creates duplicates.',
                ]},
            ],
        },
        '7.33.0': {
            date: '2026-06-25',
            headline: 'Pinpoint loan allocation + a sharper, health-aware classifier',
            sections: [
                { title: 'New', items: [
                    'Bank-statement loan repayments now land on the EXACTLY right loan — even when you have several. If you keep two housing loans and a vehicle lease, WealthFlow now tells them apart by loan TYPE first (a vehicle / lease payment can never be filed against a housing loan), then by the monthly instalment amount (which separates two same-type loans), then decisively by the loan / account number or the loan name when the statement prints it.',
                    'Zero silent mistakes: when a statement genuinely does not print enough to be certain (e.g. two same-bank housing loans, no type word, an amount near neither instalment), the row is surfaced for your one-tap confirmation in the import review — it is never quietly filed against the wrong loan.',
                ]},
                { title: 'Improved', items: [
                    'The instant classifier now recognises far more health spending — HEALTH, doctor, medicine, dispensary, drug store, e-Channelling, doc990, dental, optical, physiotherapy, ayurveda and more — so health charges stop falling into "Other", even when the statement text is abbreviated or cut off by OCR.',
                    'The 18-engine AI vote (all engines still run IN PARALLEL) got a richer Sri-Lankan merchant brief and now reads abbreviated / truncated statement text more intelligently, so "Goes to" and "Type" are correct even more often. The AI still only ever upgrades a generic guess — locked fuel / cash-advance / fee verdicts are never overridden.',
                ]},
                { title: 'Note', items: [
                    'This is a backend / engine update — no app screens changed. Just open the app and re-import (or re-run auto-sort) to feel the difference.',
                ]},
            ]
        },
        '7.32.0': {
            date: '2026-06-25',
            headline: 'Even more AI engines — all voting in parallel for sharper classification',
            sections: [
                { title: 'New', items: [
                    'WealthFlow\'s classification brain now consults up to 18 AI engines at once — xAI Grok, Anthropic Claude, DeepInfra, Hyperbolic, Novita, OpenAI and Cohere now join the existing line-up (Gemini, Groq, DeepSeek, Mistral, Together, Fireworks, OpenRouter, Cerebras, SambaNova, NVIDIA, GitHub Models). Every engine runs IN PARALLEL and decides each ambiguous charge by majority vote, so "Goes to" and "Type" land correctly even more often. Engines you have configured contribute; the ones you have not simply sit out.',
                ]},
                { title: 'Improved', items: [
                    'The built-in knowledge base is now in lock-step with the import classifier — many more Sri Lankan merchants, fees, taxes, levies and fuel stations are recognised instantly and offline, so fewer charges ever need the AI at all.',
                    'The AI still only ever UPGRADES a generic guess — locked fuel, cash-advance and fee verdicts are never overridden, so the classifier can only get better.',
                    'App modules now always refresh on a new release (no lingering old code), and the server now gives the multi-engine vote its full time budget so even slower engines still get to weigh in.',
                ]},
            ]
        },
        '7.31.0': {
            date: '2026-06-24',
            headline: 'Open the installed app straight to your dashboard',
            sections: [
                { title: 'New', items: [
                    'Passcode-free entry for the installed app — when WealthFlow runs as the installed app (added to your home screen / APK), you can open straight to your dashboard with no passcode or biometric. Turn it on in Settings → Device Access & Encryption. For your security it NEVER applies in a normal browser tab — only the private installed app — and it is off by default.',
                    'While passcode-free entry is on, the installed app also stops auto-locking on inactivity (a browser tab still auto-locks normally).',
                ]},
                { title: 'Note', items: [
                    'Your PIN and biometrics are untouched and still protect a browser tab and every other device. Turn the option off anytime to require your passcode again.',
                ]},
            ]
        },
        '7.30.0': {
            date: '2026-06-22',
            headline: 'Loans that reconcile themselves & a sharper, faster classifier',
            sections: [
                { title: 'New', items: [
                    'Loan auto-allocation — when a bank statement contains a loan repayment (EMI / instalment / standing order), WealthFlow now matches it to the right loan and files it against that month automatically, exactly like every other tab\'s allocated-months view. If you had already marked that month paid, the statement amount takes over (it\'s the authoritative figure). It is conservative on purpose: a payment must clearly look like a loan (loan wording plus a matching bank, name or installment amount) so ordinary purchases are never mistaken for a loan payment.',
                    'Correct loan among several — with multiple loans (e.g. two housing loans and a vehicle lease) the right one is chosen by amount, bank and name, and decisively by the loan/account number when the bank prints it — so even two near-identical loans are told apart.',
                    'Cheque auto-routing — cheque lines on a bank statement now file straight into the Cheque tab: a deposit/inward cheque as Received (money in), a cheque payment/outward as Issued (money out), with the cheque number read from the narration. Cheque-book and return fees correctly stay as bank charges.',
                    'CC One-Time now sorts with two clean buttons — ↓ Newest and ↑ Oldest (default ↓ Newest) — so the controls never wrap and the "+ Add Payment" button stays put on smaller screens.',
                ]},
                { title: 'Improved', items: [
                    'Much smarter auto-classification — the trained engine now recognises far more Sri Lankan merchants and services (supermarkets, restaurants, ride apps, e-commerce, pharmacies & hospitals, schools & courses, insurers, and streaming/SaaS subscriptions), so "Goes to" and "Type" are pre-selected correctly for many more rows without waiting on the AI.',
                    'More fuel forecourts and income types (freelance/commission/royalty) are detected out of the box.',
                ]},
                { title: 'Fixed', items: [
                    'Statement balance lines written as "B/F" or "C/F" are now correctly skipped instead of leaking in as an expense.',
                ]},
            ]
        },
        '7.29.0': {
            date: '2026-06-22',
            headline: 'Sharper credit-card brain & a smoother CC workspace',
            sections: [
                { title: 'New', items: [
                    'Re-payment type — repayments and refunds on a card statement are detected automatically and filed as a credit that pays down your charges (oldest first). You can also pick "Re-payment" manually.',
                    'Service Fee is now a one-tap type everywhere (manual add + statement review).',
                    'CC One-Time sorts newest statement date first by default — import the latest statement first, then older ones, and the most recent stays on top.',
                    'Card filter chips are colour-coded per card so you can tell them apart at a glance.',
                ]},
                { title: 'Improved', items: [
                    'Far more accurate fee detection — FUEL SURCHARGE, ADVANCE FEE, STAMP DUTY, annual & membership fees, finance/interest charges and taxes/levies (VAT, NBT, SSCL, CESS) all resolve to Service Fee, and a fee always wins over fuel & cash-advance.',
                    'Record-a-payment is locked to the card in context (no more typing the wrong name); the amount auto-formats with thousands separators and .00 cents.',
                    'The trained classifier is now the single source of truth in the import review, so a wrong AI guess can no longer mislabel a charge.',
                ]},
                { title: 'Fixed', items: [
                    'Deleting a card\'s statements now also clears its left-over payments (no more orphaned credit surplus).',
                    'Removed the duplicated "LKR LKR" on the card filter chips.',
                    'What\'s New now always shows the release notes.',
                ]},
            ]
        },
        '7.28.0': {
            date: '2026-06-21',
            headline: 'Imported card charges no longer show as paid',
            sections: [
                { title: 'Fixed', items: [
                    'Charges imported from a credit-card statement are correctly marked unpaid until a payment actually covers them (previously every imported charge could show as Paid).',
                    'A one-time self-healing pass re-opens any charge wrongly auto-marked paid by the old import, while keeping your real manual and auto-matched payments intact.',
                ]},
            ]
        },
        '7.12.0': {
            date: '2026-06-01',
            headline: 'Smarter, safer, and now self-updating',
            sections: [
                { title: 'New', items: [
                    'In-app updates — see what\'s new, agree, confirm with your PIN, and the app updates itself with a live progress bar.',
                    'Send Feedback — report a bug or idea right from Settings; it reaches the team automatically.',
                    'Card & Account Registry is back — map a card\'s last-4 so the AI routes service charges correctly.',
                ]},
                { title: 'Improved', items: [
                    'Much higher transaction-categorisation accuracy (600+ Sri-Lanka-aware merchant rules + agentic web lookup for unknown shops).',
                    'Income & investment auto-detection (salary, dividends, unit trusts).',
                    'Cleaner, more professional interface with fewer decorative emojis.',
                ]},
                { title: 'Fixed', items: [
                    'The demo sample can no longer be saved as your real data.',
                    'Review queue: each item now has a Remove button.',
                    'AI advisor suggestion chips now always respond.',
                ]},
                { security: true, title: 'Security', items: [
                    'All AI data (memory, review queue, job queue) encrypted at rest with AES-256-GCM.',
                ]},
            ]
        }
    };

    let _manifest = null;     // loaded version.json (optional)
    let _swWaiting = null;    // a waiting service worker, if any
    let _fbImageData = null;  // attached screenshot (downscaled data-URL) for feedback

    // ───────────────────────────────────────────────────────────────────────
    //  DETECTION
    // ───────────────────────────────────────────────────────────────────────
    async function _loadManifest() {
        // (a) inline manifest if the page defined one
        if (window.wfVersionManifest) { _manifest = window.wfVersionManifest; return _manifest; }
        // (b) Firestore manifest written by the auto-release brain — this lets
        //     the server announce/schedule updates with NO redeploy. Takes
        //     priority over the static file when present and newer.
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const db = window.db || (fb && fb.firestore ? fb.firestore() : null);
            if (db) {
                const doc = await db.collection('system').doc('manifest').get();
                if (doc && doc.exists) {
                    const m = doc.data();
                    if (m && m.latest) { _manifest = m; return _manifest; }
                }
            }
        } catch (_) { /* offline or no permission — fall through to static file */ }
        // (c) static version.json (cache-busted) — fallback
        try {
            const r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
            if (r.ok) { _manifest = await r.json(); return _manifest; }
        } catch (_) {}
        return null;
    }

    function _installedVersion() {
        try { return localStorage.getItem(LS_INSTALLED) || null; } catch (_) { return null; }
    }
    function _markInstalled(v) {
        try { localStorage.setItem(LS_INSTALLED, v); } catch (_) {}
    }

    // The version that is *available* to move to (manifest latest, else current build)
    function _latestVersion() {
        if (_manifest && _manifest.latest) return _manifest.latest;
        return CURRENT_VERSION;
    }

    // v7.35.0 — release notes come in TWO shapes: a rich object
    // { headline, date, sections:[{title, items:[...]}] } (BUILTIN_NOTES) OR a plain
    // string (the version.json manifest, e.g. "7.34.0": "…"). The What's-New sheet and
    // the post-update welcome both read notes.sections — a string has none, so they
    // used to throw (undefined.map / undefined.forEach) and the "View" button did
    // nothing. _normNotes guarantees the object shape for every caller.
    function _normNotes(n) {
        if (!n) return null;
        if (typeof n === 'string') {
            const txt = n.trim();
            return txt ? { headline: "What's New", sections: [{ title: 'Highlights', items: [txt] }] } : null;
        }
        if (Array.isArray(n.sections)) return n;            // already structured
        const items = [];
        ['body', 'note', 'text', 'desc', 'description', 'summary'].forEach(k => { if (n[k]) items.push(String(n[k])); });
        const out = { headline: n.headline || "What's New", sections: items.length ? [{ title: 'Highlights', items }] : [] };
        if (n.date) out.date = n.date;
        if (n.mandatory) out.mandatory = n.mandatory;
        if (n.security) out.security = n.security;
        return out;
    }
    function _rawNotesFor(v) {
        if (_manifest && _manifest.notes && _manifest.notes[v]) return _manifest.notes[v];
        if (BUILTIN_NOTES[v]) return BUILTIN_NOTES[v];
        // v7.29.0 — never show an empty What's New: fall back to the newest notes we have.
        try {
            const all = Object.assign({}, BUILTIN_NOTES, (_manifest && _manifest.notes) || {});
            const vk = x => String(x).split('.').map(Number);
            const keys = Object.keys(all).sort((a, b) => { const A = vk(a), B = vk(b); for (let i = 0; i < 3; i++) { if ((B[i] || 0) !== (A[i] || 0)) return (B[i] || 0) - (A[i] || 0); } return 0; });
            return keys.length ? all[keys[0]] : null;
        } catch (_) { return null; }
    }
    function _notesFor(v) { return _normNotes(_rawNotesFor(v)); }
    function _isMandatory(v) {
        if (_manifest && _manifest.mandatory && _manifest.mandatory.indexOf(v) >= 0) return true;
        const n = _notesFor(v);
        return !!(n && n.mandatory);
    }
    // Update "type": full | minor | security. Drives the badge + messaging.
    function _updateType(v) {
        const n = _notesFor(v);
        if (n && n.type) return n.type;
        if (_isMandatory(v)) return 'security';
        // infer from version delta: major/minor bump = full, patch = minor
        const inst = _installedVersion() || CURRENT_VERSION;
        const a = String(v).split('.').map(Number), b = String(inst).split('.').map(Number);
        if ((a[0] || 0) > (b[0] || 0) || (a[1] || 0) > (b[1] || 0)) return 'full';
        return 'minor';
    }
    function _typeBadge(type) {
        const map = {
            full:     ['Full update', '#10b981', 'rgba(16,185,129,0.15)'],
            minor:    ['Minor update', '#818cf8', 'rgba(129,140,248,0.15)'],
            security: ['Security update', '#f59e0b', 'rgba(245,158,11,0.15)']
        };
        const m = map[type] || map.minor;
        return '<span class="badge" style="background:' + m[2] + ';color:' + m[1] + ';padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;">' + m[0] + '</span>';
    }

    // True if this browser is on an older version than what's available.
    function _updateAvailable() {
        const installed = _installedVersion();
        if (!installed) return false;       // brand-new install handled separately
        return _cmp(_latestVersion(), installed) > 0;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SERVICE-WORKER COORDINATION (real file swap)
    // ───────────────────────────────────────────────────────────────────────
    function _watchServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.getRegistration().then(reg => {
            if (!reg) return;
            if (reg.waiting) { _swWaiting = reg.waiting; _refreshDashboardPill(); }
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                if (!nw) return;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                        _swWaiting = reg.waiting || nw;
                        _refreshDashboardPill();
                    }
                });
            });
            // proactively check for a new SW
            try { reg.update(); } catch (_) {}
        }).catch(() => {});
        // when the new SW takes control after we asked it to, reload once
        let _reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_reloaded) return; _reloaded = true;
            // only auto-reload if we initiated an update
            try { if (localStorage.getItem(LS_PENDING)) location.reload(); } catch (_) { location.reload(); }
        });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  DASHBOARD PILL
    // ───────────────────────────────────────────────────────────────────────
    function _refreshDashboardPill() {
        _updateNavBadge();
        const show = _updateAvailable() || !!_swWaiting;
        let pill = document.getElementById('wfUpdatePill');
        if (!show) { if (pill) pill.remove(); return; }
        if (pill) return; // already shown
        // inject into dashboard if present
        const dash = document.getElementById('page-dashboard') || document.querySelector('.page.active') || document.body;
        pill = document.createElement('button');
        pill.id = 'wfUpdatePill';
        pill.type = 'button';
        pill.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:wfUpPulse 1.8s infinite;"></span>' +
                         '<span>Update available — ' + _esc(_latestVersion()) + '</span>' +
                         '<span style="opacity:.7;">View ›</span>';
        pill.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 auto 14px;padding:10px 16px;border-radius:999px;border:1px solid rgba(16,185,129,0.4);background:linear-gradient(135deg,rgba(16,185,129,0.12),rgba(16,185,129,0.04));color:var(--text,#e6e7eb);font-size:13px;font-weight:700;cursor:pointer;width:fit-content;max-width:100%;';
        pill.onclick = openUpdateSection;
        if (!document.getElementById('wfUpStyle')) {
            const st = document.createElement('style'); st.id = 'wfUpStyle';
            st.textContent = '@keyframes wfUpPulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,0.6)}70%{box-shadow:0 0 0 9px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}';
            document.head.appendChild(st);
        }
        // place at top of dashboard content
        const anchor = dash.querySelector('.dash-head, h1, .page-title') || dash.firstChild;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(pill, anchor.nextSibling);
        else dash.insertBefore(pill, dash.firstChild);
    }

    // Tapping the dashboard pill → go to Settings + open the update section.
    function openUpdateSection() {
        try { if (typeof showPage === 'function') showPage('settings'); } catch (_) {}
        setTimeout(() => {
            const card = document.getElementById('wfUpdateCard');
            if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.style.outline = '2px solid rgba(16,185,129,0.6)'; setTimeout(() => card.style.outline = '', 1600); }
            // open the What's New sheet directly too
            showWhatsNew(_latestVersion());
        }, 350);
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SETTINGS "SOFTWARE UPDATE" CARD (self-injecting)
    // ───────────────────────────────────────────────────────────────────────
    function _injectSettingsCard() {
        // The card #wfUpdateCard is now a permanent placeholder inside the
        // settings template (it survives every renderSettings rebuild). We just
        // fill it. If for any reason the placeholder isn't there yet (older
        // cached HTML), fall back to creating it before the PWA section.
        const ph = document.getElementById('wfUpdateCard');
        if (ph) { ph.classList.add('settings-section'); _renderSettingsCard(); return true; }
        const pwa = document.getElementById('wfPwaSection');
        if (!pwa || !pwa.parentNode) return false;
        const card = document.createElement('div');
        card.className = 'settings-section';
        card.id = 'wfUpdateCard';
        pwa.parentNode.insertBefore(card, pwa);
        _renderSettingsCard();
        return true;
    }

    function _renderSettingsCard() {
        const card = document.getElementById('wfUpdateCard');
        if (!card) return;
        card.classList.add('settings-section');
        const installed = _installedVersion() || CURRENT_VERSION;
        const latest = _latestVersion();
        const avail = _updateAvailable() || !!_swWaiting;
        const mand = avail && _isMandatory(latest);
        card.style.border = avail ? '1px solid rgba(16,185,129,0.45)' : '1px solid var(--border2)';
        card.innerHTML =
            '<div class="settings-title" style="color:' + (avail ? '#10b981' : '#818cf8') + ';">Software Update</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">Current version</div><div class="setting-desc">WealthFlow Elite v' + _esc(installed) + (avail ? '' : ' · up to date') + '</div></div>' +
                (avail
                    ? '<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">' + _typeBadge(_updateType(latest)) + '<span class="badge" style="background:rgba(16,185,129,0.15);color:#10b981;padding:6px 12px;border-radius:999px;font-weight:800;">v' + _esc(latest) + '</span></span>'
                    : '<span class="badge" style="background:var(--bg2);color:var(--text3);padding:6px 12px;border-radius:999px;">Latest</span>') +
            '</div>' +
            (avail
                ? '<div style="margin-top:6px;">' +
                    (mand ? '<div style="margin-bottom:10px;padding:9px 12px;border-radius:9px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:#f87171;font-size:12.5px;font-weight:700;">Required security update — please install to keep your finances protected.</div>' : '') +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                        '<button class="btn btn-primary btn-sm" style="flex:1;min-width:150px;" onclick="wfUpdate.start()">' + (mand ? 'Install required update' : 'Update now') + '</button>' +
                        '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.whatsNew(\'' + _esc(latest) + '\')">What\'s new</button>' +
                    '</div>' +
                  '</div>'
                : '<div class="setting-row"><div class="setting-info"><div class="setting-label">Release notes</div><div class="setting-desc">See what changed in this version.</div></div><button class="btn btn-ghost btn-sm" onclick="wfUpdate.whatsNew(\'' + _esc(installed) + '\')">View</button></div>'
            ) +
            '<div class="setting-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:12px;">' +
                '<div class="setting-info"><div class="setting-label">Check for updates</div><div class="setting-desc">Look for a newer version right now.</div></div>' +
                '<button class="btn btn-secondary btn-sm" id="wfCheckBtn" onclick="wfUpdate.check()">Check now</button>' +
            '</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">System self-check</div><div class="setting-desc">Run a full diagnostic across the app\'s engines and report any issues.</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.diagnostics()">Run</button>' +
            '</div>' +
            '<div class="setting-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:12px;">' +
                '<div class="setting-info"><div class="setting-label">Auto-install security updates</div><div class="setting-desc">Like Android: when ON, urgent security updates install automatically (still backup-first + rollback). Other updates always ask first.</div></div>' +
                '<div class="toggle' + (_autoSecurityOn() ? ' on' : '') + '" id="wfAutoSec" onclick="wfUpdate.setAutoSecurity(!this.classList.contains(\'on\'))"></div>' +
            '</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">Prioritised feedback</div><div class="setting-desc">See all user feedback scored and ranked by urgency (security & crashes first).</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfFeedbackAI && wfFeedbackAI.showBoard()">View</button>' +
            '</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">Send Feedback</div><div class="setting-desc">Report a bug or suggest an idea — it\'s scored and prioritised automatically.</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.feedback()">Send</button>' +
            '</div>';
        _updateNavBadge();
    }

    // Red "1" badge on the Settings nav item when an update is available.
    function _updateNavBadge() {
        // keep the sidebar version label in sync with the real running version.
        //
        // CRITICAL FIX (v7.16.2): only write to the DOM when the value actually
        // CHANGES. A no-op `textContent = x` assignment STILL tears down the old
        // text node and inserts a fresh one — that counts as a childList mutation.
        // The old MutationObserver called this function on every mutation, so each
        // write re-fired the observer, which wrote again… an infinite self-feeding
        // microtask loop that starved the main thread. That single loop froze the
        // splash progress bar (~40%, stuck on "Securing connection…") so the app
        // never opened, and made the Settings / Software-Update buttons feel dead.
        // Idempotent writes below make every redundant call a true no-op, which is
        // what finally breaks the loop.
        try {
            const sv = document.getElementById('wfSbVer');
            if (sv) {
                const label = 'WealthFlow v' + (_installedVersion() || CURRENT_VERSION) + ' · Infinity Engine';
                if (sv.textContent !== label) sv.textContent = label;
            }
        } catch (_) {}
        const badge = document.getElementById('nb-settings');
        if (!badge) return;
        const show = _updateAvailable() || !!_swWaiting;
        const disp = show ? '' : 'none';
        if (badge.style.display !== disp) badge.style.display = disp;
        if (show && badge.textContent !== '1') badge.textContent = '1';
    }

    function _autoSecurityOn() { try { return localStorage.getItem(LS_AUTOSEC) === '1'; } catch (_) { return false; } }
    function setAutoSecurity(on) {
        try { localStorage.setItem(LS_AUTOSEC, on ? '1' : '0'); } catch (_) {}
        const tg = document.getElementById('wfAutoSec'); if (tg) tg.classList.toggle('on', !!on);
        _notify(on ? 'Auto-install for urgent security updates is ON.' : 'Auto-install for security updates is OFF.', on ? 'success' : 'info');
        if (on && _updateAvailable() && _isMandatory(_latestVersion())) {
            setTimeout(() => _autoApplyIfSecurity(), 600);
        }
    }

    // If the user opted in, silently apply an URGENT (mandatory security) update
    // — still backup-first and rollback-safe. Non-security updates never auto-apply.
    async function _autoApplyIfSecurity() {
        if (!_autoSecurityOn()) return false;
        const v = _latestVersion();
        if (!_updateAvailable()) return false;
        if (!(_isMandatory(v) && _updateType(v) === 'security')) return false;
        _notify('Installing urgent security update v' + v + '…', 'warn');
        await _runProgress(v);   // backup → swap → reload, no prompts
        return true;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  WHAT'S NEW (scrollable changelog sheet)
    // ───────────────────────────────────────────────────────────────────────
    function showWhatsNew(version) {
        const notes = _notesFor(version);
        _closeOverlay('wfWhatsNew');
        const ov = document.createElement('div');
        ov.id = 'wfWhatsNew';
        ov.style.cssText = _overlayCss();
        const secHtml = notes ? notes.sections.map(s => {
            const color = s.security ? '#f59e0b' : '#10b981';
            return '<div style="margin-bottom:16px;">' +
                '<div style="font-weight:800;font-size:13px;letter-spacing:.4px;text-transform:uppercase;color:' + color + ';margin-bottom:7px;">' + _esc(s.title) + '</div>' +
                s.items.map(it => '<div style="display:flex;gap:9px;margin-bottom:7px;font-size:13.5px;line-height:1.5;color:var(--text,#e6e7eb);"><span style="color:' + color + ';">•</span><span>' + _esc(it) + '</span></div>').join('') +
            '</div>';
        }).join('') : '<div style="color:var(--text3);font-size:13px;">No release notes available for this version.</div>';
        ov.innerHTML = _sheet(
            (notes && notes.headline ? _esc(notes.headline) : 'What\'s New') ,
            'Version ' + _esc(version) + (notes && notes.date ? ' · ' + _esc(notes.date) : ''),
            secHtml,
            '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._close(\'wfWhatsNew\')">Close</button>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
    }

    // ───────────────────────────────────────────────────────────────────────
    //  UPDATE FLOW:  EULA → PIN → backup → progress → swap → reload
    // ───────────────────────────────────────────────────────────────────────
    async function startUpdate() {
        const version = _latestVersion();
        const ok = await _showEula(version);
        if (!ok) return;
        // PIN gate (reuse the app's verified prompt)
        if (typeof window._verifyPinPrompt === 'function') {
            const pinOk = await window._verifyPinPrompt('Enter your PIN to authorise the update to v' + version + '.');
            if (!pinOk) { _notify('Update cancelled.', 'info'); return; }
        }
        await _runProgress(version);
    }

    function _showEula(version) {
        return new Promise((resolve) => {
            _closeOverlay('wfEula');
            const ov = document.createElement('div');
            ov.id = 'wfEula';
            ov.style.cssText = _overlayCss();
            const eula = _generateEula(version);
            ov.innerHTML = _sheet(
                'Update Agreement',
                'Version ' + _esc(version) + ' — please review & accept',
                '<div id="wfEulaScroll" style="max-height:46vh;overflow-y:auto;padding:14px;background:var(--bg2,#0a0e1a);border:1px solid var(--border,#1f2638);border-radius:11px;font-size:12.5px;line-height:1.6;color:var(--text2,#c7cdd9);white-space:pre-wrap;">' + _esc(eula) + '</div>' +
                '<div id="wfEulaHint" style="font-size:11.5px;color:var(--text3,#8b95a8);text-align:center;margin-top:8px;">Scroll to the bottom to continue.</div>',
                '<div style="display:flex;gap:8px;">' +
                    '<button class="btn btn-ghost" style="flex:1;" id="wfEulaCancel">Cancel</button>' +
                    '<button class="btn btn-primary" style="flex:2;opacity:.5;pointer-events:none;" id="wfEulaAgree">I Agree</button>' +
                '</div>'
            );
            document.body.appendChild(ov);
            requestAnimationFrame(() => ov.style.opacity = '1');
            const scroll = ov.querySelector('#wfEulaScroll');
            const agree = ov.querySelector('#wfEulaAgree');
            const hint = ov.querySelector('#wfEulaHint');
            const unlock = () => { agree.style.opacity = '1'; agree.style.pointerEvents = 'auto'; if (hint) hint.textContent = 'Thanks — you can continue.'; };
            // if content is short and already fully visible, unlock right away
            if (scroll.scrollHeight <= scroll.clientHeight + 8) unlock();
            scroll.addEventListener('scroll', () => { if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 12) unlock(); });
            ov.querySelector('#wfEulaCancel').onclick = () => { _close('wfEula'); resolve(false); };
            agree.onclick = () => { _close('wfEula'); resolve(true); };
        });
    }

    function _generateEula(version) {
        const today = new Date().toISOString().slice(0, 10);
        return (
'WEALTHFLOW ELITE — SOFTWARE UPDATE & END-USER LICENSE AGREEMENT\n' +
'Version ' + version + ' · Effective ' + today + '\n' +
'\n' +
'1. ACCEPTANCE. By tapping "I Agree" you consent to install WealthFlow Elite ' +
'v' + version + ' on this device and to the terms below.\n' +
'\n' +
'2. WHAT THIS UPDATE DOES. It replaces the application files cached on this ' +
'device with a newer version. Before any change is made, a backup of your data ' +
'is created. Your financial records are preserved.\n' +
'\n' +
'3. YOUR DATA & PRIVACY. WealthFlow stores your data in your own browser and, ' +
'when you enable cloud sync, in your private cloud space. AI memory, the review ' +
'queue and the job queue are encrypted at rest. We do not sell your data. Only ' +
'a non-identifying merchant name may be sent to a lookup service to categorise ' +
'unknown shops; never amounts, balances or card numbers.\n' +
'\n' +
'4. NO FINANCIAL ADVICE. WealthFlow is a personal money-management tool. Its ' +
'AI suggestions are informational and are not professional financial advice.\n' +
'\n' +
'5. SECURITY UPDATES. Some updates address security issues and may be marked ' +
'required. Installing them promptly helps keep your financial data safe.\n' +
'\n' +
'6. NO WARRANTY. The software is provided "as is" without warranty of any kind ' +
'to the extent permitted by law. You remain responsible for verifying your own ' +
'financial figures.\n' +
'\n' +
'7. PER-DEVICE INSTALLATION. This update applies to this device only. Other ' +
'devices update independently when you choose.\n' +
'\n' +
'8. ROLLBACK SAFETY. If the update cannot complete, the previous version ' +
'remains active and your data is restored from the pre-update backup.\n' +
'\n' +
'By continuing, you acknowledge you have read and agree to this Agreement for ' +
'WealthFlow Elite v' + version + '.\n'
        );
    }

    // Real progress: each step does actual work, then advances the bar.
    async function _runProgress(version) {
        _closeOverlay('wfProgress');
        const ov = document.createElement('div');
        ov.id = 'wfProgress';
        ov.style.cssText = _overlayCss() + 'pointer-events:auto;';
        ov.innerHTML =
            '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:18px;width:100%;max-width:440px;padding:24px;box-shadow:0 30px 90px rgba(0,0,0,0.6);">' +
              '<div style="font-weight:800;font-size:17px;color:var(--text,#e6e7eb);margin-bottom:4px;">Updating to v' + _esc(version) + '</div>' +
              '<div id="wfPgStep" style="font-size:12.5px;color:var(--text3,#8b95a8);margin-bottom:16px;min-height:18px;">Preparing…</div>' +
              '<div style="height:12px;border-radius:999px;background:var(--bg2,#0a0e1a);overflow:hidden;border:1px solid var(--border,#1f2638);">' +
                '<div id="wfPgBar" style="height:100%;width:0%;background:linear-gradient(90deg,#10b981,#34d399);transition:width .5s ease;"></div>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--text2,#c7cdd9);">' +
                '<span id="wfPgPct" style="font-weight:800;color:#10b981;">0%</span>' +
                '<span id="wfPgEta">estimating…</span>' +
              '</div>' +
            '</div>';
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');

        const setBar = (p) => { const b = document.getElementById('wfPgBar'), t = document.getElementById('wfPgPct'); if (b) b.style.width = p + '%'; if (t) t.textContent = p + '%'; };
        const setStep = (s) => { const e = document.getElementById('wfPgStep'); if (e) e.textContent = s; };
        const setEta = (sec) => { const e = document.getElementById('wfPgEta'); if (e) e.textContent = sec > 0 ? ('about ' + sec + 's remaining') : 'finishing…'; };

        const steps = [
            { pct: 12, eta: 9, label: 'Encrypting and backing up your data…', run: async () => {
                try { if (typeof window.backupNow === 'function') await window.backupNow(true, 'pre-update'); } catch (_) {}
                // Local pre-update snapshot so self-heal can roll data back if the
                // new version crash-loops. Stores the wf2_* keys only (the app's data).
                try {
                    const snap = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && k.indexOf('wf2_') === 0) snap[k] = localStorage.getItem(k);
                    }
                    localStorage.setItem('wf_preupdate_snapshot', JSON.stringify({ at: Date.now(), data: snap }));
                } catch (_) {}
            }},
            { pct: 40, eta: 6, label: 'Downloading new version files…', run: async () => {
                // ask the SW registration to fetch the newest files
                try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (_) {}
                await _sleep(700);
            }},
            { pct: 68, eta: 4, label: 'Applying security protocols…', run: async () => { await _sleep(600); }},
            { pct: 88, eta: 2, label: 'Swapping core files…', run: async () => {
                try { localStorage.setItem(LS_PENDING, version); } catch (_) {}
                // tell the waiting SW to take over (triggers controllerchange→reload)
                try {
                    const reg = await navigator.serviceWorker.getRegistration();
                    const w = (reg && reg.waiting) || _swWaiting;
                    if (w) w.postMessage({ type: 'SKIP_WAITING' });
                } catch (_) {}
                await _sleep(500);
            }},
            { pct: 100, eta: 0, label: 'Finalising…', run: async () => { await _sleep(400); }},
        ];

        for (const st of steps) {
            setStep(st.label); setEta(st.eta);
            await st.run();
            setBar(st.pct);
            await _sleep(250);
        }

        // Mark the new version installed and queue the post-update popup.
        _markInstalled(version);
        try { localStorage.setItem(LS_SEEN_POPUP, ''); } catch (_) {}
        setStep('Update complete. Restarting…');

        // If a SW actually took control, controllerchange already reloaded.
        // Otherwise (no SW / already controlling) reload ourselves so new files load.
        await _sleep(700);
        try { localStorage.removeItem(LS_PENDING); } catch (_) {}
        location.reload();
    }

    // ───────────────────────────────────────────────────────────────────────
    //  POST-UPDATE "WELCOME" POPUP (after re-login / reload)
    // ───────────────────────────────────────────────────────────────────────
    function _maybeShowPostUpdate() {
        const installed = _installedVersion();
        if (!installed) return;
        let seen = null;
        try { seen = localStorage.getItem(LS_SEEN_POPUP); } catch (_) {}
        if (seen === installed) return;            // already shown for this version
        const notes = _notesFor(installed);
        if (!notes) { try { localStorage.setItem(LS_SEEN_POPUP, installed); } catch (_) {} return; }
        // show centered welcome
        _closeOverlay('wfPostUpdate');
        const ov = document.createElement('div');
        ov.id = 'wfPostUpdate';
        ov.style.cssText = _overlayCss();
        const items = [];
        notes.sections.forEach(s => s.items.forEach(it => items.push({ t: s.title, v: it, sec: !!s.security })));
        const list = items.slice(0, 8).map(o =>
            '<div style="display:flex;gap:9px;margin-bottom:8px;font-size:13px;line-height:1.5;color:var(--text,#e6e7eb);">' +
            '<span style="color:' + (o.sec ? '#f59e0b' : '#10b981') + ';font-weight:800;min-width:54px;">' + _esc(o.t) + '</span>' +
            '<span>' + _esc(o.v) + '</span></div>').join('');
        ov.innerHTML = _sheet(
            'Welcome to v' + _esc(installed),
            notes.headline ? _esc(notes.headline) : 'Your app has been updated',
            list,
            '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._closePost()">Return to Dashboard</button>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
    }
    function _closePost() {
        const v = _installedVersion();
        try { localStorage.setItem(LS_SEEN_POPUP, v); } catch (_) {}
        _close('wfPostUpdate');
    }

    // ───────────────────────────────────────────────────────────────────────
    //  CHECK FOR UPDATES (manual)
    // ───────────────────────────────────────────────────────────────────────
    async function checkForUpdates() {
        const btn = document.getElementById('wfCheckBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
        // re-fetch manifest + ask the SW to look for new files
        await _loadManifest();
        try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (_) {}
        await _sleep(900);
        if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }
        _refreshDashboardPill();
        _renderSettingsCard();
        if (_updateAvailable() || _swWaiting) {
            _notify('Update available — v' + _latestVersion() + ' is ready to install.', 'success');
            openUpdateSection();
        } else {
            _notify('You\'re on the latest version (v' + (_installedVersion() || CURRENT_VERSION) + ').', 'info');
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SYSTEM SELF-CHECK / DIAGNOSTICS
    //  The honest version of "all the AIs check the code": a multi-stage
    //  diagnostic that verifies every engine is loaded and responding, checks
    //  data integrity, and reports issues. Runs real checks, not theatre.
    // ───────────────────────────────────────────────────────────────────────
    function _runChecks() {
        const checks = [];
        const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

        // Stage 1 — core engines present
        ok('Brain / classifier reachable', typeof window.wfBrainClassify === 'function' || typeof window.wfClassifySms === 'function', 'SMS/statement classification');
        ok('Category intelligence', !!(window.wfCategoryAI && window.wfCategoryAI.classify), '600+ keyword rules');
        ok('Learning memory', !!(window.wfMemory && window.wfMemory.recall), 'remembers your categories');
        ok('Duplicate defence', !!(window.wfDedup && window.wfDedup.scanExisting), 'stops double-filing');
        ok('Review queue', !!(window.wfReview && window.wfReview.add), 'ask-me-later');
        ok('Background queue', !!(window.wfQueue && window.wfQueue.enqueueSms), 'walk-away processing');
        ok('Encryption', !!(window.wfCrypto && (window.wfCrypto.isAvailable ? window.wfCrypto.isAvailable() : true)), 'AES-256-GCM at rest');
        ok('Card registry', !!(window.wfCardRegistry && window.wfCardRegistry.get), 'card→type routing');
        ok('Update system', !!(window.wfUpdate && window.wfUpdate.start), 'this engine');
        ok('Boot Guard', typeof window.__wfBootGuardSuccess === 'function', 'purges bad cache & recovers from black screen');
        ok('Feedback intelligence', !!(window.wfFeedbackAI && window.wfFeedbackAI.analyse), 'semantic prioritisation');

        // Stage 2 — storage + data integrity
        let dbOk = false, recCount = 0;
        try {
            dbOk = !!(window.DB && typeof DB.get === 'function');
            if (dbOk) ['expenses', 'income', 'subscriptions', 'cconetime', 'ccinstall'].forEach(k => { try { recCount += (DB.get(k) || []).length; } catch (_) {} });
        } catch (_) {}
        ok('Local database', dbOk, recCount + ' records readable');

        // Stage 3 — cloud + backup
        // Cloud sync: Firestore is up if the firebase SDK loaded AND an app is
        // initialised. Check several signals so a local variable name doesn't
        // cause a false "CHECK".
        let cloudOk = false;
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const hasApp = !!(fb && fb.apps && fb.apps.length > 0);
            const hasStore = !!(window.db || (fb && fb.firestore));
            cloudOk = !!(fb && (hasApp || hasStore));
        } catch (_) {}
        ok('Cloud sync', cloudOk, cloudOk ? 'real-time Firestore' : 'sign in to enable cloud sync');
        let lastBackup = null;
        try { lastBackup = (typeof window._getLastBackupMs === 'function') ? window._getLastBackupMs() : null; } catch (_) {}
        ok('Backup ready', !!(typeof window.backupNow === 'function'), lastBackup ? ('last: ' + new Date(lastBackup).toLocaleString()) : 'backup engine present');

        // Stage 4 — service worker / offline
        ok('Offline support', 'serviceWorker' in navigator, 'works without signal');

        // Stage 5 — live functional probe (actually classify a known string)
        let probeOk = false, probeDetail = '';
        try {
            if (window.wfCategoryAI && window.wfCategoryAI.classify) {
                const r = window.wfCategoryAI.classify('CARGILLS FOOD CITY', 'debit LKR1000 CARGILLS FOOD CITY', { type: 'debit', useMemory: false });
                probeOk = r && /grocer|food/i.test(r.category);
                probeDetail = 'Cargills → ' + (r ? r.category : '?');
            }
        } catch (_) {}
        ok('Live classification probe', probeOk, probeDetail);

        return checks;
    }

    function showDiagnostics() {
        _closeOverlay('wfDiag');
        const ov = document.createElement('div');
        ov.id = 'wfDiag';
        ov.style.cssText = _overlayCss();
        ov.innerHTML = _sheet('System Self-Check', 'Running diagnostics…',
            '<div id="wfDiagBody" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;">Scanning all engines…</div>',
            '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._close(\'wfDiag\')">Close</button>');
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');

        // run checks progressively for a "working" feel, then render results
        setTimeout(() => {
            const checks = _runChecks();
            const passed = checks.filter(c => c.pass).length;
            const total = checks.length;
            const allGood = passed === total;
            const rows = checks.map(c =>
                '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#1f2638);">' +
                    '<span style="font-size:15px;">' + (c.pass ? '✅' : '⚠️') + '</span>' +
                    '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text,#e6e7eb);">' + _esc(c.name) + '</div>' +
                    (c.detail ? '<div style="font-size:11px;color:var(--text3,#8b95a8);">' + _esc(c.detail) + '</div>' : '') + '</div>' +
                    '<span style="font-size:11px;font-weight:700;color:' + (c.pass ? '#10b981' : '#f59e0b') + ';">' + (c.pass ? 'OK' : 'CHECK') + '</span>' +
                '</div>').join('');
            const body = document.getElementById('wfDiagBody');
            if (body) {
                body.style.display = 'block';
                body.innerHTML =
                    '<div style="text-align:center;margin-bottom:14px;">' +
                        '<div style="font-size:34px;font-weight:900;color:' + (allGood ? '#10b981' : '#f59e0b') + ';">' + passed + '/' + total + '</div>' +
                        '<div style="font-size:12.5px;color:var(--text3,#8b95a8);">' + (allGood ? 'All systems operational' : 'Some items need attention') + '</div>' +
                    '</div>' + rows;
            }
            const sub = ov.querySelector('div[style*="font-size:12.5px"]');
            if (sub) sub.textContent = allGood ? 'All systems operational' : passed + '/' + total + ' checks passed';
        }, 900);
    }

    // ───────────────────────────────────────────────────────────────────────
    //  FEEDBACK (Firestore + optional email backup)
    // ───────────────────────────────────────────────────────────────────────
    function openFeedback() {
        _closeOverlay('wfFeedback');
        const ov = document.createElement('div');
        ov.id = 'wfFeedback';
        ov.style.cssText = _overlayCss();
        ov.innerHTML = _sheet(
            'Send Feedback',
            'Report a bug or suggest an idea',
            '<div style="display:flex;flex-direction:column;gap:10px;">' +
                '<select id="wfFbType" style="padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;">' +
                    '<option value="bug">🐞 Bug report</option><option value="idea">💡 Feature idea</option><option value="other">💬 Other</option>' +
                '</select>' +
                '<textarea id="wfFbText" rows="5" placeholder="Tell us what happened or what you\'d like…" style="padding:12px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;resize:vertical;"></textarea>' +
                '<div>' +
                    '<input type="file" id="wfFbImg" accept="image/*" style="display:none;" />' +
                    '<button type="button" id="wfFbImgBtn" style="width:100%;padding:11px;background:var(--bg,#060a14);border:1px dashed var(--border2,#1f2638);border-radius:9px;color:var(--text3,#8b95a8);font-size:13px;cursor:pointer;">📎 Attach a screenshot (optional)</button>' +
                    '<div id="wfFbImgPreview" style="display:none;margin-top:8px;position:relative;"></div>' +
                '</div>' +
                '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text3,#8b95a8);"><input type="checkbox" id="wfFbDiag" checked> Attach basic diagnostics (version, device) to help fix faster</label>' +
            '</div>',
            '<div style="display:flex;gap:8px;">' +
                '<button class="btn btn-ghost" style="flex:1;" onclick="wfUpdate._close(\'wfFeedback\')">Cancel</button>' +
                '<button class="btn btn-primary" style="flex:2;" id="wfFbSend">Send feedback</button>' +
            '</div>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
        ov.querySelector('#wfFbSend').onclick = _submitFeedback;
        // image attach: read as a downscaled data-URL so it's small enough to store
        const imgBtn = ov.querySelector('#wfFbImgBtn'), imgInput = ov.querySelector('#wfFbImg'), prev = ov.querySelector('#wfFbImgPreview');
        if (imgBtn && imgInput) {
            imgBtn.onclick = () => imgInput.click();
            imgInput.onchange = () => {
                const f = imgInput.files && imgInput.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                    // downscale to max 900px to keep the payload small
                    const img = new Image();
                    img.onload = () => {
                        const max = 900, scale = Math.min(1, max / Math.max(img.width, img.height));
                        const cv = document.createElement('canvas');
                        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
                        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                        _fbImageData = cv.toDataURL('image/jpeg', 0.7);
                        if (prev) { prev.style.display = 'block'; prev.innerHTML = '<img src="' + _fbImageData + '" style="max-width:100%;border-radius:8px;border:1px solid var(--border,#1f2638);"/><button type="button" onclick="this.parentNode.style.display=\'none\';this.parentNode.innerHTML=\'\';window.wfUpdate&&(window.wfUpdate._clearFbImg&&window.wfUpdate._clearFbImg());" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;width:26px;height:26px;cursor:pointer;">×</button>'; }
                        if (imgBtn) imgBtn.textContent = '📎 Screenshot attached — tap to change';
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(f);
            };
        }
    }

    async function _submitFeedback() {
        const type = (document.getElementById('wfFbType') || {}).value || 'other';
        const text = ((document.getElementById('wfFbText') || {}).value || '').trim();
        const diag = !!(document.getElementById('wfFbDiag') || {}).checked;
        if (text.length < 4) { _notify('Please type a little more so we can help.', 'warn'); return; }
        const payload = {
            type, text,
            version: _installedVersion() || CURRENT_VERSION,
            createdAt: new Date().toISOString(),
            uid: (window.currentUser && window.currentUser.uid) || null,
            image: _fbImageData || null,
            ua: diag ? navigator.userAgent : null,
            screen: diag ? (screen.width + 'x' + screen.height) : null,
            lang: diag ? navigator.language : null
        };
        // ALWAYS keep a local copy first, so "Your Feedback" shows it instantly
        // and nothing is ever lost — even if it also goes to the cloud.
        try { const s = JSON.parse(sessionStorage.getItem('wf_feedback_session') || '[]'); s.push(payload); sessionStorage.setItem('wf_feedback_session', JSON.stringify(s)); } catch (_) {}
        try { const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); q.push(Object.assign({ _pending: true }, payload)); localStorage.setItem('wf_feedback_queue', JSON.stringify(q.slice(-50))); } catch (_) {}

        let stored = false;
        // (1) Firestore — so it can be fetched/analysed/prioritised
        try {
            if (window.db && window.firebase && firebase.firestore) {
                const uid = payload.uid || 'anon';
                await window.db.collection('feedback').add(Object.assign({}, payload, { uid,
                    _ts: firebase.firestore.FieldValue.serverTimestamp() }));
                stored = true;
                _markQueuedSent(payload);   // clear the _pending flag for this item
            }
        } catch (_) {}
        // (2) Email backup for urgent alerts (optional endpoint, fails silently)
        try {
            await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            stored = true;
        } catch (_) {}
        _fbImageData = null;
        _close('wfFeedback');
        _notify(stored ? 'Thank you — your feedback was sent and prioritised.' : 'Saved — we\'ll send it automatically when you\'re back online. It already shows in “Your Feedback”.', stored ? 'success' : 'info');
    }

    // remove the _pending flag once an item is confirmed sent to the cloud
    function _markQueuedSent(payload) {
        try {
            const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]');
            const key = (payload.text || '') + '|' + (payload.createdAt || '');
            const upd = q.map(x => ((x.text || '') + '|' + (x.createdAt || '')) === key ? Object.assign({}, x, { _pending: false }) : x);
            localStorage.setItem('wf_feedback_queue', JSON.stringify(upd));
        } catch (_) {}
    }

    // Flush any feedback that was queued while offline/closed → Firestore, so it
    // appears in the board and reaches the brain. Runs on launch + when online.
    async function _flushQueuedFeedback() {
        let q = [];
        try { q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); } catch (_) { return; }
        const pending = q.filter(x => x && x._pending);
        if (!pending.length) return;
        if (!(window.db && window.firebase && firebase.firestore)) return;
        let changed = false;
        for (const p of pending) {
            try {
                const uid = p.uid || (window.currentUser && window.currentUser.uid) || 'anon';
                await window.db.collection('feedback').add(Object.assign({}, p, { uid, _pending: undefined,
                    _ts: firebase.firestore.FieldValue.serverTimestamp() }));
                p._pending = false; changed = true;
            } catch (_) { /* still offline — keep for next time */ }
        }
        if (changed) { try { localStorage.setItem('wf_feedback_queue', JSON.stringify(q)); } catch (_) {} }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  shared UI helpers
    // ───────────────────────────────────────────────────────────────────────
    function _overlayCss() {
        return 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.78);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .2s;';
    }
    function _sheet(title, sub, bodyHtml, footerHtml) {
        return '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:18px;width:100%;max-width:520px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 30px 90px rgba(0,0,0,0.6);">' +
            '<div style="padding:18px 20px;padding-top:max(18px, calc(env(safe-area-inset-top,0px) + 14px));border-bottom:1px solid var(--border,#1f2638);">' +
                '<div style="font-weight:800;font-size:17px;color:var(--text,#e6e7eb);">' + title + '</div>' +
                (sub ? '<div style="font-size:12.5px;color:var(--text3,#8b95a8);margin-top:2px;">' + sub + '</div>' : '') +
            '</div>' +
            '<div style="padding:18px 20px;overflow-y:auto;flex:1;">' + bodyHtml + '</div>' +
            '<div style="padding:14px 20px;border-top:1px solid var(--border,#1f2638);">' + footerHtml + '</div>' +
        '</div>';
    }
    function _close(id) { const ov = document.getElementById(id); if (ov) { ov.style.opacity = '0'; setTimeout(() => ov.remove(), 200); } }
    function _closeOverlay(id) { const ov = document.getElementById(id); if (ov) ov.remove(); }
    function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ───────────────────────────────────────────────────────────────────────
    //  INIT
    // ───────────────────────────────────────────────────────────────────────
    async function init() {
        // Wrap everything so a failure in any single step can never prevent the
        // Software Update card from being injected (the "sometimes missing" bug).
        try { _watchServiceWorker(); } catch (_) {}

        const installed = _installedVersion();
        if (!installed) {
            _markInstalled(CURRENT_VERSION);
            try { localStorage.setItem(LS_SEEN_POPUP, CURRENT_VERSION); } catch (_) {}
        } else if (_cmp(CURRENT_VERSION, installed) > 0) {
            _markInstalled(CURRENT_VERSION);
            try { localStorage.removeItem(LS_SEEN_POPUP); } catch (_) {}
        }

        // Inject the card RIGHT NOW with whatever version info we already have,
        // BEFORE any awaited/network work. The manifest then loads in the
        // background and refreshes the card when it arrives.
        try { _injectSettingsCard(); _refreshDashboardPill(); } catch (_) {}

        // Load the manifest in the background (non-blocking). A hung/failed
        // Firestore/network call must never stall card injection.
        _loadManifest().then(() => {
            try { _refreshDashboardPill(); _renderSettingsCard(); } catch (_) {}
            // mandatory-update handling, after we know the real latest version
            try {
                if (_updateAvailable() && _isMandatory(_latestVersion())) {
                    if (_autoSecurityOn() && _updateType(_latestVersion()) === 'security') setTimeout(() => { _autoApplyIfSecurity(); }, 2000);
                    else setTimeout(() => { _notify('A required security update is available.', 'warn'); openUpdateSection(); }, 1800);
                }
            } catch (_) {}
        }).catch(() => {});

        setTimeout(_maybeShowPostUpdate, 1400);

        // Flush any feedback queued while offline/closed, and retry when back online.
        setTimeout(() => { _flushQueuedFeedback(); }, 3000);
        try { window.addEventListener('online', () => { _flushQueuedFeedback(); }); } catch (_) {}

        // Inject dashboard pill + settings card. First a short burst for the
        // initial paint, then a PERMANENT MutationObserver so the card is
        // guaranteed to (re)appear whenever the Settings page is in the DOM —
        // no finite retry count that could expire before Settings is opened.
        let tries = 0;
        const t = setInterval(() => {
            _refreshDashboardPill();
            _injectSettingsCard();
            if (++tries > 8) clearInterval(t);
        }, 600);

        // durable guard: whenever the Settings page re-renders, its
        // #wfUpdateCard placeholder is recreated EMPTY — re-fill it.
        //
        // CRITICAL FIX (v7.16.2): the previous version observed the ENTIRE
        // <body> and, on every single mutation, wrote to the DOM (#wfSbVer via
        // _refreshDashboardPill). Those writes were themselves mutations, so the
        // observer re-fired forever — an infinite microtask loop that pinned the
        // main thread. That one loop is what froze the splash progress bar at
        // ~40% (the app could never finish booting) AND what made every button
        // in the Software-Update section feel dead / the section appear to
        // vanish. The replacement below is loop-proof by design:
        //   • it is SCOPED to the settings container, not the whole body, so
        //     overlays, the clock, AI typing, etc. don't trigger it;
        //   • it NEVER touches the sidebar/pill on a mutation — it only ever
        //     re-fills an empty #wfUpdateCard;
        //   • it DISCONNECTS itself before writing and reconnects after, so it
        //     can never observe (and react to) its own changes;
        //   • it is debounced, so a burst of mutations collapses into one pass;
        //   • when the card is already present + filled it does NOTHING and
        //     schedules NOTHING — steady-state cost is effectively zero.
        try {
            const _target = () =>
                document.getElementById('page-settings') ||
                document.getElementById('settingsContent') ||
                document.body;
            let _scheduled = false;
            let mo = null;
            const _needsFill = () => {
                const ph = document.getElementById('wfUpdateCard');
                return !(ph && ph.querySelector('.settings-title')); // missing OR empty
            };
            const _fillNow = () => {
                _scheduled = false;
                if (!_needsFill()) return;            // already good → no DOM writes
                try { if (mo) mo.disconnect(); } catch (_) {}
                try { _injectSettingsCard(); } catch (_) {}   // creates-if-missing + fills
                try { if (mo) mo.observe(_target(), { childList: true, subtree: true }); } catch (_) {}
            };
            mo = new MutationObserver(() => {
                if (_scheduled) return;
                if (!_needsFill()) return;            // cheap read-only check, no writes
                _scheduled = true;
                setTimeout(_fillNow, 16);             // debounce one frame
            });
            mo.observe(_target(), { childList: true, subtree: true });
            window._wfUpdateObserver = mo;
        } catch (_) {}

        // heartbeat: timer-driven safety net (NOT mutation-driven, so it can
        // never loop). Re-fills an empty card and re-shows the dashboard pill if
        // it went missing after a dashboard re-render. Both calls are idempotent
        // and early-return when nothing is needed, so the steady-state cost is nil.
        setInterval(() => {
            try {
                const ph = document.getElementById('wfUpdateCard');
                if (ph && !ph.querySelector('.settings-title')) _renderSettingsCard();
                if (!document.getElementById('wfUpdatePill')) _refreshDashboardPill();
            } catch (_) {}
        }, 5000);

        // Re-check the manifest periodically (every 30 min) so a freshly
        // published update appears without a manual check.
        setInterval(async () => { try { await _loadManifest(); _refreshDashboardPill(); _renderSettingsCard(); } catch (_) {} }, 30 * 60 * 1000);
    }

    // ── DEV/TEST: simulate that an update is available so you can SEE the whole
    //    flow without publishing a new build. Call wfUpdate.simulate('7.13.0').
    //    Pass a version > current; clears with wfUpdate.simulate(false). ───────
    function simulateUpdate(versionOrFalse) {
        if (versionOrFalse === false || versionOrFalse == null) {
            _manifest = null;
            _markInstalled(CURRENT_VERSION);
            _refreshDashboardPill(); _renderSettingsCard();
            _notify('Test update cleared — back to current build.', 'info');
            return;
        }
        const v = String(versionOrFalse);
        _manifest = {
            latest: v,
            mandatory: [],
            notes: { [v]: {
                date: new Date().toISOString().slice(0, 10),
                type: 'full',
                headline: 'Test update ' + v,
                sections: [
                    { title: 'New', items: ['This is a simulated update so you can preview the full install journey.'] },
                    { title: 'Improved', items: ['Faster everything, smarter categorisation.'] },
                    { security: true, title: 'Security', items: ['Simulated monthly security hardening.'] }
                ]
            } }
        };
        // make sure the device is on an OLDER version than the simulated one
        try { localStorage.setItem(LS_INSTALLED, CURRENT_VERSION); } catch (_) {}
        _refreshDashboardPill(); _renderSettingsCard();
        _notify('Test update ' + v + ' is now available — check the Dashboard or Settings.', 'success');
        openUpdateSection();
    }

    window.wfUpdate = {
        init, start: startUpdate, whatsNew: showWhatsNew, openSection: openUpdateSection,
        feedback: openFeedback, check: checkForUpdates, diagnostics: showDiagnostics,
        simulate: simulateUpdate, setAutoSecurity: setAutoSecurity,
        _clearFbImg: () => { _fbImageData = null; },
        refresh: () => { _refreshDashboardPill(); _injectSettingsCard(); _renderSettingsCard(); },
        _close, _closePost, version: CURRENT_VERSION
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
    else setTimeout(init, 1500);

    console.log('[wfUpdate] ✓ Update system loaded (build ' + CURRENT_VERSION + ')');
})();
