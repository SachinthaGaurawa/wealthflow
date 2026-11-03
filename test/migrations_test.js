/* Data migrations that cannot lose the books: every way one can go wrong is measured and put back.
 *
 * The runner is run against a fake DB with the same get/set shape as the app's. Nothing here trusts a migration: the tests write
 * deliberately bad ones (drops a record, changes an amount, is not idempotent, throws, cannot be undone) and check that the books
 * end up byte-for-byte what they were.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOOKS = () => ({
    transactions: [{ id: 't1', amount: 1500.5, memo: 'Rent | May' }, { id: 't2', amount: -200, memo: 'Coffee | Cafe' }, { id: 't3', amount: 99.99, memo: 'plain' }],
    debtors: [{ id: 'd1', amount: 5000, name: 'A' }],
});

/** A DB with the app's get/set shape. `failOn` makes the nth set (1-based) of a given key throw, to test mid-write failures. */
function fakeDB(books = BOOKS(), { failSet = () => false } = {}) {
    const data = JSON.parse(JSON.stringify(books));
    const writes = [];
    const db = {
        get: (k, def) => (data[k] !== undefined ? data[k] : def),
        set: (k, v) => { writes.push(k); if (failSet(k, writes.length)) throw new Error('disk full on ' + k); data[k] = JSON.parse(JSON.stringify(v)); },
    };
    return { db, data, writes };
}
const boot = (db, extra = {}, seed = {}) => loadBrowserModule('wealthflow-migrations.js', { html: '', localStorage: seed, globals: { DB: db, WF_APP_VERSION: '7.70.0', ...extra } });
const ledgerOf = (localStorage) => JSON.parse(localStorage.getItem('wf_migrations') || '{}');
const snapOf = (localStorage) => JSON.parse(localStorage.getItem('wf_migration_snapshot') || 'null');

/** A well-behaved migration: splits "Rent | May" into {memo:'Rent', note:'May'}. Idempotent, reversible, money untouched. */
const splitMemo = (over = {}) => ({
    id: '2026-11-05-split-memo',
    touches: ['transactions'],
    up(d) { d.transactions = d.transactions.map((r) => { if (typeof r.memo !== 'string' || r.memo.indexOf(' | ') < 0) return r; const [a, ...b] = r.memo.split(' | '); const o = { ...r, memo: a, note: b.join(' | ') }; return o; }); return d; },
    down(d) { d.transactions = d.transactions.map((r) => { if (r.note === undefined) return r; const { note, ...rest } = r; return { ...rest, memo: r.memo + ' | ' + note }; }); return d; },
    fixture: { transactions: [{ id: 'x', amount: 10, memo: 'A | B' }, { id: 'y', amount: -4, memo: 'no split' }] },
    ...over,
});

describe('checkMigration: what must hold before a migration may ship', () => {
    const { window } = boot(fakeDB().db);
    const check = (m) => window.WFMigrations.checkMigration(m);
    it('a good migration has no problems', () => expect(check(splitMemo())).toEqual([]));
    it.each([
        ['no down', { down: undefined }, /down is missing: a migration that cannot go back does not ship/],
        ['no fixture', { fixture: undefined }, /fixture is missing/],
        ['a fixture without the key it touches', { fixture: { other: [] } }, /fixture has no transactions/],
        ['a bad id', { id: 'Split Memo' }, /id must look like/],
        ['no keys', { touches: [] }, /touches must list the keys/],
        ['a key twice', { touches: ['transactions', 'transactions'] }, /twice/],
    ])('refuses %s', (_n, patch, re) => expect(check(splitMemo(patch)).join('|')).toMatch(re));
    it('refuses one that drops a record', () => expect(check(splitMemo({ up: (d) => { d.transactions.pop(); return d; } })).join('|')).toMatch(/1 records? became|2 records became 1/));
    it('refuses one that changes an amount', () => expect(check(splitMemo({ up: (d) => { d.transactions[0].amount += 1; return d; } })).join('|')).toMatch(/the money changed/));
    it('refuses one that is not idempotent', () => expect(check(splitMemo({ up: (d) => { d.transactions = d.transactions.map((r) => ({ ...r, memo: r.memo + '!' })); return d; }, down: (d) => d })).join('|')).toMatch(/not idempotent/));
    it('refuses one whose down does not give the fixture back', () => expect(check(splitMemo({ down: (d) => d })).join('|')).toMatch(/down does not give the fixture back exactly/));
    it('refuses one that throws', () => expect(check(splitMemo({ up: () => { throw new Error('boom'); } })).join('|')).toMatch(/threw on the fixture: boom/));
    it('refuses one that returns other keys than it declared', () => expect(check(splitMemo({ up: (d) => ({ ...d, extra: [] }) })).join('|')).toMatch(/other keys than the ones declared/));
    it('allows a count change only when the migration says so', () => {
        const dropOne = { up: (d) => { d.transactions = d.transactions.slice(0, 1); return d; }, down: (d) => d, fixture: { transactions: [{ id: 'a', amount: 1 }] } };
        expect(check(splitMemo({ ...dropOne, countMayChange: true, moneyMayChange: true })).join('|')).not.toMatch(/records? became/);
    });
});

describe('run: nothing registered means nothing happens', () => {
    it('does not read, write, back up or leave a trace', async () => {
        const f = fakeDB(); let backups = 0;
        const { window, localStorage } = boot(f.db, { backupNow: async () => { backups++; return true; } });
        expect(await window.WFMigrations.run()).toEqual([]);
        expect(f.writes).toEqual([]); expect(backups).toBe(0); expect(localStorage.store.size).toBe(0);
    });
    it('does nothing in decoy mode, even with a migration waiting', async () => {
        const f = fakeDB(); const { window } = boot(f.db, { _isDecoyMode: true });
        window.WFMigrations.register(splitMemo());
        expect(await window.WFMigrations.run()).toEqual([]); expect(f.writes).toEqual([]);
    });
});

describe('run: a good migration', () => {
    it('is applied through DB.set, recorded, with a restore point kept and the cloud backup result stated as it came out', async () => {
        const f = fakeDB(); const calls = [];
        const { window, localStorage } = boot(f.db, { backupNow: async (s, t) => { calls.push([s, t]); return true; } });
        window.WFMigrations.register(splitMemo());
        const [r] = await window.WFMigrations.run();
        expect(r).toMatchObject({ id: '2026-11-05-split-memo', result: 'applied', cloudBackup: 'saved' });
        expect(calls).toEqual([[true, 'pre-migration']]);
        expect(f.data.transactions[0]).toMatchObject({ memo: 'Rent', note: 'May', amount: 1500.5 });
        expect(f.data.debtors).toEqual(BOOKS().debtors);               // a key it does not touch is not written
        expect(f.writes).toEqual(['transactions']);
        expect(ledgerOf(localStorage).applied['2026-11-05-split-memo']).toMatchObject({ build: '7.70.0', cloudBackup: 'saved' });
        expect(snapOf(localStorage)).toMatchObject({ status: 'applied', before: { transactions: BOOKS().transactions } });
    });
    it('records "not-saved" when there is no cloud backup, and still applies (the local restore point is the one that matters)', async () => {
        const f = fakeDB(); const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        expect((await window.WFMigrations.run())[0]).toMatchObject({ result: 'applied', cloudBackup: 'not-saved' });
        expect(ledgerOf(localStorage).applied['2026-11-05-split-memo'].cloudBackup).toBe('not-saved');
    });
    it('is not applied twice', async () => {
        const f = fakeDB(); const { window } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        await window.WFMigrations.run(); f.writes.length = 0;
        expect(await window.WFMigrations.run()).toEqual([]); expect(f.writes).toEqual([]);
    });
    it('waits for data instead of calling an empty book migrated', async () => {
        const f = fakeDB({ debtors: [] }); const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        expect((await window.WFMigrations.run())[0]).toMatchObject({ result: 'waiting-for-data' });
        expect(ledgerOf(localStorage).applied).toBeUndefined();
    });
    it('an undo is a decision: the next launch does not quietly apply it again', async () => {
        const f = fakeDB(); const { window } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        await window.WFMigrations.run();
        await window.WFMigrations.undo('2026-11-05-split-memo');
        f.writes.length = 0;
        expect(await window.WFMigrations.run()).toEqual([]);
        expect(f.writes).toEqual([]); expect(f.data.transactions).toEqual(BOOKS().transactions);
    });
    it('can be undone by its own down, with the same proof', async () => {
        const f = fakeDB(); const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        await window.WFMigrations.run();
        expect(await window.WFMigrations.undo('2026-11-05-split-memo')).toMatchObject({ result: 'undone' });
        expect(f.data.transactions).toEqual(BOOKS().transactions);
        expect(ledgerOf(localStorage).applied['2026-11-05-split-memo']).toBeUndefined();
    });
});

describe('run: a bad migration never changes the books', () => {
    /* A bad one cannot even be registered (checkMigration refuses it on its fixture), so the runner's own proof on REAL data is
     * tested by giving it a migration that behaves on its fixture and misbehaves on the owner's books. */
    const goodOnFixtureBadOnReal = (badUp) => splitMemo({ up(d) { return d.transactions.length === 2 ? splitMemo().up(d) : badUp(d); } });

    it.each([
        ['drops a record', (d) => { d.transactions.pop(); return d; }, /3 records became 2/],
        ['changes an amount', (d) => { d.transactions[0].amount = 1; return d; }, /the money changed/],
        ['returns nothing', () => null, /up returned nothing/],
        ['throws', () => { throw new Error('boom'); }, /boom/],
        ['is not idempotent on this data', (d) => { d.transactions = d.transactions.map((r) => ({ ...r, memo: r.memo + '!' })); return d; }, /not idempotent on this data/],
    ])('refuses one that %s: nothing is written', async (_n, badUp, re) => {
        const f = fakeDB(); const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(goodOnFixtureBadOnReal(badUp));
        const [r] = await window.WFMigrations.run();
        expect(r.result).toBe('refused'); expect(r.why).toMatch(re);
        expect(f.writes).toEqual([]);
        expect(f.data).toEqual(BOOKS());
        expect(ledgerOf(localStorage).failed['2026-11-05-split-memo'].why).toMatch(re);
        expect(ledgerOf(localStorage).applied).toEqual({});
    });

    it("refuses one that its own check refuses", async () => {
        const f = fakeDB(); const { window } = boot(f.db);
        window.WFMigrations.register(splitMemo({ check: (b) => b.transactions.length === 2 }));
        expect((await window.WFMigrations.run())[0]).toMatchObject({ result: 'refused', why: expect.stringMatching(/its own check refused the result/) });
        expect(f.data).toEqual(BOOKS());
    });
});

describe('run: a failure in the middle puts everything back', () => {
    const twoKeys = () => splitMemo({
        touches: ['transactions', 'debtors'],
        up(d) { d.transactions = d.transactions.map((r) => ({ ...r, tag: 'x' })); d.debtors = d.debtors.map((r) => ({ ...r, tag: 'x' })); return d; },
        down(d) { d.transactions = d.transactions.map(({ tag, ...r }) => r); d.debtors = d.debtors.map(({ tag, ...r }) => r); return d; },
        fixture: { transactions: [{ id: 'a', amount: 1 }], debtors: [{ id: 'b', amount: 2 }] },
    });
    it('the second write throws: the first key is restored, read back, and the books are exactly what they were', async () => {
        const f = fakeDB(BOOKS(), { failSet: (k, n) => k === 'debtors' && n === 2 });   // write 1 = transactions (forward), write 2 = debtors (forward) fails
        const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(twoKeys());
        const [r] = await window.WFMigrations.run();
        expect(r.result).toBe('reverted'); expect(r.why).toMatch(/a write failed: disk full on debtors/);
        expect(f.data).toEqual(BOOKS());
        expect(snapOf(localStorage).status).toBe('reverted');
        expect(ledgerOf(localStorage).failed['2026-11-05-split-memo'].why).toMatch(/disk full/);
        expect(ledgerOf(localStorage).applied).toEqual({});
    });
    it('the revert itself fails: it says so loudly, keeps the restore point, and does not claim the books are safe', async () => {
        let armed = false;
        const f = fakeDB(BOOKS(), { failSet: (k) => armed && k === 'transactions' });
        const { window, localStorage } = boot(f.db);
        // fail the SECOND key forward, and any later write to transactions (the revert)
        const realSet = f.db.set; let n = 0;
        f.db.set = (k, v) => { n++; if (n === 2) { armed = true; throw new Error('disk full on ' + k); } return realSet(k, v); };
        window.WFMigrations.register(twoKeys());
        const [r] = await window.WFMigrations.run();
        expect(r.result).toBe('revert-failed');
        expect(snapOf(localStorage)).toMatchObject({ status: 'revert-failed', before: BOOKS() });
        expect(ledgerOf(localStorage).failed['2026-11-05-split-memo'].why).toMatch(/REVERT INCOMPLETE/);
    });
    it('the page closed after the first write: the next launch puts the restore point back before anything else', async () => {
        const f = fakeDB(); const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        // what a half-done run leaves behind: new shape in one key, restore point still "in-progress"
        f.data.transactions = f.data.transactions.map((r) => ({ ...r, memo: 'HALF' }));
        localStorage.setItem('wf_migration_snapshot', JSON.stringify({ id: '2026-11-05-split-memo', at: 1, status: 'in-progress', before: BOOKS() }));
        const results = await window.WFMigrations.run();
        expect(results[0]).toMatchObject({ id: '2026-11-05-split-memo', result: 'reverted-after-interruption' });
        expect(f.data.transactions).toEqual(BOOKS().transactions);
        expect(snapOf(localStorage)).toMatchObject({ status: 'reverted', note: 'interrupted' });
        expect(results.length).toBe(2);
        expect(results[1]).toMatchObject({ result: 'not-retried' });   // it failed on this build: no loop
    });
});

describe('run: no loops, no silent skipping, and no room is not a reason to risk it', () => {
    it('a migration that failed is not retried on the same build, and is tried once more on a new one', async () => {
        const f = fakeDB();
        const bad = () => splitMemo({ up(d) { return d.transactions.length === 2 ? splitMemo().up(d) : null; } });
        const a = boot(f.db); a.window.WFMigrations.register(bad());
        expect((await a.window.WFMigrations.run())[0].result).toBe('refused');
        expect((await a.window.WFMigrations.run())[0].result).toBe('not-retried');
        const b = boot(f.db, { WF_APP_VERSION: '7.70.1' }, Object.fromEntries(a.localStorage.store));
        b.window.WFMigrations.register(bad());
        expect((await b.window.WFMigrations.run())[0].result).toBe('refused');       // tried again on the new build
    });
    it('stops at the first migration that does not go through; later ones may rely on it', async () => {
        const f = fakeDB(); const { window } = boot(f.db);
        window.WFMigrations.register(splitMemo({ up(d) { return d.transactions.length === 2 ? splitMemo().up(d) : null; } }));
        window.WFMigrations.register(splitMemo({ id: '2026-11-06-second', touches: ['debtors'], up: (d) => d, down: (d) => d, fixture: { debtors: [{ id: 'z', amount: 1 }] } }));
        const rs = await window.WFMigrations.run();
        expect(rs.map((r) => r.id)).toEqual(['2026-11-05-split-memo']);
    });
    it('too large to keep a restore point: it is not run', async () => {
        const big = { transactions: Array.from({ length: 9000 }, (_, i) => ({ id: 'r' + i, amount: i, memo: 'A | ' + 'x'.repeat(200) })) };
        const f = fakeDB(big); const { window } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        expect((await window.WFMigrations.run())[0]).toMatchObject({ result: 'skipped', why: 'too-large' });
        expect(f.writes).toEqual([]);
    });
    it('no room to write the restore point: it is not run', async () => {
        const f = fakeDB(); const { window, localStorage } = boot(f.db);
        window.WFMigrations.register(splitMemo());
        localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
        expect((await window.WFMigrations.run())[0]).toMatchObject({ result: 'skipped', why: 'no-restore-point' });
        expect(f.writes).toEqual([]); expect(f.data).toEqual(BOOKS());
    });
    it('a cloud backup that hangs does not hold the books hostage', async () => {
        const f = fakeDB(); const { window } = boot(f.db, { backupNow: () => new Promise(() => {}) });
        window.WFMigrations.register(splitMemo());
        const t0 = Date.now();
        const r = (await window.WFMigrations.run())[0];
        expect(r).toMatchObject({ result: 'applied', cloudBackup: 'not-saved' });
        expect(Date.now() - t0).toBeLessThan(12000);
    }, 15000);
});

describe('the registry shipped in the app', () => {
    const { window } = loadBrowserModule('wealthflow-migrations.js', { html: '', globals: { DB: fakeDB().db } });
    const list = window.WFMigrations.list();
    it('every migration in it passes the same checks, ids are unique and in order', () => {
        for (const m of list) expect(window.WFMigrations.checkMigration(m), m.id).toEqual([]);
        const ids = list.map((m) => m.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect([...ids].sort()).toEqual(ids);
    });
    it('is loaded by the app, and run after the older one-off migrations', () => {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        expect(html).toMatch(/<script src="wealthflow-migrations\.js" defer><\/script>/);
        expect(html.indexOf('_migrateCCOTPaidFix(); } catch')).toBeLessThan(html.indexOf('WFMigrations.run('));
    });
    it('uses no regex lookbehind (older Safari cannot parse it)', () => {
        expect(fs.readFileSync(path.join(ROOT, 'wealthflow-migrations.js'), 'utf8')).not.toMatch(/\(\?<[=!]/);
    });
});
