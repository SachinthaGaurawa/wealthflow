import { describe, it, expect } from 'vitest';
import { messagesSince, recentMessages } from '../gmail-hook.js';

const reply = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const event = id => ({ messagesAdded: [{ message: { id } }] });

describe('history cursor durability', () => {
    it('backfills every exact-sender page when history expires', async () => {
        const urls = [];
        const result = await recentMessages('token', async url => {
            urls.push(url);
            return reply(urls.length === 1
                ? { messages: [{ id: 'a' }], nextPageToken: 'next' }
                : { messages: [{ id: 'b' }] });
        }, 25, ['from:statements@bank.example']);
        expect(result).toEqual({ ok: true, ids: ['a', 'b'] });
        expect(decodeURIComponent(urls[0])).toContain('{from:statements@bank.example}');
        expect(urls[1]).toContain('pageToken=next');
    });
    it('never queries a mailbox with an empty whitelist', async () => {
        let calls = 0;
        expect(await recentMessages('token', async () => { calls++; }, 25, [])).toEqual({ ok: true, ids: [] });
        expect(calls).toBe(0);
    });
    it('collects every page and deduplicates redelivered message IDs', async () => {
        const urls = [];
        const result = await messagesSince('token', '10', async url => {
            urls.push(url);
            return urls.length === 1
                ? reply({ history: [event('a')], historyId: '30', nextPageToken: 'next + page' })
                : reply({ history: [event('a'), event('b')], historyId: '30' });
        });
        expect(result).toEqual({ ok: true, ids: ['a', 'b'], historyId: '30' });
        expect(urls[1]).toContain('pageToken=next%20%2B%20page');
    });
    it('never exposes a committable cursor after a later page fails', async () => {
        let calls = 0;
        const result = await messagesSince('token', '10', async () => ++calls === 1
            ? reply({ history: [event('a')], historyId: '30', nextPageToken: 'next' })
            : reply({}, 503));
        expect(result.ok).toBe(false);
        expect(result.historyId).toBeUndefined();
    });
    it('stops cyclic pagination without claiming success', async () => {
        let calls = 0;
        const result = await messagesSince('token', '10', async () => {
            calls++;
            return reply({ nextPageToken: 'same', historyId: '30' });
        });
        expect(calls).toBe(2);
        expect(result).toEqual({ ok: false, reason: 'history-pagination-incomplete' });
    });
    it('reports transport failures as retryable without advancing', async () => {
        const result = await messagesSince('token', '10', async () => { throw new Error('offline'); });
        expect(result).toEqual({ ok: false, reason: 'history-unavailable' });
    });
});
