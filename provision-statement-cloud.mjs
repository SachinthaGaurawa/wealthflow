import { execFileSync } from 'node:child_process';

// Run from an authenticated administrator terminal. No secrets are printed or
// passed as process arguments. Existing IAM bindings are preserved.
const env = process.env;
const project = env.GOOGLE_CLOUD_PROJECT;
const location = env.STATEMENT_CLOUD_LOCATION || 'asia-south1';
const serviceAccount = env.STATEMENT_SERVICE_ACCOUNT;
const origin = env.STATEMENT_SYNC_ORIGIN;
const secret = env.CRON_SECRET;
if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project || '') || !/^[a-z]+-[a-z]+\d$/.test(location) || !/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount || '') || !secret || secret.length < 24) throw new Error('Set GOOGLE_CLOUD_PROJECT, STATEMENT_SERVICE_ACCOUNT, STATEMENT_SYNC_ORIGIN and a CRON_SECRET of at least 24 characters.');
const url = new URL(origin);
if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('STATEMENT_SYNC_ORIGIN must be an HTTPS origin.');
const token = execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
async function request(url, method = 'GET', body, tolerateConflict = false) {
    const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (tolerateConflict && response.status === 409) return null;
    if (!response.ok) throw new Error(`Cloud provisioning failed (${response.status}) for ${new URL(url).pathname}.`);
    return response.status === 204 ? {} : response.json();
}
execFileSync('gcloud', ['services', 'enable', 'cloudkms.googleapis.com', 'cloudtasks.googleapis.com', 'cloudscheduler.googleapis.com', '--project', project, '--quiet'], { stdio: 'inherit' });
const root = `projects/${project}/locations/${location}`;
const keyRing = `${root}/keyRings/wealthflow-statements`;
const key = `${keyRing}/cryptoKeys/vault`;
const queue = `${root}/queues/wealthflow-statements`;
await request(`https://cloudkms.googleapis.com/v1/${root}/keyRings?keyRingId=wealthflow-statements`, 'POST', {}, true);
await request(`https://cloudkms.googleapis.com/v1/${keyRing}/cryptoKeys?cryptoKeyId=vault`, 'POST', { purpose: 'ENCRYPT_DECRYPT', versionTemplate: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protectionLevel: 'SOFTWARE' } }, true);
const policy = await request(`https://cloudkms.googleapis.com/v1/${key}:getIamPolicy`);
policy.bindings ||= [];
let binding = policy.bindings.find(b => b.role === 'roles/cloudkms.cryptoKeyEncrypterDecrypter' && !b.condition);
if (!binding) { binding = { role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter', members: [] }; policy.bindings.push(binding); }
const member = `serviceAccount:${serviceAccount}`;
if (!binding.members.includes(member)) binding.members.push(member);
await request(`https://cloudkms.googleapis.com/v1/${key}:setIamPolicy`, 'POST', { policy });
await request(`https://cloudtasks.googleapis.com/v2/${root}/queues`, 'POST', { queue: { name: queue, rateLimits: { maxDispatchesPerSecond: 1, maxConcurrentDispatches: 1 }, retryConfig: { maxAttempts: 20, maxRetryDuration: '86400s', minBackoff: '10s', maxBackoff: '3600s', maxDoublings: 5 } } }, true);
// Queue-scoped enqueuing is sufficient; no project-wide task administration.
const queuePolicy = await request(`https://cloudtasks.googleapis.com/v2/${queue}:getIamPolicy`, 'POST', {});
queuePolicy.bindings ||= [];
let enqueue = queuePolicy.bindings.find(b => b.role === 'roles/cloudtasks.enqueuer' && !b.condition);
if (!enqueue) { enqueue = { role: 'roles/cloudtasks.enqueuer', members: [] }; queuePolicy.bindings.push(enqueue); }
if (!enqueue.members.includes(member)) enqueue.members.push(member);
await request(`https://cloudtasks.googleapis.com/v2/${queue}:setIamPolicy`, 'POST', { policy: queuePolicy });
const jobName = `${root}/jobs/wealthflow-statement-catchup`;
const job = { name: jobName, schedule: '* * * * *', timeZone: 'Etc/UTC', attemptDeadline: '60s', retryConfig: { retryCount: 3, minBackoffDuration: '10s', maxBackoffDuration: '60s' }, httpTarget: { uri: url.origin + '/api/statement-sync', httpMethod: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: Buffer.from('{}').toString('base64') } };
const created = await request(`https://cloudscheduler.googleapis.com/v1/${root}/jobs`, 'POST', job, true);
if (!created) await request(`https://cloudscheduler.googleapis.com/v1/${jobName}?updateMask=schedule,timeZone,attemptDeadline,retryConfig,httpTarget`, 'PATCH', job);
console.log(JSON.stringify({ STATEMENT_VAULT_KMS_KEY: key, STATEMENT_TASK_QUEUE: queue, STATEMENT_SYNC_ORIGIN: url.origin, scheduler: jobName, secret: 'configured; not displayed' }, null, 2));
