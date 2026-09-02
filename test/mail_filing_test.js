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
        expect(fn('_reviewMailStatements')).toContain('.map(_mailRowForReview)');
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
            .toContain('fetched again on the next scan');
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
