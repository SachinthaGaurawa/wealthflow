/* The data-migration runner on the REAL app: the real DB (record stamps, tombstones, sync hooks, redraw) under it, in a real browser.
 *
 * The unit tests prove the runner against a fake DB. What a fake cannot show is whether the measurements still hold when DB.set
 * stamps every record, so this seeds real books, registers migrations, and checks that a good one is kept, a bad one never touches
 * the books, a write that fails half way is put back, and an applied one can be undone.
 *
 * Run: node test/e2e/migrations.mjs     (set WF_CHROME to a Chromium binary if Playwright's own is not installed)
 */
import { bootDevices } from './devices.mjs';

const results = [];
const note = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : '')); };

const w = await bootDevices(['d']);
const dev = w.devices.d;
const page = dev.page;

try {
    note('the runner is loaded by the app and the registry shipped in it is empty', await page.evaluate(() => !!window.WFMigrations && window.WFMigrations.list().length === 0));

    // real books, written the way the app writes them
    const seed = await page.evaluate(() => {
        const rows = [{ id: 'e1', amount: 1500.5, memo: 'Rent | May' }, { id: 'e2', amount: 200, memo: 'Coffee | Cafe' }, { id: 'e3', amount: 99.99, memo: 'plain' }];
        DB.set('expenses', rows, true);
        DB.set('debtors', [{ id: 'd1', amount: 5000, name: 'A' }], true);
        localStorage.removeItem('wf_migrations'); localStorage.removeItem('wf_migration_snapshot');
        return rows;
    });
    const books = () => page.evaluate(() => ({ expenses: DB.get('expenses', []).map((r) => ({ id: r.id, amount: r.amount, memo: r.memo, note: r.note })), debtors: DB.get('debtors', []).map((r) => ({ id: r.id, amount: r.amount })) }));
    const original = await books();

    // 0. nothing registered: nothing happens
    const idle = await page.evaluate(async () => ({ r: await WFMigrations.run(), snap: localStorage.getItem('wf_migration_snapshot'), ledger: localStorage.getItem('wf_migrations') }));
    note('0. with nothing registered, run() does nothing (no result, no restore point, no ledger)', idle.r.length === 0 && idle.snap === null && idle.ledger === null, JSON.stringify(idle));

    // the migration under test is defined inside the page (functions cannot cross the wire)
    await page.evaluate(() => {
        window.__mkSplit = () => ({
            id: '2026-11-05-split-memo', touches: ['expenses'],
            up(d) { d.expenses = d.expenses.map((r) => { if (typeof r.memo !== 'string' || r.memo.indexOf(' | ') < 0) return r; const p = r.memo.split(' | '); return Object.assign({}, r, { memo: p[0], note: p.slice(1).join(' | ') }); }); return d; },
            down(d) { d.expenses = d.expenses.map((r) => { if (r.note === undefined) return r; const o = Object.assign({}, r); const n = o.note; delete o.note; o.memo = o.memo + ' | ' + n; return o; }); return d; },
            fixture: { expenses: [{ id: 'x', amount: 10, memo: 'A | B' }, { id: 'y', amount: 4, memo: 'no split' }] },
        });
    });

    // 1. a good migration is applied through the real DB
    await page.evaluate(() => window.WFMigrations.register(window.__mkSplit()));
    const r1 = await page.evaluate(() => WFMigrations.run());
    const after1 = await books();
    note('1. a good migration is applied', r1.length === 1 && r1[0].result === 'applied', JSON.stringify(r1));
    note('1. the records are in the new shape, none lost, and the money is exactly the same', after1.expenses.length === 3 && after1.expenses[0].memo === 'Rent' && after1.expenses[0].note === 'May' && after1.expenses.reduce((s, r) => s + r.amount, 0) === original.expenses.reduce((s, r) => s + r.amount, 0), JSON.stringify(after1.expenses[0]));
    note('1. a key it does not touch is exactly as it was', JSON.stringify(after1.debtors) === JSON.stringify(original.debtors));
    const led = await page.evaluate(() => ({ ledger: JSON.parse(localStorage.getItem('wf_migrations')), snap: JSON.parse(localStorage.getItem('wf_migration_snapshot')) }));
    note('1. it is in the ledger, with a restore point of the old books kept', !!led.ledger.applied['2026-11-05-split-memo'] && led.snap.status === 'applied' && led.snap.before.expenses.length === 3, JSON.stringify({ ledger: Object.keys(led.ledger.applied), snap: led.snap.status }));
    const r1b = await page.evaluate(() => WFMigrations.run());
    note('1. running again changes nothing (already applied)', r1b.length === 0 && JSON.stringify(await books()) === JSON.stringify(after1));

    // 2. it can be undone by its own down
    const u = await page.evaluate(() => WFMigrations.undo('2026-11-05-split-memo'));
    const afterUndo = await books();
    note('2. undo gives the original books back, exactly', u.result === 'undone' && JSON.stringify(afterUndo) === JSON.stringify(original), JSON.stringify(u));

    // 3. a migration that is fine on its fixture and wrong on the real books never reaches them (the undone one above is not redone)
    const restore = () => page.evaluate((rows) => { DB.set('expenses', rows, true); DB.set('debtors', [{ id: 'd1', amount: 5000, name: 'A' }], true); }, seed);
    await restore();
    await page.evaluate(() => { const m = window.__mkSplit(); m.id = '2026-11-06-drops-a-record'; const good = m.up; m.up = (d) => (d.expenses.length === 2 ? good(d) : (d.expenses.pop(), d)); window.WFMigrations.register(m); });
    const r3 = await page.evaluate(() => WFMigrations.run());
    note('3. one that drops a record on the real books is refused before any write', r3.length === 1 && r3[0].result === 'refused' && /3 records became 2/.test(r3[0].why), JSON.stringify(r3));
    note('3. the books are exactly what they were', JSON.stringify(await books()) === JSON.stringify(original));

    // 4. a write that fails half way is put back
    await restore();
    const r4 = await page.evaluate(async () => {
        const m = {
            id: '2026-11-07-two-keys', touches: ['expenses', 'debtors'],
            up(d) { d.expenses = d.expenses.map((r) => Object.assign({}, r, { tag: 'x' })); d.debtors = d.debtors.map((r) => Object.assign({}, r, { tag: 'x' })); return d; },
            down(d) { d.expenses = d.expenses.map((r) => { const o = Object.assign({}, r); delete o.tag; return o; }); d.debtors = d.debtors.map((r) => { const o = Object.assign({}, r); delete o.tag; return o; }); return d; },
            fixture: { expenses: [{ id: 'a', amount: 1 }], debtors: [{ id: 'b', amount: 2 }] },
        };
        // only this migration is pending: the earlier ones are undone or already refused on this build
        const L = JSON.parse(localStorage.getItem('wf_migrations'));
        L.undone['2026-11-06-drops-a-record'] = 1;
        localStorage.setItem('wf_migrations', JSON.stringify(L));
        WFMigrations.register(m);
        const realSet = DB.set; let failed = false;
        // the SECOND key to be written fails: the first has already been changed by then
        DB.set = function (k, v, s) { if (k === 'debtors' && !failed) { failed = true; throw new Error('disk full on ' + k); } return realSet.call(DB, k, v, s); };
        try { return await WFMigrations.run(); } finally { DB.set = realSet; }
    });
    note('4. a write that fails half way is reverted', r4.length === 1 && r4[0].result === 'reverted' && /disk full on debtors/.test(r4[0].why), JSON.stringify(r4));
    note('4. both keys are exactly what they were (the one already written was put back)', JSON.stringify(await books()) === JSON.stringify(original));

    note('no uncaught page errors', dev.errors.length === 0, dev.errors.join(' | ').slice(0, 300));
} catch (e) {
    note('the run reached the end without an exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
    await w.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
