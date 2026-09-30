import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gzipSync, gunzipSync } from 'node:zlib';
import { request, save, remove, sync, dismissReview, authChanged, getState, migrateUnlockedVault, friendly, review, reviewSummary, retryAttemptsSummary, openReview, autoRenderPending } from '../wealthflow-statement-cloud.js';

const active = { uid: 'owner', getIdToken: vi.fn(async () => 'verified-token') };
const reply = (ok, body) => ({ ok, json: async () => body });
// A minimal stand-in for the DOM, only for the one test below that must reach
// openReview()'s real rendering path (no environment: 'jsdom' here — this
// suite is pure-logic-only by design). Every element it hands back is the
// same shape drawReview() actually touches: className/style/textContent as
// plain settable fields, onclick as a settable slot, appendChild as a no-op.
const fakeElement = () => ({ style: {}, appendChild: () => {}, replaceChildren: () => {}, setAttribute: () => {}, remove: () => {}, classList: { add: () => {} } });
const fakeDocument = () => ({ createElement: () => fakeElement(), body: { appendChild: () => {} } });
beforeEach(() => {
    vi.stubGlobal('window', { firebase: { auth: () => ({ currentUser: active }) }, dispatchEvent: vi.fn(), localStorage: { setItem: vi.fn() }, _wfRecentSweep: vi.fn(async () => 0) });
    vi.stubGlobal('CustomEvent', class { constructor(type, options) { this.type = type; this.detail = options.detail; } });
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('document', fakeDocument());
});
afterEach(() => vi.unstubAllGlobals());

describe('missing months are shown, and shared in diagnostics without an address', () => {
    const coverage = { at: 1, missing: 2, staged: 0, series: [
        { label: 'Consolidated eStatement', bank: 'NTB', first: '2026-01', last: '2026-08', months: {}, missing: ['2026-03'], gaps: [{ month: '2026-03', mail: [{ messageId: 'm1', from: 'estatements@nationstrust.com', subject: 'Your e-Statement', outcome: 'a-new-address-at-a-bank-you-approved' }] }] },
        { label: 'eStatement', bank: 'AMEX', first: '2026-01', last: '2026-08', months: {}, missing: ['2026-05'], gaps: [{ month: '2026-05', mail: [] }] },
    ] };
    it('keeps the sync\'s coverage, and summarises it by outcome only', async () => {
        await authChanged(null);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0, coverage }));
        await authChanged(active);
        const summary = reviewSummary();
        expect(summary.coverage).toMatchObject({ missing: 2, series: [
            { label: 'Consolidated eStatement', first: '2026-01', last: '2026-08', missing: ['2026-03'], gaps: [{ month: '2026-03', outcomes: ['a-new-address-at-a-bank-you-approved'] }] },
            { label: 'eStatement', missing: ['2026-05'], gaps: [{ month: '2026-05', outcomes: [] }] },
        ] });
        expect(JSON.stringify(summary.coverage)).not.toMatch(/@|nationstrust|Your e-Statement|m1/);
        await authChanged(null);
        expect(reviewSummary().coverage).toBeUndefined();
    });
    it('lists months closed automatically as empty, each with a Reopen that asks the server and forgets it', async () => {
        const buttons = [], texts = [];
        const element = () => { const e = { ...fakeElement(), _t: '', set textContent(v) { this._t = v; texts.push(v); }, get textContent() { return this._t; } }; return e; };
        vi.stubGlobal('document', { createElement: tag => { const e = element(); if (tag === 'button') buttons.push(e); return e; }, body: { appendChild: () => {} } });
        await authChanged(null);
        window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ onSnapshot: ok => { ok({ docs: [] }); return () => {}; } }) }) }) }) }) };
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 }))
            .mockResolvedValueOnce(reply(true, { ok: true, processed: 0, coverage: { at: 1, missing: 0, series: [], empties: [{ id: 'msg5.file.html.2000', label: 'eStatement_0276_2026MAY.html', month: '2026-05' }] } }));
        await authChanged(active);
        await openReview();
        expect(texts).toContain('Closed automatically — the bank\'s own figures show nothing moved');
        expect(texts.some(x => x.startsWith('2026-05 · eStatement_0276_2026MAY.html'))).toBe(true);
        expect(reviewSummary().coverage.closedEmpty).toBe(1);
        const reopen = buttons.find(b => b._t === 'Reopen');
        fetch.mockResolvedValueOnce(reply(true, { ok: true, reopened: true })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0 }));
        await reopen.onclick();
        expect(JSON.parse(fetch.mock.calls.at(-2)[1].body)).toEqual({ action: 'reopen-empty', id: 'msg5.file.html.2000' });
        await authChanged(null);
    });
    it('draws one line per missing month, saying what the search found', async () => {
        const texts = [];
        const element = () => ({ ...fakeElement(), set textContent(v) { texts.push(v); }, get textContent() { return ''; } });
        vi.stubGlobal('document', { createElement: element, body: { appendChild: () => {} } });
        await authChanged(null);
        window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ onSnapshot: ok => { ok({ docs: [] }); return () => {}; } }) }) }) }) }) };
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0, coverage }));
        await authChanged(active);
        await openReview();
        expect(texts).toContain('2 statement months not in your mailbox yet');
        expect(texts).toContain('Consolidated eStatement · 2026-03: a new sender address — approve it in Settings → Statement senders');
        expect(texts).toContain('eStatement · 2026-05: no email from this bank arrived that month');
        await authChanged(null);
    });
});

describe('the mailbox audit is shown, and nothing refused is hidden', () => {
    const coverage = { at: 1, missing: 0, series: [],
        audit: { at: Date.parse('2026-09-30T10:00:00Z'), listed: 61, accounted: 57, examined: 4, taken: 3, refused: 1, held: 2, complete: true },
        refused: [{ messageId: 'm9', reason: 'dkim-did-not-pass', text: 'it claims to be from your bank but carries no valid signature', from: 'statements@nationstrust.com', subject: 'Your e-Statement', filename: 'Consolidated_eStatement_2026MAR_458290.html', receivedMs: Date.parse('2026-04-02T05:00:00Z'), asked: false }],
        log: [{ id: 'a', at: 5, bank: 'NTB', file: 'Consolidated_eStatement_2026MAR_458290.html', month: '2026-03', status: 'Missing-Added', math: 'PASSED', via: 'audit', sha: 'abcdef012345', last4: '8057', closing: 10 },
            { id: 'b', at: 4, bank: 'AMEX', file: 'eStatement_0276_2026MAY.html', month: '2026-05', status: 'Needs-Review', math: 'FAILED', via: '', sha: '', last4: '', closing: null }] };
    const open = async () => {
        const buttons = [], texts = [];
        const element = () => ({ ...fakeElement(), _t: '', set textContent(v) { this._t = v; texts.push(v); }, get textContent() { return this._t; } });
        vi.stubGlobal('document', { createElement: tag => { const e = element(); if (tag === 'button') buttons.push(e); return e; }, body: { appendChild: () => {} } });
        await authChanged(null);
        window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ onSnapshot: ok => { ok({ docs: [] }); return () => {}; } }) }) }) }) }) };
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0, coverage: JSON.parse(JSON.stringify(coverage)) }));
        await authChanged(active);
        await openReview();
        return { buttons, texts };
    };
    it('says what the history check found, lists refused bank mail with its reason, and offers Take it', async () => {
        const { buttons, texts } = await open();
        expect(texts).toContain('Mailbox history check');
        expect(texts.some(x => /61 bank emails with attachments found · 57 already accounted for · 3 added now · 1 refused · 2 waiting on a sender decision$/.test(x))).toBe(true);
        expect(texts).toContain('1 email from your banks that were not taken');
        expect(texts.some(x => x.includes('statements@nationstrust.com · Consolidated_eStatement_2026MAR_458290.html: it claims to be from your bank but carries no valid signature'))).toBe(true);
        const take = buttons.find(b => b._t === 'Take it');
        fetch.mockResolvedValueOnce(reply(true, { ok: true, queued: true })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0 }));
        await take.onclick();
        expect(JSON.parse(fetch.mock.calls.at(-2)[1].body)).toEqual({ action: 'take-refused', messageId: 'm9' });
        await authChanged(null);
    });
    it('keeps a per-statement audit log with what each proved, and a failed tap says so instead of pretending', async () => {
        const { buttons, texts } = await open();
        expect(texts).toContain('Statement audit log (2)');
        expect(texts).toContain('2026-03 · NTB · Consolidated_eStatement_2026MAR_458290.html · Missing-Added · maths PASSED · …8057 · abcdef012345');
        expect(texts).toContain('2026-05 · AMEX · eStatement_0276_2026MAY.html · Needs-Review · maths FAILED');
        fetch.mockRejectedValueOnce(new Error('offline'));
        const take = buttons.find(b => b._t === 'Take it');
        await take.onclick();
        expect(take.disabled).toBe(false);
        await authChanged(null);
    });
    it('offers no Take it for a refusal a tap cannot fix', async () => {
        const untakeable = { ...coverage, refused: [{ ...coverage.refused[0], reason: 'too-many-attachments', text: 'it carries more attachments than a statement should', takeable: false }] };
        const buttons = [];
        const element = () => ({ ...fakeElement(), _t: '', set textContent(v) { this._t = v; }, get textContent() { return this._t; } });
        vi.stubGlobal('document', { createElement: tag => { const e = element(); if (tag === 'button') buttons.push(e); return e; }, body: { appendChild: () => {} } });
        await authChanged(null);
        window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ onSnapshot: ok => { ok({ docs: [] }); return () => {}; } }) }) }) }) }) };
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0, coverage: untakeable }));
        await authChanged(active);
        await openReview();
        expect(buttons.some(b => b._t === 'Take it')).toBe(false);
        await authChanged(null);
    });
    it('shares the audit in diagnostics as counts and reason codes only', async () => {
        await authChanged(null);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 })).mockResolvedValueOnce(reply(true, { ok: true, processed: 0, coverage }));
        await authChanged(active);
        const shared = reviewSummary().coverage;
        expect(shared.refused).toEqual(['dkim-did-not-pass']);
        expect(shared.audit).toMatchObject({ listed: 61, accounted: 57, taken: 3, refused: 1, held: 2, complete: true });
        expect(shared.log).toEqual({ status: { 'Missing-Added': 1, 'Needs-Review': 1 }, math: { PASSED: 1, FAILED: 1 } });
        expect(JSON.stringify(shared)).not.toMatch(/@|nationstrust|abcdef|8057|Consolidated/);
        await authChanged(null);
    });
});

describe('private statement cloud frontend transport', () => {
    it('exposes a defensive state snapshot to the real browser integration', () => {
        const first = getState();
        first.configured = 'tampered';
        expect(getState().configured).not.toBe('tampered');
    });
    it('starts an authenticated cloud collection automatically on every fresh sign-in', async () => {
        await authChanged(null);
        window._wfRecentSweep = vi.fn(async () => 0);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 }))
            .mockResolvedValueOnce(reply(true, { ok: true, processed: 2 }));
        await authChanged(active);
        expect(fetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
            ['/api/statement-vault', 'GET'],
            ['/api/statement-sync', 'POST'],
        ]);
        expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ action: 'sync' });
        expect(window._wfRecentSweep).toHaveBeenCalledWith(false);
        await authChanged(null);
    });
    it('continues a bounded server backlog without holding one request open for every statement', async () => {
        vi.useFakeTimers();
        try {
            await authChanged(null);
            fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 }))
                .mockResolvedValueOnce(reply(true, { ok: true, processed: 1, morePending: true }))
                .mockResolvedValueOnce(reply(true, { ok: true, processed: 1, morePending: false }));
            await authChanged(active);
            expect(fetch).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(750);
            expect(fetch).toHaveBeenCalledTimes(3);
            await authChanged(null);
        } finally { vi.useRealTimers(); }
    });
    it('honours the server lease delay instead of polling an in-flight statement every 750ms', async () => {
        vi.useFakeTimers();
        try {
            await authChanged(null);
            fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 }))
                .mockResolvedValueOnce(reply(true, { ok: true, processed: 0, morePending: true, retryAfterMs: 5000 }))
                .mockResolvedValueOnce(reply(true, { ok: true, processed: 1, morePending: false }));
            await authChanged(active);
            await vi.advanceTimersByTimeAsync(4999);
            expect(fetch).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetch).toHaveBeenCalledTimes(3);
            await authChanged(null);
        } finally { vi.useRealTimers(); }
    });
    it('keeps automatic sign-in failures silent so Check now owns the single user notification', async () => {
        await authChanged(null); window.notify = vi.fn();
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 1 }))
            .mockResolvedValueOnce(reply(false, { ok: false, reason: 'statement-sync-unavailable' }));
        await authChanged(active);
        expect(window.notify).not.toHaveBeenCalled();
        expect(getState().error).toBe('statement-sync-unavailable');
        await authChanged(null);
    });
    it('never reduces a known autonomous retry to the generic cloud failure toast', () => {
        expect(friendly('statement-worker-retry-required')).toContain('will not block the others');
        expect(friendly('gmail-profile-unavailable')).toContain('automatic retry');
        expect(friendly('cloud-vault-required')).toContain('private cloud vault');
    });
    it('does not turn Check now into a no-op when the module missed the auth callback', async () => {
        await authChanged(null);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 1 }))
            .mockResolvedValueOnce(reply(true, { ok: true, processed: 1 }));
        await (await import('../wealthflow-statement-cloud.js')).status();
        await expect(sync()).resolves.toMatchObject({ ok: true, processed: 1 });
        expect(fetch.mock.calls[1][0]).toBe('/api/statement-sync');
        await authChanged(null);
    });
    it('sends exact passwords only to authenticated vault PUT without local plaintext storage', async () => {
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: false })).mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 1 }));
        const entries = [{ password: ' 01021990 ', kind: 'birthday', format: 'DDMMYYYY' }];
        await save(entries);
        const [path, options] = fetch.mock.calls[1];
        expect(path).toBe('/api/statement-vault');
        expect(options.method).toBe('PUT');
        expect(options.headers.Authorization).toBe('Bearer verified-token');
        expect(JSON.parse(options.body).entries).toEqual(entries);
        expect(window.localStorage.setItem).not.toHaveBeenCalled();
    });
    it('reconciles edited local passwords even when an older cloud vault already exists', async () => {
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 1 }))
            .mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 2 }))
            .mockResolvedValueOnce(reply(true, { ok: true, processed: 0 }));
        await migrateUnlockedVault([{ password: 'new-password' }, { password: 'other-password' }]);
        expect(fetch.mock.calls.map(([path, options]) => [path, options.method])).toEqual([
            ['/api/statement-vault', 'GET'], ['/api/statement-vault', 'PUT'], ['/api/statement-sync', 'POST'],
        ]);
    });
    it('only permits local fallback for an explicitly unconfigured cloud', async () => {
        fetch.mockResolvedValueOnce(reply(false, { ok: false, reason: 'statement-cloud-not-configured' }));
        expect(await save([{ password: 'secret' }])).toEqual({ ok: true, localOnly: true });
        fetch.mockResolvedValueOnce(reply(false, { ok: false, reason: 'vault-storage-unavailable' }));
        await expect(save([{ password: 'secret' }])).rejects.toThrow('vault-storage-unavailable');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('does not report cloud deletion success after a rejected delete', async () => {
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true })).mockResolvedValueOnce(reply(false, { ok: false, reason: 'vault-storage-unavailable' }));
        await expect(remove()).rejects.toThrow('vault-storage-unavailable');
        expect(fetch.mock.calls[1][1].method).toBe('DELETE');
    });
    it('rejects stale identity responses instead of adopting another session state', async () => {
        fetch.mockImplementationOnce(async () => {
            window.firebase.auth = () => ({ currentUser: null });
            return reply(true, { ok: true, saved: true });
        });
        await expect(request('/api/statement-vault')).rejects.toThrow('sign-in-changed');
    });
    it('dismisses a whole statement only after explicit confirmation and server resolution', async () => {
        window.showConfirm = vi.fn(); window.notify = vi.fn();
        dismissReview({ id: 'review-source-id', index: -1 });
        expect(fetch).not.toHaveBeenCalled();
        fetch.mockResolvedValueOnce(reply(true, { ok: true, resolved: true }));
        await window.showConfirm.mock.calls[0][5]();
        expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ action: 'review', id: 'review-source-id', decision: { module: 'skip' } });
        expect(window.notify).toHaveBeenCalledWith('Statement review dismissed securely.', 'info');
    });
    it('does not claim dismissal when a server has not confirmed resolution', async () => {
        window.showConfirm = vi.fn(); window.notify = vi.fn();
        dismissReview({ id: 'review-source-id', index: -1 });
        fetch.mockResolvedValueOnce(reply(true, { ok: true, resolved: false }));
        await window.showConfirm.mock.calls[0][5]();
        expect(window.notify).toHaveBeenCalledWith('Dismissal was not completed. The statement remains pending.', 'error');
    });
    it('opens the single-row review for an invalid-amount row instead of re-teaching an already-read layout', async () => {
        // Reason 'invalid-transaction' (statement-ledger.mjs) fires on an
        // already-indexed row whose amount/date/description failed validation —
        // the layout itself was read fine. Routing this into mapLayout() used to
        // hit mapReviewLayout's "layout-replay-would-overlap-settled-data" guard
        // forever once any sibling row from the same statement had already
        // filed, since re-teaching a known layout can never satisfy it.
        window._showCCReviewModal = vi.fn();
        window.notify = vi.fn();
        const entry = { id: 'row-review-id', index: 4, reason: 'invalid-transaction',
            row: { date: '2026-01-01', amount: 0, description: 'ATM WITHDRAWAL', direction: 'debit', bank: 'HNB' } };
        await review(entry);
        expect(window._showCCReviewModal).toHaveBeenCalledTimes(1);
        const [parsed] = window._showCCReviewModal.mock.calls[0];
        expect(parsed.transactions).toEqual([expect.objectContaining({ date: '2026-01-01', amount: 0, description: 'ATM WITHDRAWAL' })]);
        expect(typeof parsed.cloudReview).toBe('function');
        expect(window.notify).not.toHaveBeenCalledWith('The statement layout mapper is not loaded yet.', 'warn');
        // The raw code must never reach the screen unexplained (flagged by the
        // consensus review board on this exact change): the owner sees why the
        // row needs attention and what to check, not the machine's reason string.
        expect(parsed.transactions[0]._reviewWhy).not.toBe('invalid-transaction');
        expect(parsed.transactions[0]._reviewWhy).toContain('amount, date or description could not be read correctly');
    });
    it('still sends a genuinely unread statement (no row, unmapped index) to the layout teacher', async () => {
        window._showCCReviewModal = vi.fn();
        window.notify = vi.fn();
        await review({ id: 'whole-statement-id', index: -1 });
        expect(window._showCCReviewModal).not.toHaveBeenCalled();
        expect(window.notify).toHaveBeenCalledWith('The statement layout mapper is not loaded yet.', 'warn');
    });
    it('surfaces a broken review modal instead of leaving the click looking like it did nothing', async () => {
        // Before this fix, review() called _showCCReviewModal with no guard: a
        // synchronous throw there unwound through the caller's bare
        // `await review(entry)` as an unhandled rejection — nothing shown to the
        // owner, the button just silently re-enabled. That is indistinguishable
        // from "the button doesn't work", which is exactly what was reported.
        window._showCCReviewModal = vi.fn(() => { throw new Error('modal build failed'); });
        window.notify = vi.fn();
        const entry = { id: 'row-review-id', index: 2, reason: 'unproven-direction',
            row: { date: '2026-01-01', amount: 500, description: 'PAYMENT', direction: 'debit', bank: 'HNB' } };
        await review(entry); // must not throw — the whole point of the fix
        expect(window.notify).toHaveBeenCalledWith(
            'This review could not be opened. It remains pending; try again or download the original statement.', 'error');
        await authChanged(null); // the catch path reopens the list (openReview -> adoptUser); reset it like every other test here does
    });
    it('aggregates why statements are stuck without any date, amount, narration or description — for Diagnostics', async () => {
        // Same two fields the review list already shows the owner on screen
        // (reason + bank), nothing more — this is what "Copy diagnostics" now
        // sends, and it must never carry a figure from anyone's statement.
        const term = { onSnapshot: (ok) => { ok({ docs }); return () => {}; } };
        const docs = [
            { id: 'r1', data: () => ({ reason: 'card-charge-context-required', index: 5, row: { amount: 4250, description: 'KEELLS' }, bank: 'DFCC' }) },
            { id: 'r2', data: () => ({ reason: 'card-charge-context-required', index: 7, row: { amount: 900, description: 'CARGILLS' }, bank: 'DFCC' }) },
            { id: 'r3', data: () => ({ reason: 'statement-layout-or-reconciliation-needs-review', index: -1, bank: 'NTB', filename: 'ntb-aug.pdf', embeddedProblems: ['balance-chain-broken'] }) },
        ];
        window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => term } ) }) }) }) };
        await openReview();
        const summary = reviewSummary();
        expect(summary.total).toBe(3);
        expect(summary.perRow).toBe(2);
        expect(summary.wholeStatement).toBe(1);
        expect(summary.byReason).toEqual({ 'card-charge-context-required': 2, 'statement-layout-or-reconciliation-needs-review': 1 });
        expect(summary.wholeStatements).toEqual([{ bank: 'NTB', filename: 'ntb-aug.pdf', reason: 'statement-layout-or-reconciliation-needs-review', embedded: ['balance-chain-broken'] }]);
        expect(JSON.stringify(summary)).not.toMatch(/4250|900|KEELLS|CARGILLS/);
        await authChanged(null);
    });
    it('surfaces a statement stuck in the server retry loop instead of leaving it invisible until it is quarantined', async () => {
        // processOneStatement()'s transient-failure branch (statement-sync.js)
        // writes lastRetryReason/retryCount to a source on every attempt and
        // keeps it 'pending' for the next backoff window — it never reaches
        // statementReview at all, so a statement can sit here indefinitely
        // with the one fact that explains it recorded server-side and never
        // read back by anything. sync()'s response is the only place that
        // fact is available client-side.
        await authChanged(null);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 1 }))
            .mockResolvedValueOnce(reply(true, {
                ok: true, processed: 0,
                retrying: [{ bank: 'DFCC', filename: 'dfcc-sep.pdf', retryCount: 2, lastRetryReason: 'whole-statement-review-required' }],
            }));
        await authChanged(active);
        expect(retryAttemptsSummary()).toEqual([
            { bank: 'DFCC', filename: 'dfcc-sep.pdf', retryCount: 2, lastRetryReason: 'whole-statement-review-required' },
        ]);
        await authChanged(null);
    });
    it('clears a stale retry summary once a fresh sync reports nothing left retrying', async () => {
        await authChanged(null);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, saved: true, count: 1 }))
            .mockResolvedValueOnce(reply(true, { ok: true, processed: 1, retrying: [{ bank: 'HNB', filename: 'h.pdf', retryCount: 1, lastRetryReason: 'PDF_UNREADABLE' }] }));
        await authChanged(active);
        expect(retryAttemptsSummary()).toHaveLength(1);
        fetch.mockResolvedValueOnce(reply(true, { ok: true, processed: 1 }));
        await sync();
        expect(retryAttemptsSummary()).toEqual([]);
        await authChanged(null);
    });
    describe('an emailed Smart Statement is rendered on the device, like an uploaded one', () => {
        const entry = { id: 'a'.repeat(64), index: -1, filename: 'eStatement_376657XXXXX0276_2026AUG.html', bank: 'AMEX' };
        const shell = '<html><script>draw()</script></html>';
        const gz = text => gzipSync(Buffer.from(text)).toString('base64');
        const bodyOf = n => JSON.parse(fetch.mock.calls[n][1].body);
        beforeEach(() => { window._showCCReviewModal = vi.fn(); window.notify = vi.fn(); });

        it('decrypts server-side, renders on the device and sends back only the rendered document', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<table>drawn rows</table>', transactions: [{ date: '2026-09-14' }] })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, filed: 2, review: 0, replayStatus: 'filed' }));
            await review(entry);
            expect(bodyOf(0)).toEqual({ action: 'render-source', id: entry.id });
            expect(window.WFHtmlStatement.htmlToTransactionsAsync).toHaveBeenCalledWith(shell);
            expect(bodyOf(1)).toMatchObject({ action: 'rendered', id: entry.id });
            expect(gunzipSync(Buffer.from(bodyOf(1).htmlGz, 'base64')).toString()).toBe('<table>drawn rows</table>');
            expect(window._teachStatementLayout).not.toHaveBeenCalled();
            expect(window.notify).toHaveBeenCalledWith('2 statement transactions read on your device and filed.', 'success');
            await authChanged(null);
        });
        it('stops asking after three batches that move nothing, instead of hammering a source that cannot move', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-09-14' }] })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, filed: 0, review: 0, replayStatus: 'pending' }))
                .mockResolvedValue(reply(true, { ok: true, filed: 0, review: 0, queued: true, replayStatus: 'pending' }));
            await review(entry);
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered', 'layout-continue', 'layout-continue', 'layout-continue']);
            expect(window.notify).not.toHaveBeenCalledWith(expect.anything(), 'error');
            await authChanged(null);
        });
        it('continues a long statement in batches and says plainly when the owner still has to confirm it', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-09-14' }] })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, filed: 10, review: 0, replayStatus: 'pending' }))
                .mockResolvedValueOnce(reply(true, { ok: true, filed: 4, review: 0, replayStatus: 'filed' }));
            await review(entry);
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered', 'layout-continue']);
            expect(window.notify).toHaveBeenCalledWith('14 statement transactions read on your device and filed.', 'success');
            window.notify.mockClear(); fetch.mockClear();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, filed: 0, review: 1, replayStatus: 'needs_review' }));
            await review(entry);
            expect(window.notify).toHaveBeenCalledWith(expect.stringContaining('need your confirmation'), 'warn');
            await authChanged(null);
        });
        it('hands a read-but-unreconciled statement to the layout teacher instead of dead-ending, and never re-renders it', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-09-14' }] })), diagnose: vi.fn(() => ({ tables: 1, rows: 4 })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, filed: 0, review: 1, replayStatus: 'needs_review', needsLayout: true }))
                .mockResolvedValueOnce(reply(true, { ok: true, text: '14/09/2026 KEELLS STORE 123.45 DR', bank: 'AMEX', filename: entry.filename }));
            await review(entry);
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered', 'review-source']);
            expect(window._teachStatementLayout).toHaveBeenCalledTimes(1);
            expect(window._wfLayoutAttempts[0]).toMatchObject({ bank: 'AMEX', outcome: 'rendered-on-device', diag: { tables: 1 } });
            expect(JSON.stringify(window._wfLayoutAttempts)).not.toContain('KEELLS');
            // A review marked by the OLDER reader (renderedRead: true) holds text that reader got wrong: render it again.
            window.WFHtmlStatement.htmlToTransactionsAsync.mockClear(); fetch.mockClear();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) })).mockResolvedValueOnce(reply(true, { ok: true, mapped: true, filed: 1, review: 0, replayStatus: 'filed' }));
            await review({ ...entry, renderedRead: true });
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered']);
            window.WFHtmlStatement.htmlToTransactionsAsync.mockClear(); fetch.mockClear();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'rendered rows text', bank: 'AMEX', filename: entry.filename }));
            await review({ ...entry, renderedRead: 3 });
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['review-source']);
            expect(window.WFHtmlStatement.htmlToTransactionsAsync).not.toHaveBeenCalled();
            await authChanged(null);
        });
        describe('autonomously, with nobody tapping anything', () => {
            const html = (id, name, extra = {}) => ({ id, data: () => ({ reason: 'statement-layout-or-reconciliation-needs-review', index: -1, bank: 'AMEX', filename: name, ...extra }) });
            const store = new Map();
            let docs;
            const load = async entries => {
                vi.useFakeTimers();
                docs = entries;
                window.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
                window.db = { collection: () => ({ doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ onSnapshot: ok => { ok({ docs }); return () => {}; } }) }) }) }) }) };
                await openReview();
            };
            afterEach(() => { vi.useRealTimers(); store.clear(); });
            const filedReply = () => reply(true, { ok: true, mapped: true, filed: 5, review: 0, replayStatus: 'filed' });

            it('reads every pending HTML statement itself and skips PDFs and already-read ones', async () => {
                window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<table>x</table>', transactions: [{ date: '2026-07-13' }] })) };
                await load([html('a'.repeat(64), 'amex-jul.html'), html('b'.repeat(64), 'ntb-aug.htm'), html('c'.repeat(64), 'hnb.pdf'), html('d'.repeat(64), 'amex-jun.html', { renderedRead: 3 })]);
                fetch.mockImplementation(async (_, options) => {
                    const body = JSON.parse(options.body);
                    return body.action === 'render-source' ? reply(true, { ok: true, htmlGz: gz(shell) }) : filedReply();
                });
                const done = await autoRenderPending();
                expect(done).toEqual({ statements: 2, filed: 10, needLayout: 0, empty: 0 });
                expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered', 'render-source', 'rendered']);
                expect(window.notify).toHaveBeenCalledWith('10 statement transactions read on your device and filed automatically.', 'success');
                await authChanged(null);
            });
            it('sends a month with no transactions to the server, which alone can tell it from a page that failed to draw', async () => {
                window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<table>balances only</table>', transactions: [] })) };
                await load([html('e'.repeat(64), 'amex-may.html')]);
                fetch.mockImplementation(async (_, options) => JSON.parse(options.body).action === 'render-source'
                    ? reply(true, { ok: true, htmlGz: gz(shell) })
                    : reply(true, { ok: true, mapped: true, filed: 0, review: 0, replayStatus: 'filed', needsLayout: false, why: { noMovement: true, rows: 0 } }));
                const done = await autoRenderPending();
                expect(done).toEqual({ statements: 1, filed: 0, needLayout: 0, empty: 1 });
                expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered']);
                expect(window.notify).toHaveBeenCalledWith('1 statement had no transactions and was closed.', 'info');
                expect(window._wfLayoutAttempts[0].server).toEqual({ noMovement: true, rows: 0 });
                await authChanged(null);
            });
            it('does not retry, for a day, a statement the device could not read — but does retry one that only hit the network', async () => {
                window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: false, renderedHtml: '', transactions: [] })) };
                await load([html('a'.repeat(64), 'amex-jul.html')]);
                fetch.mockResolvedValue(reply(true, { ok: true, htmlGz: gz(shell) }));
                await autoRenderPending();
                expect(fetch).toHaveBeenCalledTimes(1);
                await autoRenderPending();
                expect(fetch).toHaveBeenCalledTimes(1);
                store.clear(); fetch.mockClear();
                fetch.mockResolvedValue(reply(false, { ok: false, reason: 'statement-service-unavailable' }));
                await autoRenderPending();
                await autoRenderPending();
                expect(fetch).toHaveBeenCalledTimes(2);
                await authChanged(null);
            });
            it('does not hammer a statement the server keeps refusing', async () => {
                window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-07-13' }] })) };
                await load([html('a'.repeat(64), 'amex-jul.html')]);
                fetch.mockImplementation(async (_, options) => JSON.parse(options.body).action === 'render-source'
                    ? reply(true, { ok: true, htmlGz: gz(shell) }) : reply(false, { ok: false, reason: 'review-source-owner-mismatch' }));
                await autoRenderPending();
                const first = fetch.mock.calls.length;
                await autoRenderPending();
                expect(fetch.mock.calls.length).toBe(first);
                await authChanged(null);
            });
            it('tells the owner once when statements were read but still need their confirmation', async () => {
                window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-07-13' }] })) };
                await load([html('a'.repeat(64), 'amex-jul.html'), html('b'.repeat(64), 'amex-aug.html')]);
                fetch.mockImplementation(async (_, options) => JSON.parse(options.body).action === 'render-source'
                    ? reply(true, { ok: true, htmlGz: gz(shell) }) : reply(true, { ok: true, mapped: true, filed: 0, review: 1, replayStatus: 'needs_review', needsLayout: true }));
                const done = await autoRenderPending();
                expect(done).toEqual({ statements: 0, filed: 0, needLayout: 2, empty: 0 });
                expect(window.notify).toHaveBeenCalledWith('2 statements were read on your device but need your confirmation. Open the review to confirm.', 'warn');
                await authChanged(null);
            });
            it('starts on its own shortly after the pending statements arrive', async () => {
                window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-07-13' }] })) };
                fetch.mockImplementation(async (_, options) => JSON.parse(options.body).action === 'render-source' ? reply(true, { ok: true, htmlGz: gz(shell) }) : filedReply());
                await load([html('a'.repeat(64), 'amex-jul.html')]);
                expect(fetch).not.toHaveBeenCalled();
                await vi.advanceTimersByTimeAsync(4000);
                await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
                expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered']);
                await authChanged(null);
            });
        });
        it('falls back to the text layout teacher when the device draws no rows', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: false, renderedHtml: '', transactions: [] })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'AMEX', filename: entry.filename }));
            await review(entry);
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'review-source']);
            expect(window._teachStatementLayout).toHaveBeenCalledTimes(1);
            await authChanged(null);
        });
        it('falls back to the teacher when the server reads no rows from what the device rendered', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-09-14' }] })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(false, { ok: false, reason: 'rendered-statement-has-no-rows' }))
                .mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'AMEX', filename: entry.filename }));
            await review(entry);
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['render-source', 'rendered', 'review-source']);
            expect(window._teachStatementLayout).toHaveBeenCalledTimes(1);
            await authChanged(null);
        });
        it('reports a possibly-already-read statement instead of a false failure', async () => {
            window._teachStatementLayout = vi.fn();
            window.WFHtmlStatement = { htmlToTransactionsAsync: vi.fn(async () => ({ rendered: true, renderedHtml: '<p>x</p>', transactions: [{ date: '2026-09-14' }] })) };
            fetch.mockResolvedValueOnce(reply(true, { ok: true, htmlGz: gz(shell) }))
                .mockResolvedValueOnce(reply(false, { ok: false, reason: 'whole-statement-review-required' }));
            await review(entry);
            expect(window.notify).toHaveBeenCalledWith(expect.stringContaining('may already be read'), 'warn');
            expect(window._teachStatementLayout).not.toHaveBeenCalled();
            await authChanged(null);
        });
        it('never takes the render route for a PDF or when no renderer is loaded', async () => {
            window._teachStatementLayout = vi.fn();
            fetch.mockResolvedValue(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }));
            await review({ id: entry.id, index: -1, filename: 'statement.pdf' });
            await review(entry);
            expect(fetch.mock.calls.map((_, n) => bodyOf(n).action)).toEqual(['review-source', 'review-source']);
            await authChanged(null);
        });
    });
    describe('layout confirmation survives a transient network blip', () => {
        // "Yes, read it this way" already did the real work: re-fetching the
        // source, re-proposing a reading, the owner tapping through every date.
        // The ONE call left — confirming it — must not force all of that to be
        // redone just because a mobile connection blipped for a few seconds.
        const teachWith = rows => vi.fn((items, cb) => cb([{ rows }]));
        const oneRow = [{ date: '2026-01-01', amount: 100, direction: 'debit' }];

        it('retries a timed-out confirmation and succeeds without re-teaching the layout', async () => {
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            vi.useFakeTimers();
            try {
                fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                    .mockResolvedValueOnce(reply(false, { ok: false, reason: 'statement-request-timed-out' }))
                    .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, queued: true }));
                const pending = review({ id: 'whole-statement-id', index: -1 });
                await vi.runAllTimersAsync();
                await pending;
                expect(fetch).toHaveBeenCalledTimes(3);
                expect(JSON.parse(fetch.mock.calls[1][1].body)).toMatchObject({ action: 'layout' });
                expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ action: 'layout' });
                expect(window.notify).toHaveBeenCalledWith('Statement layout verified. Remaining rows are continuing in the background.', 'info');
            } finally { vi.useRealTimers(); await authChanged(null); }
        });
        it('retries a raw dropped-connection failure, not just a named timeout', async () => {
            // Flagged by an automated (Codex) review: fetch() itself rejects a
            // dropped connection or DNS failure with a browser-native TypeError
            // per the Fetch spec, not an AbortError — request() used to rethrow
            // that unchanged, so it matched neither retryable reason and the
            // single most common real "no network" case never retried at all.
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            vi.useFakeTimers();
            try {
                fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                    .mockRejectedValueOnce(new TypeError('Failed to fetch'))
                    .mockResolvedValueOnce(reply(true, { ok: true, mapped: true, queued: true }));
                const pending = review({ id: 'whole-statement-id', index: -1 });
                await vi.runAllTimersAsync();
                await pending;
                expect(fetch).toHaveBeenCalledTimes(3);
                expect(window.notify).toHaveBeenCalledWith('Statement layout verified. Remaining rows are continuing in the background.', 'info');
            } finally { vi.useRealTimers(); await authChanged(null); }
        });
        it('never retries a permanent rejection like an unreproduced statement', async () => {
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                .mockResolvedValueOnce(reply(false, { ok: false, reason: 'layout-confirmation-does-not-reproduce-statement' }));
            // mapLayout() does not await _teachStatementLayout()'s callback (the
            // owner's dialog interaction is not something the outer call can
            // block on), so review() itself resolves before the callback's own
            // async work — including this rejection — has run. Poll for it,
            // the same way this file already does for the fastest/collective race.
            review({ id: 'whole-statement-id', index: -1 });
            await vi.waitFor(() => expect(window.notify).toHaveBeenCalled());
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(window.notify).toHaveBeenCalledWith('Cloud layout saving was not completed. The original statement remains pending.', 'error');
            await authChanged(null);
        });
        it('reports a possibly-already-mapped statement distinctly instead of a false hard failure', async () => {
            // The exact scenario a retry can create: attempt 1 succeeds server-side
            // but its response never reaches the client (pure network drop); a
            // retry then hits mapReviewLayout's own replay guard. That must read
            // as "check the real state", never as "nothing happened" — the
            // statement genuinely may already be filed.
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                .mockResolvedValueOnce(reply(false, { ok: false, reason: 'layout-replay-would-overlap-settled-data' }));
            review({ id: 'whole-statement-id', index: -1 });
            await vi.waitFor(() => expect(window.notify).toHaveBeenCalled());
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(window.notify).toHaveBeenCalledWith(expect.stringContaining('may already be confirmed'), 'warn');
            await authChanged(null);
        });
        it('reports whole-statement-review-required the same way — inspect() throws it FIRST, before the replay guard, for this exact lost-response case', async () => {
            // Flagged by an automated (Codex) review on this exact PR: when
            // attempt 1 commits but its response is lost, mapReviewLayout's own
            // replay guard is never reached on the retry — inspect() (which it
            // calls first, every attempt) rejects with this reason as soon as it
            // sees the review is no longer 'pending'. Treating it as an ordinary
            // permanent failure would tell the owner nothing happened when the
            // statement may already be filed.
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                .mockResolvedValueOnce(reply(false, { ok: false, reason: 'whole-statement-review-required' }));
            review({ id: 'whole-statement-id', index: -1 });
            await vi.waitFor(() => expect(window.notify).toHaveBeenCalled());
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(window.notify).toHaveBeenCalledWith(expect.stringContaining('may already be confirmed'), 'warn');
            await authChanged(null);
        });
        it('never retries a deterministically unreadable PDF', async () => {
            // Flagged by an automated (Codex) review: PDF_UNREADABLE is a real,
            // permanent server reason (PUBLIC_REVIEW_SOURCE_REASONS) — retrying
            // downloads and re-parses the same broken PDF up to two more times
            // for no possible benefit.
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                .mockResolvedValueOnce(reply(false, { ok: false, reason: 'PDF_UNREADABLE' }));
            review({ id: 'whole-statement-id', index: -1 });
            await vi.waitFor(() => expect(window.notify).toHaveBeenCalled());
            expect(fetch).toHaveBeenCalledTimes(2);
            expect(window.notify).toHaveBeenCalledWith('Cloud layout saving was not completed. The original statement remains pending.', 'error');
            await authChanged(null);
        });
        it('gives up after a bounded number of retries rather than retrying forever', async () => {
            window._showCCReviewModal = vi.fn();
            window._teachStatementLayout = teachWith(oneRow);
            window.notify = vi.fn();
            vi.useFakeTimers();
            try {
                fetch.mockResolvedValueOnce(reply(true, { ok: true, text: 'STATEMENT TEXT', bank: 'HNB', filename: 's.pdf' }))
                    .mockResolvedValue(reply(false, { ok: false, reason: 'statement-service-unavailable' }));
                const pending = review({ id: 'whole-statement-id', index: -1 });
                await vi.runAllTimersAsync();
                await pending;
                expect(fetch).toHaveBeenCalledTimes(4); // review-source + 3 layout attempts (1 initial + 2 retries)
                expect(window.notify).toHaveBeenCalledWith('Cloud layout saving was not completed. The original statement remains pending.', 'error');
            } finally { vi.useRealTimers(); await authChanged(null); }
        });
    });
});
