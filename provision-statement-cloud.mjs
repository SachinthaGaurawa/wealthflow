import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Run from an authenticated administrator terminal. No secrets are printed or
// passed as process arguments. Existing IAM bindings are preserved.
export async function provisionStatementCloud({ env = process.env, f = fetch, run = execFileSync } = {}) {
const project = env.GOOGLE_CLOUD_PROJECT;
const location = env.STATEMENT_CLOUD_LOCATION || 'asia-south1';
const serviceAccount = env.STATEMENT_SERVICE_ACCOUNT;
const origin = env.STATEMENT_SYNC_ORIGIN;
const secret = env.CRON_SECRET;
if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project || '') || !/^[a-z]+-[a-z]+\d$/.test(location) || !/^[\w.-]+@[\w.-]+\.iam\.gserviceaccount\.com$/.test(serviceAccount || '') || typeof secret !== 'string' || secret.length < 24 || /[^\x21-\x7e]/.test(secret)) throw new Error('Set GOOGLE_CLOUD_PROJECT, STATEMENT_SERVICE_ACCOUNT, STATEMENT_SYNC_ORIGIN and a printable CRON_SECRET of at least 24 characters.');
const url = new URL(origin);
if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('STATEMENT_SYNC_ORIGIN must be an HTTPS origin.');
const token = run('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
if (!token) throw new Error('Cloud administrator access token is unavailable.');
async function request(url, method = 'GET', body, tolerateConflict = false) {
    const response = await f(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    if (tolerateConflict && response.status === 409) return null;
    if (!response.ok) throw new Error(`Cloud provisioning failed (${response.status}) for ${new URL(url).pathname}.`);
    return response.status === 204 ? {} : response.json();
}
run('gcloud', ['services', 'enable', 'cloudkms.googleapis.com', 'cloudtasks.googleapis.com', 'cloudscheduler.googleapis.com', '--project', project, '--quiet'], { stdio: 'inherit' });
const root = `projects/${project}/locations/${location}`;
const keyRing = `${root}/keyRings/wealthflow-statements`;
const key = `${keyRing}/cryptoKeys/vault`;
const queue = `${root}/queues/wealthflow-statements`;
await request(`https://cloudkms.googleapis.com/v1/${root}/keyRings?keyRingId=wealthflow-statements`, 'POST', {}, true);
await request(`https://cloudkms.googleapis.com/v1/${keyRing}/cryptoKeys?cryptoKeyId=vault`, 'POST', { purpose: 'ENCRYPT_DECRYPT', versionTemplate: { algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION', protectionLevel: 'SOFTWARE' } }, true);
// Version 3 preserves existing conditional bindings during the read-modify-write.
const policy = await request(`https://cloudkms.googleapis.com/v1/${key}:getIamPolicy?options.requestedPolicyVersion=3`);
policy.bindings ||= [];
let binding = policy.bindings.find(b => b.role === 'roles/cloudkms.cryptoKeyEncrypterDecrypter' && !b.condition);
if (!binding) { binding = { role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter', members: [] }; policy.bindings.push(binding); }
const member = `serviceAccount:${serviceAccount}`;
if (!binding.members.includes(member)) binding.members.push(member);
await request(`https://cloudkms.googleapis.com/v1/${key}:setIamPolicy`, 'POST', { policy });
const queueBody = { name: queue, rateLimits: { maxDispatchesPerSecond: 1, maxConcurrentDispatches: 1 }, retryConfig: { maxAttempts: 20, maxRetryDuration: '86400s', minBackoff: '10s', maxBackoff: '3600s', maxDoublings: 5 } };
const createdQueue = await request(`https://cloudtasks.googleapis.com/v2/${root}/queues`, 'POST', { queue: queueBody }, true);
if (!createdQueue) await request(`https://cloudtasks.googleapis.com/v2/${queue}?updateMask=rateLimits,retryConfig`, 'PATCH', queueBody);
// Queue-scoped enqueuing is sufficient; no project-wide task administration.
const queuePolicy = await request(`https://cloudtasks.googleapis.com/v2/${queue}:getIamPolicy`, 'POST', { options: { requestedPolicyVersion: 3 } });
queuePolicy.bindings ||= [];
let enqueue = queuePolicy.bindings.find(b => b.role === 'roles/cloudtasks.enqueuer' && !b.condition);
if (!enqueue) { enqueue = { role: 'roles/cloudtasks.enqueuer', members: [] }; queuePolicy.bindings.push(enqueue); }
if (!enqueue.members.includes(member)) enqueue.members.push(member);
await request(`https://cloudtasks.googleapis.com/v2/${queue}:setIamPolicy`, 'POST', { policy: queuePolicy });
const jobName = `${root}/jobs/wealthflow-statement-catchup`;
const job = { name: jobName, schedule: '* * * * *', timeZone: 'Etc/UTC', attemptDeadline: '60s', retryConfig: { retryCount: 3, minBackoffDuration: '10s', maxBackoffDuration: '60s' }, httpTarget: { uri: url.origin + '/api/statement-sync', httpMethod: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: Buffer.from('{}').toString('base64') } };
const created = await request(`https://cloudscheduler.googleapis.com/v1/${root}/jobs`, 'POST', job, true);
if (!created) await request(`https://cloudscheduler.googleapis.com/v1/${jobName}?updateMask=schedule,timeZone,attemptDeadline,retryConfig,httpTarget`, 'PATCH', job);
return { STATEMENT_VAULT_KMS_KEY: key, STATEMENT_TASK_QUEUE: queue, STATEMENT_SYNC_ORIGIN: url.origin, scheduler: jobName, secret: 'configured; not displayed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    console.log(JSON.stringify(await provisionStatementCloud(), null, 2));
}
