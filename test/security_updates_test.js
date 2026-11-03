/* =============================================================================
 * test/security_updates_test.js
 * -----------------------------------------------------------------------------
 * On 2026-11-03 five "Vulnerable dependency" issues (#279 #315 #316 #346 #382)
 * had sat open and `ai-stuck` for a month. The detector worked; nothing could
 * act on what it found, because the fix agent may not edit package.json /
 * package-lock.json. .github/workflows/security-updates.yml is the deterministic
 * fixer. These tests pin the properties that make it trustworthy:
 *   - it really is scheduled (weekly urgent + monthly full) and manually runnable;
 *   - it applies only semver-compatible fixes (never --force);
 *   - it runs the whole test suite before it opens anything;
 *   - it never merges or approves its own pull request;
 *   - it fails loudly rather than swallowing errors.
 * and the pure summariser that produces its before/after tables.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { summarise, render } from '../autonomy/audit-summary.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/security-updates.yml'), 'utf8');
const CODE = WF.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('security-updates.yml is a real, scheduled, honest fixer', () => {
    it('runs weekly (urgent) and monthly (full) and can be started by hand', () => {
        expect(CODE).toMatch(/cron:\s*'30 5 \* \* 1'/);
        expect(CODE).toMatch(/cron:\s*'30 6 1 \* \*'/);
        expect(CODE).toMatch(/workflow_dispatch:/);
    });

    it('applies only semver-compatible fixes — never --force', () => {
        expect(CODE).toMatch(/npm audit fix/);
        expect(CODE).not.toMatch(/--force/);
        expect(CODE).not.toMatch(/npm audit fix[^\n]*--legacy/);
    });

    it('runs the whole test suite BEFORE opening a pull request', () => {
        const tests = CODE.indexOf('run: npm test');
        const pr = CODE.indexOf('gh pr create');
        expect(tests).toBeGreaterThan(-1);
        expect(pr).toBeGreaterThan(tests);
        expect(CODE).toMatch(/steps\.tests\.outcome == 'success'/);
    });

    it('never merges, approves or labels its own change human-approved', () => {
        expect(CODE).not.toMatch(/gh pr merge/);
        expect(CODE).not.toMatch(/--auto\b/);
        expect(CODE).not.toMatch(/--add-label[^\n]*human-approved/);
        expect(CODE).not.toMatch(/--label[^\n]*human-approved/);
        expect(CODE).not.toMatch(/enable_pr_auto_merge|enablePullRequestAutoMerge/);
    });

    it('does not swallow failures', () => {
        expect(CODE).not.toMatch(/continue-on-error/);
        expect(CODE).not.toMatch(/>\s*\/dev\/null/);
        expect(CODE).not.toMatch(/\|\|\s*true\s*$/m);
    });

    it('reports a broken update and unfixable serious vulnerabilities', () => {
        expect(CODE).toMatch(/Security update broke the test suite/);
        expect(CODE).toMatch(/Fail if serious vulnerabilities remain/);
        expect(CODE).toMatch(/exit 1/);
    });

    it('files its failure issue under its own label, never the shared pipeline-health one', () => {
        // pipeline-liveness closes whichever open issue carries pipeline-health once main is
        // green; this issue is about a PR that never touched main (Codex review on #493).
        expect(CODE).not.toMatch(/pipeline-health/);
        expect(CODE).toMatch(/--label security-update --label ai-stuck/);
    });

    // Codex review on #493: a red run alone is easy to miss; vulnerabilities that no safe fix covers
    // need an issue a person will see, and a repeat run must not pile up duplicates.
    it('files (or updates) an issue for serious vulnerabilities no safe fix covers, before failing the run', () => {
        const file = CODE.indexOf('File an issue for vulnerabilities no safe fix covers');
        const fail = CODE.indexOf('Fail if serious vulnerabilities remain');
        expect(file).toBeGreaterThan(-1);
        expect(fail).toBeGreaterThan(file);
        const step = CODE.slice(file, fail);
        expect(step).toMatch(/if: always\(\) && steps\.after\.outputs\.serious != ''/);
        expect(step).toMatch(/gh issue create --label security-update --label ai-stuck/);
        expect(step).toMatch(/gh issue comment/);                // a repeat run comments instead of duplicating
        expect(step).toMatch(/cat after\.txt/);                  // the issue names the packages
        expect(step).not.toMatch(/pipeline-health/);
    });

    it('does not open a second pull request while one is waiting', () => {
        expect(CODE).toMatch(/already waiting for review/);
    });

    it('has the least privilege it needs and a hardened runner', () => {
        expect(CODE).toMatch(/permissions:\s*\n\s*contents: write\s*\n\s*pull-requests: write\s*\n\s*issues: write/);
        expect(CODE).toMatch(/step-security\/harden-runner@v2/);
    });
});

describe('audit-summary — the numbers in the PR body', () => {
    const audit = {
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 2, critical: 0, total: 3 } },
        vulnerabilities: {
            nodemailer: { severity: 'moderate', isDirect: true, range: '3.0.0 - 10.1.3', fixAvailable: true },
            'node-forge': { severity: 'high', isDirect: false, range: '<=1.4.0', fixAvailable: true },
            vite: { severity: 'high', isDirect: false, range: '8.3.0 - 8.3.2', fixAvailable: { name: 'vite', version: '9.0.0', isSemVerMajor: true } },
        },
    };

    it('counts by severity and totals', () => {
        const s = summarise(audit);
        expect(s.total).toBe(3);
        expect(s.counts).toMatchObject({ critical: 0, high: 2, moderate: 1 });
    });

    it('lists the worst first and flags direct deps and major-only fixes', () => {
        const out = render(summarise(audit)).split('\n');
        expect(out[0]).toBe('total 3: critical 0 · high 2 · moderate 1 · low 0 · info 0');
        expect(out[1]).toMatch(/^high\s+node-forge/);
        expect(out.find((l) => l.includes('vite'))).toMatch(/major \(vite@9\.0\.0\)/);
        expect(out.find((l) => l.includes('nodemailer'))).toMatch(/\(direct\)/);
    });

    it('says plainly when there is nothing', () => {
        expect(render(summarise({ metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} }))).toMatch(/no vulnerable packages/);
    });

    it('tolerates a malformed audit rather than throwing', () => {
        expect(summarise(null).total).toBe(0);
        expect(summarise({}).vulns).toEqual([]);
    });
});
