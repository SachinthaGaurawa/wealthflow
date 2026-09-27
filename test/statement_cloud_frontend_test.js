import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, save, remove, sync, dismissReview, authChanged, getState, migrateUnlockedVault, friendly, review } from '../wealthflow-statement-cloud.js';

const active = { uid: 'owner', getIdToken: vi.fn(async () => 'verified-token') };
const reply = (ok, body) => ({ ok, json: async () => body });
beforeEach(() => {
    vi.stubGlobal('window', { firebase: { auth: () => ({ currentUser: active }) }, dispatchEvent: vi.fn(), localStorage: { setItem: vi.fn() }, _wfRecentSweep: vi.fn(async () => 0) });
    vi.stubGlobal('CustomEvent', class { constructor(type, options) { this.type = type; this.detail = options.detail; } });
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

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
});
