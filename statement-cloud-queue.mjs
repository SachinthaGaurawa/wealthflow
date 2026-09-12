import { createHash, randomUUID } from 'node:crypto';
import { cloudAccessToken } from './statement-cloud-vault.mjs';

export function queueConfig(env = process.env) {
    if (!/^projects\/[\w.:-]+\/locations\/[\w-]+\/queues\/[\w-]+$/.test(env.STATEMENT_TASK_QUEUE || '')) throw new Error('statement-queue-not-configured');
    let origin;
    try { origin = new URL(env.STATEMENT_SYNC_ORIGIN); } catch (_) { throw new Error('statement-origin-not-configured'); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('statement-origin-invalid');
    if (!env.CRON_SECRET || env.CRON_SECRET.length < 24) throw new Error('statement-schedule-secret-not-configured');
    return { queue: env.STATEMENT_TASK_QUEUE, url: origin.origin + '/api/statement-sync' };
}

export async function enqueueStatementSync({ env = process.env, f = fetch, identity = randomUUID(), tokenProvider = cloudAccessToken } = {}) {
    const { queue, url } = queueConfig(env);
    const token = await tokenProvider(env, f);
    const id = createHash('sha256').update(identity).digest('hex');
    const task = { name: `${queue}/tasks/statement-${id}`, httpRequest: { httpMethod: 'POST', url,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.CRON_SECRET}` },
        body: Buffer.from('{"action":"drain"}').toString('base64') }, dispatchDeadline: '60s' };
    try {
        const r = await f(`https://cloudtasks.googleapis.com/v2/${queue}/tasks`, { method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ task }), signal: AbortSignal.timeout(8000) });
        if (!r.ok && r.status !== 409) throw new Error();
        return { queued: true };
    } catch (_) { throw new Error('statement-queue-unavailable'); }
}
