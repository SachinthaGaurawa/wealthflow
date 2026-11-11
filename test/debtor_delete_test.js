/* =============================================================================
 * test/debtor_delete_test.js — a debtor can always be deleted, and deleting one stops its texts
 * -----------------------------------------------------------------------------
 * Owner, 2026-11-11: the trash button on a settled debtor ("Menika", nothing lent) did nothing. It was refused by the "completed records are
 * permanent" rule, with a toast and no question. Debtors are now the one kind that can be deleted at any state: it asks, it deletes the one
 * record (found by id), it reads the removal back, and it can be undone. The browser side is test/e2e/debtor-delete.mjs; these pin the wiring
 * and the server half: a deleted debtor owes no text, and a text already queued for it is cancelled.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { deriveEvents } from '../sms-events.mjs';
import { sweepUser } from '../sms-engine.mjs';
import { createFirestore } from './helpers/fake-firestore.js';

const HTML = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
const body = (name) => {
    const at = HTML.indexOf('function ' + name + '(');
    expect(at, name + ' exists').toBeGreaterThan(-1);
    const next = HTML.indexOf('\n        function ', at + 10);
    return HTML.slice(at, next > 0 ? next : at + 6000);
};

describe('the delete handler', () => {
    const fn = body('_deleteDebtor');
    it('is no longer refused for a settled debtor, and every other kind keeps its rule', () => {
        expect(fn).not.toContain('_wfKeepDone');
        for (const kind of ['investment', 'loan', 'ccinstall', 'ccot', 'cheque', 'target', 'pawn', 'subscription']) expect(HTML).toContain(`_wfKeepDone('${kind}'`);
    });
    it('always asks first, and says what goes with the debtor', () => {
        expect(fn).toContain('showConfirm(');
        expect(fn).toContain('repayment history');
        expect(fn).toContain('stops every text');
    });
    it('removes the one record by id (never a filter on an id that may be missing), and reads the removal back', () => {
        expect(fn).toContain('findIndex((x) => _debtorSame(x, d))');
        expect(fn).toContain('list.splice(at, 1)');
        expect(fn).not.toMatch(/filter\(\(x\) => x && x\.id !== d\.id\)/);
        expect(fn).toMatch(/some\(\(x\) => _debtorSame\(x, removed\)\)\) \{ notify\('Could not delete/);
    });
    it('offers an Undo that restores the record WITHOUT its old stamp, or every other device would delete it again', () => {
        expect(fn).toContain("_wfUndoBar(who + ' deleted', 'Undo'");
        expect(fn).toContain('delete rest._ut');
    });
    it('the trash button on every debtor row is wired to it', () => {
        expect(HTML).toContain('data-liq-ddel');
        expect(HTML).toMatch(/\[data-liq-ddel\][\s\S]{0,200}_deleteDebtor\(debtors\[/);
    });
});

describe('what the server owes after a debtor is deleted', () => {
    const NOW = Date.UTC(2026, 9, 10, 6, 0, 0);
    const iso = (n) => new Date(NOW + n * 86400000).toISOString().slice(0, 10);
    const debtor = {
        id: 'd1', name: 'Menika', phone: '0772222222', nic: '853400937V', sms_notifications_enabled: true, sms_enabled_at: NOW - 7200e3,
        sms_remind_late: true, sms_remind_at: NOW - 7200e3, dueISO: iso(-3),
        events: [{ id: 'e1', kind: 'lent', amount: 50000, date: iso(-1), confirmed: true, at: NOW - 3600e3 }],
    };
    const books = (debtors) => ({ settings: { currency: 'LKR' }, debtors });

    it('a debtor present owes texts; the same book without it owes none for that debtor', () => {
        expect(deriveEvents(books([debtor]), NOW).events.some((e) => String(e.key).includes('d1'))).toBe(true);
        expect(deriveEvents(books([]), NOW).events.some((e) => String(e.key).includes('d1'))).toBe(false);
    });

    it('a text already queued for a debtor that is then deleted is cancelled before it goes', async () => {
        const { db } = createFirestore({});
        const down = { configured: false, senderId: 'WealthFlow', async send() { return { ok: false }; } };
        const run = (user, client) => sweepUser({ db, uid: 'u1', user, client, now: NOW, env: {}, deps: { random: () => 0.5 } });
        const first = await run(books([debtor]), down);                         // queued, gateway not set up
        expect(first.derived).toBeGreaterThan(0);
        const second = await run(books([]), down);                              // the debtor is gone from the book
        expect(second.cancelled).toBeGreaterThan(0);
        const sent = [];
        const up = { sent, configured: true, senderId: 'WealthFlow', async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; } };
        await run(books([]), up);
        expect(sent.filter((m) => m.to.includes('772222222'))).toEqual([]);
    });
});
