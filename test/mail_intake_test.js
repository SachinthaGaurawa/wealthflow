/* =============================================================================
 * test/mail_intake_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-mail-intake.js is the device side of the mail statement pipeline:
 * a server stores encrypted bytes it cannot read, and this reassembles, unlocks
 * with the local vault, parses, routes, and refuses to guess.
 *
 * TWO PROPERTIES CARRY THE WHOLE DESIGN, AND BOTH ARE ABSENCES.
 *
 * 1. NO RETURN VALUE EVER CONTAINS A PASSWORD. The module holds several vault
 *    keys at once, and the ordinary way a secret reaches a log is an error
 *    object that helpfully quotes the credential it failed on. The tests below
 *    do not read the code and conclude it is careful — they serialise every
 *    object the module returns, including from the failure paths, and search
 *    the text for the key.
 *
 * 2. NOTHING IS FILED THAT THE CROSS-CHECK DID NOT PASS. Stated as an invariant
 *    over generated input rather than as a handful of examples, because the
 *    requirement is that an expense is NEVER recorded as income, and a list of
 *    cases only ever demonstrates the cases in the list.
 *
 * The cross-check itself is two independent sources, not three models voting:
 * the parser reads credit/debit off the bank's own running balance, the router
 * reads income/expense off the description. Their disagreement is a real
 * contradiction. The test named "SALARY REVERSAL" is the shape that matters —
 * wording that reads like income on a row the bank's arithmetic says was money
 * going out.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import M, {
    QUARANTINE, QUARANTINE_TEXT, BATCH,
    assemble, unlock, crossCheck, intakeStatement, intakeAll, notificationFor, summarise,
} from '../wealthflow-mail-intake.js';

const SECRET = 'NIC-991234567V';
/** An opener that accepts exactly one key and quotes the wrong one at you. */
const openerFor = (secret) => (bytes, pw) => {
    if (pw === secret) return Promise.resolve({ pages: 3 });
    // Deliberately hostile: a real library's error often includes the input.
    return Promise.reject(new Error(`PasswordException: rejected "${pw}"`));
};

/* ═══════════════════════════════════════════════════════════════════════════
 * REASSEMBLY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a statement is assembled whole or not at all', () => {
    it('joins parts in index order, whatever order they arrive in', () => {
        const r = assemble({ parts: 3 }, [{ i: 2, d: 'C' }, { i: 0, d: 'A' }, { i: 1, d: 'B' }]);
        expect(r).toEqual({ ok: true, base64: 'ABC' });
    });

    it('refuses a payload with a hole in it, and says which part is missing', () => {
        /* The dangerous case, and the reason the count is verified rather than
         * trusted: a PDF rebuilt from parts 0 and 2 can still open, shorter, and
         * be parsed as a complete statement with pages of transactions absent. */
        const r = assemble({ parts: 3 }, [{ i: 0, d: 'A' }, { i: 2, d: 'C' }]);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(QUARANTINE.CHUNKS_MISSING);
        expect(r.detail.missing).toEqual([1]);
    });

    it('ignores a part whose index is outside the manifest', () => {
        // A stray sibling document must not be able to pad the count to full.
        const r = assemble({ parts: 2 }, [{ i: 0, d: 'A' }, { i: 5, d: 'X' }]);
        expect(r.ok).toBe(false);
        expect(r.detail.missing).toEqual([1]);
    });

    it('does not let a duplicated index count twice', () => {
        const r = assemble({ parts: 2 }, [{ i: 0, d: 'A' }, { i: 0, d: 'A' }]);
        expect(r.ok, 'the same part sent twice was accepted as two parts').toBe(false);
    });

    it('reads a small statement straight from the manifest', () => {
        expect(assemble({ d: 'ONLY' }, [])).toEqual({ ok: true, base64: 'ONLY' });
    });

    it('treats an empty manifest as missing, not as an empty statement', () => {
        expect(assemble({}, []).ok).toBe(false);
        expect(assemble(null, null).ok).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE VAULT KEYS DO NOT COME BACK OUT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('nothing the module returns carries a password', () => {
    it('not on success', async () => {
        const r = await unlock('b', ['wrong', SECRET], openerFor(SECRET));
        expect(r.ok).toBe(true);
        expect(JSON.stringify(r)).not.toContain(SECRET);
        expect(r.usedIndex, 'the caller needs to know WHICH key worked, not what it is').toBe(1);
    });

    it('not when every key fails', async () => {
        const r = await unlock('b', ['wrong1', 'wrong2'], openerFor(SECRET));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(QUARANTINE.PASSWORD_FAILED);
        const s = JSON.stringify(r);
        expect(s).not.toContain('wrong1');
        expect(s).not.toContain('wrong2');
        expect(r.detail.tried, 'how many were tried is useful; which ones is not').toBe(2);
    });

    it('not when the opener throws with the key in its message', async () => {
        // openerFor quotes the rejected password in its Error. If that error
        // were propagated or attached, this is where it would show.
        const r = await unlock('b', [SECRET + '-nope'], openerFor(SECRET));
        expect(JSON.stringify(r)).not.toContain(SECRET + '-nope');
    });

    it('and not anywhere in a whole pipeline run that failed to open', async () => {
        /* The end-to-end version: serialise the ENTIRE result of a statement
         * that could not be unlocked, and look for any of the keys. */
        const keys = ['first-key', 'second-key', SECRET];
        const r = await intakeStatement(
            { id: 'm1', bank: 'HNB', manifest: { d: 'zzz' } },
            {
                openPdf: openerFor('a-different-secret'),
                extractText: () => '', parse: () => ({ rows: [] }), route: () => [],
                vaultKeys: () => keys,
            },
        );
        const s = JSON.stringify(r);
        for (const k of keys) expect(s, `${k} reached the pipeline result`).not.toContain(k);
        expect(r.quarantined[0].reason).toBe(QUARANTINE.PASSWORD_FAILED);
    });
});

describe('unlocking', () => {
    it('opens an unencrypted statement without spending a key', async () => {
        let asked = 0;
        const open = (b, pw) => { if (pw != null) asked++; return Promise.resolve({ pages: 1 }); };
        const r = await unlock('b', [SECRET], open);
        expect(r.ok).toBe(true);
        expect(r.encrypted).toBe(false);
        expect(r.usedIndex).toBe(-1);
        expect(asked, 'a key was offered to a PDF that was never locked').toBe(0);
    });

    it('tries candidates in order and stops at the first that works', async () => {
        const tried = [];
        const open = (b, pw) => {
            if (pw != null) tried.push(pw);
            if (pw === 'third') return Promise.resolve({ pages: 1 });
            return Promise.reject(new Error('no'));
        };
        const r = await unlock('b', ['first', 'second', 'third', 'fourth'], open);
        expect(r.usedIndex).toBe(2);
        expect(tried).toEqual(['first', 'second', 'third']);
    });

    it('distinguishes an empty vault from keys that all failed', async () => {
        const empty = await unlock('b', [], openerFor(SECRET));
        expect(empty.reason).toBe(QUARANTINE.NO_VAULT_KEYS);
        const failed = await unlock('b', ['x'], openerFor(SECRET));
        expect(failed.reason, 'the two need different advice: add a key vs fix the key')
            .toBe(QUARANTINE.PASSWORD_FAILED);
    });

    it('refuses to run without an injected opener rather than reaching for a global', async () => {
        await expect(unlock('b', ['x'], undefined)).rejects.toThrow(/openPdf/);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CROSS-CHECK
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the bank’s arithmetic and the description must agree', () => {
    const proven = (direction) => ({ direction, directionSource: 'balance' });

    it('quarantines wording that reads like income on money the bank says went out', () => {
        // "SALARY REVERSAL" — the shape the whole module exists for.
        const v = crossCheck(proven('debit'), { module: 'income', confidence: 0.95 });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(QUARANTINE.ROUTING_CONFLICT);
        expect(v.detail).toMatchObject({ bankSays: 'debit', descriptionSays: 'credit' });
    });

    it('and the same contradiction the other way round', () => {
        const v = crossCheck(proven('credit'), { module: 'expenses', confidence: 0.95 });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(QUARANTINE.ROUTING_CONFLICT);
    });

    it('files a row when both sources agree and the bank proved the direction', () => {
        expect(crossCheck(proven('credit'), { module: 'income', confidence: 0.9 }).ok).toBe(true);
        expect(crossCheck(proven('debit'), { module: 'expenses', confidence: 0.9 }).ok).toBe(true);
    });

    it.each(['balance', 'marker', 'column', 'sign'])(
        'accepts a direction the parser took from the statement itself (%s)', (src) => {
            expect(crossCheck({ direction: 'debit', directionSource: src },
                { module: 'expenses', confidence: 0.9 }).ok).toBe(true);
        });

    it.each(['keyword', 'assumed', '', undefined])(
        'refuses a direction the parser inferred rather than read (%s)', (src) => {
            /* The guarantee rests entirely on the direction being the bank's,
             * so a row where the parser guessed it cannot be checked at all —
             * however confident the category looks. */
            const v = crossCheck({ direction: 'debit', directionSource: src },
                { module: 'expenses', confidence: 0.99 });
            expect(v.ok).toBe(false);
            expect(v.reason).toBe(QUARANTINE.DIRECTION_UNRESOLVED);
        });

    it('refuses a row with no direction at all', () => {
        const v = crossCheck({ direction: '', directionSource: 'balance' }, { module: 'expenses', confidence: 0.99 });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe(QUARANTINE.DIRECTION_UNRESOLVED);
    });

    it.each(['loans', 'goal_alloc'])(
        'does not invent a direction constraint for %s, which is legitimately either way', (module) => {
            // A loan row can be a repayment out or a disbursement in; asserting
            // one would quarantine correct rows.
            expect(crossCheck(proven('credit'), { module, confidence: 0.9 }).ok).toBe(true);
            expect(crossCheck(proven('debit'), { module, confidence: 0.9 }).ok).toBe(true);
        });

    it('still refuses those when the category itself is weak', () => {
        expect(crossCheck(proven('credit'), { module: 'loans', confidence: 0.5 }).ok).toBe(false);
    });

    it('honours the router’s own doubt even at high confidence', () => {
        const v = crossCheck(proven('debit'), { module: 'expenses', confidence: 0.99, needsReview: true });
        expect(v.ok, 'the router said it was unsure and the number said otherwise').toBe(false);
        expect(v.reason).toBe(QUARANTINE.LOW_CONFIDENCE);
    });

    it('takes the confidence floor from the caller', () => {
        const row = proven('debit');
        const routed = { module: 'expenses', confidence: 0.6 };
        expect(crossCheck(row, routed).ok).toBe(false);
        expect(crossCheck(row, routed, { minConfidence: 0.5 }).ok).toBe(true);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE INVARIANT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('nothing is filed that the cross-check did not pass', () => {
    it('holds across every combination of direction, provenance, module and confidence', async () => {
        /* Stated as a property over the whole input space rather than as
         * examples. The requirement is that an expense is NEVER filed as
         * income; a list of cases can only ever show the cases in the list. */
        const directions = ['credit', 'debit', ''];
        const sources = ['balance', 'marker', 'column', 'sign', 'keyword', 'assumed', ''];
        const modules = ['income', 'expenses', 'cc_payment', 'subscriptions', 'ccinstall', 'cconetime', 'loans', 'goal_alloc'];
        const confidences = [0.3, 0.74, 0.75, 0.99];

        const rows = [];
        for (const direction of directions) {
            for (const directionSource of sources) {
                for (const module of modules) {
                    for (const confidence of confidences) {
                        rows.push({ row: { date: '2026-08-01', narration: module, amount: 100, direction, directionSource },
                            module, confidence });
                    }
                }
            }
        }
        expect(rows.length).toBe(3 * 7 * 8 * 4);

        const r = await intakeStatement({ id: 'p', bank: 'HNB', manifest: { d: 'z' } }, {
            openPdf: () => Promise.resolve({ pages: 1 }),
            extractText: () => 'x'.repeat(200),
            parse: () => ({ rows: rows.map((x) => x.row) }),
            route: () => rows.map((x) => ({ row: x.row, module: x.module, confidence: x.confidence, fields: { desc: x.module } })),
            vaultKeys: () => [],
        });

        expect(r.applied.length + r.quarantined.length).toBe(rows.length);
        for (const a of r.applied) {
            const v = crossCheck(a.row, a);
            expect(v.ok, `filed a row the cross-check rejects: ${JSON.stringify(a.row)} -> ${a.module}`).toBe(true);
        }
        // And the converse: an income module is never filed on a debit row.
        for (const a of r.applied) {
            if (a.module === 'income' || a.module === 'cc_payment') expect(a.row.direction).toBe('credit');
            if (['expenses', 'subscriptions', 'ccinstall', 'cconetime'].includes(a.module)) {
                expect(a.row.direction).toBe('debit');
            }
        }
        expect(r.applied.length, 'the property passed only because nothing was filed at all')
            .toBeGreaterThan(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PIPELINE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('every refusal reaches quarantine with a reason', () => {
    const base = {
        openPdf: () => Promise.resolve({ pages: 1 }),
        extractText: () => 'x'.repeat(200),
        parse: () => ({ rows: [{ date: '2026-08-01', narration: 'KEELLS', amount: 100, direction: 'debit', directionSource: 'balance' }] }),
        route: (rows) => rows.map((row) => ({ row, module: 'expenses', confidence: 0.9, fields: { desc: row.narration } })),
        vaultKeys: () => [SECRET],
    };
    const run = (item, over = {}) => intakeStatement(item, { ...base, ...over });
    const GOOD = { id: 'x', bank: 'HNB', manifest: { d: 'zzz' } };

    it.each([
        ['an incomplete payload', { id: 'x', bank: 'HNB', manifest: { parts: 2 }, parts: [{ i: 0, d: 'A' }] }, {}, QUARANTINE.CHUNKS_MISSING],
        ['no vault keys', GOOD, { openPdf: openerFor(SECRET), vaultKeys: () => [] }, QUARANTINE.NO_VAULT_KEYS],
        ['every key wrong', GOOD, { openPdf: openerFor('other'), vaultKeys: () => ['a', 'b'] }, QUARANTINE.PASSWORD_FAILED],
        ['a scanned statement', GOOD, { extractText: () => '   ' }, QUARANTINE.NO_TEXT_LAYER],
        ['a parser that throws', GOOD, { parse: () => { throw new Error('layout'); } }, QUARANTINE.UNPARSEABLE],
        ['a layout yielding no rows', GOOD, { parse: () => ({ rows: [] }) }, QUARANTINE.UNPARSEABLE],
        ['routing that throws', GOOD, { route: () => { throw new Error('boom'); } }, QUARANTINE.UNPARSEABLE],
    ])('quarantines %s', async (_why, item, over, reason) => {
        const r = await run(item, over);
        expect(r.applied, 'something was filed despite the statement failing').toEqual([]);
        expect(r.quarantined).toHaveLength(1);
        expect(r.quarantined[0].reason).toBe(reason);
        expect(r.quarantined[0].scope).toBe('statement');
        expect(r.quarantined[0].bank).toBe('HNB');
    });

    it('every reason has a sentence, and every sentence a reason', () => {
        // A reason with no text renders as "it needs a look", which tells
        // nobody anything; a text with no reason is a branch that cannot fire.
        expect(Object.keys(QUARANTINE_TEXT).sort()).toEqual(Object.values(QUARANTINE).sort());
    });

    it('skips duplicates silently rather than reporting them as problems', async () => {
        const r = await run(GOOD, {
            route: (rows) => rows.map((row) => ({ row, duplicate: true })),
        });
        expect(r.applied).toEqual([]);
        expect(r.quarantined, 'a row already in the ledger is not an issue to review').toEqual([]);
    });

    it('reports which vault key worked so the caller can reorder them', async () => {
        const r = await run(GOOD, { openPdf: openerFor(SECRET), vaultKeys: () => ['no', SECRET] });
        expect(r.usedVaultIndex).toBe(1);
        expect(r.encrypted).toBe(true);
    });
});

describe('the interface keeps running while this does', () => {
    it('hands control back every BATCH rows', async () => {
        let yields = 0;
        const n = BATCH * 4 + 3;
        const rows = Array.from({ length: n }, (_, i) => ({
            date: '2026-08-01', narration: 'ROW' + i, amount: 10,
            direction: 'debit', directionSource: 'balance',
        }));
        await intakeStatement({ id: 'y', bank: 'HNB', manifest: { d: 'z' } }, {
            openPdf: () => Promise.resolve({ pages: 1 }),
            extractText: () => 'x'.repeat(200),
            parse: () => ({ rows }),
            route: () => rows.map((row) => ({ row, module: 'expenses', confidence: 0.9, fields: { desc: row.narration } })),
            vaultKeys: () => [],
            yieldToUi: () => { yields++; return Promise.resolve(); },
        });
        expect(yields, `${n} rows should yield ${Math.floor((n - 1) / BATCH)} times`)
            .toBe(Math.floor((n - 1) / BATCH));
    });

    it('does not yield at all for a short statement', async () => {
        let yields = 0;
        const rows = [{ date: '2026-08-01', narration: 'A', amount: 1, direction: 'debit', directionSource: 'balance' }];
        await intakeStatement({ id: 'y', bank: 'HNB', manifest: { d: 'z' } }, {
            openPdf: () => Promise.resolve({ pages: 1 }),
            extractText: () => 'x'.repeat(200),
            parse: () => ({ rows }),
            route: () => rows.map((row) => ({ row, module: 'expenses', confidence: 0.9, fields: {} })),
            vaultKeys: () => [],
            yieldToUi: () => { yields++; return Promise.resolve(); },
        });
        expect(yields).toBe(0);
    });
});

describe('one bad statement does not stop the others', () => {
    const deps = {
        openPdf: () => Promise.resolve({ pages: 1 }),
        extractText: () => 'x'.repeat(200),
        parse: () => ({ rows: [{ date: '2026-08-01', narration: 'KEELLS', amount: 100, direction: 'debit', directionSource: 'balance' }] }),
        route: (rows) => rows.map((row) => ({ row, module: 'expenses', confidence: 0.9, fields: { desc: row.narration } })),
        vaultKeys: () => [],
    };

    it('carries on past an incomplete one', async () => {
        const r = await intakeAll([
            { id: 'a', bank: 'HNB', manifest: { parts: 2 }, parts: [{ i: 0, d: 'A' }] },
            { id: 'b', bank: 'DFCC', manifest: { d: 'zzz' } },
        ], deps);
        expect(r.statements).toBe(2);
        expect(r.failed).toBe(1);
        expect(r.applied).toHaveLength(1);
    });

    it('turns a statement that threw into a quarantine entry, not a crash', async () => {
        const r = await intakeAll([{ id: 'a', bank: 'HNB', manifest: { d: 'z' } }], {
            ...deps,
            extractText: () => { throw new Error('exploded'); },
        });
        // extractText throwing is caught inside and becomes NO_TEXT_LAYER; the
        // outer guard is for anything that escapes the inner ones at all.
        expect(r.quarantined).toHaveLength(1);
        expect(r.failed).toBe(1);
    });

    it('refuses to run at all without its dependencies, rather than half-working', async () => {
        await expect(intakeStatement({ id: 'a' }, { openPdf: () => {} })).rejects.toThrow(/extractText/);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE USER IS TOLD
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the notification says which bank and which transaction', () => {
    it('matches the sentence the requirement asked for', () => {
        const msg = notificationFor({
            scope: 'row', bank: 'Nations Trust', reason: QUARANTINE.ROUTING_CONFLICT,
            row: { date: '2026-08-03', desc: 'SALARY REVERSAL', amount: 12000 },
        });
        expect(msg).toMatch(/^Issue detected with Nations Trust statement\. Requires your manual review for transaction/);
        expect(msg).toContain('SALARY REVERSAL');
        expect(msg).toContain('2026-08-03');
        expect(msg).toContain(QUARANTINE_TEXT[QUARANTINE.ROUTING_CONFLICT]);
    });

    it('has a statement-level form that does not pretend to name a transaction', () => {
        const msg = notificationFor({ scope: 'statement', bank: 'HNB', reason: QUARANTINE.PASSWORD_FAILED });
        expect(msg).toBe('Issue detected with HNB statement. Requires your manual review: '
            + 'none of your saved vault keys opened it.');
        expect(msg).not.toContain('transaction');
    });

    it('puts statement-level failures first and collapses the row noise', () => {
        const s = summarise({
            applied: [1, 2],
            quarantined: [
                { scope: 'row', bank: 'HNB', reason: QUARANTINE.LOW_CONFIDENCE, row: {} },
                { scope: 'statement', bank: 'DFCC', reason: QUARANTINE.PASSWORD_FAILED },
                { scope: 'row', bank: 'HNB', reason: QUARANTINE.LOW_CONFIDENCE, row: {} },
            ],
        });
        expect(s.applied).toBe(2);
        expect(s.quarantined).toBe(3);
        expect(s.messages).toHaveLength(2);
        expect(s.messages[0], 'a statement that never opened was buried under row messages')
            .toContain('DFCC');
        expect(s.messages[1]).toBe('2 transactions need your review.');
    });

    it('says nothing when nothing needs saying', () => {
        expect(summarise({ applied: [1], quarantined: [] }).messages).toEqual([]);
    });
});

describe('the module surface', () => {
    it('parses and records — it never sends', () => {
        for (const k of Object.keys(M)) {
            expect(k, `${k} reads like it transmits`).not.toMatch(/^(send|post|upload|sync|transmit|report)/);
        }
    });
});
