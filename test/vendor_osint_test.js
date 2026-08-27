/* =============================================================================
 * test/vendor_osint_test.js
 * -----------------------------------------------------------------------------
 * Agent 2 sends a merchant name to a search engine and brings back a category.
 * Two things about that are dangerous, and both are load-bearing here.
 *
 * FIRST: IT TALKS TO THE INTERNET, ABOUT A BANK STATEMENT.
 *
 * Everything else in this pipeline runs on the device precisely so that nothing
 * about the owner's money leaves it. This module is the one deliberate hole,
 * and the whole justification for it is that what goes through is a shop name
 * and a country. So there is a test here that builds a request out of a row
 * carrying an amount, a balance, a date, an account number, a card tail and a
 * bank, then reads the URL, the headers and the body and fails if ANY of those
 * strings appear anywhere in them. Not "checks the payload shape" — reads what
 * would go on the wire and greps it for the secrets.
 *
 * SECOND: THE ANSWER LOOKS LIKE IT KNOWS THE DIRECTION, AND IT DOES NOT.
 *
 * "Dining" means an expense. A refund from a restaurant is a credit. Both are
 * true at once, and an implementation that reads the category as a direction
 * files the refund as a spend — income and expense mixed, on the word of a
 * search engine that never saw the money move. The bank proved the direction
 * with a balance that changed; nothing here is allowed to overrule it, or to
 * supply it where it is missing, or to be averaged against it.
 *
 * The refund case is the first test in that block, and applyFinding()'s output
 * is diffed field by field against the row it was given so that a direction
 * cannot be copied through by accident either.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot tell you whether the search engine's answers are any good. No
 * provider key exists in CI and none should — a test suite that reaches a real
 * search API is a test suite that fails when someone else's service is down.
 * What is tested is every path around the answer: how it is asked for, what is
 * refused before asking, and what happens to each shape of reply. The quality
 * of the reply itself is the endpoint's problem, and the Quarantine Zone is
 * what catches it being wrong.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import O, {
    OSINT, ENDPOINT, SAFE_KEYS, CATEGORY_MODULE, MAX_LIFT,
    vendorKey, payloadFor, moduleForCategory, eligible, ask, applyFinding, enrich,
} from '../wealthflow-vendor-osint.js';
import { QUARANTINE, MODULE_DIRECTION, PROVEN_SOURCES } from '../wealthflow-mail-intake.js';

/* A quarantined row of the shape intakeStatement actually produces.
 *
 * `row` and `routed` are pulled out of the override before the rest is spread,
 * because the obvious spelling — merging them and then spreading `over` at the
 * end — puts the raw override back on top and silently discards every default.
 * It cost eight failures on the first run of this file: rows written to test the
 * direction check arrived with no descriptor at all, so they were refused for
 * the wrong reason and the tests still looked like they were exercising it. */
const held = (over = {}) => {
    const { row, routed, ...rest } = over;
    return {
        scope: 'row',
        reason: QUARANTINE.LOW_CONFIDENCE,
        detail: { confidence: 0.4, module: 'expenses' },
        bank: 'HNB',
        id: 'stmt-1',
        ...rest,
        row: {
            date: '2026-02-11',
            desc: 'POS 412345XXXXXX7788 SPAR SUPERMARKET COL 03',
            amount: 4820.5,
            direction: 'debit',
            directionSource: 'balance',
            ...(row || {}),
        },
        routed: { module: 'expenses', confidence: 0.4, needsReview: true, ...(routed || {}) },
    };
};

/** A fetch that answers with whatever a test wants, and records the call. */
const spyFetch = (body, { ok = true, throws = false } = {}) => {
    const calls = [];
    const f = async (url, opts) => {
        calls.push({ url: String(url), opts });
        if (throws) throw new Error('network');
        return { ok, json: async () => body };
    };
    f.calls = calls;
    return f;
};
const ANSWER = { ok: true, category: 'Food & Groceries', description: 'A supermarket chain', provider: 'brave', confidence: 0.88 };

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT LEAVES THE DEVICE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('only a shop name and a country ever leave', () => {
    it('sends exactly the two permitted keys and nothing else', () => {
        expect(Object.keys(payloadFor('SPAR', 'Sri Lanka')).sort()).toEqual([...SAFE_KEYS].sort());
    });

    it('does not put a single figure from the statement on the wire', async () => {
        /* THE TEST THIS FILE EXISTS FOR.
         *
         * Every one of these strings is real data from the row being looked up.
         * The assertion is not on the payload's shape — it reads the URL, the
         * headers and the body as text and fails if any of them is in there,
         * which is the only version of this check that survives someone adding
         * a field to "help the search be more accurate". */
        const secrets = {
            amount: '4820.5', balance: '1284933.11', date: '2026-02-11',
            account: '004010123456', cardTail: '7788', maskedCard: '412345XXXXXX7788',
            bank: 'HNB', reference: '887302911',
        };
        const q = held({
            row: {
                desc: `POS ${secrets.maskedCard} SPAR SUPERMARKET COL 03 REF ${secrets.reference}`,
                amount: Number(secrets.amount),
                balance: Number(secrets.balance),
                date: secrets.date,
                accountNo: secrets.account,
                card_last4: secrets.cardTail,
                direction: 'debit', directionSource: 'balance',
            },
        });
        const f = spyFetch(ANSWER);
        await enrich([q], { fetch: f });

        expect(f.calls).toHaveLength(1);
        const wire = f.calls[0].url + '\n' + JSON.stringify(f.calls[0].opts);
        for (const [what, value] of Object.entries(secrets)) {
            expect(wire, `${what} (${value}) went on the wire`).not.toContain(value);
        }
        expect(JSON.parse(f.calls[0].opts.body)).toEqual({ merchant: 'SPAR SUPERMARKET COL 03', country: 'Sri Lanka' });
    });

    it('posts to the endpoint that already exists, not a new one', () => {
        // /api/merchant-search is registered in the router and already carries a
        // timeout and a provider chain. A second endpoint would need both again.
        expect(ENDPOINT).toBe('/api/merchant-search');
    });

    it('defaults the country rather than sending an empty one', () => {
        expect(payloadFor('SPAR').country).toBe('Sri Lanka');
        expect(payloadFor('SPAR', '  ').country).toBe('Sri Lanka');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SCRUBBING THE DESCRIPTOR
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the name pulled out of a statement line', () => {
    it.each([
        ['POS 412345XXXXXX7788 SPAR SUPERMARKET COL 03', 'SPAR SUPERMARKET COL 03'],
        ['ATM WITHDRAWAL 004010123456', 'WITHDRAWAL'],
        ['CARD PURCHASE KEELLS SUPER', 'KEELLS SUPER'],
        ['TXN REF 887302911 UBER TRIP', 'UBER TRIP'],
        ['visa debit dialog axiata plc', 'DIALOG AXIATA PLC'],
    ])('reads %s as %s', (raw, expected) => {
        expect(vendorKey(raw)).toBe(expected);
    });

    it('keeps digits that are part of a business name', () => {
        /* The scrub drops identifiers, not numerals. A rule that deleted every
         * digit would turn a real shop into a different real shop. */
        expect(vendorKey('POS 7 ELEVEN COLOMBO')).toBe('7 ELEVEN COLOMBO');
        expect(vendorKey('CAFE 24 KANDY')).toBe('CAFE 24 KANDY');
    });

    it.each([
        ['a masked card number', '412345XXXXXX7788'],
        ['a bare reference', 'REF 887302911'],
        ['a date', '20260211'],
        ['an account number', '004010123456'],
        ['nothing at all', '   '],
        ['punctuation only', '--- /// ---'],
        ['two letters', 'AB 998877'],
    ])('refuses to look up %s', (_why, raw) => {
        expect(vendorKey(raw), 'this would have been a request carrying an identifier')
            .toBe(null);
    });

    it('drops a masked fragment even when it is too short to be a number', () => {
        /* Every masked-card fixture above happens to carry four or more digits,
         * so the digit rule catches them and the masking rule is never reached —
         * removing it broke nothing on the first mutation run. Some issuers
         * print a three-digit masked tail, which only the masking rule stops. */
        expect(vendorKey('POS **123 SPAR SUPERMARKET')).toBe('SPAR SUPERMARKET');
        expect(vendorKey('CARD X45 KEELLS SUPER')).toBe('KEELLS SUPER');
    });

    it('drops a short identifier sitting right next to a real name', () => {
        /* The card's last four is exactly four digits, and it is the identifier
         * the account registry matches accounts on. A descriptor like
         * `POS SPAR 4471` must not carry it to a search engine next to the shop
         * that would place where it was used. Six-digit references likewise. */
        expect(vendorKey('POS SPAR 4471')).toBe('SPAR');
        expect(vendorKey('KEELLS SUPER 887302')).toBe('KEELLS SUPER');
    });

    it('caps the length, so a pathological descriptor cannot become the query', () => {
        expect(vendorKey('SUPERMARKET '.repeat(40)).length).toBeLessThanOrEqual(64);
    });

    it('never throws, whatever the row contains', () => {
        for (const bad of [null, undefined, 0, {}, [], NaN]) {
            expect(() => vendorKey(bad)).not.toThrow();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS NOT WORTH ASKING ABOUT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('which rows are looked up at all', () => {
    it('takes a row held up only by its category', () => {
        expect(eligible(held())).toMatchObject({ ok: true, key: 'SPAR SUPERMARKET COL 03' });
    });

    it.each([
        QUARANTINE.ROUTING_CONFLICT,
        QUARANTINE.DIRECTION_UNRESOLVED,
        QUARANTINE.PASSWORD_FAILED,
        QUARANTINE.UNPARSEABLE,
    ])('leaves a row quarantined for %s alone', (reason) => {
        /* None of these is a naming problem. A merchant name cannot resolve a
         * contradiction between the bank's arithmetic and its own description,
         * and pretending it can is how the contradiction gets buried. */
        const r = eligible(held({ reason }));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(OSINT.NOT_ELIGIBLE);
    });

    it('refuses a row whose direction the bank did not prove', () => {
        /* The row cannot be filed whatever comes back, so the request would
         * spend a vendor name for nothing. The deeper reason is in the module:
         * an answer sitting beside an unresolved direction is an invitation to
         * use it as one. */
        for (const src of ['wording', 'assumed', '', undefined]) {
            const r = eligible(held({ row: { directionSource: src } }));
            expect(r.ok, `looked up a row whose direction came from "${src}"`).toBe(false);
            expect(r.reason).toBe(OSINT.NOT_ELIGIBLE);
        }
    });

    it('accepts every direction source the bank actually proves', () => {
        for (const src of PROVEN_SOURCES) {
            expect(eligible(held({ row: { directionSource: src } })).ok, src).toBe(true);
        }
    });

    it('refuses a row with no direction even when the source looks proven', () => {
        const r = eligible(held({ row: { direction: '', directionSource: 'balance' } }));
        expect(r.ok).toBe(false);
    });

    it('refuses a row with no name in it', () => {
        const r = eligible(held({ row: { desc: 'ATM 004010123456' } }));
        expect(r.reason).toBe(OSINT.NO_VENDOR);
    });

    it('never throws on a malformed record', () => {
        for (const bad of [null, undefined, {}, { row: null }]) {
            expect(() => eligible(bad)).not.toThrow();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ANSWER
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('reading the reply', () => {
    it('turns a good answer into a finding', async () => {
        const f = await ask('SPAR', { fetch: spyFetch(ANSWER) });
        expect(f).toMatchObject({ category: 'Food & Groceries', module: 'expenses', provider: 'brave' });
    });

    it.each([
        ['an HTTP failure', ANSWER, { ok: false }],
        ['the endpoint saying it could not', { ok: false, reason: 'no provider configured' }, {}],
        ['an answer with no category', { ok: true }, {}],
        ['a body that is not an object', null, {}],
        ['a network error', ANSWER, { throws: true }],
    ])('returns null for %s', async (_why, body, opts) => {
        expect(await ask('SPAR', { fetch: spyFetch(body, opts) })).toBe(null);
    });

    it('ignores a category attached to a reply that declared itself a failure', async () => {
        /* The ok flag is the endpoint's own verdict. A body that says it failed
         * and still carries a category is a partial or stale error payload, and
         * reading the category out of it is the helpful move that turns a failed
         * lookup into a filed transaction. The first mutation run showed the
         * other tests here reach null by a different route and would not have
         * noticed this check disappearing. */
        expect(await ask('SPAR', { fetch: spyFetch({ ok: false, category: 'Dining', provider: 'brave' }) }))
            .toBe(null);
    });

    it('returns null when there is no fetch to use, rather than throwing', async () => {
        expect(await ask('SPAR', {})).toBe(null);
        expect(await ask('SPAR')).toBe(null);
    });

    it('does not make a request for an empty key', async () => {
        const f = spyFetch(ANSWER);
        expect(await ask('', { fetch: f })).toBe(null);
        expect(f.calls).toHaveLength(0);
    });

    it('caps what the endpoint is allowed to claim', async () => {
        const f = await ask('SPAR', { fetch: spyFetch({ ...ANSWER, confidence: 0.999 }) });
        expect(f.confidence, 'one search result cannot settle a row').toBeLessThanOrEqual(MAX_LIFT);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FIREWALL
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a search engine may name a merchant and may never decide a direction', () => {
    it('refuses a purchase category on money that came IN', () => {
        /* THE REFUND. A restaurant refund is a credit, and "Dining" is an
         * expense category, and both are correct. The bank's reading is the one
         * backed by a balance that moved. */
        const r = applyFinding(
            { module: 'expenses', confidence: 0.4 },
            { category: 'Dining', module: 'expenses', confidence: 0.88, provider: 'brave' },
            { direction: 'credit', directionSource: 'balance' },
        );
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(OSINT.CONTRADICTS_BANK);
        expect(r.detail).toMatchObject({ bankSays: 'credit', webSays: 'debit', category: 'Dining' });
    });

    it('drops the whole finding on a contradiction, not just its direction', () => {
        // A category that only makes sense in the other direction is not a
        // partial win to be kept for the review card.
        const r = applyFinding({ module: 'income' }, { category: 'Dining', module: 'expenses', confidence: 0.9 },
            { direction: 'credit', directionSource: 'balance' });
        expect(r.routed).toBeUndefined();
    });

    it('never carries a direction field into what it returns', () => {
        /* Even in the accepting case. The upgraded routing is built from the
         * ROUTING, never from the row, so there is no field for a direction to
         * be copied into — this test fails the moment someone spreads the row
         * in "to keep the context together". */
        const r = applyFinding({ module: 'expenses', confidence: 0.4 },
            { category: 'Dining', module: 'expenses', confidence: 0.88, provider: 'x' },
            { direction: 'debit', directionSource: 'balance' });
        expect(r.ok).toBe(true);
        expect(r.routed).not.toHaveProperty('direction');
        expect(r.routed).not.toHaveProperty('directionSource');
    });

    it('leaves the row object itself untouched', () => {
        const row = { direction: 'debit', directionSource: 'balance', amount: 100 };
        const before = JSON.stringify(row);
        applyFinding({ module: 'expenses' }, { category: 'Dining', module: 'expenses', confidence: 0.9 }, row);
        expect(JSON.stringify(row)).toBe(before);
    });

    it('accepts a category that agrees with the bank', () => {
        const r = applyFinding({ module: 'expenses', confidence: 0.4, needsReview: true },
            { category: 'Subscriptions', module: 'subscriptions', confidence: 0.88, provider: 'tavily' },
            { direction: 'debit', directionSource: 'balance' });
        expect(r.ok).toBe(true);
        expect(r.routed).toMatchObject({
            module: 'subscriptions', category: 'Subscriptions', needsReview: false, vendorSource: 'web:tavily',
        });
    });

    it('lets a finding refine which module, when the direction still agrees', () => {
        // expenses -> subscriptions is a real upgrade: both are money out, and
        // one of them is a recurring charge the app can then track.
        const r = applyFinding({ module: 'expenses' },
            { category: 'Subscriptions', module: 'subscriptions', confidence: 0.85 },
            { direction: 'debit', directionSource: 'balance' });
        expect(r.routed.module).toBe('subscriptions');
        expect(MODULE_DIRECTION[r.routed.module]).toBe('debit');
    });

    it('never lowers a confidence the router had already earned', () => {
        const r = applyFinding({ module: 'expenses', confidence: 0.74 },
            { category: 'Dining', module: 'expenses', confidence: 0.5 },
            { direction: 'debit', directionSource: 'balance' });
        expect(r.routed.confidence).toBe(0.74);
    });

    it('never lifts a row to certainty', () => {
        const r = applyFinding({ module: 'expenses', confidence: 0.4 },
            { category: 'Dining', module: 'expenses', confidence: 1 },
            { direction: 'debit', directionSource: 'balance' });
        expect(r.routed.confidence).toBeLessThanOrEqual(MAX_LIFT);
        expect(r.routed.confidence).toBeLessThan(1);
    });

    it('refuses a category it has never heard of', () => {
        /* An upstream provider adding a category must not become a misfiled
         * transaction. There is no default module here on purpose. */
        const r = applyFinding({ module: 'expenses' }, { category: 'Crypto Mining', module: null },
            { direction: 'debit', directionSource: 'balance' });
        expect(r.reason).toBe(OSINT.UNKNOWN_CATEGORY);
    });

    it('treats "Other" as the endpoint saying it does not know', () => {
        expect(moduleForCategory('Other')).toBe(null);
        expect(CATEGORY_MODULE).not.toHaveProperty('Other');
    });

    it('files every category it does claim to know into a real module', () => {
        for (const [category, mod] of Object.entries(CATEGORY_MODULE)) {
            expect(MODULE_DIRECTION[mod], `${category} -> ${mod} is not a module the cross-check knows`)
                .toBeDefined();
        }
    });

    it('reads the direction table the cross-check uses, not a copy of it', () => {
        /* Two copies of this table in two files is the drift that has already
         * bitten this repo once, in two workflows' sensitive-path lists. The
         * assertion is on object identity, so a local redefinition fails here
         * rather than three months later on one row. */
        expect(O.MODULE_DIRECTION === undefined || O.MODULE_DIRECTION === MODULE_DIRECTION).toBe(true);
        expect(MODULE_DIRECTION.income).toBe('credit');
        expect(MODULE_DIRECTION.expenses).toBe('debit');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BATCH
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('looking up a statement full of rows', () => {
    it('asks once for forty rows from the same shop', async () => {
        const rows = Array.from({ length: 40 }, () => held());
        const f = spyFetch(ANSWER);
        const r = await enrich(rows, { fetch: f });
        expect(f.calls, 'forty requests for one supermarket').toHaveLength(1);
        expect(r.lookups).toBe(1);
        expect(r.upgraded).toHaveLength(40);
    });

    it('asks once per distinct shop', async () => {
        const f = spyFetch(ANSWER);
        await enrich([
            held(), held({ row: { desc: 'POS KEELLS SUPER' } }), held(),
        ], { fetch: f });
        expect(f.calls).toHaveLength(2);
    });

    it('remembers a failure too, rather than retrying it per row', async () => {
        const f = spyFetch(ANSWER, { ok: false });
        const r = await enrich([held(), held(), held()], { fetch: f });
        expect(f.calls).toHaveLength(1);
        expect(r.upgraded).toHaveLength(0);
        expect(r.remaining).toHaveLength(3);
        expect(r.remaining[0].osint.reason).toBe(OSINT.NO_ANSWER);
    });

    it('does nothing at all when there is no way to ask', async () => {
        const rows = [held(), held()];
        const r = await enrich(rows, {});
        expect(r.lookups).toBe(0);
        expect(r.reason).toBe(OSINT.UNAVAILABLE);
        expect(r.remaining).toEqual(rows);
        expect(r.remaining[0], 'a row nothing was attempted on must not be marked as failed')
            .not.toHaveProperty('osint');
    });

    it('keeps a contradicted row quarantined, with the reason on it', async () => {
        const q = held({ row: { direction: 'credit', directionSource: 'balance' } });
        const r = await enrich([q], { fetch: spyFetch({ ...ANSWER, category: 'Dining' }) });
        expect(r.upgraded).toHaveLength(0);
        expect(r.remaining[0].osint.reason).toBe(OSINT.CONTRADICTS_BANK);
        expect(r.remaining[0].routed, 'the contradicted finding was applied anyway')
            .toMatchObject({ module: 'expenses', confidence: 0.4 });
    });

    it('passes ineligible rows straight through, untouched and un-asked', async () => {
        const f = spyFetch(ANSWER);
        const q = held({ reason: QUARANTINE.ROUTING_CONFLICT });
        const r = await enrich([q], { fetch: f });
        expect(f.calls).toHaveLength(0);
        expect(r.remaining[0]).toEqual(q);
    });

    it('handles a mixed statement without losing a row', async () => {
        const rows = [
            held(),                                                        // upgraded
            held({ reason: QUARANTINE.ROUTING_CONFLICT }),                 // not eligible
            held({ row: { desc: 'ATM 004010123456' } }),                   // no name
            held({ row: { direction: 'credit', directionSource: 'balance' } }), // contradicted
        ];
        const r = await enrich(rows, { fetch: spyFetch(ANSWER) });
        expect(r.upgraded.length + r.remaining.length, 'a row went missing').toBe(rows.length);
        expect(r.upgraded).toHaveLength(1);
    });

    it('returns empty lists for an empty statement, not a crash', async () => {
        for (const bad of [[], null, undefined]) {
            const r = await enrich(bad, { fetch: spyFetch(ANSWER) });
            expect(r.upgraded).toEqual([]);
            expect(r.remaining).toEqual([]);
        }
    });

    it('marks what it upgraded, so the ledger can show where a category came from', async () => {
        const r = await enrich([held()], { fetch: spyFetch(ANSWER) });
        expect(r.upgraded[0].osint).toMatchObject({ reason: OSINT.APPLIED, vendor: 'SPAR SUPERMARKET COL 03' });
        expect(r.upgraded[0].routed.vendorSource).toBe('web:brave');
    });
});
