#!/usr/bin/env node
/* Prints how many seconds the fix workflow should wait before starting (see feedback-group.mjs).
 * Reads the open user-feedback issues from GitHub. Any failure prints 0: waiting is a courtesy, never a blocker. */
import { quietWaitSeconds } from './feedback-group.mjs';

const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
async function main() {
    if (!token || !repo || process.env.GITHUB_EVENT_NAME !== 'issues') return 0;
    const r = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&labels=user-feedback&per_page=50&sort=created&direction=desc`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wealthflow-autonomy' },
    });
    if (!r.ok) return 0;
    const rows = (await r.json()).filter((i) => !i.pull_request && !(i.labels || []).some((l) => ['ai-working', 'ai-stuck', 'ai-fixed'].includes(String(l.name))));
    if (!rows.length) return 0;
    // a crash or a security report does not wait for company
    if (rows.some((i) => (i.labels || []).some((l) => ['crash', 'security'].includes(String(l.name).toLowerCase())))) return 0;
    const times = rows.map((i) => Date.parse(i.created_at)).filter(Number.isFinite);
    return quietWaitSeconds({ now: Date.now(), newestAt: Math.max(...times), oldestAt: Math.min(...times) });
}
main().then((s) => console.log(String(s)), () => console.log('0'));
