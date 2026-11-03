/* =============================================================================
 * test/release_approval_test.js — the human tap that nobody gave
 * -----------------------------------------------------------------------------
 * For weeks release.cjs waited for `approval.approved === true`. Nobody
 * tapped, so every scheduled run exited 2, was reported as a green "not a
 * failure", and 86 real commits were never announced to the app. These tests pin
 * the replacement rule: with --auto-approve the gates (checked by the workflow)
 * stand in for the tap; without it the old gate still holds; and the brain can
 * never force a mandatory update on its own.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { decideApproval } = require('../autonomy/release-approval.cjs');
const ROOT = path.resolve(import.meta.dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/auto-release.yml'), 'utf8');

const awaiting = { shouldRelease: true, consumed: false, urgent: true, approval: { required: true, approved: false } };

describe('without --auto-approve the old human gate is untouched', () => {
    it('waits for a tap (exit 2)', () => {
        const d = decideApproval({ brain: awaiting });
        expect(d.go).toBe(false); expect(d.exit).toBe(2); expect(d.reason).toMatch(/awaits approval/);
    });
    it('honours "not due" and "already consumed"', () => {
        expect(decideApproval({ brain: { shouldRelease: false } }).go).toBe(false);
        expect(decideApproval({ brain: { shouldRelease: true, consumed: true } }).go).toBe(false);
    });
    it('--force still overrides', () => {
        expect(decideApproval({ brain: awaiting, force: true }).go).toBe(true);
    });
    it('a human-approved proposal goes, and may be urgent', () => {
        const d = decideApproval({ brain: { shouldRelease: true, urgent: true, approval: { required: true, approved: true } } });
        expect(d.go).toBe(true); expect(d.urgentFromBrain).toBe(true);
    });
});

describe('with --auto-approve the gates replace the tap', () => {
    it('a proposal awaiting approval now goes, and says why', () => {
        const d = decideApproval({ brain: awaiting, autoApprove: true });
        expect(d.go).toBe(true); expect(d.autoApproved).toBe(true);
        expect(d.reason).toMatch(/release gates/);
    });
    it('the brain tally ("not due", "consumed") cannot veto work the gates proved is real', () => {
        expect(decideApproval({ brain: { shouldRelease: false }, autoApprove: true }).go).toBe(true);
        expect(decideApproval({ brain: { shouldRelease: true, consumed: true }, autoApprove: true }).go).toBe(true);
    });
    it('NEVER lets the brain force a mandatory update', () => {
        expect(decideApproval({ brain: awaiting, autoApprove: true }).urgentFromBrain).toBe(false);
    });
    it('no brain at all is a plain bump either way', () => {
        expect(decideApproval({ brain: null, autoApprove: true }).go).toBe(true);
        expect(decideApproval({ brain: null }).go).toBe(true);
    });
});

describe('the workflow wires the gates before the release', () => {
    it('the Release step only runs when the Gates step passed, and passes --auto-approve', () => {
        const rel = WF.indexOf('- name: Release\n');
        expect(rel).toBeGreaterThan(-1);
        expect(WF.slice(rel, rel + 200)).toMatch(/steps\.gates\.outputs\.ok == 'yes'/);
        expect(WF).toMatch(/ARGS\+=\(--push --auto-approve\)/);
    });
    it('the Gates step runs the real test suite and a production health probe, and files an issue when blocked', () => {
        const g = WF.indexOf('- name: Gates');
        const block = WF.slice(g, WF.indexOf('- name: Release\n'));
        expect(block).toMatch(/npm test/);
        expect(block).toMatch(/HEALTH_URL/);
        expect(block).toMatch(/gh issue create/);
    });
    it('a release is only done when production serves it (api, manifest and app shell)', () => {
        const c = WF.indexOf('- name: Confirm the new version is LIVE in production');
        expect(c).toBeGreaterThan(-1);
        const block = WF.slice(c);
        for (const needle of ['/api/version', '/version.json', '/app', 'WF_APP_VERSION', 'exit 1']) expect(block).toContain(needle);
    });
    it('releases are attempted every 6h and after each merge, not once a day', () => {
        expect(WF).toMatch(/cron: '0 \*\/6 \* \* \*'/);
        expect(WF).toMatch(/push:\s*\n\s*branches: \[main\]/);
    });
});

// Codex review on #493: a manual "Release now" used to skip the suite yet still passed
// --auto-approve, so a red commit could be released under a gate that never ran.
import fs from 'node:fs';
import path from 'node:path';
describe('the test gate applies to every trigger, manual dispatch included', () => {
    const WF = fs.readFileSync(path.resolve(import.meta.dirname, '../.github/workflows/auto-release.yml'), 'utf8');
    const gates = WF.slice(WF.indexOf('- name: Gates (tests on this commit'), WF.indexOf('- name: Release\n'));
    it('npm test is not conditional on the event type', () => {
        expect(gates).toMatch(/npm test > gate-tests\.log/);
        expect(gates).not.toMatch(/workflow_dispatch/);
        expect(gates).not.toMatch(/if \[ "\$GITHUB_EVENT_NAME"/);
    });
});

// ── what a release SAYS must come from what it contains ─────────────────────────
// The first release made without a human tap (v7.69.36, 2026-11-03) was announced as
// {"headline":"Urgent security update", ... "Addressed: ..."} — the brain's feedback tally,
// serialised to JSON, over a range of 77 ordinary changes and no security fix at all.
const { brainNoteForRelease } = require('../autonomy/release-approval.cjs');
const RELEASE_SRC = fs.readFileSync(path.join(ROOT, 'release.cjs'), 'utf8');

describe('brainNoteForRelease — the brain\'s tally is not a record of what shipped', () => {
    const tally = { headline: 'Urgent security update', sections: [{ title: 'Fixed', items: ['Addressed: something nobody fixed'] }] };
    it('under --auto-approve nothing from the brain is ever shipped as notes', () => {
        expect(brainNoteForRelease({ brainNotes: tally, autoApprove: true })).toBe('');
        expect(brainNoteForRelease({ brainNotes: 'Anything', autoApprove: true })).toBe('');
        expect(brainNoteForRelease({ brainNotes: { summary: 'Anything' }, autoApprove: true })).toBe('');
    });
    it('a proposal a human approved may still use its plain text or summary', () => {
        expect(brainNoteForRelease({ brainNotes: '  Fixed the bill reminder.  ' })).toBe('Fixed the bill reminder.');
        expect(brainNoteForRelease({ brainNotes: { summary: 'Fixed the bill reminder.' } })).toBe('Fixed the bill reminder.');
    });
    it('an object is never serialised into the notes', () => {
        expect(brainNoteForRelease({ brainNotes: tally })).toBe('');
        expect(brainNoteForRelease({ brainNotes: null })).toBe('');
        expect(brainNoteForRelease({})).toBe('');
    });
    it('release.cjs goes through it and no longer stringifies the brain\'s notes', () => {
        expect(RELEASE_SRC).toMatch(/brainNoteForRelease\(\{ brainNotes: bd\.notes, autoApprove: AUTO_APPROVE \}\)/);
        expect(RELEASE_SRC).not.toMatch(/JSON\.stringify\(bd\.notes\)/);
    });
    it('an approved-by-the-gates release is not labelled with the brain\'s feedback reason', () => {
        expect(RELEASE_SRC).toMatch(/\(AUTO_APPROVE && !URGENT\) \? 'automatic release'/);
    });
    it('the announcement carries the same itemised notes as version.json, and repairs unreadable ones', () => {
        expect(RELEASE_SRC).toMatch(/man\.notes\[next\] = \(RELEASE_NOTES && RELEASE_NOTES\.structured\) \? RELEASE_NOTES\.structured : NOTE/);
        expect(RELEASE_SRC).toMatch(/repairManifestNotes\(man\.notes, vj\.notes\)/);
    });
});

describe('the notes already published for v7.69.36 are the real ones', () => {
    const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    const n = vj.notes['7.69.36'];
    it('version.json holds a structured list of real changes, not serialised JSON', () => {
        expect(typeof n).toBe('object');
        expect(Array.isArray(n.sections) && n.sections.length).toBeGreaterThan(0);
        const text = JSON.stringify(n);
        expect(text).not.toMatch(/Urgent security update/);
        expect(text).not.toMatch(/Addressed:/);
        expect(text).toMatch(/\(#4\d\d\)/);               // the changes carry their pull request numbers
    });
    it('the changelog entry is readable text under that version', () => {
        const log = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
        const at = log.indexOf('## v7.69.36');
        const body = log.slice(at, log.indexOf('## v7.69.35'));
        expect(body).not.toMatch(/\{"date"/);
        expect(body).not.toMatch(/Urgent security update/);
        expect(body).toMatch(/What changed for you/);
    });
});
