import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request, save, remove, dismissReview } from '../wealthflow-statement-cloud.js';

const active = { uid: 'owner', getIdToken: vi.fn(async () => 'verified-token') };
const reply = (ok, body) => ({ ok, json: async () => body });
beforeEach(() => {
    vi.stubGlobal('window', { firebase: { auth: () => ({ currentUser: active }) }, dispatchEvent: vi.fn(), localStorage: { setItem: vi.fn() } });
    vi.stubGlobal('CustomEvent', class { constructor(type, options) { this.type = type; this.detail = options.detail; } });
    vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('private statement cloud frontend transport', () => {
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
});
