/* =============================================================================
 * test/feedback_status_contract_test.js
 * -----------------------------------------------------------------------------
 * THE RETURN PATH: /api/feedback-status tells the app when the owner's feedback
 * has actually been fixed and shipped. Auditing both ends of that contract
 * — what feedback-status.js EMITS against what the client READS — turned up two
 * fields the server computes and nobody consumes.
 *
 *   1. wontFix. An issue closed as "not planned" comes back
 *      { completed: false, wontFix: true }. The client's status mapping was
 *          completed ? 'completed' : needsHuman ? … : inProgress ? … : 'open'
 *      so a DECLINED report fell through to 'open' and sat in the app as
 *      still-pending forever — re-polled every cycle, never marked seen. The
 *      owner would wait indefinitely for an answer already given.
 *
 *   2. ok:false. feedback-status.js send() defaults to HTTP 200, and its
 *      not_configured branch returns { ok:false, reason:'not_configured' }
 *      through it. The client checked only `r.ok` — the HTTP status — so a
 *      server with no GitHub token was indistinguishable from "nothing has
 *      completed yet". The handler's own comment says exactly this must not
 *      happen: "a missing token must not look like 'your feedback was
 *      ignored'". It populated the field. Nobody read it.
 *
 * Both are the same defect this repository keeps producing — an answer computed,
 * transmitted, and never consumed — and both are only visible by comparing the
 * two sides. Neither end's own tests could see it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { summarise } from '../feedback-status.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');

const issue = (over = {}) => ({ number: 42, state: 'open', title: 'x', labels: [], comments: 0, ...over });

describe('the server still emits what the client depends on', () => {
    it('produces every field the client reads', () => {
        // If a rename drops one of these the app silently loses a status, so the
        // dependency is pinned from the consumer's side.
        const s = summarise(issue({ state: 'closed', state_reason: 'completed' }), []);
        for (const k of ['number', 'completed', 'wontFix', 'needsHuman', 'inProgress', 'shippedVersion']) {
            expect(s, `summarise() no longer emits "${k}"`).toHaveProperty(k);
        }
    });

    it('marks a declined issue wontFix and NOT completed', () => {
        const s = summarise(issue({ state: 'closed', state_reason: 'not_planned' }), []);
        expect(s.completed).toBe(false);
        expect(s.wontFix).toBe(true);
    });

    it('marks a genuinely fixed issue completed and not wontFix', () => {
        const s = summarise(issue({ state: 'closed', state_reason: 'completed' }), []);
        expect(s.completed).toBe(true);
        expect(s.wontFix).toBe(false);
    });

    it('flags ai-stuck and ai-working distinctly', () => {
        expect(summarise(issue({ labels: [{ name: 'ai-stuck' }] }), []).needsHuman).toBe(true);
        expect(summarise(issue({ labels: [{ name: 'ai-working' }] }), []).inProgress).toBe(true);
    });
});

describe('the client now consumes wontFix', () => {
    it('maps a declined report to "declined", not "open"', () => {
        expect(SRC).toMatch(/st\.wontFix \? 'declined'/);
    });

    it('stops re-polling a decision once it has been seen', () => {
        // Without this a declined report is fetched on every cycle forever,
        // because only `completed` ever set _completedSeen.
        expect(SRC).toMatch(/if \(st\.wontFix && !x\._completedSeen\) \{ next\._completedSeen = true;/);
    });

    it('still puts completed ahead of every other state', () => {
        // Ordering matters: a fixed issue that also carries ai-stuck must read
        // as fixed, not as needing attention.
        const m = /_status: st\.completed \? 'completed'[\s\S]{0,220}?'open'/.exec(SRC);
        expect(m, 'the status mapping has moved — retarget this test').toBeTruthy();
        expect(m[0].indexOf("'completed'")).toBeLessThan(m[0].indexOf("'declined'"));
        expect(m[0].indexOf("'declined'")).toBeLessThan(m[0].indexOf("'needs-attention'"));
    });
});

describe('the client no longer mistakes a broken server for an empty result', () => {
    it('inspects the body flag, not just the HTTP status', () => {
        // The whole point: send() answers ok:false with HTTP 200, so r.ok is
        // true and tells the client nothing.
        expect(SRC).toMatch(/if \(j && j\.ok === false\)/);
    });

    it('records the reason instead of swallowing it', () => {
        expect(SRC).toMatch(/_feedbackStatusDown = j\.reason \|\| 'unavailable'/);
        expect(SRC).toMatch(/console\.warn\('\[wfUpdate\] feedback status unavailable:'/);
    });

    it('clears the flag once a healthy response arrives', () => {
        // A sticky error would make one bad poll look permanent.
        expect(SRC).toMatch(/_feedbackStatusDown = null;/);
    });

    it('exposes the reason so it can be proven, not just logged', () => {
        expect(SRC).toMatch(/_feedbackStatusReason: \(\) => _feedbackStatusDown/);
    });
});

describe('the not_configured response really does arrive as HTTP 200', () => {
    it('send() defaults to 200, which is why the body flag is load-bearing', () => {
        // If this ever changes to a non-2xx the client's r.ok check would start
        // catching it — but the body check must stay either way, and this
        // records WHY the extra check exists.
        const server = fs.readFileSync(path.join(ROOT, 'feedback-status.js'), 'utf8');
        expect(server).toMatch(/function send\(res, body, status = 200\)/);
        const notConfigured = server.slice(server.indexOf("reason: 'not_configured'") - 200, server.indexOf("reason: 'not_configured'") + 200);
        expect(notConfigured).toMatch(/ok: false/);
        expect(notConfigured).not.toMatch(/\b(4\d\d|5\d\d)\b/);   // no explicit error status
    });
});
