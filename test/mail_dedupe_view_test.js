/* =============================================================================
 * test/mail_dedupe_view_test.js
 * -----------------------------------------------------------------------------
 * The owner reported duplicate statements, was told it was fixed, and saw the
 * duplicates again. Both things were true, and the gap between them is what
 * this file is about.
 *
 * stableItemKey stopped NEW duplicates being written. It removed none of the
 * ones already stored — and those are the ones on the screen, because the
 * mailbox card lists what is in the store rather than fetching anything. So a
 * fix that only changed future writes left the screen exactly as it was.
 *
 * Two documents are the same statement when they came from the same message
 * and carry the same attachment. The old key put Gmail's remintable
 * attachmentId in the document NAME, so one statement could be stored under
 * many names — but never with a different messageId or filename.
 *
 * COLLAPSED, NOT DELETED, and that is deliberate. Hiding a row is undone by a
 * reload; a delete is not, and someone's bank statements are not the place to
 * gamble on a grouping rule being right.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { dedupeStored, betterCopy } from '../wealthflow-mail-ingest.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** A stored row as the listing endpoint builds it. */
const row = (id, manifest, parts = []) => ({ id, manifest, parts });
const stmt = (over = {}) => ({ messageId: 'm1', filename: 'statement.pdf', size: 2048, bank: 'HNB', ...over });

describe('the same statement is shown once, however many copies are stored', () => {
    it('collapses copies written under different attachment ids', () => {
        /* Exactly the shape the bug produced: one message, one attachment,
         * three documents, because the token in the NAME kept changing. */
        const out = dedupeStored([
            row('m1.ATT-A', stmt()),
            row('m1.ATT-B', stmt()),
            row('m1.statement_pdf.2048', stmt()),
        ]);
        expect(out).toHaveLength(1);
    });

    it('keeps two DIFFERENT statements from the same message', () => {
        /* A message carrying January and February is two statements. Merging
         * them would lose one, which is worse than showing a duplicate. */
        const out = dedupeStored([
            row('a', stmt({ filename: 'january.pdf' })),
            row('b', stmt({ filename: 'february.pdf' })),
        ]);
        expect(out).toHaveLength(2);
    });

    it('keeps the same filename from two different messages', () => {
        /* Banks reuse `statement.pdf` every month. */
        const out = dedupeStored([
            row('a', stmt({ messageId: 'm1' })),
            row('b', stmt({ messageId: 'm2' })),
        ]);
        expect(out).toHaveLength(2);
    });

    it('separates same message and filename when the SIZE differs', () => {
        const out = dedupeStored([
            row('a', stmt({ size: 1000 })),
            row('b', stmt({ size: 2000 })),
        ]);
        expect(out).toHaveLength(2);
    });

    it('keeps the most complete copy', () => {
        /* A half-written document and a whole one are not interchangeable. */
        const out = dedupeStored([
            row('half', stmt(), [{ i: 0 }]),
            row('whole', stmt(), [{ i: 0 }, { i: 1 }, { i: 2 }]),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('whole');
    });

    it('breaks a tie by which was stored first, so repeated calls agree', () => {
        const a = row('a', stmt({ storedMs: 200 }));
        const b = row('b', stmt({ storedMs: 100 }));
        expect(dedupeStored([a, b])[0].id).toBe('b');
        expect(dedupeStored([b, a])[0].id).toBe('b');
    });

    it('never merges records it cannot identify', () => {
        /* No messageId AND no filename is not evidence of sameness. Two such
         * rows are two rows, because guessing here loses a statement. */
        const out = dedupeStored([row('x', { bank: 'HNB' }), row('y', { bank: 'HNB' })]);
        expect(out).toHaveLength(2);
    });

    it('survives the shapes a real store contains', () => {
        expect(dedupeStored([])).toEqual([]);
        expect(dedupeStored(null)).toEqual([]);
        expect(dedupeStored([null, undefined])).toEqual([]);
        expect(dedupeStored([row('a', null)])).toHaveLength(1);
    });

    it('is order-independent in what it keeps', () => {
        const rows = [
            row('a', stmt(), [{ i: 0 }]),
            row('b', stmt(), [{ i: 0 }, { i: 1 }]),
            row('c', stmt()),
        ];
        expect(dedupeStored(rows)[0].id).toBe('b');
        expect(dedupeStored([...rows].reverse())[0].id).toBe('b');
    });

    it('betterCopy prefers parts over an earlier timestamp', () => {
        const thin = row('thin', stmt({ storedMs: 1 }));
        const fat = row('fat', stmt({ storedMs: 999 }), [{ i: 0 }]);
        expect(betterCopy(thin, fat).id).toBe('fat');
    });
});

describe('the listing endpoint uses it, and says how many it collapsed', () => {
    const SRC = fs.readFileSync(path.join(ROOT, 'gmail-link.js'), 'utf8');

    it('collapses before assembling parts', () => {
        /* Reading every copy's parts only to discard all but one is the same
         * work several times over, on a phone. */
        /* SCOPED TO THE LISTING BLOCK. Both anchors are now ambiguous
         * file-wide: the delete and mark-filed routes also reach into
         * `collection('parts')`, and they sit ABOVE this block — so a naive
         * first-index comparison compared the listing's dedupe against a
         * different route's parts and reported the order inverted. The
         * assertion was right and its anchors had gone stale, which is the
         * failure mode worth naming: a guard that breaks when unrelated code
         * moves is a guard that will one day be deleted rather than fixed. */
        const at = SRC.indexOf("method === 'GET' && /[?&]items=1/");
        expect(at, 'the listing route is gone').toBeGreaterThan(-1);
        const block = SRC.slice(at);
        const i = block.indexOf('dedupeStored(rows)');
        const j = block.indexOf("collection('parts')");
        expect(i, 'the listing no longer collapses duplicates').toBeGreaterThan(-1);
        expect(j, 'the listing no longer assembles parts').toBeGreaterThan(-1);
        expect(i, 'parts are assembled before duplicates are collapsed').toBeLessThan(j);
    });

    it('reports the count rather than quietly returning a shorter list', () => {
        /* The owner asked why the same statements kept appearing. A number
         * they can watch fall to zero answers that; a list that silently got
         * shorter does not. */
        expect(SRC).toContain('duplicates:');
    });

    it('raised the cap, and scans more than it returns', () => {
        /* 25 could not hold a real history. The scan ceiling is the higher of
         * the two so a store full of repeats cannot crowd out real statements. */
        const scan = /ITEMS_SCAN_MAX = (\d+)/.exec(SRC);
        const ret = /ITEMS_RETURN_MAX = (\d+)/.exec(SRC);
        expect(scan, 'the scan ceiling is gone').toBeTruthy();
        expect(ret, 'the return ceiling is gone').toBeTruthy();
        expect(Number(ret[1])).toBeGreaterThan(25);
        expect(Number(scan[1])).toBeGreaterThanOrEqual(Number(ret[1]));
        expect(SRC, 'the old flat limit is back').not.toContain("items').limit(25)");
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST SCAN HAS TO HAPPEN WITHOUT BEING ASKED
 * ═══════════════════════════════════════════════════════════════════════════
 * Connecting a mailbox registers a Gmail watch, and a watch reports only what
 * arrives NEXT. Everything already in the inbox — on the day you connect, all
 * of it — is reachable only through the historical scan, and that ran only
 * when someone pressed a button.
 *
 * So a freshly connected mailbox said "Connected. No statements waiting",
 * which was true and completely misleading: nothing had ever looked. The owner
 * reported it twice, and the second time after being told it was fixed.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a connected mailbox scans its own history once', () => {
    const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    function fn(name) {
        const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
        if (at < 0) return '';
        let depth = 0;
        for (let j = HTML.indexOf('{', at); j < HTML.length; j += 1) {
            if (HTML[j] === '{') depth += 1;
            else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
        }
        return '';
    }

    const SYNC = fn('runMailSync');

    it('runMailSync triggers the backfill when the store is empty', () => {
        expect(SYNC, 'runMailSync is gone').toBeTruthy();
        expect(SYNC, 'nothing runs the historical scan on its own').toContain('runBackfill(FIRST_SCAN_MONTHS)');
        expect(SYNC).toContain('!docs.length');
    });

    it('only once, and the marker is set BEFORE the scan runs', () => {
        /* A scan that fails must not re-arm itself on every render against
         * someone's Gmail quota. The button remains for a deliberate retry. */
        const at = SYNC.indexOf('_markFirstScan()');
        const run = SYNC.indexOf('runBackfill(FIRST_SCAN_MONTHS)');
        expect(at, 'the once-only marker is gone').toBeGreaterThan(-1);
        expect(at, 'the marker is written after the scan, so a failure repeats forever')
            .toBeLessThan(run);
        expect(SYNC).toContain('!_firstScanDone()');
    });

    it('does not start a second scan while one is running', () => {
        expect(SYNC).toContain("_scan.stage !== 'running'");
    });

    it('re-reads the store when the scan found something', () => {
        /* Otherwise the card keeps showing the empty answer it computed before
         * the statements arrived. */
        expect(SYNC).toContain('_scan.found > 0');
    });

    it('the empty banner no longer claims the inbox was searched', () => {
        /* "No statements waiting" said the looking had been done. It had not. */
        expect(HTML).not.toContain('Connected. No statements waiting');
        expect(HTML).toContain('has not been scanned yet');
    });

    it('scans a real span of history, not one month', () => {
        const m = /FIRST_SCAN_MONTHS = (\d+)/.exec(HTML);
        expect(m, 'the first-scan depth is gone').toBeTruthy();
        expect(Number(m[1])).toBeGreaterThanOrEqual(12);
    });

    it('the marker can be cleared, so a rescan is possible without devtools', () => {
        expect(HTML).toContain('_wfResetFirstScan');
    });
});
