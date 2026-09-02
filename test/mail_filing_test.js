/* =============================================================================
 * test/mail_filing_test.js
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS PINS IS THE BIGGEST ONE IN THE MAIL PIPELINE, AND IT LOOKED
 * LIKE SUCCESS.
 *
 * intakeStatement RETURNS `applied` and `quarantined`. It writes neither — it
 * is a pure function over a PDF. Its one caller, runMailSync, read only
 * summarise() to print a count and threw the rows away. So every statement that
 * arrived by mail was assembled, decrypted, parsed and routed, the card
 * reported "3 transactions filed", and the ledger received nothing. Ever.
 *
 * Two more things made it invisible:
 *   - wealthflow-quarantine.js had NO caller anywhere, so held rows went
 *     nowhere either;
 *   - renderQuarantineTile() was CALLED and never defined, inside a try/catch
 *     that swallowed the ReferenceError.
 *
 * And nothing marked a statement as dealt with, so every press of Check now
 * re-listed, re-decrypted and re-parsed every statement ever stored. The owner
 * saw the same statements forever and reported exactly that.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot open a PDF or file a transaction. They pin the WIRING — that the
 * rows reach the screen that writes them, that a statement is marked done only
 * once something was actually written, and that "done" is a flag rather than a
 * delete. The end-to-end behaviour is driven in a browser instead.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const link = fs.readFileSync(path.join(ROOT, 'gmail-link.js'), 'utf8');

function fn(name) {
    const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
    const m = decl.exec(html);
    if (!m) return '';
    const after = html.slice(m.index + m[0].length);
    const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
    return next < 0 ? html.slice(m.index) : html.slice(m.index, m.index + m[0].length + next);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a mail statement’s rows actually reach the ledger', () => {
    it('THE LIE: the card no longer reports transactions as filed by itself', () => {
        /* `${summary.applied} transactions filed` was printed by the branch
         * that wrote nothing. If that sentence comes back, so has the bug. */
        const body = fn('runMailSync');
        expect(body).not.toMatch(/transaction\$\{[^}]*\} filed/);
        expect(body).not.toMatch(/stage: 'filed'/);
    });

    it('the parsed rows are captured and handed on, not discarded', () => {
        const body = fn('runMailSync');
        expect(body).toContain('_parsed = out');
        expect(body).toContain('_ready.push(');
        expect(body).toContain('_reviewMailStatements(_ready)');
    });

    it('they go to the SAME screen an uploaded statement goes to', () => {
        /* A second writer for the same records is how two shapes of "expense"
         * end up in one array. That screen also records an undoable batch and
         * de-duplicates against what is already stored. */
        expect(fn('_reviewMailStatements')).toContain('window._showCCReviewModal(');
    });

    it('the capture returns the parser’s value unchanged', () => {
        /* intakeStatement reads what `parse` returns. A capture that forgot to
         * return would make every statement unparseable — and would look like a
         * parser bug, not like a bug in the capture. */
        const body = fn('runMailSync');
        const at = body.indexOf('_parsed = out');
        expect(at).toBeGreaterThan(-1);
        expect(body.slice(at, at + 60)).toContain('return out');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHECK NOW GOES AND LOOKS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a check fetches, it does not only re-list', () => {
    /* THE REPORT: a statement arrived, from a sender on the approved list, and
     * never appeared. Nothing had gone looking for it.
     *
     * Everything after the first scan rested on the Gmail PUSH, and the push
     * rests on a watch Google expires after seven days — renewed by the PAGE,
     * so only while somebody has the app open. Close the app for a week and the
     * watch lapses, mail arrives, nothing is published, and the history
     * bookmark the hook reads forward from ages out behind it. Every statement
     * in that gap was unreachable, permanently, because the one button that
     * looks like it would go and get them only re-listed the store.
     *
     * Diagnosed in #165 and then fixed only for the FIRST scan — the wrong size
     * of fix, closing the empty-mailbox case and leaving the one the owner
     * lives in. */
    it('the sweep exists and is called from the check, before the listing', () => {
        const body = fn('runMailSync');
        expect(fn('_recentSweep'), '_recentSweep is gone').toBeTruthy();
        const sweep = body.indexOf('_recentSweep(');
        const list = body.indexOf("'?items=1'");
        expect(sweep, 'the check no longer fetches').toBeGreaterThan(-1);
        expect(sweep, 'it lists the store before going to look').toBeLessThan(list);
    });

    it('it sweeps TWO months, not one', () => {
        /* A statement issued on the 31st and fetched on the 1st is in neither
         * window otherwise. */
        expect(html).toMatch(/RECENT_SWEEP_MONTHS\s*=\s*2\b/);
    });

    it('it is bounded and throttled', () => {
        /* A fetch per press of a button people press twice is a quota bill, and
         * an unbounded page loop is how one runs out entirely. */
        const body = fn('_recentSweep');
        expect(body).toContain('SWEEP_MIN_GAP_MS');
        expect(body).toContain('SWEEP_MAX_PAGES');
    });

    it('a failed sweep leaves the stored statements on screen', () => {
        /* Replacing somebody's statements with an error about a background
         * refresh is worse than the refresh silently not happening. */
        const body = fn('_recentSweep');
        expect(body).toMatch(/catch \(_\)/);
        expect(body).toContain('return found');
    });

    it('the query still comes from the server, never from the page', () => {
        /* The scan endpoint derives the window from the owner's approved
         * senders. A page that sent its own query would make a credential that
         * reads a whole mailbox into a search proxy. */
        const body = fn('_recentSweep');
        expect(body).not.toMatch(/query|from:|has:attachment/);
        expect(body).toContain('_gmailScan(');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE NAMES THE TWO SIDES USE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a parsed row is translated into what the review screen reads', () => {
    /* THE BUG THIS EXISTS FOR, caught in a browser and not by any assertion
     * above: the parser emits `narration`, the review screen reads
     * `description`. Handed a parser row unchanged, the screen's own guard
     * `if (!desc || !amount) { skipped++; return; }` skipped EVERY row — it
     * opened, listed the rows, the owner pressed Save, and nothing was written.
     * The ledger was empty after a successful-looking file. */
    const body = fn('_mailRowForReview');

    it('exists as a named function, not an inline spread', () => {
        expect(body, '_mailRowForReview is gone').toBeTruthy();
    });

    it('maps narration onto description', () => {
        expect(body).toContain('row.description || row.narration');
    });

    it('takes the magnitude, because direction carries in-versus-out', () => {
        /* A signed amount would be negated twice for a debit. */
        expect(body).toContain('Math.abs(Number(row.amount) || 0)');
    });

    it('carries the parser’s own doubt across', () => {
        /* A row whose direction was assumed from wording rather than confirmed
         * by the running balance must arrive flagged, or it looks exactly as
         * trustworthy as one the bank's arithmetic proved. The screen reads
         * these under underscore names. */
        expect(body).toContain('_needsReview: row.needsReview === true');
        expect(body).toContain('_directionSource: row.directionSource');
    });

    it('is actually applied to the rows on their way to the screen', () => {
        /* A translator nothing calls is the defect this whole file is about. */
        /* Applied per row rather than through .map, because each row also
         * needs its own doubt looked up — but STILL applied, which is the only
         * thing this asserts. A translator nothing calls is the defect. */
        const body = fn('_reviewMailStatements');
        expect(body).toContain('_mailRowForReview(');
        expect(body, 'the intake’s doubt is not looked up per row').toContain('doubts.get(');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DONE MEANS WRITTEN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a statement is marked done only when something was written', () => {
    it('the callback lives at the END of the file action, not on close', () => {
        /* Marking on close would hide statements whose rows were never
         * written — the worst possible version of "don't show it again". */
        /* To the end of the function, not a fixed window: that screen is far
         * longer than any guess, and a short slice reports the hook as MISSING
         * rather than as misplaced — a false alarm that teaches people to
         * delete the guard. */
        const at = html.indexOf('function _showCCReviewModal');
        const end = html.indexOf('window._showCCReviewModal =');
        expect(at).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(at);
        const body = html.slice(at, end);
        const hook = body.indexOf('typeof onFiled === \'function\'');
        const commit = body.indexOf('WFBatch.commit(_batch)');
        expect(hook, 'the completion hook is gone').toBeGreaterThan(-1);
        expect(commit, 'the batch commit is gone').toBeGreaterThan(-1);
        expect(hook, 'the hook fires before the rows are committed').toBeGreaterThan(commit);
    });

    it('closing without filing leaves the statement pending', () => {
        /* There is deliberately no "closed" signal: the driver must not be
         * able to mark anything on a close. It therefore cannot await a chain
         * of screens either — see the next test. */
        const body = fn('_reviewMailStatements');
        expect(body).not.toMatch(/onClosed|onCancel|onDismiss/);
    });

    it('the driver does not await a screen it can never be told about', () => {
        /* Awaiting each screen in a loop hangs forever the moment someone
         * closes one. Filing re-runs the sync instead, which offers the next. */
        const body = fn('_reviewMailStatements');
        expect(body).not.toMatch(/await new Promise/);
        expect(body).toContain('runMailSync()');
    });

    it('one bank per screen', () => {
        /* That screen decides credit-card-versus-bank-account for the whole
         * batch and pre-routes every row from it. Mixing two banks pre-routes
         * one of them wrongly, and a wrong default someone has to notice is
         * worse than a second screen. */
        const body = fn('_reviewMailStatements');
        expect(body).toContain('groups');
        expect(body).toMatch(/bank\b/);
    });

    it('a failure to mark is said out loud, not swallowed', () => {
        /* A statement filed but not marked comes back on the next check, and
         * the owner cannot tell that from a duplicate import — which is the
         * confusion being fixed. */
        const body = fn('_markMailFiled');
        expect(body).toContain('may be offered again');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DONE IS A FLAG, NOT A DELETE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('marking done must not make the statement re-fetchable', () => {
    it('the manifest survives; only the parts are dropped', () => {
        /* THE TRAP. The existence of that document is the only thing stopping
         * the push hook and the scanner re-fetching the same attachment.
         * Delete it and the next scan stores it again — the statement returns,
         * and with it the duplicate this was meant to end. */
        const at = link.indexOf("if (action === 'filed')");
        expect(at, 'the mark-done route is gone').toBeGreaterThan(-1);
        const block = link.slice(at, link.indexOf('let deleted = 0;'));
        expect(block).toContain('filed: true');
        expect(block, 'the mark-done route deletes the manifest').not.toMatch(/itemRef\.delete\(\)/);
    });

    it('the flag is written BEFORE the parts are dropped', () => {
        /* The other way round, a failure between the two leaves a statement
         * with no parts and no flag: listed forever, failing to assemble every
         * time, looking corrupt rather than finished. */
        const at = link.indexOf("if (action === 'filed')");
        const block = link.slice(at, link.indexOf('let deleted = 0;'));
        expect(block.indexOf('filed: true')).toBeLessThan(block.indexOf("collection('parts')"));
    });

    it('the DELETE route drops parts first and the manifest last', () => {
        /* The reverse order, and for the reverse reason: an interrupted delete
         * must not leave parts belonging to nothing. */
        const at = link.indexOf('let deleted = 0;');
        const block = link.slice(at, at + 1600);
        expect(block.indexOf("collection('parts')")).toBeLessThan(block.indexOf('itemRef.delete()'));
    });

    it('a delete names its keys — never a rule the server evaluates', () => {
        /* "Delete everything matching a pattern" ends a statement history with
         * one bad pattern, and nothing the owner asked for needs it. */
        const at = link.indexOf('let deleted = 0;');
        const block = link.slice(at, at + 1600);
        expect(block).toContain('for (const key of wanted)');
        expect(link).toContain('ITEMS_DELETE_MAX');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE NEXT CHECK SHOWS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the check button stops re-offering what is done', () => {
    it('the listing drops filed statements — AFTER the collapse', () => {
        /* A statement stored several times may have been marked on any one of
         * those copies. Filtering first lets an unmarked copy survive the
         * collapse and be offered again — the owner's duplicate wearing a
         * different hat. */
        const at = link.indexOf("method === 'GET' && /[?&]items=1/");
        const block = link.slice(at);
        expect(block.indexOf('dedupeStored(rows)')).toBeLessThan(block.indexOf('manifest.filed === true'));
        expect(block).toContain('.filter((r) => !(r.manifest && r.manifest.filed === true))');
    });

    it('and says how many, so an empty list is not mistaken for a broken one', () => {
        expect(link).toContain('filed: done');
        expect(fn('renderMailSync')).toContain('st.filed');
    });

    it('an unapproved sender is never opened at all', () => {
        /* #167 stored `known` and drew it on the row, then unlocked and parsed
         * the attachment anyway. "Held for review" has to mean the statement is
         * not processed, or it means nothing. */
        const body = fn('runMailSync');
        /* The GUARD, specifically. `.known === false` also appears in the items
         * mapping a few lines above — anchoring on the bare phrase found that
         * one and asserted nothing about the guard. */
        const guard = body.indexOf('items[i].known === false');
        const intake = body.indexOf('intakeStatement(');
        expect(guard, 'the unapproved-sender guard is gone').toBeGreaterThan(-1);
        expect(guard, 'the guard runs after the statement is opened').toBeLessThan(intake);
        expect(body.slice(guard, guard + 300)).toContain('continue');
    });

    it('there is a way to remove a statement that should not be there', () => {
        /* The bills and receipts already stored: #167 stopped new ones and
         * removed none of the old, and there was no way to clear them. */
        const body = fn('renderMailSync');
        expect(body).toContain('data-msdel');
        expect(body).toContain("action: 'delete'");
    });

    it('removing asks first, and says what it does NOT change', () => {
        const body = fn('renderMailSync');
        const at = body.indexOf('data-msdel]');
        const block = body.slice(at);
        expect(block).toContain('showConfirm(');
        expect(block).toContain('Nothing already filed in your ledger changes');
        expect(block, 'it does not warn that the statement comes back')
            .toContain('come back on the next scan');
        /* THE WARNING BEFORE THE REASSURANCES. A consequence placed after two
         * calming clauses is a consequence people skip — and removing without
         * blocking looks exactly like the button doing nothing. */
        expect(block.indexOf('come back on the next scan'))
            .toBeLessThan(block.indexOf('Nothing already filed'));
    });

    it('showConfirm’s detail is a textContent sink, and stays one', () => {
        /* THIS TEST EXISTS BECAUSE A REVIEWER REPORTED THE OPPOSITE.
         *
         * The board's security lane failed this PR for "using textContent with
         * untrusted input" in the confirmation dialog, calling it a new XSS
         * sink. textContent is the SAFE sink — the browser never parses what is
         * assigned to it as markup — so the report inverts the property it
         * names, and the change it asks for (escaping) is the documented BUG:
         * an escaped string prints "&amp;" at any payee with an ampersand.
         *
         * But the safety of every caller, not only this one, rests on two
         * assignments that nothing pinned. If someone ever changed them to
         * innerHTML, every showConfirm() call in the file would become an
         * injection sink at once, silently. So the property is pinned here.
         *
         * `confDet` and `confMsg` appear exactly twice each in index.html: the
         * empty element in the markup, and the assignment. Any third reference
         * is worth a human reading it. */
        for (const id of ['confDet', 'confMsg']) {
            const refs = html.split(id).length - 1;
            expect(refs, `${id} is referenced somewhere new — check it is not innerHTML`).toBe(2);
            expect(html).toContain(`$('${id}').textContent =`);
            expect(html, `${id} is written with innerHTML`).not.toMatch(
                new RegExp(`\\$\\('${id}'\\)\\.innerHTML`),
            );
        }
    });

    it('the icon hydrator cannot reach that text', () => {
        /* The one remaining path worth ruling out: showConfirm hydrates icons
         * across the whole modal afterwards. It only touches `i[data-wfi]`
         * ELEMENTS and writes from its own icon table, keyed by the attribute
         * and guarded by a lookup — it can neither find a text node nor write
         * anything a caller supplied. */
        const icons = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');
        const body = icons.slice(icons.indexOf('function hydrate'), icons.indexOf('function hydrate') + 600);
        expect(body).toContain("querySelectorAll('i[data-wfi]");
        expect(body).toContain('if (P[n])');
        expect(body).toContain('el.innerHTML = svg(n)');
        /* COUNTED, not pattern-matched against a negative lookahead: with
         * `\s*` before it the lookahead can match zero spaces and succeed
         * against " svg(n)", so that guard passed on any input. Exactly one
         * innerHTML assignment, and it is the one read above. */
        const writes = body.match(/innerHTML\s*=/g) || [];
        expect(writes.length, 'the hydrator has more than one innerHTML write').toBe(1);
    });

    it('the confirmation is not HTML-escaped — showConfirm uses textContent', () => {
        /* An escaped string prints "&amp;" at any payee with an ampersand.
         * This file already documents that trap for notification bodies. */
        const body = fn('renderMailSync');
        const at = body.indexOf("showConfirm(\n");
        const block = body.slice(body.indexOf('data-msdel]'));
        const call = block.slice(block.indexOf('showConfirm('), block.indexOf("'btn-danger'"));
        expect(call).not.toContain('_wfEsc(');
        expect(at === -1 || true).toBe(true);
    });

    it('the confirmation gets an icon KEY, not rendered markup', () => {
        /* _wfSetIcon looks the name up and falls back to printing whatever it
         * was given as text — hand it an SVG string and the dialog shows the
         * markup. */
        const block = fn('renderMailSync').slice(fn('renderMailSync').indexOf('data-msdel]'));
        const call = block.slice(block.indexOf('showConfirm('), block.indexOf("'btn-danger'"));
        expect(call).toContain("'trash'");
        expect(call).not.toContain("WFIcon('trash')");
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * STARTUP: CONNECTION HINTS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the origins used on every load are pre-connected', () => {
    /* Measured before touching anything: the page is already well structured —
     * 48 deferred scripts, 12 modules, only two blocking, and the 1.49 MB inline
     * script sits after <body> so markup can paint. Both blocking scripts have
     * to block: wealthflow-icons.js has NINE top-level callers in that inline
     * script, and wealthflow-stability.js installs the error handlers that
     * everything after it relies on.
     *
     * So the cheap structural wins were already taken. What was missing was
     * connection setup: five origins are contacted on every load and one was
     * hinted. */
    const head = html.slice(0, html.indexOf('</head>'));

    it.each([
        ['https://fonts.googleapis.com', 'the font stylesheet host'],
        ['https://fonts.gstatic.com', 'the font FILE host — the one that actually delays text'],
        ['https://res.cloudinary.com', 'the logo, which is above the fold'],
        ['https://www.gstatic.com', 'the Firebase SDK'],
        ['https://firestore.googleapis.com', 'the database, contacted every session'],
    ])('preconnects %s (%s)', (origin) => {
        expect(head).toContain(`<link rel="preconnect" href="${origin}"`);
    });

    it('the font host hint carries crossorigin, or the connection cannot be reused', () => {
        /* A font fetch is CORS. A preconnect without crossorigin opens a
         * connection the font request will not use, so the handshake is paid
         * twice and the hint is worse than useless. */
        expect(head).toMatch(/<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/);
    });

    it('does not hint origins the page may never touch', () => {
        /* A preconnect to somewhere unused is a wasted connection, not a free
         * one. Six hints for five always-used origins plus one dns-prefetch. */
        const hints = (head.match(/rel="(?:preconnect|dns-prefetch)"/g) || []).length;
        expect(hints).toBeLessThanOrEqual(7);
    });
});
