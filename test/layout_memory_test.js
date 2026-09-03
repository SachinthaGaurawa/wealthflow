// =============================================================================
// WealthFlow Shadow Test Harness — teaching the parser a bank's layout once
// =============================================================================
// The owner cannot find every bank's statement email, and when a statement does
// arrive from a bank whose layout the parser has never seen, it used to be
// dropped in silence. Their instruction was explicit: "DO NOT SILENTLY DROP IT.
// Send it to the Needs Review widget. Let me manually verify it once, so the AI
// can learn the layout for the future."
//
// WHAT IS BEING GUARDED HERE, AND WHY EACH GUARD EXISTS
//
// 1. NO SECOND PARSER. The module learns only the DATE SHAPE and rewrites the
//    text so the real parser can read it. A "fallback parser" would drift from
//    the real one, and then a statement reads one way on Tuesday and another on
//    Friday. The tests below assert the rows come back in the parser's own shape
//    with its own direction evidence, because that is only true if the real
//    parser produced them.
//
// 2. A LOOSE REGEX FINDS DATES INSIDE NUMBERS. The first version of this module
//    learned the "layout" (\d{1,2})(\d{1,2})(\d{1,2}) from the four digits of
//    the YEAR in "05.07.2026" — read as 20|2|6, a real calendar date — and every
//    row came back stamped 2020-02-06 on a reading that reconciled perfectly,
//    because reconciliation never looks at dates. Scored 19 out of 19. That is
//    asserted against by name below.
//
// 3. A GREEDY GLOBAL SCAN HID THE REAL DATE. Scanning the whole document at once
//    matched "00\n02.07" — the tail of one line's balance, the newline and the
//    head of the next line's date — and CONSUMED the real date, so propose()
//    returned zero candidates on a statement whose dates are perfectly legible.
//    Hence: per line, and restart one character on from a rejected match.
//
// 4. AMBIGUITY IS REPORTED, NOT RESOLVED. 02.07.2026 is the 2nd of July and the
//    7th of February and the balances reconcile identically either way. A
//    silently transposed month is a year of misfiled transactions, so both
//    readings are kept and flagged.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';

/* Both browser modules on ONE fake window, because the parser reaches for
 * window.WFLayoutMemory and the memory reaches back for the parser. Loading them
 * into separate scopes would test two halves that never meet. */
function loadBoth() {
    const win = {};
    for (const f of ['wealthflow-statement-parser.js', 'wealthflow-layout-memory.js']) {
        new Function('window', 'console', fs.readFileSync(f, 'utf8'))(win, { log() {} });
    }
    win.WFLayoutMemory.useStore(win.WFLayoutMemory.memoryStore());
    return { P: win.WFStatementParser, M: win.WFLayoutMemory, win };
}

const DOTTED = [
    'ACCOUNT STATEMENT',
    'OPENING BALANCE 100,000.00',
    '02.07.2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00',
    '03.07.2026 SALARY JULY 250,000.00 345,750.00',
    '05.07.2026 CEB ELECTRICITY 8,430.50 337,319.50',
    'CLOSING BALANCE 337,319.50',
].join('\n');

/* A reference column long enough to push the date past the parser's LEAD_SLACK,
 * and a compact YYYYMMDD date — the second of the two ways an otherwise ordinary
 * statement becomes unreadable. */
const COMPACT = [
    'OPENING BALANCE 20,000.00',
    'REF/CHQ/000012345678 20260702 CARGILLS FOOD CITY 1,500.00 18,500.00',
    'REF/CHQ/000012345679 20260705 SALARY 60,000.00 78,500.00',
    'CLOSING BALANCE 78,500.00',
].join('\n');

describe('the modules actually loaded and are connected', () => {
    it('exposes its API (guards against a vacuous pass)', () => {
        const { P, M } = loadBoth();
        for (const fn of ['propose', 'learn', 'normalise', 'remember', 'recall', 'forget', 'useStore', 'memoryStore']) {
            expect(typeof M[fn], fn + ' missing').toBe('function');
        }
        expect(typeof P.parseStatement).toBe('function');
    });

    it('the statements used below really are unreadable to the parser alone', () => {
        // Without this, every assertion after it could pass on a statement the
        // parser reads unaided, and the feature would be untested.
        const { P } = loadBoth();
        expect(P.parseStatement(DOTTED).verdict).toBe('unreadable');
        expect(P.parseStatement(DOTTED).rows).toHaveLength(0);
        expect(P.parseStatement(COMPACT).verdict).toBe('unreadable');
        expect(P.parseStatement(COMPACT).rows).toHaveLength(0);
    });
});

describe('propose(): reading a statement nobody taught us', () => {
    it('offers a reading of a dotted date that the statement’s own arithmetic agrees with', () => {
        const { P, M } = loadBoth();
        const readings = M.propose(DOTTED, P.parseStatement, { bank: 'Sampath Bank' });
        expect(readings.length).toBeGreaterThan(0);
        const best = readings[0];
        expect(best.reconciliation.ok).toBe(true);
        expect(best.rows.map((r) => [r.date, r.amount, r.direction])).toEqual([
            ['2026-07-02', 4250, 'debit'],
            ['2026-07-03', 250000, 'credit'],
            ['2026-07-05', 8430.5, 'debit'],
        ]);
    });

    it('reads a compact date behind a long reference column', () => {
        const { P, M } = loadBoth();
        const readings = M.propose(COMPACT, P.parseStatement);
        expect(readings.length).toBeGreaterThan(0);
        expect(readings[0].rows.map((r) => [r.date, r.amount])).toEqual([
            ['2026-07-02', 1500],
            ['2026-07-05', 60000],
        ]);
    });

    it('THE ROWS ARE THE REAL PARSER’S, not a second reader’s', () => {
        // Direction from the bank's own running balance, and the flags the
        // review screen reads. Only parseStatement() produces these.
        const { P, M } = loadBoth();
        const row = M.propose(DOTTED, P.parseStatement)[0].rows[0];
        expect(row.directionSource).toBe('balance');
        expect(row.balanceVerified).toBe(true);
        expect(row.needsReview).toBe(false);
        expect(row.narration).toBe('KEELLS SUPER COLOMBO');
        expect(row).toHaveProperty('valid', true);
    });

    it('THE NAMED MISTAKE: a date is never learned from digits inside a number', () => {
        // "05.07.2026" contains "2026", which reads as 20|2|6 -> 2020-02-06 and
        // reconciles perfectly. No proposal may be built on it.
        const { P, M } = loadBoth();
        for (const r of M.propose(DOTTED, P.parseStatement)) {
            expect(r.template.re, 'a separator-less non-compact shape was learned')
                .not.toBe('(\\d{1,2})(\\d{1,2})(\\d{1,2})');
            for (const row of r.rows) expect(row.date.slice(0, 4)).toBe('2026');
        }
    });

    it('THE NAMED MISTAKE: a greedy scan must not swallow the date it was looking for', () => {
        // The balance on the line above ends in digits; the date starts the next
        // line. Scanned as one document these join into a match that consumes
        // both and yields nothing.
        const { M } = loadBoth();
        expect(M.runsOn('OPENING BALANCE 100,000.00')).toHaveLength(0);
        const found = M.runsOn('02.07.2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00');
        expect(found.length).toBeGreaterThan(0);
        expect(found[0].text).toBe('02.07.2026');
    });

    it('says when a reading is ambiguous instead of quietly picking one', () => {
        const { P, M } = loadBoth();
        const readings = M.propose(DOTTED, P.parseStatement);
        const orders = readings.map((r) => r.template.order);
        expect(orders).toContain('dmy');
        expect(orders).toContain('mdy');
        expect(readings[0].ambiguous).toBe(true);
        // Day-first is the convention of the market this is built for, so it is
        // the one offered first — but only after the flag says it is a choice.
        expect(readings[0].template.order).toBe('dmy');
    });

    it('refuses a reading that scatters rows across the calendar', () => {
        const { P, M } = loadBoth();
        // Every reading offered must keep the statement inside a plausible
        // period; a template that reads a reference number as a date does not.
        for (const r of M.propose(COMPACT, P.parseStatement)) {
            const months = new Set(r.rows.map((x) => x.date.slice(0, 7)));
            expect(months.size).toBeLessThanOrEqual(3);
        }
    });

    it('offers nothing rather than nonsense when there is nothing to read', () => {
        const { P, M } = loadBoth();
        expect(M.propose('', P.parseStatement)).toEqual([]);
        expect(M.propose('no numbers and no dates at all', P.parseStatement)).toEqual([]);
    });
});

describe('learn(): the owner corrected the rows', () => {
    it('derives the layout from confirmed rows and proves it can read them back', () => {
        const { P, M } = loadBoth();
        const res = M.learn(DOTTED, [
            { date: '2026-07-02', amount: 4250 },
            { date: '2026-07-03', amount: 250000 },
            { date: '2026-07-05', amount: 8430.5 },
        ], P.parseStatement, { bank: 'Sampath Bank' });
        expect(res.ok).toBe(true);
        expect(res.template.order).toBe('dmy');
        expect(res.matched).toBe(3);
        expect(res.produced).toBe(3);
    });

    it('REFUSES a template it cannot read back — the guard that matters most', () => {
        // A template that only works on the statement it was learned from would
        // be trusted on the next one. Better no memory than a wrong one.
        const { P, M } = loadBoth();
        const res = M.learn(DOTTED, [{ date: '2026-07-02', amount: 999999 }], P.parseStatement);
        expect(res.ok).toBe(false);
        expect(res.reason).toMatch(/could be found/i);
    });

    it('says so plainly when there is nothing to learn from', () => {
        const { P, M } = loadBoth();
        expect(M.learn(DOTTED, [], P.parseStatement).ok).toBe(false);
        expect(M.learn('', [{ date: '2026-07-02', amount: 1 }], P.parseStatement).ok).toBe(false);
        expect(M.learn(DOTTED, [{ date: 'not-a-date', amount: 1 }], P.parseStatement).ok).toBe(false);
    });
});

describe('remember() and recall(): one confirmation, then it reads on its own', () => {
    it('the SAME statement parses after the layout is confirmed', () => {
        const { P, M } = loadBoth();
        const best = M.propose(DOTTED, P.parseStatement, { bank: 'Sampath Bank' })[0];
        expect(M.remember('Sampath Bank', best.template).ok).toBe(true);

        const after = P.parseStatement(DOTTED, { bank: 'Sampath Bank' });
        expect(after.verdict).toBe('parsed');
        expect(after.understood).toBe(true);
        expect(after.rows).toHaveLength(3);
        expect(after.learnedLayout).toBe(best.template.id);
    });

    it('THE POINT OF THE WHOLE FEATURE: a statement never seen before parses too', () => {
        const { P, M } = loadBoth();
        M.remember('Sampath Bank', M.propose(DOTTED, P.parseStatement)[0].template);
        const nextMonth = [
            'OPENING BALANCE 337,319.50',
            '02.08.2026 SINGER MEGA 12,000.00 325,319.50',
            '09.08.2026 DIVIDEND 5,000.00 330,319.50',
            'CLOSING BALANCE 330,319.50',
        ].join('\n');
        // Unknown to a memory that has learned nothing. Checked on a SEPARATE
        // instance, because in this one the layout has just been remembered —
        // and a bankless parse deliberately tries every layout it holds.
        expect(loadBoth().P.parseStatement(nextMonth).verdict).toBe('unreadable');
        const read = P.parseStatement(nextMonth, { bank: 'Sampath Bank' });
        expect(read.verdict).toBe('parsed');
        expect(read.rows.map((r) => [r.date, r.amount, r.direction])).toEqual([
            ['2026-08-02', 12000, 'debit'],
            ['2026-08-09', 5000, 'credit'],
        ]);
    });

    it('THE COLLIDING ID: two layouts that differ only in their separator are two layouts', () => {
        // Built by stripping punctuation out of the regex, the ids for a
        // dot-separated and an underscore-separated date were identical, and the
        // second was discarded as a duplicate of the first.
        const { M } = loadBoth();
        const a = M.makeTemplate('(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})', 'dmy', false, 'A');
        const b = M.makeTemplate('(\\d{1,2})_(\\d{1,2})_(\\d{4})', 'dmy', false, 'B');
        expect(a.id).not.toBe(b.id);
        M.remember('A', a);
        M.remember('B', b);
        expect(M.recall('A').map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    });

    it('tries this bank’s layout before anyone else’s, and other banks after', () => {
        const { P, M } = loadBoth();
        M.remember('Bank A', M.makeTemplate('(\\d{1,2})_(\\d{1,2})_(\\d{4})', 'dmy', false, 'Bank A'));
        M.remember('Bank B', M.propose(DOTTED, P.parseStatement)[0].template);
        const list = M.recall('Bank B');
        expect(list[0].bank).toBe('Bank B');
        // Statement software is sold, not written per bank: a layout learned for
        // one bank is worth trying on another, so it is kept in the list.
        expect(list.length).toBeGreaterThan(1);
        // And it works: Bank C has taught us nothing, yet its statement reads.
        expect(P.parseStatement(DOTTED, { bank: 'Bank C' }).verdict).toBe('parsed');
    });

    it('never tries more layouts than it promised, whatever is stored', () => {
        const { M } = loadBoth();
        for (let i = 0; i < 40; i++) {
            M.remember('Bank ' + i, M.makeTemplate('(\\d{1,2})x' + i + '(\\d{1,2})x(\\d{4})', 'dmy', false, 'Bank ' + i));
        }
        expect(M.recall('Bank 39').length).toBeLessThanOrEqual(M.TRY_LIMIT);
        expect(M.recall(null).length).toBeLessThanOrEqual(M.TRY_LIMIT);
    });

    it('forgets on request, and says so when there was nothing to forget', () => {
        const { P, M } = loadBoth();
        M.remember('Sampath Bank', M.propose(DOTTED, P.parseStatement)[0].template);
        expect(P.parseStatement(DOTTED, { bank: 'Sampath Bank' }).verdict).toBe('parsed');
        expect(M.forget('Sampath Bank').ok).toBe(true);
        expect(P.parseStatement(DOTTED, { bank: 'Sampath Bank' }).verdict).toBe('unreadable');
        expect(M.forget('Sampath Bank').ok).toBe(false);
    });

    it('a corrupt or absent store is an empty memory, not a crash', () => {
        const { P, M } = loadBoth();
        M.useStore({ get: () => '{{{not json', set: () => {} });
        expect(M.recall('Any')).toEqual([]);
        expect(() => P.parseStatement(DOTTED, { bank: 'Any' })).not.toThrow();
        M.useStore({ get: () => null, set: () => { throw new Error('quota'); } });
        expect(M.remember('Any', M.makeTemplate('(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})', 'dmy')).ok).toBe(false);
    });
});

describe('a learned layout must not damage a statement that already read fine', () => {
    it('the known layouts are untouched by a memory full of other banks', () => {
        const { P, M } = loadBoth();
        M.remember('Elsewhere', M.propose(DOTTED, P.parseStatement)[0].template);
        const known = [
            '01/07/2026 OPENING BALANCE 100,000.00',
            '02/07/2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00',
            '03/07/2026 SALARY JULY 250,000.00 345,750.00',
            '05/07/2026 CEB ELECTRICITY 8,430.50 337,319.50',
        ].join('\n');
        const res = P.parseStatement(known, { bank: 'Anywhere' });
        expect(res.verdict).toBe('parsed');
        expect(res.learnedLayout == null).toBe(true);      // never entered the fallback
        expect(res.rows.map((r) => r.amount)).toEqual([4250, 250000, 8430.5]);
    });

    it('normalise() with no template, or a broken one, returns the text unharmed', () => {
        const { M } = loadBoth();
        expect(M.normalise(DOTTED, null)).toBe(DOTTED);
        expect(M.normalise(DOTTED, { re: '([' })).toBe(DOTTED);   // an invalid regex
    });
});

describe('adversarial input', () => {
    it('never throws and never loops, whatever the statement contains', () => {
        const { P, M } = loadBoth();
        fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
            expect(() => M.propose(s, P.parseStatement)).not.toThrow();
            expect(() => M.learn(s, [{ date: '2026-07-02', amount: 10 }], P.parseStatement)).not.toThrow();
            expect(() => P.parseStatement(s, { bank: s.slice(0, 12) })).not.toThrow();
        }), { numRuns: runs(60) });
    });

    it('a stored template can never rewrite a money token into a date', () => {
        const { M } = loadBoth();
        // The template matches three digit groups; the money on this line must
        // survive it untouched, or amounts start turning into dates.
        const tpl = M.makeTemplate('(\\d{4})(\\d{1,2})(\\d{1,2})', 'ymd', false, 'x');
        const line = 'PAYMENT 1,234,567.89 AND 20260702 REF';
        const out = M.normalise(line, tpl);
        expect(out).toContain('1,234,567.89');
        expect(out.startsWith('2026-07-02 ')).toBe(true);
    });
});
