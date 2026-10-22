/* =============================================================================
 * test/discover_liveness_test.js
 * -----------------------------------------------------------------------------
 * All four runs the discovery workflow has ever had were cancelled at the
 * 15-minute timeout. The owner read the run summary — "✅ Autonomous discovery
 * — nothing actionable. Every detector ran and found nothing to file." — and
 * reasonably concluded the agent was blind and looping.
 *
 * It was neither. Three separate defects compounded:
 *
 *   1. harden-runner runs this job with disable-sudo: true, and
 *      `playwright install --with-deps` shells out to `sudo apt-get`. The
 *      install failed on every run: "sudo: a password is required".
 *   2. continue-on-error swallowed that, so the step reported success and the
 *      scan ran with no browser — losing every detector that needs a live page.
 *   3. A FAILED Playwright launch leaks a handle that keeps node alive forever.
 *      All output arrived one second in; the runner killed the process as an
 *      orphan fourteen minutes later.
 *
 * The worst of the three is not the timeout. It is that the summary asserted
 * "Every detector ran" on a run where half of them never started, turning an
 * outage into a clean bill of health.
 *
 * These tests run the real script as a subprocess, because the failure only
 * appears in process-exit behaviour that no in-process assertion can observe.
 * ===========================================================================*/

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/autonomous-discover.yml'), 'utf8');

/**
 * Run discover.mjs the way CI does and report exit status + step summary.
 * A hard timeout is the point of the test: the bug WAS the absence of an exit.
 */
function runDiscover({ args = [], breakBrowser = false, timeoutMs = 90_000, auditTimeoutMs = 12_000, npmStub = null } = {}) {
    const summary = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wf-disc-')), 'summary.md');
    // `npm audit` is a registry call. Left unbounded, a slow registry ate the whole 60 s budget of the
    // tests below (CI: 3 failures, "Terminate orphan process (npm audit)"), so the scanner is given a short,
    // explicit audit budget here. A stub `npm` first on PATH stands in for the registry when a test needs
    // a particular answer from it.
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summary, WF_AUDIT_TIMEOUT_MS: String(auditTimeoutMs) };
    if (npmStub) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-npm-'));
        fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\n${npmStub}\n`, { mode: 0o755 });
        env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
    }
    if (breakBrowser) env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent-on-purpose';
    const r = spawnSync(process.execPath, ['autonomy/discover.mjs', ...args], {
        cwd: ROOT, env, timeout: timeoutMs, encoding: 'utf8',
    });
    return {
        status: r.status,
        timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM',
        summary: fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '',
    };
}

describe('the scanner must terminate, whatever its dependencies do', () => {
    it('exits when the browser cannot launch — the exact CI failure', () => {
        const r = runDiscover({ breakBrowser: true });
        expect(r.timedOut, 'discover.mjs hung: this is the 15-minute timeout').toBe(false);
        expect(r.status).toBe(0);
    }, 120_000);

    it('exits on the static-only path too', () => {
        const r = runDiscover({ args: ['--no-ui'], timeoutMs: 60_000 });
        expect(r.timedOut).toBe(false);
        expect(r.status).toBe(0);
    }, 90_000);

    it('the source ends with an explicit exit rather than trusting the loop to drain', () => {
        const src = fs.readFileSync(path.join(ROOT, 'autonomy/discover.mjs'), 'utf8');
        expect(src).toMatch(/process\.exit\(0\);/);
    });
});

describe('"found nothing" and "could not look" must never read the same', () => {
    it('reports INCOMPLETE when the browser detectors could not start', () => {
        const r = runDiscover({ breakBrowser: true });
        expect(r.summary).toMatch(/incomplete/i);
        expect(r.summary).toMatch(/did not run at all/i);
        expect(r.summary).toMatch(/not.{0,5}\*{0,2}a clean bill of health/i);
        // The precise false claim that caused this report must be gone.
        expect(r.summary).not.toMatch(/Every detector ran/);
        // And it must name the reason, not just assert incompleteness.
        expect(r.summary).toMatch(/could not launch Chromium/i);
    }, 120_000);

    it('says "skipped by request" when --no-ui was passed', () => {
        // Distinct from both other cases. An earlier draft of the fix claimed
        // "Every detector ran, including the browser sweep" here — reintroducing
        // the same defect one branch over.
        const r = runDiscover({ args: ['--no-ui'], timeoutMs: 60_000 });
        expect(r.summary).toMatch(/static detectors only/i);
        expect(r.summary).toMatch(/skipped by request/i);
        expect(r.summary).not.toMatch(/including the browser sweep/);
        expect(r.summary).not.toMatch(/incomplete/i);
    }, 90_000);

    it('only claims a full scan when the sweep genuinely ran', async () => {
        const { getUiSweepStatus } = await import('../autonomy/discover.mjs');
        // Fresh import: nothing has run the sweep, so it must not claim it did.
        expect(getUiSweepStatus().ran).toBe(false);
    });
});

/* -----------------------------------------------------------------------------
 * THE MASKING DEFECT, AND WHY THE SUBPROCESS TESTS ABOVE ARE NOT ENOUGH
 *
 * The summary was four mutually exclusive branches with `findings.length` ahead
 * of the sweep-status branch, so a run that had BOTH a static finding and a dead
 * browser sweep printed the findings table and never mentioned the sweep. The
 * incomplete branch existed and was simply unreachable whenever there was
 * anything to report — which is to say, on every run that mattered.
 *
 * The two subprocess tests above did catch it. They caught it by luck. They only
 * saw it because `nanoid` happened to be vulnerable in this repo at that moment,
 * which is what put a finding and a broken sweep into the same run. Bump nanoid
 * — which this same change does — and those tests go green again with the
 * masking defect fully intact, having proved nothing. A test whose red depends
 * on the state of the lockfile is not a guard, it is a coincidence.
 *
 * So the composition is asserted directly, across every combination, with the
 * inputs supplied rather than discovered.
 * ---------------------------------------------------------------------------*/
describe('coverage and findings are separate facts and both are always reported', () => {
    const BROKE = { ran: false, reason: 'could not launch Chromium: spawn ENOENT' };
    const RAN = { ran: true, reason: null };
    const FOUND = [{ severity: 'high', kind: 'dep-vuln', key: 'nanoid' }];

    let renderSummary;
    beforeAll(async () => { ({ renderSummary } = await import('../autonomy/discover.mjs')); });

    it('THE REGRESSION: findings do not suppress a failed-sweep warning', () => {
        // This is the exact input the old code got wrong, and the assertion it
        // could not have passed: it emitted the table and stopped.
        const md = renderSummary({ findings: FOUND, ui: BROKE });
        expect(md, 'the finding itself must still be reported').toMatch(/nanoid/);
        expect(md, 'a finding silenced the coverage warning again').toMatch(/incomplete/i);
        expect(md).toMatch(/did not run at all/i);
        expect(md).toMatch(/could not launch Chromium/);
        expect(md).not.toMatch(/Every detector ran|every detector ran/);
    });

    it('warns about a failed sweep when there is nothing else to say', () => {
        const md = renderSummary({ findings: [], ui: BROKE });
        expect(md).toMatch(/incomplete/i);
        expect(md).toMatch(/not.{0,5}\*{0,2}a clean bill of health/i);
    });

    it('claims a complete scan only when the sweep genuinely ran', () => {
        const md = renderSummary({ findings: [], ui: RAN });
        expect(md).toMatch(/every detector ran, including the browser sweep/i);
        expect(md).not.toMatch(/incomplete/i);
    });

    it('reports findings from a complete scan without downgrading it', () => {
        const md = renderSummary({ findings: FOUND, ui: RAN });
        expect(md).toMatch(/nanoid/);
        expect(md).toMatch(/every detector ran/i);
        expect(md).not.toMatch(/incomplete/i);
    });

    it('calls --no-ui skipped-by-request, never incomplete, findings or not', () => {
        // A deliberate switch-off is not an outage. Saying "incomplete" here
        // would train the owner to ignore the word on the runs where it is real.
        for (const findings of [[], FOUND]) {
            const md = renderSummary({ findings, ui: BROKE, uiDisabled: true });
            expect(md).toMatch(/static detectors only/i);
            expect(md).toMatch(/skipped by request/i);
            expect(md).not.toMatch(/incomplete/i);
            expect(md).not.toMatch(/including the browser sweep/);
        }
        expect(renderSummary({ findings: FOUND, ui: BROKE, uiDisabled: true })).toMatch(/nanoid/);
    });

    it('never reports a bare finding count with no coverage statement at all', () => {
        // The general form of the defect: whatever the inputs, a reader must
        // always be told what was scanned, not only what was found.
        for (const ui of [BROKE, RAN]) {
            for (const uiDisabled of [false, true]) {
                for (const findings of [[], FOUND]) {
                    expect(
                        renderSummary({ findings, ui, uiDisabled }),
                        `no coverage line for ui.ran=${ui.ran} uiDisabled=${uiDisabled} findings=${findings.length}`,
                    ).toMatch(/\*\*Coverage/);
                }
            }
        }
    });

    it('survives being called with nothing, rather than throwing inside the reporter', () => {
        // summarise(null) in the cross-page probe threw for exactly this reason.
        // A reporter that crashes loses the whole run's output.
        expect(() => renderSummary()).not.toThrow();
        expect(renderSummary()).toMatch(/\*\*Coverage/);
    });
});

describe('a dependency audit that cannot answer is reported as such, and cannot hold the scanner up', () => {
    const GAVE_UP = { completed: false, reason: 'npm audit did not answer within 120 s' };
    const FOUND = [{ severity: 'high', kind: 'dep-vuln', key: 'nanoid' }];
    const BROKE = { ran: false, reason: 'could not launch Chromium: spawn ENOENT' };
    const RAN = { ran: true, reason: null };
    let renderSummary;
    beforeAll(async () => { ({ renderSummary } = await import('../autonomy/discover.mjs')); });

    it('says the audit did not finish, in every combination of findings and browser sweep', () => {
        for (const ui of [BROKE, RAN]) {
            for (const uiDisabled of [false, true]) {
                for (const findings of [[], FOUND]) {
                    const md = renderSummary({ findings, ui, uiDisabled, audit: GAVE_UP });
                    const where = `ui.ran=${ui.ran} uiDisabled=${uiDisabled} findings=${findings.length}`;
                    expect(md, where).toMatch(/Dependency audit: did not finish/);
                    expect(md, where).toMatch(/did not answer within 120 s/);
                    expect(md, `${where}: a run that skipped the audit must not open with an OK`).toMatch(/^### \[(WARNING)\]/);
                }
            }
        }
    });

    it('stays silent about the audit when it did finish, so the warning keeps its meaning', () => {
        const md = renderSummary({ findings: [], ui: RAN, audit: { completed: true, reason: null } });
        expect(md).not.toMatch(/Dependency audit/);
        expect(md).toMatch(/^### \[OK\]/);
        expect(renderSummary({ findings: [], ui: RAN })).not.toMatch(/Dependency audit/);
    });

    it('gives up on a registry that never answers, exits cleanly, and says so', () => {
        // `exec` so the stub IS the sleeping process: a shell that merely spawns `sleep` would leave the
        // sleeper holding the pipe and the test would measure the sleep, not the timeout.
        const t0 = Date.now();
        const r = runDiscover({ args: ['--no-ui'], timeoutMs: 40_000, auditTimeoutMs: 2000, npmStub: 'exec sleep 120' });
        expect(r.timedOut, 'the scanner waited on npm audit').toBe(false);
        expect(Date.now() - t0).toBeLessThan(30_000);
        expect(r.status).toBe(0);
        expect(r.summary).toMatch(/Dependency audit: did not finish/);
        expect(r.summary).toMatch(/did not answer within 2 s/);
        expect(r.summary).toMatch(/^### \[WARNING\]/);
    }, 60_000);

    it('treats a registry that is unreachable (JSON error, non-zero exit) as a failed audit, not a clean one', () => {
        const r = runDiscover({ args: ['--no-ui'], timeoutMs: 40_000, npmStub: `echo '{"error":{"code":"ENOTFOUND","summary":"request failed"}}'; exit 1` });
        expect(r.status).toBe(0);
        expect(r.summary).toMatch(/Dependency audit: did not finish/);
        expect(r.summary).toMatch(/could not reach the registry \(ENOTFOUND\)/);
    }, 60_000);

    it('does not raise the alarm when the audit answers, with or without vulnerabilities', () => {
        const r = runDiscover({ args: ['--no-ui'], timeoutMs: 40_000, npmStub: `echo '{"vulnerabilities":{}}'` });
        expect(r.status).toBe(0);
        expect(r.summary).not.toMatch(/Dependency audit/);
        expect(r.summary).toMatch(/static detectors only/i);
        const withVuln = runDiscover({ args: ['--no-ui'], timeoutMs: 40_000, npmStub: `echo '{"vulnerabilities":{"left-pad":{"severity":"high","via":[]}}}'; exit 1` });
        expect(withVuln.status).toBe(0);
        expect(withVuln.summary).not.toMatch(/Dependency audit/);
        expect(withVuln.summary).toMatch(/left-pad/);
    }, 60_000);
});

describe('the workflow can actually install the browser it depends on', () => {
    it('does not use --with-deps, which needs sudo this job has disabled', () => {
        expect(WF).toMatch(/npx playwright install chromium/);
        expect(WF, '--with-deps shells out to sudo apt-get and cannot work here')
            .not.toMatch(/playwright install --with-deps/);
    });

    it('still runs harden-runner with sudo disabled — the fix did not weaken that', () => {
        expect(WF).toMatch(/disable-sudo:\s*true/);
    });

    it('keeps continue-on-error so a broken browser cannot kill static scanning', () => {
        // Deliberate: the browser failing must degrade the scan, not end it.
        // Safe now only because the degradation is reported instead of hidden.
        const i = WF.indexOf('Install Chromium');
        expect(i, 'install step anchor not found — retarget this test').toBeGreaterThan(-1);
        expect(WF.slice(Math.max(0, i - 200), i + 200)).toMatch(/continue-on-error:\s*true/);
    });
});
