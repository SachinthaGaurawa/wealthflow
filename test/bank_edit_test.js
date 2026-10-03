import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { detect, choose, tailsOf } from '../wealthflow-bank-detect.js';
import { INSTITUTIONS, PICKER, displayBank } from '../wealthflow-institutions.js';
import { bankIdentity } from '../statement-coverage.mjs';

/* =============================================================================
 * THE BANK IS READ — AND THE OWNER HAS THE LAST WORD.
 * The first version named the bank from the statement and, when it could not, said "Bank not identified" and stopped there. A bank that prints only a logo, or the first statement of
 * a new account, left the owner with a label they could not fix. These tests hold the correction to the same standard as the reading: it is labelled, locked and priced exactly like an
 * automatic answer, it is re-checked against the statement registry, it is remembered for the next statement, and it can never make the lock disagree with the email worker.
 * ===========================================================================*/

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const V4 = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');

/* A statement whose text never names its bank (the bank prints a logo), for a savings account. */
const logoOnly = `Your Combined Banking Statement
Client Name: MR A B C EXAMPLE
Account Number: 100000005187
Statement Period: 01/04/2026 - 30/04/2026
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
04/04/2026 04/04/2026 Inward Ceft Transfer Tr 50,000.00 250,000.00`;

describe('a statement that does not name its bank says why, and who came closest', () => {
    it('no bank anywhere in the text: not identified, with the reason in words and nothing to suggest', () => {
        const r = detect({ text: logoOnly, history: {} });
        expect(r.ok).toBe(false);
        expect(r.suggest).toEqual([]);
        expect(r.why.join(' ')).toMatch(/does not name a bank/);
        expect(r.why.join(' ')).toMatch(/••5187 is not in your books or your email history/);
        expect(r.tails).toEqual([{ tail: '5187', kind: 'labelled', network: '' }]);
    });
    it('says when the email history could not be checked at all', () => {
        expect(detect({ text: logoOnly, history: null }).why.join(' ')).toMatch(/email history could not be checked/);
        expect(detect({ text: logoOnly, history: {} }).why.join(' ')).not.toMatch(/could not be checked/);
    });
    it('a near miss names the closest bank for one tap — but never files under it', () => {
        /* a legal-entity line only in the footer, and one mention: 5 points, one short of the bar */
        const text = `${logoOnly}\n${'Notes about this statement.\n'.repeat(45)}DFCC Bank PLC, 73/5 Galle Road, Colombo 03`;
        const r = detect({ text });
        expect(r.ok).toBe(false);
        expect(r.name).toBe('');
        expect(r.lockName).toBe('');
        expect(r.suggest).toHaveLength(1);
        expect(r.suggest[0]).toMatchObject({ ok: false, name: 'DFCC Bank', lockName: 'DFCC Bank', points: 5 });
        expect(r.why.join(' ')).toMatch(/closest was DFCC Bank, at 5 of the 6 points/);
    });
    it('the file name alone is a weak hint: offered, not taken', () => {
        const r = detect({ text: logoOnly, filename: 'DFCC Bank Statement - Apr 26.pdf' });
        expect(r.ok).toBe(false);
        expect(r.suggest.map((s) => s.name)).toEqual(['DFCC Bank']);
        expect(r.suggest[0].basis).toEqual(['the file name']);
    });
    it('two banks about equally named are both offered, neither taken', () => {
        const r = detect({ text: 'Hatton National Bank PLC\nSampath Bank PLC\nStatement of account\nAccount No: 001234567890' });
        expect(r.ok).toBe(false);
        expect(r.suggest.map((s) => s.name).sort()).toEqual(['Hatton National Bank (HNB)', 'Sampath Bank']);
        expect(r.why.join(' ')).toMatch(/named about equally/);
    });
    it('a successful answer carries no suggestions and no reasons', () => {
        const r = detect({ text: 'Sampath Bank PLC\nStatement of Account\nAccount No: 0012 3456 7890' });
        expect(r).toMatchObject({ ok: true, name: 'Sampath Bank', suggest: [], why: [] });
        expect(r.tails[0]).toMatchObject({ tail: '7890' });
    });
});

describe('a correction by the owner is an answer like any other', () => {
    it('every institution the picker offers: the record label is the picker name, the lock label is the email worker\'s, the fee key opens a schedule', () => {
        for (const inst of INSTITUTIONS) {
            const r = choose(inst.name, { tails: [] });
            expect(r, inst.name).toMatchObject({ ok: true, manual: true, name: inst.name, basis: ['you chose it'] });
            /* the lock id: a statement filed by hand under this choice and the same statement filed by email are one lock */
            expect(bankIdentity(r.lockName).id, inst.name).toBe(bankIdentity(inst.mailName || inst.name).id);
        }
    });
    it('NTB: the picker entry names the product; the lock is the issuer\'s either way', () => {
        const amex = choose('Nations Trust Bank (NTB) — AMEX');
        const visa = choose('Nations Trust Bank (NTB) — Visa/Mastercard');
        expect(amex).toMatchObject({ name: 'Nations Trust Bank (NTB) — AMEX', product: 'amex', feeKey: 'Nations Trust Bank (NTB) — AMEX', lockName: 'Nations Trust Bank (NTB)' });
        expect(visa).toMatchObject({ name: 'Nations Trust Bank (NTB) — Visa/Mastercard', product: 'visa-mc', feeKey: 'Nations Trust Bank (NTB) — Visa/Mastercard', lockName: 'Nations Trust Bank (NTB)' });
        expect(bankIdentity(amex.lockName).id).toBe(bankIdentity(visa.lockName).id);
        /* the bare issuer name says nothing about the card, so it opens the generic schedule rather than quoting a wrong one */
        expect(choose('Nations Trust Bank (NTB)')).toMatchObject({ product: '', feeKey: 'Other', lockName: 'Nations Trust Bank (NTB)' });
    });
    it('a bank typed however the owner types it is the institution the picker knows', () => {
        expect(choose('dfcc')).toMatchObject({ name: 'DFCC Bank', lockName: 'DFCC Bank', feeKey: 'DFCC Bank' });
        expect(choose('  HATTON NATIONAL BANK plc ')).toMatchObject({ name: 'Hatton National Bank (HNB)' });
        expect(choose('Sampath')).toMatchObject({ name: 'Sampath Bank' });
        expect(choose("People's Bank")).toMatchObject({ name: 'Peoples Bank' });
    });
    it('a bank outside the fifteen is kept in the owner\'s words, with the generic fee schedule', () => {
        expect(choose('Cargills Bank')).toMatchObject({ ok: true, name: 'Cargills Bank', lockName: 'Cargills Bank', feeKey: 'Other' });
    });
    it('the owner\'s existing label for the card is reused, so one card stays one card', () => {
        const ctx = { tails: [{ tail: '1234' }], books: [{ bank: 'Commercial Bank', last4: '1234', seen: 5 }] };
        expect(choose('commercial bank', ctx).name).toBe('Commercial Bank');
        const hnb = { tails: [{ tail: '8057' }], books: [{ bank: 'HNB', last4: '8057', seen: 12 }] };
        expect(choose('Hatton National Bank (HNB)', hnb).name).toBe('HNB');
        /* ...but only for the same bank: a label of another bank on that tail is not borrowed */
        expect(choose('Seylan Bank', hnb).name).toBe('Seylan Bank');
    });
    it('a blank choice clears the bank: the statement is filed without a label, exactly like an unidentified one', () => {
        const r = choose('   ');
        expect(r).toMatchObject({ ok: false, manual: true, cleared: true, name: '', lockName: '', feeKey: '' });
        expect(bankIdentity(r.lockName).id).toBe(bankIdentity('').id);
    });
    it('what is typed is cleaned: no markup, no control characters, bounded', () => {
        const r = choose('<b>Evil</b>\u0000 Bank' + 'x'.repeat(200));
        expect(r.name).not.toMatch(/[<>\u0000]/);
        expect(r.name.length).toBeLessThanOrEqual(60);
        expect(() => choose(undefined)).not.toThrow();
        expect(() => choose(null, null)).not.toThrow();
        expect(() => choose(42, { tails: 'x', books: 'y', history: 7 })).not.toThrow();
    });
});

describe('what the owner said about a card or account is remembered for the next statement', () => {
    it('a statement that prints the same account number is named from the owner\'s word, and says so', () => {
        const r = detect({ text: logoOnly, taught: [{ bank: 'DFCC Bank', last4: '5187' }] });
        expect(r).toMatchObject({ ok: true, name: 'DFCC Bank', lockName: 'DFCC Bank' });
        expect(r.basis).toContain('you set the bank for this card or account before');
    });
    it('another account number is not that account: the word is about one number only', () => {
        expect(detect({ text: logoOnly, taught: [{ bank: 'DFCC Bank', last4: '9999' }] }).ok).toBe(false);
    });
    it('it never stands against a statement that names another bank: the page wins when it is sure, and a close call is "not identified"', () => {
        /* the header names Sampath with a legal-entity line (11): the owner's word (6) does not overrule the page */
        expect(detect({ text: `Sampath Bank PLC\n${logoOnly}`, taught: [{ bank: 'DFCC Bank', last4: '5187' }] })).toMatchObject({ ok: true, name: 'Sampath Bank' });
        /* the header only mentions it (7) against the owner's word (6): too close to call, so neither is filed — both are offered */
        const close = detect({ text: `Sampath\n${logoOnly}`, taught: [{ bank: 'DFCC Bank', last4: '5187' }] });
        expect(close.ok).toBe(false);
        expect(close.suggest.map((s) => s.name).sort()).toEqual(['DFCC Bank', 'Sampath Bank']);
        /* and where the owner's word agrees with the page they add up */
        expect(detect({ text: `Sampath\n${logoOnly}`, taught: [{ bank: 'Sampath Bank', last4: '5187' }] })).toMatchObject({ ok: true, name: 'Sampath Bank', confidence: 'certain' });
    });
    it('two banks taught for one number is a tie, and a tie is not an answer', () => {
        expect(detect({ text: logoOnly, taught: [{ bank: 'DFCC Bank', last4: '5187' }, { bank: 'Sampath Bank', last4: '5187' }] }).ok).toBe(false);
    });
    it('the label the owner chose is the label reused — and a mail-domain label is the same bank as its picker name', () => {
        const r = detect({ text: logoOnly, taught: [{ bank: 'Dfccbank', last4: '5187' }] });
        expect(r).toMatchObject({ ok: true, name: 'Dfccbank', lockName: 'DFCC Bank', feeKey: 'DFCC Bank' });
        expect(bankIdentity(r.lockName).id).toBe(bankIdentity('Dfccbank').id);
    });
    it('a card the email sync filed under a mail-domain label ("Dfccbank", "Hnb") groups with its bank: one label for one card', () => {
        const text = 'DFCC BANK PLC\nStatement\nAccount Number: 100000005187';
        const r = detect({ text, books: [{ bank: 'Dfccbank', last4: '5187', seen: 9 }] });
        expect(r).toMatchObject({ ok: true, name: 'Dfccbank', lockName: 'DFCC Bank', feeKey: 'DFCC Bank' });
        expect(r.ranked).toEqual([{ issuer: 'DFCC Bank', total: 15 }]);              // one candidate, not a DFCC and a "Dfccbank"
        expect(detect({ text: 'Hatton National Bank PLC\nAccount No: 004010123456', books: [{ bank: 'Hnb', last4: '3456', seen: 4 }] })).toMatchObject({ name: 'Hnb', lockName: 'Hatton National Bank (HNB)' });
        expect(choose('DFCC Bank', { tails: [{ tail: '5187' }], books: [{ bank: 'Dfccbank', last4: '5187', seen: 9 }] }).name).toBe('Dfccbank');
    });
    it('is total: no memory it is handed makes it throw', () => {
        for (const taught of [null, 'x', 7, [null], [{}], [{ bank: '', last4: '5187' }], [{ bank: 'DFCC Bank', last4: 'abcd' }]]) expect(() => detect({ text: logoOnly, taught })).not.toThrow();
    });
});

/* ── the memory the page keeps ───────────────────────────────────────────────────────── */

function loadMemory(storage) {
    const { window } = parseHTML('<html><body></body></html>');
    window.localStorage = storage;
    const src = V4.slice(V4.indexOf('var _WF_TAUGHT_MAX'), V4.indexOf('window.WFBankMemory = { taught: _wfTaught, teach: _wfTeach };') + 'window.WFBankMemory = { taught: _wfTaught, teach: _wfTeach };'.length);
    new Function('window', src)(window);
    return window.WFBankMemory;
}
const fakeStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, _m: m }; };

describe('WFBankMemory (device-local, per signed-in user)', () => {
    it('remembers the printed number against the bank the owner chose, newest first, one entry per number', () => {
        const mem = loadMemory(fakeStorage());
        expect(mem.teach({ ok: true, name: 'DFCC Bank', tails: [{ tail: '5187' }] })).toBe(1);
        expect(mem.teach({ ok: true, name: 'Sampath Bank', tails: [{ tail: '5187' }] })).toBe(1);
        expect(mem.taught()).toMatchObject([{ bank: 'Sampath Bank', last4: '5187' }]);
        mem.teach({ ok: true, name: 'DFCC Bank', tails: [{ tail: '1111' }, { tail: '2222' }, { tail: '3333' }] });
        expect(mem.taught().map((a) => a.last4)).toEqual(['1111', '2222', '5187']);
    });
    it('remembers nothing when no number was printed, no bank was chosen, or the store is unusable', () => {
        const mem = loadMemory(fakeStorage());
        expect(mem.teach({ ok: true, name: 'DFCC Bank', tails: [] })).toBe(0);
        expect(mem.teach({ ok: false, name: '', tails: [{ tail: '5187' }] })).toBe(0);
        expect(mem.teach(null)).toBe(0);
        expect(mem.taught()).toEqual([]);
        const broken = loadMemory({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
        expect(broken.teach({ ok: true, name: 'DFCC Bank', tails: [{ tail: '5187' }] })).toBe(0);
        expect(broken.taught()).toEqual([]);
        const junk = fakeStorage(); junk.setItem('wf_bank_taught_v1:anon', '{"not":"a list"}');
        expect(loadMemory(junk).taught()).toEqual([]);
    });
    it('is bounded', () => {
        const mem = loadMemory(fakeStorage());
        for (let i = 0; i < 260; i += 1) mem.teach({ ok: true, name: 'DFCC Bank', tails: [{ tail: String(1000 + i) }] });
        expect(mem.taught().length).toBeLessThanOrEqual(200);
    });
    it('holds labels and four-digit tails only', () => {
        const store = fakeStorage();
        loadMemory(store).teach({ ok: true, name: 'DFCC Bank', tails: [{ tail: '5187' }] });
        const saved = JSON.parse([...store._m.values()][0]);
        expect(Object.keys(saved[0]).sort()).toEqual(['at', 'bank', 'last4']);
        expect(saved[0].last4).toMatch(/^\d{4}$/);
    });
    it('the page feeds what it remembers to the detector, and hands the review screen what it needs to correct an answer', () => {
        expect(V4).toMatch(/books: _wfBooks\(\), taught: _wfTaught\(\), history: null/);
        expect(V4).toMatch(/r\.ctx = \{ filename: name, tails: r\.tails \|\| \[\], books: input\.books, taught: input\.taught, history: input\.history \}/);
    });
});

/* ── the review screen ───────────────────────────────────────────────────────────────── */

function extractModal() {
    const at = HTML.search(/function\s+_showCCReviewModal\s*\(/);
    const end = HTML.indexOf('\n        window._showCCReviewModal =', at);
    return HTML.slice(at, end).trim();
}
const MODAL = extractModal();

function harness({ guard, memory, parsedExtra = {}, bankArg = '', detection } = {}) {
    const { window, document } = parseHTML('<html><body></body></html>');
    window.WFRoute = null; window.WFMerchants = null;
    window.WFInstitutions = { PICKER, displayBank };
    window.WFBankDetect = { choose };
    window.WFBankMemory = memory || { teach() {} };
    window.WFStatementCloud = { guard };
    const store = { cconetime: [], ccPayments: [], expenses: [], incomeRecv: [], loans: [], cheques: [] };
    const DB = { get: (k) => store[k] || [], set: (k, v) => { store[k] = v; return true; } };
    const notes = [];
    let n = 0;
    const factory = new Function('window', 'document', 'DB', 'requestAnimationFrame', 'parseMoney', 'fmtN', '_wfEsc', 'notify', 'today', 'triggerHaptic', 'uid', 'INC_TYPES',
        `${MODAL}; return _showCCReviewModal;`);
    const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    const show = factory(window, document, DB, (fn) => fn(), (v) => Number(String(v || '').replace(/,/g, '')) || 0, (v) => Number(v || 0).toFixed(2), esc,
        (message, kind) => notes.push({ message, kind }), () => '2026-10-03', () => {}, () => 'id' + (n += 1), ['Salary', 'Other']);
    const det = detection || detect({ text: logoOnly, history: {} });
    const parsed = {
        transactions: [{ date: '2026-04-04', description: 'Inward Ceft Transfer', amount: 50000, direction: 'credit', type: 'purchase' }],
        statement_period: '01/04/2026 - 30/04/2026', card_last4: '',
        _wfBank: { ...det, ctx: { filename: 'statement.pdf', tails: det.tails, books: [], taught: [], history: {} } },
        _wfGuard: { sha: 'a'.repeat(64), bank: '', last4: '5187', periodText: '01/04/2026 - 30/04/2026', dates: ['2026-04-04'], filename: 'statement.pdf', size: 10, rows: 1, token: 'TOKEN-ORIGINAL' },
        ...parsedExtra,
    };
    show(parsed, bankArg);
    const q = (sel) => document.querySelector(sel);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { window, document, parsed, store, notes, q, tick, show };
}
const filed = (h) => [...h.store.cconetime, ...h.store.ccPayments, ...h.store.expenses, ...h.store.incomeRecv];
const setSelect = (h, value) => { const el = h.q('#_ccr_bankSel'); Object.defineProperty(el, 'value', { configurable: true, writable: true, value }); return el; };
const guardSpy = (answer = () => ({})) => {
    const calls = { parsed: [], claim: [] };
    return { calls, parsed: async (a) => { calls.parsed.push(a); const r = answer(a, calls.parsed.length); return { info: { ...a, token: 'TOKEN-' + calls.parsed.length }, ...r }; }, claim: async (info) => { calls.claim.push(info); return null; } };
};

describe('the review screen shows the bank and lets the owner correct it', () => {
    it('extracts the real modal', () => { expect(MODAL.length).toBeGreaterThan(5000); });

    it('a named bank is shown with how it was found, and can be edited', () => {
        const h = harness({ guard: guardSpy(), detection: detect({ text: 'Sampath Bank PLC\nStatement of Account\nAccount No: 0012 3456 7890' }), bankArg: 'Sampath Bank' });
        expect(h.q('#_ccr_bank').textContent).toMatch(/Bank:\s*Sampath Bank\s*— found automatically \(the statement names it\)/);
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Sampath Bank');
        expect(h.q('#_ccr_bankEdit').textContent).toMatch(/Edit/);
        expect(h.q('#_ccr_bankSel')).toBeNull();            // the editor opens on request
    });

    it('an unnamed bank says so, says why, and offers a way to choose — it never blocks the upload', () => {
        const h = harness({ guard: guardSpy() });
        const box = h.q('#_ccr_bank').textContent;
        expect(box).toMatch(/Bank not identified/);
        expect(box).toMatch(/does not name a bank/);
        expect(h.q('#_ccr_bankEdit').textContent).toMatch(/Choose bank/);
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Bank Statement');
        expect(h.q('#_ccr_save').disabled).toBeFalsy();
    });

    it('the closest bank is offered as one tap; tapping it sets the bank, the title and the records', async () => {
        const g = guardSpy();
        const h = harness({ guard: g, detection: detect({ text: logoOnly, filename: 'DFCC Bank Statement - Apr 26.pdf' }) });
        const chip = h.q('._ccr_bankPick');
        expect(chip.textContent).toBe('Use DFCC Bank');
        chip.click(); await h.tick(); await h.tick();
        expect(h.q('#_ccr_ttlbank').textContent).toBe('DFCC Bank');
        expect(h.q('#_ccr_bank').textContent).toMatch(/Bank:\s*DFCC Bank\s*— set by you/);
        expect(h.parsed._wfBank).toMatchObject({ ok: true, manual: true, name: 'DFCC Bank', lockName: 'DFCC Bank' });
        expect(h.q('._ccr_bankPick')).toBeNull();
    });

    it('the editor lists the picker banks, a "no bank label" choice and "another bank"; choosing applies it', async () => {
        const g = guardSpy();
        const h = harness({ guard: g });
        h.q('#_ccr_bankEdit').click();
        const sel = h.q('#_ccr_bankSel');
        const values = [...sel.querySelectorAll('option')].map((o) => o.getAttribute('value'));
        expect(values).toEqual(['', ...INSTITUTIONS.map((i) => i.name), '__other']);
        expect(PICKER[PICKER.length - 1]).toBe('Other');           // "Other" is the free-text entry, not a bank
        setSelect(h, 'Seylan Bank');
        h.q('#_ccr_bankUse').click(); await h.tick(); await h.tick();
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Seylan Bank');
        expect(h.parsed._wfBank.lockName).toBe('Seylan Bank');
        expect(h.q('#_ccr_bankSel')).toBeNull();                    // the editor closes
    });

    it('another bank: its name is typed, a blank name is refused, and the owner\'s words become the label', async () => {
        const h = harness({ guard: guardSpy() });
        h.q('#_ccr_bankEdit').click();
        setSelect(h, '__other');
        h.document.querySelector('#_ccr_bankSel').dispatchEvent(new h.window.Event('change', { bubbles: true }));
        h.q('#_ccr_bankTxt').value = '   ';
        h.q('#_ccr_bankUse').click(); await h.tick();
        expect(h.notes.some((n) => /Type the bank name/.test(n.message))).toBe(true);
        expect(h.q('#_ccr_bankSel')).not.toBeNull();                // still editing
        h.q('#_ccr_bankTxt').value = 'Cargills Bank';
        h.q('#_ccr_bankUse').click(); await h.tick(); await h.tick();
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Cargills Bank');
        expect(h.parsed._wfBank).toMatchObject({ name: 'Cargills Bank', feeKey: 'Other' });
    });

    it('cancel leaves everything as it was', () => {
        const h = harness({ guard: guardSpy() });
        h.q('#_ccr_bankEdit').click();
        h.q('#_ccr_bankCancel').click();
        expect(h.q('#_ccr_bankSel')).toBeNull();
        expect(h.q('#_ccr_bank').textContent).toMatch(/Bank not identified/);
    });

    it('the registry is asked about the bank now chosen, and the claim at Save carries ITS issuer label — one lock with the email worker', async () => {
        const g = guardSpy();
        const h = harness({ guard: g });
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'Hatton National Bank (HNB)'); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        expect(g.calls.parsed).toHaveLength(1);
        expect(g.calls.parsed[0]).toMatchObject({ sha: 'a'.repeat(64), bank: 'Hatton National Bank (HNB)', last4: '5187', periodText: '01/04/2026 - 30/04/2026', rows: 1 });
        expect(h.parsed._wfGuard.token).toBe('TOKEN-1');            // the new check's token, not the old one
        h.q('#_ccr_save').click(); await h.tick(); await h.tick(); await h.tick();
        expect(g.calls.claim).toHaveLength(1);
        expect(g.calls.claim[0]).toMatchObject({ bank: 'Hatton National Bank (HNB)', token: 'TOKEN-1' });
        expect(bankIdentity(g.calls.claim[0].bank).id).toBe(bankIdentity('Hatton National Bank (HNB)').id);
    });

    it('a statement already in the books under the bank chosen turns Save off, with the reason; changing the bank turns it back on', async () => {
        const g = guardSpy((a) => (a.bank === 'DFCC Bank' ? { duplicate: true, via: 'email', notice: 'Already Added via Email Sync (DFCC Bank ••5187, Apr 2026 · 40 transactions in your books)' } : {}));
        const h = harness({ guard: g });
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'DFCC Bank'); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        expect(h.q('#_ccr_save').disabled).toBe(true);
        expect(h.q('#_ccr_bank').textContent).toMatch(/Already Added via Email Sync \(DFCC Bank ••5187, Apr 2026 · 40 transactions in your books\)/);
        expect(h.q('#_ccr_bank').textContent).toMatch(/will not be added a second time/);
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'Sampath Bank'); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        expect(h.q('#_ccr_save').disabled).toBe(false);
        expect(h.q('#_ccr_bank').textContent).not.toMatch(/Already Added/);
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Sampath Bank');
    });

    it('Save is held while the registry is being asked, so a claim can never carry the old bank', async () => {
        let release; const gate = new Promise((r) => { release = r; });
        const g = guardSpy(); const slow = g.parsed;
        g.parsed = async (a) => { await gate; return slow(a); };
        const h = harness({ guard: g });
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'Seylan Bank'); h.q('#_ccr_bankUse').click();
        await h.tick();
        expect(h.q('#_ccr_save').disabled).toBe(true);
        release(); await h.tick(); await h.tick();
        expect(h.q('#_ccr_save').disabled).toBe(false);
    });

    it('two quick corrections: the last one wins, and the first one\'s answer is ignored', async () => {
        const order = []; const resolvers = [];
        const g = guardSpy(); const base = g.parsed;
        g.parsed = (a) => new Promise((res) => { resolvers.push(() => base(a).then((r) => { order.push(a.bank); res(r); })); });
        const h = harness({ guard: g });
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'DFCC Bank'); h.q('#_ccr_bankUse').click(); await h.tick();
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'Seylan Bank'); h.q('#_ccr_bankUse').click(); await h.tick();
        resolvers[1](); await h.tick(); await h.tick();
        resolvers[0](); await h.tick(); await h.tick();
        expect(h.parsed._wfBank.name).toBe('Seylan Bank');
        expect(h.parsed._wfGuard.bank).toBe('Seylan Bank');
        expect(h.q('#_ccr_save').disabled).toBe(false);
    });

    it('a registry that cannot be reached never stops the owner: the correction still applies and Save stays on', async () => {
        const g = guardSpy(); g.parsed = async () => { throw new Error('offline'); };
        const h = harness({ guard: g });
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'Seylan Bank'); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Seylan Bank');
        expect(h.q('#_ccr_save').disabled).toBe(false);
    });

    it('saved records carry the chosen bank, and the correction is remembered for the next statement', async () => {
        const taught = [];
        const h = harness({ guard: guardSpy(), memory: { teach: (c) => taught.push(c) } });
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'Sampath Bank'); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach((el) => { el.checked = true; });
        h.q('#_ccr_save').click();
        for (let i = 0; i < 6; i += 1) await h.tick();
        expect(filed(h).length).toBe(1);
        expect(filed(h)[0].bank).toBe('Sampath Bank');
        expect(taught).toHaveLength(1);
        expect(taught[0]).toMatchObject({ ok: true, manual: true, name: 'Sampath Bank' });
        expect(taught[0].tails[0].tail).toBe('5187');
    });

    it('an automatic answer is not "taught" — only what the owner said is', async () => {
        const taught = [];
        const h = harness({ guard: guardSpy(), memory: { teach: (c) => taught.push(c) }, bankArg: 'Sampath Bank', detection: detect({ text: 'Sampath Bank PLC\nStatement of Account\nAccount No: 0012 3456 7890' }) });
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach((el) => { el.checked = true; });
        h.q('#_ccr_save').click();
        for (let i = 0; i < 6; i += 1) await h.tick();
        expect(filed(h).length).toBe(1);
        expect(taught).toEqual([]);
    });

    it('clearing the bank files the rows without a label', async () => {
        const h = harness({ guard: guardSpy(), bankArg: 'Sampath Bank', detection: detect({ text: 'Sampath Bank PLC\nStatement of Account\nAccount No: 0012 3456 7890' }) });
        h.q('#_ccr_bankEdit').click(); setSelect(h, ''); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        expect(h.q('#_ccr_bank').textContent).toMatch(/No bank label/);
        expect(h.q('#_ccr_ttlbank').textContent).toBe('Bank Statement');
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach((el) => { el.checked = true; });
        h.q('#_ccr_save').click();
        for (let i = 0; i < 6; i += 1) await h.tick();
        expect(filed(h)[0].bank).toBe('');
    });

    it('only a manual upload can edit the bank: a mailbox review (many banks in one batch) and the cloud review get no editor', () => {
        const noBank = harness({ guard: guardSpy(), parsedExtra: { _wfBank: undefined, _wfGuard: undefined } });
        expect(noBank.q('#_ccr_bank')).toBeNull();
        expect(noBank.q('#_ccr_bankEdit')).toBeNull();
        const cloud = harness({ guard: guardSpy(), parsedExtra: { cloudReview: async () => {} } });
        expect(cloud.q('#_ccr_bankEdit')).toBeNull();
    });

    it('the bank name is escaped wherever it is printed', () => {
        const h = harness({ guard: guardSpy(), bankArg: '<img src=x onerror=alert(1)>', detection: { ...detect({ text: 'Sampath Bank PLC\nAccount No: 0012 3456 7890' }), name: '<img src=x onerror=alert(1)>' } });
        expect(h.q('#_ccr_bank img')).toBeNull();
        expect(h.q('#_ccr_ttlbank img')).toBeNull();
        expect(h.q('#_ccr_ttlbank').textContent).toBe('<img src=x onerror=alert(1)>');
    });
});

describe('a bank is written by its own name — the label stored on the records is not touched', () => {
    /* The email sync labels a statement from the sender's mail domain ("dfccbank.com" -> "Dfccbank"), and the books reuse that label so one card stays one card. */
    const dfccBooks = (label) => detect({ text: 'Statement of Account\nAccount No: 1000 0000 5187\nDFCC Bank PLC\nStatement Period: 01/04/2026 - 30/04/2026', books: [{ bank: label, last4: '5187', seen: 6 }] });

    it('the books\' label stays the record label; the screen shows the institution\'s name', async () => {
        const det = dfccBooks('Dfccbank');
        expect(det).toMatchObject({ ok: true, name: 'Dfccbank' });   // the stored label: unchanged, so the card stays one card
        const h = harness({ guard: guardSpy(), detection: det, bankArg: det.name });
        expect(h.q('#_ccr_ttlbank').textContent).toBe('DFCC Bank');
        expect(h.q('#_ccr_bankName').textContent).toBe('DFCC Bank');
        expect(h.q('#_ccr_bank').textContent).not.toMatch(/Dfccbank/);
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach((el) => { el.checked = true; });
        h.q('#_ccr_save').click();
        for (let i = 0; i < 6; i += 1) await h.tick();
        expect(filed(h)[0].bank).toBe('Dfccbank');
    });

    it('correcting it by hand keeps that label too, and the screen still shows the proper name (the owner\'s screenshot)', async () => {
        const det = dfccBooks('Dfccbank');
        const h = harness({ guard: guardSpy(), detection: { ...det, ok: false, name: '', manual: false }, bankArg: '' });
        h.parsed._wfBank.ctx.books = [{ bank: 'Dfccbank', last4: '5187', seen: 6 }];
        h.q('#_ccr_bankEdit').click(); setSelect(h, 'DFCC Bank'); h.q('#_ccr_bankUse').click();
        await h.tick(); await h.tick();
        expect(h.parsed._wfBank).toMatchObject({ manual: true, name: 'Dfccbank', lockName: 'DFCC Bank' });
        expect(h.q('#_ccr_ttlbank').textContent).toBe('DFCC Bank');
        expect(h.q('#_ccr_bankName').textContent).toBe('DFCC Bank');
        expect(h.q('#_ccr_bank').textContent).toMatch(/Bank:\s*DFCC Bank\s*— set by you/);
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach((el) => { el.checked = true; });
        h.q('#_ccr_save').click();
        for (let i = 0; i < 6; i += 1) await h.tick();
        expect(filed(h)[0].bank).toBe('Dfccbank');
    });

    it('opening the editor on a mail-domain label selects the institution in the list, not "another bank"', () => {
        for (const [label, listed] of [['Dfccbank', 'DFCC Bank'], ['Hnb', 'Hatton National Bank (HNB)'], ['Sampathbank', 'Sampath Bank'], ['Commercialbank', 'Commercial Bank'], ['Peoplesbank', 'Peoples Bank']]) {
            const det = detect({ text: `${listed} PLC\nStatement of Account\nAccount No: 1000 0000 5187`, books: [{ bank: label, last4: '5187', seen: 3 }] });
            const h = harness({ guard: guardSpy(), detection: det, bankArg: det.name });
            h.q('#_ccr_bankEdit').click();
            const picked = [...h.document.querySelectorAll('#_ccr_bankSel option')].filter((o) => o.hasAttribute('selected')).map((o) => o.getAttribute('value'));
            expect(picked, label).toEqual([listed]);
        }
    });

    it('NTB: the product picks the list entry; with no product the bank is typed as the issuer', () => {
        const amex = harness({ guard: guardSpy(), detection: { ...detect({ text: 'Nations Trust Bank PLC\nAmerican Express card 376657*****0276' }), name: 'Nations Trust Bank (NTB)' }, bankArg: 'Nations Trust Bank (NTB)' });
        expect(amex.parsed._wfBank.product).toBe('amex');
        amex.q('#_ccr_bankEdit').click();
        expect([...amex.document.querySelectorAll('#_ccr_bankSel option')].filter((o) => o.hasAttribute('selected')).map((o) => o.getAttribute('value'))).toEqual(['Nations Trust Bank (NTB) — AMEX']);
        const bare = harness({ guard: guardSpy(), detection: { ...detect({ text: 'Nations Trust Bank PLC\nStatement of Account\nAccount No: 1000 0000 5187' }), name: 'Nationstrust' }, bankArg: 'Nationstrust' });
        expect(bare.q('#_ccr_ttlbank').textContent).toBe('Nations Trust Bank (NTB)');
        bare.q('#_ccr_bankEdit').click();
        expect(bare.q('#_ccr_bankTxt').getAttribute('value')).toBe('Nations Trust Bank (NTB)');
    });

    it('a bank the app does not list is shown exactly as it is written, and never as a different bank', () => {
        for (const name of ['Cargills Bank', 'Pan', 'National Bank', 'Pdbank']) {
            const h = harness({ guard: guardSpy(), detection: { ...detect({ text: 'Statement of Account\nAccount No: 1000 0000 5187' }), name }, bankArg: name });
            expect(h.q('#_ccr_ttlbank').textContent, name).toBe(name);
        }
    });

    it('the mailbox-review path, which passes the stored label as the bank, shows the name and files the label', async () => {
        const h = harness({ guard: guardSpy(), bankArg: 'Dfccbank', parsedExtra: { _wfBank: undefined, _wfGuard: undefined } });
        expect(h.q('#_ccr_ttlbank').textContent).toBe('DFCC Bank');
        h.document.querySelectorAll('#_ccr_body ._ccr_keep').forEach((el) => { el.checked = true; });
        h.q('#_ccr_save').click();
        for (let i = 0; i < 6; i += 1) await h.tick();
        expect(filed(h)[0].bank).toBe('Dfccbank');
    });
});

describe('wiring', () => {
    it('the editor, the registry re-check, the claim and the memory are all in the review screen', () => {
        expect(MODAL).toMatch(/window\.WFBankDetect\.choose/);
        expect(MODAL).toMatch(/G\.parsed\(\{ sha: info\.sha, bank: res\.ok \? res\.lockName : ''/);
        expect(MODAL).toMatch(/parsed\._wfGuard = fresh/);
        expect(MODAL).toMatch(/WFBankMemory\.teach\(parsed\._wfBank\)/);
        expect(MODAL).not.toMatch(/Which credit card \/ bank\?/);
    });
    it('the detector exports choose and the page memory is registered', () => {
        expect(fs.readFileSync(path.join(ROOT, 'wealthflow-bank-detect.js'), 'utf8')).toMatch(/const API = \{ detect, choose, tailsOf, networkOfBin, NAMED_AT, LEAD_BY \}/);
        expect(V4).toMatch(/window\.WFBankMemory = \{ taught: _wfTaught, teach: _wfTeach \}/);
    });
    it('tailsOf is unchanged for the memory: the same tail a statement prints is the one remembered', () => {
        expect(tailsOf(logoOnly)[0]).toMatchObject({ tail: '5187' });
    });
});
