/* =============================================================================
 * test/backfill_test.js
 * -----------------------------------------------------------------------------
 * Backfilling a mailbox means pushing years of statements at a ledger that is
 * already full — much of it typed in by hand, covering the same months. So the
 * headline test in this file is not about scanning. It is this:
 *
 *   a transaction the owner entered by hand, and the statement row describing
 *   the same purchase, must produce the SAME cryptographic identity.
 *
 * If they do not, the dedup engine returns "no duplicates found" and means
 * "I looked at nothing", and the backfill doubles a year of spending.
 *
 * THE ENGINE WAS ALREADY THERE. THE SET WAS ALWAYS EMPTY.
 *
 * hashRow() and classifyStatement({ existingHashes }) have existed for a long
 * time and are well tested. Searching this repository for a caller that passes
 * `existingHashes` returns the router's own doc comment and the dedup test file
 * — and nothing else. Every real caller left it defaulted to an empty Set, so
 * the engine has only ever de-duplicated a statement against itself. The tests
 * below are the first ones to exercise it against a ledger, which is the
 * scenario it was written for.
 *
 * A HARD CONSTRAINT HAS TWO SIDES
 *
 * "0% duplication" is one of them. The other is that no real transaction may be
 * deleted to achieve it, and that failure is far worse: a duplicate is visible
 * in the list and one tap to remove, while a transaction silently dropped as a
 * "duplicate" is money that spent itself. Two coffees at the same shop, same
 * price, same day, with no reference printed, are one identity and two real
 * events. There is a test for exactly that, and before this change the second
 * coffee disappeared.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot scan a mailbox. Nothing in this module fetches — it decides what
 * should be fetched next and folds the answer back into a cursor — which is
 * what makes a deep scan testable at all, and is also the limit: that the
 * queries it writes actually match statements in a real Gmail account is not
 * provable here.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import B, {
    LEDGER_SOURCES, HASH_BATCH, MAX_WINDOWS_PER_RUN, NOTIFY_REASONS,
    rowFromRecord, ledgerHashes, planWindows, startCursor, nextStep, advance, STATEMENT_TERMS,
    shouldPause, notifiable, runSummary,
} from '../wealthflow-backfill.js';
import { hashRow, occurrenceKey, classifyStatement } from '../wealthflow-statement-router.js';
import { QUARANTINE } from '../wealthflow-mail-intake.js';

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a hand-typed entry and the statement row for it are the same transaction', () => {
    it('matches an expense the owner entered months ago', async () => {
        /* THE TEST THIS FILE EXISTS FOR. The record on the left is what the app
         * stores when someone adds an expense by hand. The row on the right is
         * what the parser pulls out of the PDF. Same purchase, two sources,
         * written years apart by different code — and the backfill is safe only
         * if they collide. */
        const stored = { date: '2026-02-11', desc: 'SPAR SUPERMARKET', amount: 4820.5, card_last4: '4471' };
        const fromStatement = { date: '2026-02-11', description: 'SPAR SUPERMARKET', amount: 4820.5, card_last4: '4471' };

        const known = await ledgerHashes({ expenses: [stored] });
        const result = await classifyStatement({ rows: [fromStatement], existingHashes: known });

        expect(result[0].duplicate, 'the backfill would have doubled this transaction').toBe(true);
        expect(result[0].duplicateOf).toBe('ledger');
    });

    it('matches across every module that holds transactions', async () => {
        for (const [key, spec] of Object.entries(LEDGER_SOURCES)) {
            const descField = spec.desc[0];
            const stored = { date: '2026-01-05', [descField]: 'DIALOG AXIATA', amount: 3200 };
            const known = await ledgerHashes({ [key]: [stored] });
            const r = await classifyStatement({
                rows: [{ date: '2026-01-05', description: 'DIALOG AXIATA', amount: 3200 }],
                existingHashes: known,
            });
            expect(r[0].duplicate, `${key} reads its description from a different field`).toBe(true);
        }
    });

    it('does not match a different transaction that merely looks similar', async () => {
        const known = await ledgerHashes({ expenses: [{ date: '2026-02-11', desc: 'SPAR', amount: 4820.5 }] });
        const rows = [
            { date: '2026-02-12', description: 'SPAR', amount: 4820.5 },   // next day
            { date: '2026-02-11', description: 'SPAR', amount: 4820.51 },  // one cent
            { date: '2026-02-11', description: 'KEELLS', amount: 4820.5 }, // other shop
        ];
        const r = await classifyStatement({ rows, existingHashes: known });
        expect(r.map((x) => x.duplicate)).toEqual([false, false, false]);
    });

    it('matches when the statement prints a full timestamp and the ledger holds a plain date', async () => {
        /* The same property as the headline test, in the representation that
         * actually turns up: a hand-typed entry stores `2026-02-11`, and a
         * parser reading an ISO date column produces `2026-02-11T08:12:00Z`.
         * The identity slices the date to ten characters so the two collide.
         * Nothing tested that slice, and removing it survived the first
         * mutation run — with it gone, every row from a statement that prints
         * times stops matching everything the owner ever typed in. */
        const known = await ledgerHashes({ expenses: [{ date: '2026-02-11', desc: 'SPAR', amount: 4820.5 }] });
        const r = await classifyStatement({
            rows: [{ date: '2026-02-11T08:12:00Z', description: 'SPAR', amount: 4820.5 }],
            existingHashes: known,
        });
        expect(r[0].duplicate).toBe(true);
    });

    it('reads a date stored only as a timestamp', async () => {
        const ms = Date.parse('2026-02-11T00:00:00Z');
        const known = await ledgerHashes({ expenses: [{ date_ms: ms, desc: 'SPAR', amount: 100 }] });
        const r = await classifyStatement({
            rows: [{ date: '2026-02-11', description: 'SPAR', amount: 100 }], existingHashes: known,
        });
        expect(r[0].duplicate).toBe(true);
    });

    it('uses a record’s own stored hash when it has one', async () => {
        const known = await ledgerHashes({ expenses: [{ hash: 'deadbeef', desc: 'X', amount: 1 }] });
        expect(known.has('deadbeef')).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER SIDE OF THE HARD CONSTRAINT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('no real transaction is deleted in the name of zero duplicates', () => {
    it('keeps two identical purchases made on the same day', async () => {
        /* Same shop, same price, same day, no reference printed — one identity
         * and two real events. Before the occurrence rule the second one was
         * marked a duplicate and silently dropped. Across a backfilled year
         * that is not an edge case. */
        const coffee = { date: '2026-02-11', description: 'BARISTA COL 03', amount: 850 };
        const r = await classifyStatement({ rows: [coffee, { ...coffee }] });
        expect(r.map((x) => x.duplicate), 'the second coffee was deleted').toEqual([false, false]);
    });

    it('still catches the same printed row twice under one reference', async () => {
        // A bank does not print one transaction twice under one reference, so
        // this really is a duplicate — and the existing behaviour is preserved.
        const row = { date: '2026-02-11', description: 'KEELLS', amount: 4250, ref: 'TX-1' };
        const r = await classifyStatement({ rows: [row, { ...row }] });
        expect(r.map((x) => x.duplicate)).toEqual([false, true]);
        expect(r[1].duplicateOf).toBe('statement');
    });

    it('tells two same-priced purchases apart by the time they happened', async () => {
        const rows = [
            { date: '2026-02-11', time: '08:12', description: 'BARISTA', amount: 850 },
            { date: '2026-02-11', time: '16:40', description: 'BARISTA', amount: 850 },
        ];
        const r = await classifyStatement({ rows });
        expect(r.map((x) => x.duplicate)).toEqual([false, false]);
    });

    it('keeps the time OUT of the identity itself', async () => {
        /* Deliberate, and the opposite of the obvious reading. A hand-typed
         * entry has a date and no time. Fold the time into the identity and the
         * statement row stops matching it — which breaks the cross-source dedup
         * that is the entire reason this exists. The time earns its keep as a
         * tiebreaker between occurrences, not as part of what a transaction IS. */
        const withTime = await hashRow({ date: '2026-02-11', time: '08:12', description: 'BARISTA', amount: 850 });
        const without = await hashRow({ date: '2026-02-11', description: 'BARISTA', amount: 850 });
        expect(withTime).toBe(without);
    });

    it.each([
        ['a reference', { ref: 'TX-9' }, 'R:TX-9'],
        ['a lowercase reference', { ref: 'tx-9' }, 'R:TX-9'],
        ['a time field', { time: '08:12' }, 'T:08:12'],
        ['a time inside the date', { date: '2026-02-11T08:12:00Z' }, 'T:08:12:00'],
    ])('reads an occurrence key from %s', (_why, over, expected) => {
        expect(occurrenceKey({ date: '2026-02-11', ...over })).toBe(expected);
    });

    it('has no occurrence key when the bank printed neither', () => {
        expect(occurrenceKey({ date: '2026-02-11', description: 'X', amount: 1 })).toBe(null);
        expect(occurrenceKey(null)).toBe(null);
    });

    it('a ledger match is a duplicate even with no occurrence key at all', async () => {
        // The stored copy may be hand-typed, carrying neither reference nor
        // time. The hash is all there is to match on, and matching on it is
        // exactly the point of cross-source dedup.
        const row = { date: '2026-02-11', description: 'SPAR', amount: 100 };
        const r = await classifyStatement({ rows: [row], existingHashes: new Set([await hashRow(row)]) });
        expect(r[0].duplicate).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * READING THE LEDGER
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('collecting what is already stored', () => {
    it('names only real record keys', async () => {
        /* A typo here fails silently as "no duplicates found" — the worst shape
         * of bug this pipeline produces. The canonical list lives in index.html
         * and is read from it rather than copied.
         *
         * Imported rather than require()d: this package is ESM, and
         * test/esm_require_test.js fails any tracked .js file that reaches for a
         * bare require. It did not fail when this file was first written,
         * because that guard scans `git ls-files` and the file was still
         * untracked — so a violation in a NEW file cannot surface until the run
         * after it is committed. Worth knowing before trusting a green local
         * run on a file you have just created. */
        const fs = await import('node:fs');
        const path = await import('node:path');
        const html = fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
        const line = /_WF_RECORD_KEYS\s*=\s*\[([^\]]+)\]/.exec(html);
        expect(line, 'could not find _WF_RECORD_KEYS in index.html').toBeTruthy();
        const known = line[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, ''));
        for (const key of Object.keys(LEDGER_SOURCES)) {
            expect(known, `${key} is not a key this app stores records under`).toContain(key);
        }
    });

    it('returns an empty set for an empty app, not a crash', async () => {
        for (const bad of [null, undefined, {}, { expenses: null }]) {
            expect((await ledgerHashes(bad)).size).toBe(0);
        }
    });

    it('survives a record too malformed to hash', async () => {
        const known = await ledgerHashes({
            expenses: [null, {}, { amount: 'abc' }, { date: '2026-02-11', desc: 'OK', amount: 5 }],
        });
        expect(known.size).toBeGreaterThan(0);
    });

    it('hands control back so a big ledger does not freeze the phone', async () => {
        let yields = 0;
        const many = Array.from({ length: HASH_BATCH * 2 + 5 }, (_, i) => ({
            date: '2026-02-11', desc: 'SHOP ' + i, amount: i + 1,
        }));
        await ledgerHashes({ expenses: many }, { yieldToUi: async () => { yields += 1; } });
        expect(yields).toBeGreaterThanOrEqual(2);
    });

    it('reads the fields hashRow actually looks at', () => {
        const r = rowFromRecord(
            { date: '2026-02-11', merchant: 'SPAR', amount: 10, reference: 'R1', cardLast4: '4471' },
            LEDGER_SOURCES.expenses,
        );
        expect(r).toEqual({ date: '2026-02-11', description: 'SPAR', amount: 10, ref: 'R1', card_last4: '4471' });
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SCAN PLAN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('planning a deep scan', () => {
    const NOW = Date.parse('2026-08-27T10:00:00Z');

    it('walks backwards a month at a time, newest first', () => {
        const w = planWindows({ months: 3, now: NOW });
        expect(w.map((x) => x.label)).toEqual(['2026-08', '2026-07', '2026-06']);
    });

    it('starts with the recent months, because an interrupted scan keeps what it got', () => {
        const w = planWindows({ months: 24, now: NOW });
        expect(w[0].after).toBeGreaterThan(w[23].after);
    });

    it('crosses a year boundary correctly', () => {
        const w = planWindows({ months: 3, now: Date.parse('2026-01-15T00:00:00Z') });
        expect(w.map((x) => x.label)).toEqual(['2026-01', '2025-12', '2025-11']);
    });

    it('asks Gmail to do the filtering', () => {
        const w = planWindows({ months: 1, now: NOW, senders: ['hnb.lk', 'dfcc.lk'] });
        expect(w[0].query).toContain('has:attachment');
        expect(w[0].query).toContain('from:hnb.lk OR from:dfcc.lk');
        expect(w[0].query).toMatch(/after:2026\/08\/01/);
        expect(w[0].query).toMatch(/before:2026\/09\/01/);
    });

    it('still writes a usable query with no sender list', () => {
        expect(planWindows({ months: 1, now: NOW }).length).toBe(1);
        expect(planWindows({ months: 1, now: NOW })[0].query).not.toContain('from:');
    });

    it('bounds how far back it will ever go', () => {
        expect(planWindows({ months: 9999, now: NOW }).length).toBeLessThanOrEqual(120);
        expect(planWindows({ months: 0, now: NOW }).length).toBe(1);
        expect(planWindows({ months: -5, now: NOW }).length).toBe(1);
    });

    it('does not read the clock on its own', () => {
        /* A planner that reads Date.now() cannot be tested, and this one decides
         * how much of someone's mailbox gets read. */
        expect(planWindows({ months: 2, now: NOW })).toEqual(planWindows({ months: 2, now: NOW }));
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * STOPPING AND STARTING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a scan that can be interrupted', () => {
    const NOW = Date.parse('2026-08-27T10:00:00Z');
    const fresh = () => startCursor({ months: 3, now: NOW, senders: ['hnb.lk'] });

    it('points at the newest window first', () => {
        expect(nextStep(fresh()).window.label).toBe('2026-08');
    });

    it('stays in the window while Gmail hands back more pages', () => {
        const c = advance(fresh(), { ids: ['a', 'b'], pageToken: 'PAGE2' });
        const step = nextStep(c);
        expect(step.window.label).toBe('2026-08');
        expect(step.pageToken).toBe('PAGE2');
        expect(c.scanned).toBe(2);
    });

    it('moves on only when the pages run out, not when one comes back empty', () => {
        /* An empty page mid-window is normal — every message in it was filtered
         * out. Treating it as the end truncates the scan at the first quiet
         * month, and the months behind it are never read. */
        const c = advance(fresh(), { ids: [], pageToken: 'PAGE2' });
        expect(nextStep(c).window.label).toBe('2026-08');
        const d = advance(c, { ids: [] });
        expect(nextStep(d).window.label).toBe('2026-07');
        expect(nextStep(d).pageToken, 'carried a finished window’s page token into the next one')
            .toBe(null);
    });

    it('finishes, and says so', () => {
        let c = fresh();
        for (let i = 0; i < 3; i++) c = advance(c, { ids: ['x'], statements: 1 });
        expect(c.done).toBe(true);
        expect(nextStep(c)).toBe(null);
        expect(c.statements).toBe(3);
    });

    it('resumes exactly where it stopped, from a cursor that was stored and reloaded', () => {
        let c = advance(fresh(), { ids: ['a'] });
        c = JSON.parse(JSON.stringify(c));           // as it would come back from storage
        expect(nextStep(c).window.label).toBe('2026-07');
    });

    it('pauses rather than reading ten years in one go', () => {
        let c = startCursor({ months: 120, now: NOW });
        const started = c.index;
        let steps = 0;
        while (nextStep(c) && !shouldPause(started, c)) { c = advance(c, { ids: [] }); steps += 1; }
        expect(steps).toBe(MAX_WINDOWS_PER_RUN);
        expect(c.done).toBe(false);
    });

    it('never throws on a cursor that arrived damaged', () => {
        for (const bad of [null, undefined, {}, { windows: null }, { windows: [], index: 99 }]) {
            expect(() => nextStep(bad)).not.toThrow();
            expect(() => advance(bad, {})).not.toThrow();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SILENCE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a backfill does not make a phone buzz fifty times', () => {
    it('says nothing at all about a year that filed cleanly', () => {
        const twelveMonths = { applied: 1840, duplicates: 233, notify: notifiable([]) };
        expect(runSummary(twelveMonths), 'a successful backfill interrupted the owner').toBe(null);
    });

    it('stays silent about old statements that simply would not open', () => {
        /* For a statement that arrived thirty seconds ago, a password failure is
         * worth saying. For one from March 2023 it is a line in a summary. */
        const held = [
            { scope: 'statement', reason: QUARANTINE.PASSWORD_FAILED },
            { scope: 'statement', reason: QUARANTINE.NO_TEXT_LAYER },
            { scope: 'row', reason: QUARANTINE.LOW_CONFIDENCE },
        ];
        expect(notifiable(held)).toEqual([]);
    });

    it('speaks up for a row where the bank and the description disagree', () => {
        const held = [{ scope: 'row', reason: QUARANTINE.ROUTING_CONFLICT }];
        expect(notifiable(held)).toHaveLength(1);
        expect(runSummary({ applied: 40, duplicates: 3, notify: notifiable(held) }))
            .toContain('1 transaction');
    });

    it('counts, rather than listing, when several need a look', () => {
        const held = Array.from({ length: 7 }, () => ({ scope: 'row', reason: QUARANTINE.DIRECTION_UNRESOLVED }));
        const line = runSummary({ applied: 500, duplicates: 12, notify: notifiable(held) });
        expect(line).toContain('7 transactions');
        expect(line).toContain('500 filed automatically');
        expect(line).toContain('12 already in your records');
    });

    it('only ever escalates reasons a person can actually decide', () => {
        for (const reason of NOTIFY_REASONS) {
            expect(Object.values(QUARANTINE), `${reason} is not a reason the intake produces`)
                .toContain(reason);
        }
    });

    it('escalates exactly two reasons, and no statement-level failure', () => {
        /* Pinned by equality rather than by example. Both survivors of the first
         * mutation run were widenings of this set that no test could see: one
         * added a statement-open failure to it, the other dropped the scope
         * check that was the only thing filtering such a failure out. Either
         * one alone turns a quiet backfill into fifty notifications about
         * statements from 2023 whose passwords no longer work. */
        expect([...NOTIFY_REASONS].sort()).toEqual(['direction-unresolved', 'routing-conflict']);
        for (const reason of [QUARANTINE.PASSWORD_FAILED, QUARANTINE.NO_TEXT_LAYER,
            QUARANTINE.UNPARSEABLE, QUARANTINE.CHUNKS_MISSING, QUARANTINE.LOW_CONFIDENCE]) {
            expect(NOTIFY_REASONS.has(reason), `${reason} would interrupt the owner`).toBe(false);
        }
    });

    it('will not escalate a whole-statement failure even if its reason qualifies', () => {
        // Defence in depth: a statement-scope record has no row to review, so a
        // card with two dropdowns could not be built for it whatever it says.
        expect(notifiable([{ scope: 'statement', reason: QUARANTINE.ROUTING_CONFLICT }])).toEqual([]);
    });

    it('never throws on a malformed result', () => {
        for (const bad of [null, undefined, {}, { notify: null }]) {
            expect(() => runSummary(bad)).not.toThrow();
            expect(() => notifiable(bad && bad.notify)).not.toThrow();
        }
    });

    it('exports what the caller needs and nothing half-built', () => {
        for (const fn of ['ledgerHashes', 'planWindows', 'startCursor', 'nextStep', 'advance', 'notifiable']) {
            expect(typeof B[fn], fn).toBe('function');
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE QUERY HAS TO ASK FOR BANKS NOBODY LISTED
 * ═══════════════════════════════════════════════════════════════════════════
 * This query used to be `has:attachment (from:a OR from:b ...)` over the four
 * domains the ingest allowlist happened to name. The owner banks with more
 * than ten institutions and index.html's own dropdown lists fifteen, so
 * eleven of them were never ASKED FOR — no parser bug and no rejection to look
 * up, because Gmail was never told those messages existed.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the scan query catches an unlisted bank', () => {
    const NOW2 = Date.UTC(2026, 7, 15);
    const q = (opts) => planWindows({ months: 1, now: NOW2, ...opts })[0].query;

    /* THE VOCABULARY IS NOW ASKED FOR, NOT ASSUMED.
     *
     * These two used to pass `senders` and expect the statement wording to be
     * there as well, because `discover` defaulted to true. It no longer does:
     * `discover` used to mean "also match the vocabulary" and now selects a
     * different question entirely — headers only, nothing downloaded — so
     * defaulting to it would turn every caller that never heard of the flag
     * into a run that imports nothing and reports success.
     *
     * The guarantee these tests protect is unchanged and still checked: someone
     * who has approved nobody sees banks they have not listed. It is now
     * requested by `includeTerms`, which gmail-scan.mjs sets exactly when the
     * owner's approved list is empty. */
    it('asks for statement wording as well as known senders, when asked to', () => {
        const query = q({ senders: ['hnb.lk'], includeTerms: true });
        expect(query, 'a known sender must still match on WHO it is').toContain('from:hnb.lk');
        expect(query, 'and an unlisted bank on WHAT it calls itself').toContain('"statement"');
    });

    it('the two are OR-ed, so either alone qualifies', () => {
        const query = q({ senders: ['hnb.lk'], includeTerms: true });
        const group = query.slice(query.indexOf('('));
        expect(group).toMatch(/from:hnb\.lk OR /);
        expect(group).not.toMatch(/from:hnb\.lk AND /);
    });

    it('and a curated owner is asked about nobody else', () => {
        const query = q({ senders: ['hnb.lk'] });
        expect(query).toContain('from:hnb.lk');
        expect(query).not.toContain('"statement"');
    });

    it('bounds the volume with filename:pdf rather than by sender', () => {
        expect(q({})).toContain('filename:pdf');
    });

    it('applies no category filter, because banks land in Promotions', () => {
        expect(q({ senders: ['hnb.lk'] })).not.toContain('category:');
    });

    it('still asks for exactly one month', () => {
        expect(q({ senders: [] })).toMatch(/after:2026\/08\/01/);
        expect(q({ senders: [] })).toMatch(/before:2026\/09\/01/);
    });

    it('every term is quoted, so a two-word term stays one term', () => {
        const query = q({ terms: ['account advice'] });
        expect(query).toContain('"account advice"');
    });

    it('the vocabulary is the one the ingest gate reads', () => {
        /* One list. If the query searched for words the acceptance gate did
         * not recognise, mail would be fetched and then thrown away. */
        expect(Array.isArray(STATEMENT_TERMS)).toBe(true);
        expect(STATEMENT_TERMS).toContain('statement');
        expect(STATEMENT_TERMS.length).toBeGreaterThanOrEqual(5);
    });
});
