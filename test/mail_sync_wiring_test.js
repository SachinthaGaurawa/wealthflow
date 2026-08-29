/* =============================================================================
 * test/mail_sync_wiring_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-mail-intake.js has 141 passing tests and, until this change, was
 * loaded by nothing. wealthflow-statement-router.js was imported only by its own
 * tests. wealthflow-intelligence.js's vault modal had been defined, exported and
 * reachable from zero callers since v7.7.0 — which is why password-locked
 * statements were never opened: there was no way to put a password in.
 *
 * Every one of those is invisible to a unit test, because in every case the
 * MODULE was fine. So this file reads index.html and pins the wiring.
 *
 * TWO BUGS IT EXISTS BECAUSE OF, BOTH FOUND BY RUNNING THE PAGE
 *
 * 1. `parse` was wired to WFStatementParser.parseStatementText, which returns
 *    `parseStatement(text).rows` — a BARE ARRAY. intakeStatement reads
 *    `parsed.rows`, so it saw undefined, then zero rows, then quarantined every
 *    statement as unparseable. It failed as a plausible "needs review" rather
 *    than as an error, so nothing looked broken.
 *
 * 2. The boot render was placed next to the sweeper renders and landed inside
 *    wfSweepRecord() — a function that runs only when somebody records a sweep.
 *    The card never appeared on load: the exact "I don't see ANYTHING" defect
 *    this change exists to fix, reproduced inside the fix.
 *
 * Neither is visible in a diff. Both are one assertion here.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';

const html = await (async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
})();

/* Comments stripped before any NEGATIVE assertion. A check for "this string is
 * absent" otherwise matches the comment explaining why it must be absent — which
 * is exactly what happened on the first run of this file, and on the DB.set
 * check in test/vault_test.js. Positive assertions run against the raw text, so
 * a call cannot be faked by a comment mentioning it. */
function codeOnly(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * The body of a top-level `function NAME(` in the page, to its closing brace.
 *
 * BRACE COUNTING STARTS AFTER THE PARAMETER LIST, not at the first `{`. A
 * destructured parameter — `function f({ force = false } = {})` — puts a brace
 * before the body, so counting from the first one closes on the parameter list
 * and returns a fragment. That is not hypothetical: it truncated
 * _ensureMailWatch to a few characters here, and the identical mistake once
 * returned 178 characters of a 5,212-character function on showActionableBanner.
 * The failure mode is a test that reads almost nothing and passes.
 */
function functionBody(name) {
    const at = html.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    // Walk the parameter list to its matching ')' before looking for the body.
    let p = html.indexOf('(', at);
    let paren = 0;
    let i = -1;
    for (let j = p; j < html.length; j += 1) {
        if (html[j] === '(') paren += 1;
        else if (html[j] === ')') {
            paren -= 1;
            if (paren === 0) { i = html.indexOf('{', j); break; }
        }
    }
    if (i < 0) return '';
    let depth = 0;
    for (let j = i; j < html.length; j += 1) {
        if (html[j] === '{') depth += 1;
        else if (html[j] === '}') { depth -= 1; if (depth === 0) return html.slice(at, j + 1); }
    }
    return html.slice(at);
}

describe('the dormant modules are actually loaded', () => {
    it.each([
        ['wealthflow-mail-intake.js', 'the device half of the mail pipeline'],
        ['wealthflow-statement-router.js', 'row hashing, routing and ledger dedup'],
        ['wealthflow-vault.js', 'the bank password vault'],
    ])('loads %s as a module', (file) => {
        expect(html).toContain(`<script type="module" src="${file}"></script>`);
    });

    it('exposes the router on window, since the page reaches modules that way', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(import.meta.dirname, '../wealthflow-statement-router.js'), 'utf8');
        expect(src).toContain('window.WFStatementRouter = API');
    });
});

describe('the pipeline is handed the right functions', () => {
    it('THE ONE THAT SILENTLY FILED NOTHING: parse must return {rows}, not an array', () => {
        /* parseStatementText === `parseStatement(text).rows`. Wiring it here
         * makes intakeStatement read `.rows` off an array, get undefined, and
         * quarantine every statement as unparseable — a believable-looking
         * "needs review" on a pipeline that is in fact completely broken. */
        const fn = functionBody('runMailSync');
        expect(fn, 'runMailSync not found').toBeTruthy();
        expect(fn).toContain('WFStatementParser.parseStatement(text)');
        expect(codeOnly(fn), 'parse is wired to the bare-array shorthand again')
            .not.toContain('parseStatementText');
    });

    it('passes the four functions intakeStatement requires', () => {
        // It throws a TypeError if any is missing, so a gap here is a hard
        // failure at runtime rather than a degraded result.
        const fn = functionBody('runMailSync');
        for (const dep of ['openPdf:', 'extractText:', 'parse:', 'route:']) {
            expect(fn, `missing dep ${dep}`).toContain(dep);
        }
    });

    it('finally passes existingHashes, which nothing ever had', () => {
        /* classifyStatement has accepted `existingHashes` since it was written
         * and no caller had ever supplied one, so every import was deduplicated
         * against itself only and a statement re-imported next month would land
         * a second time. */
        const fn = functionBody('runMailSync');
        expect(fn).toContain('existingHashes: ledgerHashes');
        expect(fn).toContain('WFBackfill.ledgerHashes(appData)');
    });

    it('builds the ledger hash set once per run, not once per statement', () => {
        // It scans every record the app holds; doing it per statement makes a
        // ten-statement sync ten full passes over the ledger.
        const fn = functionBody('runMailSync');
        const hashAt = fn.indexOf('WFBackfill.ledgerHashes(appData)');
        const loopAt = fn.indexOf('for (let i = 0; i < docs.length');
        expect(hashAt).toBeGreaterThan(0);
        expect(loopAt).toBeGreaterThan(0);
        expect(hashAt, 'the ledger is rescanned for every statement').toBeLessThan(loopAt);
    });

    it('takes its passwords from the vault rather than a literal', () => {
        const fn = functionBody('runMailSync');
        expect(fn).toContain('wfVaultPdfPasswords');
    });
});

describe('the card is actually drawn', () => {
    it('THE OTHER ONE: renders from renderDash, not from an unrelated function', () => {
        /* The first version of this call landed inside wfSweepRecord(), so the
         * card only ever appeared after somebody recorded a sweep. Asserting the
         * call exists is not enough — it existed then too. It has to be in the
         * function that draws the dashboard. */
        const dash = functionBody('renderDash');
        expect(dash, 'renderDash not found').toBeTruthy();
        expect(dash, 'the sync card is not drawn when the dashboard draws')
            .toContain('renderMailSync();');

        /* UNCONDITIONALLY, and this needed a second assertion: deleting the
         * plain call still left the one inside the _mailConnected() callback, so
         * the first version of this test passed on a dashboard that drew nothing
         * until an async probe resolved — and drew nothing at all if it never
         * did. The first render must come BEFORE the probe. */
        const drawAt = dash.indexOf('renderMailSync();');
        const probeAt = dash.indexOf('_mailConnected()');
        expect(probeAt, 'the connection probe is gone').toBeGreaterThan(0);
        expect(drawAt, 'the card is only drawn after an async probe resolves')
            .toBeLessThan(probeAt);

        const sweepRecord = codeOnly(functionBody('wfSweepRecord'));
        expect(sweepRecord).not.toContain('renderMailSync();');
    });

    it('has a host element on the dashboard page', () => {
        expect(html).toContain('id="wfMailSync"');
    });

    it('is never hidden, unlike every other conditional card', () => {
        /* A card that disappears when nothing is connected is indistinguishable
         * from a feature that was never built — which is precisely how this
         * pipeline came to be described as live while no part of it ran. The
         * other dashboard cards start `display:none`; this one must not. */
        const at = html.indexOf('id="wfMailSync"');
        const tag = html.slice(at, at + 200);
        expect(tag).not.toContain('display:none');
    });

    it('says what is missing when nothing is connected', () => {
        const fn = functionBody('renderMailSync');
        expect(fn).toContain('Mailbox not connected');
    });
});

describe('the vault has a way in', () => {
    it('the ID vault modal, unreachable since v7.7.0, now has a caller', () => {
        expect(html).toContain('onclick="openIdVault()"');
        expect(html).toContain('window.wfVault.openModal()');
    });

    it('the bank password vault has a settings row', () => {
        expect(html).toContain('onclick="openBankVault()"');
    });

    it('warns that a forgotten PIN cannot be recovered, before anything is saved', () => {
        // A password store with no recovery has to say so at the moment of
        // creation, not in a support answer afterwards.
        const fn = functionBody('openBankVault');
        expect(fn).toContain('There is no recovery');
    });

    it('never puts a password into markup', () => {
        /* Passwords are assigned with `.value =` on an already-built input. A
         * password can contain quotes and angle brackets — that is what a good
         * password looks like — and interpolating one into an attribute is both
         * an escaping bug and a way for the secret to land in a DOM dump. */
        const fn = functionBody('openBankVault');
        expect(fn).toContain("._bv_pw').value = row.password");
        expect(codeOnly(fn), 'a password was interpolated into markup')
            .not.toMatch(/value="\$\{[^}]*password/);
    });

    it('does not log anything from the vault screen', () => {
        const fn = codeOnly(functionBody('openBankVault'));
        expect(fn).not.toMatch(/console\.(log|warn|error)/);
    });
});

/* ── A FAILED CHECK IS NOT AN ANSWER OF "NO" ─────────────────────────────────
 *
 * /api/gmail-link answered 500 to every request it ever received: it read
 * getAdminDb()'s { db, reason, admin } wrapper as though it were the Firestore
 * handle, and died on `db.collection is not a function`. The card showed "Not
 * connected" throughout — because _mailConnected() returned false for a failed
 * check and false for an unconnected mailbox, and the card could not tell them
 * apart. That is the same defect the endpoint itself was built to fix, one layer
 * up: an error rendered as a calm, wrong fact.
 *
 * These RUN the page's function against a stubbed transport rather than reading
 * it. Reading the source is what missed the crash in the first place. */
describe('the card can tell a broken check from an empty one', () => {
    /** The shipped _mailConnected(), executed with _gmailLink replaced. */
    function mailConnectedWith(reply) {
        const src = functionBody('_mailConnected');
        expect(src, 'index.html no longer defines _mailConnected').toBeTruthy();
        const make = new Function('_gmailLink', `
            let _mailStatus = null, _mailCheckError = null;
            ${src}
            return {
                run: _mailConnected,
                get status() { return _mailStatus; },
                get error() { return _mailCheckError; },
            };
        `);
        return make(async () => (typeof reply === 'function' ? reply() : reply));
    }

    it('a connected mailbox reads as connected, with no error', async () => {
        const m = mailConnectedWith({ status: 200, body: { ok: true, connected: true, email: 'a@b.c' } });
        expect(await m.run()).toBe(true);
        expect(m.error).toBe(null);
    });

    it('an honestly empty answer is "not connected" and NOT an error', async () => {
        const m = mailConnectedWith({ status: 200, body: { ok: true, connected: false, missing: [] } });
        expect(await m.run()).toBe(false);
        expect(m.error, 'an empty answer must not be reported as a fault').toBe(null);
    });

    it('THE REGRESSION: a 500 is recorded as a failed check, not as "not connected"', async () => {
        const m = mailConnectedWith({ status: 500, body: { ok: false, error: 'Endpoint runtime crash' } });
        expect(await m.run()).toBe(false);
        expect(m.error, 'a 500 was reported as an ordinary "not connected"').toBeTruthy();
        expect(m.error).toContain('Endpoint runtime crash');
    });

    it('a 503 with no body still names something', async () => {
        const m = mailConnectedWith({ status: 503, body: null });
        await m.run();
        expect(String(m.error)).toContain('503');
    });

    it('a 200 whose body is not ok is a failed check too', async () => {
        const m = mailConnectedWith({ status: 200, body: { ok: false, error: 'state unreadable' } });
        expect(await m.run()).toBe(false);
        expect(m.error).toContain('state unreadable');
    });

    it('a thrown transport error is a failed check, not a "no"', async () => {
        const m = mailConnectedWith(() => { throw new Error('NetworkError: failed to fetch'); });
        expect(await m.run()).toBe(false);
        expect(m.error).toContain('failed to fetch');
    });

    it('nobody signed in is neither connected nor an error to show', async () => {
        /* _gmailLink returns null before it sends anything when there is no
         * user. There is no account whose mailbox this could be, so there is
         * nothing to warn about. */
        const m = mailConnectedWith(null);
        expect(await m.run()).toBe(false);
        expect(m.error).toBe(null);
    });

    it('the card renders the failure distinctly from the empty state', () => {
        const body = functionBody('renderMailSync');
        expect(body).toContain('_mailCheckError');
        expect(body).toContain('Could not check the mailbox');
        /* And the header line must stop claiming "Not connected" when the check
         * is what failed. */
        expect(body).toContain('Check failed');
    });
});

/* ── CONNECTED IS NOT THE SAME AS DELIVERING ─────────────────────────────────
 *
 * Google publishes to the Pub/Sub topic only while the mailbox has an active
 * users.watch. Nothing in this repository ever registered one — PUB_SUB_TOPIC
 * was configured and read by nobody — so /api/gmail-hook had never been invoked
 * and a mailbox reported as "connected" delivered nothing, forever. A watch also
 * expires after seven days, so registering it once is a pipeline with a
 * week-long fuse, not a finished feature.
 *
 * These pin the page's half: that it registers on connect, renews on load, and
 * shows the expiry instead of letting a lapse pass as silence. */
describe('the page actually asks Gmail to watch the mailbox', () => {
    it('calls /api/gmail-watch', () => {
        expect(codeOnly(html)).toContain("'/api/gmail-watch'");
    });

    it('registers the watch right after a token is saved', () => {
        /* Saving a token is not connecting the pipeline. Without this call the
         * mailbox sits "connected" and nothing is ever pushed to it. */
        const body = functionBody('openGmailLink');
        expect(body).toContain('_ensureMailWatch');
        expect(body).toContain('force: true');
    });

    it('the success message depends on the watch, not on the save', () => {
        /* "Gmail connected" over a failed watch is exactly the comfortable lie
         * this change exists to remove. */
        const body = codeOnly(functionBody('openGmailLink'));
        const at = body.indexOf('_ensureMailWatch');
        expect(at).toBeGreaterThan(-1);
        expect(body.slice(at)).toMatch(/if\s*\(\s*w\s*&&\s*w\.watching\s*\)/);
    });

    it('renews on load, so a seven-day watch does not lapse unseen', () => {
        const boot = functionBody('renderDash');
        expect(boot).toContain('_ensureMailWatch');
    });

    it('the renewal margin leaves room under Gmail’s seven-day maximum', async () => {
        const { WATCH } = await import('../gmail-watch.mjs');
        expect(WATCH.RENEW_WITH_DAYS_LEFT).toBeLessThan(WATCH.MAX_LIFETIME_DAYS);
    });

    it('the card shows a connected-but-unwatched mailbox as a fault', () => {
        const body = functionBody('renderMailSync');
        expect(body).toContain('_mailWatch');
        expect(body).toContain('not watching this mailbox');
    });

    it('the header line carries the expiry rather than a bare tick', () => {
        const label = functionBody('_mailWatchLabel');
        expect(label).toBeTruthy();
        expect(label).toContain('watching until');
        expect(label).toContain('expires in');
    });
});

describe('the watch helper only renews when it should', () => {
    /* Executed, not read — the same discipline the crash taught. */
    function ensureWith(replies) {
        const src = functionBody('_ensureMailWatch');
        expect(src, 'index.html no longer defines _ensureMailWatch').toBeTruthy();
        const calls = [];
        const make = new Function('_gmailWatch', `
            let _mailWatch = null;
            ${src}
            return { run: _ensureMailWatch, get state() { return _mailWatch; } };
        `);
        const h = make(async (method) => { calls.push(method); return replies[method] || null; });
        return { ...h, run: h.run, calls, get state() { return h.state; } };
    }

    it('does not POST when the watch is fresh', async () => {
        const h = ensureWith({ GET: { status: 200, body: { connected: true, watching: true, needsRenewal: false } } });
        await h.run();
        expect(h.calls).toEqual(['GET']);
    });

    it('POSTs when renewal is due', async () => {
        const h = ensureWith({
            GET: { status: 200, body: { connected: true, watching: false, needsRenewal: true } },
            POST: { status: 200, body: { connected: true, watching: true, needsRenewal: false } },
        });
        await h.run();
        expect(h.calls).toEqual(['GET', 'POST']);
        expect(h.state.watching).toBe(true);
    });

    it('does not POST when no mailbox is connected', async () => {
        /* There is nothing to register a watch WITH, and asking would produce a
         * 409 the card would then have to explain. */
        const h = ensureWith({ GET: { status: 200, body: { connected: false, watching: false, needsRenewal: true } } });
        await h.run();
        expect(h.calls).toEqual(['GET']);
    });

    it('a failed renewal keeps the state it could read, and records the error', async () => {
        /* Blanking it would hide a watch that is live but close to expiring —
         * the one moment the card most needs to say something. */
        const h = ensureWith({
            GET: { status: 200, body: { connected: true, watching: true, needsRenewal: true, daysLeft: 1 } },
            POST: { status: 502, body: { ok: false, error: 'Gmail refused the watch (HTTP 403)' } },
        });
        await h.run();
        expect(h.state.watching).toBe(true);
        expect(h.state.daysLeft).toBe(1);
        expect(h.state.error).toContain('403');
    });

    it('an unreadable GET leaves no stale state behind', async () => {
        const h = ensureWith({ GET: { status: 500, body: null } });
        expect(await h.run()).toBe(null);
        expect(h.state).toBe(null);
    });
});

/* ── THE ENGINE THAT PLANNED A SCAN NOBODY RAN ───────────────────────────────
 *
 * wealthflow-backfill.js exports ledgerHashes, planWindows, startCursor,
 * nextStep, advance, shouldPause, notifiable and runSummary. The page used ONE
 * of them — ledgerHashes — and the entire scan-planning half had no caller at
 * all, so the app could only ever wait for a bank to send something new.
 *
 * That is this repository's most-repeated defect, and it had claimed the
 * backfill engine as well as openVaultModal, wealthflow-mail-intake.js and
 * wealthflow-statement-router.js before it. */
describe('the backfill engine is actually driven', () => {
    const code = codeOnly(html);

    it.each([
        ['resumeCursor', 'every run restarts at the newest month and the rest of the mailbox is unreachable'],
        ['serializeCursor', 'the position is not written down and a reload loses the scan'],
        ['nextStep', 'nothing decides which window to read'],
        ['advance', 'the cursor never moves and the scan repeats one month'],
        ['shouldPause', 'a ten-year mailbox becomes one runaway loop'],
    ])('calls WFBackfill.%s — otherwise %s', (fn) => {
        expect(code).toContain(`WFBackfill.${fn}(`);
    });

    it('does not build a fresh cursor behind resumeCursor’s back', () => {
        /* startCursor() is still the right function — for a scan that has no
         * saved position. resumeCursor() calls it. The PAGE calling it directly
         * is the defect: it made every run start at index 0. */
        expect(code).not.toContain('WFBackfill.startCursor(');
    });

    it('still uses ledgerHashes, which is what keeps the backfill from duplicating', () => {
        expect(code).toContain('WFBackfill.ledgerHashes(');
    });

    it('there is a button, on the card, that starts it', () => {
        /* An engine reachable only from the console is the same as an unwired
         * one. The complaint that produced this was "WHERE IS IT?". */
        const body = functionBody('renderMailSync');
        expect(body).toContain('_ms_scan');
        expect(body).toContain('Scan historical statements');
        expect(body).toContain('openBackfill()');
    });

    it('the scan button appears only once a mailbox is connected', () => {
        /* Offering a deep scan with no credential to scan with is a button that
         * can only produce an error. */
        const body = functionBody('renderMailSync');
        const at = body.indexOf('_ms_scan');
        expect(at).toBeGreaterThan(-1);
        expect(body.slice(Math.max(0, at - 200), at)).toContain('connected === true');
    });

    it('POSTs to /api/gmail-scan and never sends a Gmail query', () => {
        /* The endpoint holds a credential that can read the whole mailbox. The
         * client says WHICH WINDOW by index; the server rebuilds the query. */
        const body = functionBody('runBackfill');
        expect(body).toContain('_gmailScan(');
        const transport = functionBody('_gmailScan');
        expect(transport).toContain("'/api/gmail-scan'");
        expect(transport).toContain("method: 'POST'");
        expect(body).not.toMatch(/query\s*:/);
        expect(body).not.toContain('has:attachment');
    });

    it('sends the cursor’s own clock, so both sides plan the same windows', () => {
        /* planWindows is a pure function of (months, now), and the server
         * rebuilds the window from the (months, now, index) it is sent. So the
         * clock has to be the one the CURSOR was planned with — a resumed scan
         * that sent a fresh Date.now() would make index 7 mean a different
         * month on each side, re-reading one and skipping another. */
        const body = functionBody('runBackfill');
        expect(body).toContain('months: _scan.cursor.months');
        expect(body).toContain('now: _scan.cursor.now');
    });

    it('RESUMES the cursor rather than rebuilding it at index 0', () => {
        /* The defect this replaced: runBackfill called startCursor() on every
         * invocation, so the six windows one run covers were always the SAME
         * six. "Run it again to continue" restarted. Anything older than half a
         * year could not be reached by any number of presses. */
        const body = functionBody('runBackfill');
        expect(body).toContain('resumeCursor(saved,');
        /* Named on the API object, so the prose above may still describe the
         * defect by name without tripping its own guard. */
        expect(body).not.toContain('WFBackfill.startCursor');
    });

    it('carries on past a batch boundary instead of asking for another press', () => {
        /* shouldPause bounds a stretch of work. It used to `break`, ending the
         * scan; now it rests and continues, so the plan actually finishes. */
        const body = functionBody('runBackfill');
        const pause = body.slice(body.indexOf('shouldPause('));
        expect(pause).toContain('SCAN_BATCH_REST_MS');
        expect(pause.slice(0, pause.indexOf('}'))).not.toMatch(/\bbreak\b/);
    });

    it('writes the position after every page, and keeps it when the scan fails', () => {
        /* An interruption should cost one page, not the whole scan — and a
         * failure is exactly the case resuming exists for, so the position
         * must survive it. */
        const body = functionBody('runBackfill');
        expect(body).toContain('_saveScanCursor(_scan.cursor)');
        const stop = body.slice(body.indexOf('const stop ='), body.indexOf('if (resumed)'));
        expect(stop).toContain('_saveScanCursor(_scan.cursor)');
    });

    it('clears the position once the plan is finished', () => {
        /* A completed cursor left behind would make the next scan resume into
         * its own end and do nothing. */
        const body = functionBody('runBackfill');
        expect(body).toContain('if (done) _clearScanCursor();');
    });

    it('files what it found through the EXISTING sync, not a second pipeline', () => {
        /* The scan writes into the same wf-mail items collection the push writes
         * into. A second ingestion path would be a second set of bugs. */
        const body = functionBody('runBackfill');
        expect(body).toContain('runMailSync()');
    });

    it('cannot loop forever if the cursor stops advancing', () => {
        const body = functionBody('runBackfill');
        expect(body).toMatch(/calls\s*<\s*\d+/);
    });

    it('says so when there is more history left — without asking for a press', () => {
        /* A scan that stops at the batch limit and reports nothing looks like a
         * scan that found nothing. It used to say "run it again to continue",
         * which was worse than silence: running it again restarted, so the
         * sentence described something the code could not do. */
        const body = functionBody('runBackfill');
        expect(body).toMatch(/paused/i);
        expect(body).toMatch(/resumes from where it stopped|pick up where it left off/i);
        expect(body).not.toMatch(/[Rr]un it again/);
    });
});
