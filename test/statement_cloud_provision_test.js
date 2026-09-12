import { describe, it, expect, vi } from 'vitest';
import { provisionStatementCloud } from '../provision-statement-cloud.mjs';

const env = { GOOGLE_CLOUD_PROJECT: 'wealthflow-test', STATEMENT_SERVICE_ACCOUNT: 'worker@wealthflow-test.iam.gserviceaccount.com', STATEMENT_SYNC_ORIGIN: 'https://wealthflow.example', CRON_SECRET: 'a'.repeat(32) };
describe('statement cloud provisioning', () => {
    it('rejects unsafe input before administrator commands', async () => {
        const run = vi.fn();
        await expect(provisionStatementCloud({ env: { ...env, CRON_SECRET: 'a'.repeat(32) + '\n' }, run })).rejects.toThrow('printable');
        await expect(provisionStatementCloud({ env: { ...env, STATEMENT_SYNC_ORIGIN: 'https://example.com/path' }, run })).rejects.toThrow('HTTPS origin');
        expect(run).not.toHaveBeenCalled();
    });
    it('preserves conditional IAM and reapplies existing queue and scheduler configuration without exposing credentials', async () => {
        const calls = [];
        const condition = { expression: 'request.time < timestamp("2030-01-01T00:00:00Z")', title: 'temporary-access' };
        const f = async (url, init) => {
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ url, method: init.method, body });
            if (url.endsWith('/queues') || url.endsWith('/jobs')) return { status: 409, ok: false };
            return { status: 200, ok: true, json: async () => url.includes(':getIamPolicy') ? { version: 3, etag: 'preserved', bindings: [{ role: 'roles/viewer', members: ['user:admin@example.com'], condition }] } : {} };
        };
        const run = vi.fn((command, args) => args.includes('print-access-token') ? 'private-admin-token' : '');
        const result = await provisionStatementCloud({ env, f, run });
        expect(calls.find(c => c.url.includes('cloudkms') && c.url.includes(':getIamPolicy')).url).toContain('requestedPolicyVersion=3');
        expect(calls.find(c => c.url.includes('cloudtasks') && c.url.includes(':getIamPolicy')).body).toEqual({ options: { requestedPolicyVersion: 3 } });
        for (const call of calls.filter(c => c.url.includes(':setIamPolicy'))) {
            expect(call.body.policy.etag).toBe('preserved');
            expect(call.body.policy.bindings[0].condition).toEqual(condition);
        }
        const queue = calls.find(c => c.method === 'PATCH' && c.url.includes('/queues/'));
        expect(queue.url).toContain('updateMask=rateLimits,retryConfig');
        expect(queue.body.rateLimits.maxConcurrentDispatches).toBe(1);
        expect(calls.find(c => c.method === 'PATCH' && c.url.includes('/jobs/')).body.schedule).toBe('* * * * *');
        expect(JSON.stringify(result)).not.toContain(env.CRON_SECRET);
        expect(JSON.stringify(result)).not.toContain('private-admin-token');
        expect(JSON.stringify(run.mock.calls)).not.toContain(env.CRON_SECRET);
    });
});
