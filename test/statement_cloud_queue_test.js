import { describe, it, expect } from 'vitest';
import { queueConfig, enqueueStatementSync } from '../statement-cloud-queue.mjs';

const env = { STATEMENT_TASK_QUEUE: 'projects/test/locations/asia-south1/queues/statements', STATEMENT_SYNC_ORIGIN: 'https://wealthflow.example', CRON_SECRET: 'x'.repeat(32) };
describe('durable statement task dispatch', () => {
    it('rejects destinations that could leak the scheduling credential', () => {
        for (const origin of ['http://example.org', 'https://user:pass@example.org', 'https://example.org/path', 'https://example.org/?x=1'])
            expect(() => queueConfig({ ...env, STATEMENT_SYNC_ORIGIN: origin })).toThrow();
        expect(() => queueConfig({ ...env, CRON_SECRET: 'short' })).toThrow();
    });
    it('uses deterministic task identity and authenticated bounded POST', async () => {
        let request;
        const f = async (url, options) => { request = { url, options }; return { ok: true, status: 200 }; };
        expect(await enqueueStatementSync({ env, f, identity: 'source-123', tokenProvider: async () => 'cloud-token' })).toEqual({ queued: true });
        const task = JSON.parse(request.options.body).task;
        expect(task.name).toMatch(/tasks\/statement-[a-f0-9]{64}$/);
        expect(task.httpRequest.url).toBe('https://wealthflow.example/api/statement-sync');
        expect(task.httpRequest.headers.Authorization).toBe('Bearer ' + env.CRON_SECRET);
        expect(request.options.headers.Authorization).toBe('Bearer cloud-token');
        expect(request.options.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString())).toEqual({ action: 'drain' });
    });
    it('accepts duplicate task creation and exposes retries on transport failure', async () => {
        const opts = { env, identity: 'same', tokenProvider: async () => 'token' };
        await expect(enqueueStatementSync({ ...opts, f: async () => ({ ok: false, status: 409 }) })).resolves.toEqual({ queued: true });
        await expect(enqueueStatementSync({ ...opts, f: async () => ({ ok: false, status: 500 }) })).rejects.toThrow('statement-queue-unavailable');
    });
});
