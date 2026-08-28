/* =============================================================================
 * test/user_impact_reason_test.js
 * -----------------------------------------------------------------------------
 * The user-impact reviewer passed five consecutive pull requests that changed
 * what appears on screen with a variant of "no user-facing changes":
 *
 *   #146  a lock-screen button rewritten to state the amount it writes
 *   #147  a new idle-cash notification
 *   #148  a settings screen and a dashboard card added to an app with neither,
 *         then every visible glyph on three screens replaced with icons
 *
 * The VERDICTS were right — none of those harmed anyone. The REASONS were
 * false, and a false reason is worse than none: on the pull request it reads as
 * a considered finding that the change is invisible, which is the exact claim
 * that let a pipeline with no interface be described as live for weeks.
 *
 * WHY THIS IS A CODE CHECK AND NOT A PROMPT LINE
 *
 * consensus-review.mjs already makes this argument twice, for two earlier
 * failures of the same shape: instructions were added to the prompt, the model
 * ignored them, and the rule moved into code. This is the third. A rule the
 * model can decline to follow is a request.
 *
 * WHAT IT MUST NOT DO
 *
 * Change a vote. New UI that harms nobody is a PASS, and turning a correct pass
 * into a failure over wording would block good work and teach the board to say
 * less. Only the sentence is replaced.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    deniesVisibleChange, addsUserVisibleSurface, DENIAL_REPLACEMENT, REVIEWERS, runReviewer,
} from '../consensus-review.mjs';

const uiDiff = [
    '--- a/index.html',
    '+++ b/index.html',
    '+                <button class="btn btn-primary" id="_bv_save">Save securely</button>',
].join('\n');

const backendDiff = [
    '--- a/wealthflow-vault.js',
    '+++ b/wealthflow-vault.js',
    '+export function newSalt(deps = {}) {',
    '+    return bytesToB64(randomOf(deps, KDF.SALT_BYTES));',
    '+}',
].join('\n');

describe('the denial the diff contradicts', () => {
    it.each([
        'No user-facing changes were identified in the executable code.',
        'No user-facing changes were found in the provided diff.',
        'No user-facing changes that could cause confusion, removal of features, or performance degradation.',
        'There is nothing the user will see here.',
        'The change is not visible to the user.',
        'No visible changes.',
    ])('is caught: %s', (reason) => {
        expect(deniesVisibleChange(reason, uiDiff)).toBe(true);
    });

    it('the exact three sentences that were actually returned', () => {
        /* Verbatim from #146, #147 and #148. If a future edit to the regex stops
         * matching these, the thing this file exists to prevent is back. */
        for (const r of [
            'No user-facing changes were identified in the executable code.',
            'No user-facing changes were found in the provided diff.',
            'No user-facing changes that could cause confusion, removal of features, or performance degradation.',
        ]) {
            expect(deniesVisibleChange(r, uiDiff), r).toBe(true);
        }
    });

    it('leaves an honest reason alone, however it is worded', () => {
        for (const r of [
            'The new banner states the amount before it is written, which is clearer than "Yes".',
            'Adds a settings row and a modal; the wording is plain and nothing is hidden.',
            'The idle-cash notification could become noisy, but the cooldown looks adequate.',
            '',
        ]) {
            expect(deniesVisibleChange(r, uiDiff), r).toBe(false);
        }
    });

    it('does NOT fire on a diff that really is invisible', () => {
        /* THE OTHER HALF. A backend-only change genuinely has no user-facing
         * part, and saying so is correct — the check must not punish a reviewer
         * for being right. */
        expect(deniesVisibleChange('No user-facing changes were identified.', backendDiff)).toBe(false);
        expect(addsUserVisibleSurface(backendDiff)).toBe(false);
    });

    it('reads only ADDED lines, not removed ones', () => {
        // A PR that DELETES a button has removed UI, and the added side may be
        // pure logic. Judging it on the `-` lines would be the same misreading
        // this file's neighbours were written to stop.
        const removal = ['--- a/index.html', '+++ b/index.html', '-  <button class="btn">Old</button>', '+  const x = 1;'].join('\n');
        expect(addsUserVisibleSurface(removal)).toBe(false);
    });

    it('recognises the surfaces this app actually uses', () => {
        for (const line of [
            '+    host.innerHTML = `<div class="card">x</div>`;',
            '+    notify("Saved", "success");',
            '+    showActionableBanner({ id, title });',
            '+    await reg.showNotification(title, opts);',
            "+    triggerHaptic('success');",
            "+    return WFIcon('lock');",
            '+  <div class="setting-row">',
        ]) {
            const d = ['--- a/index.html', '+++ b/index.html', line].join('\n');
            expect(addsUserVisibleSurface(d), line).toBe(true);
        }
    });

    it('replaces the sentence with something that claims no more than it knows', () => {
        // It must not invent a finding, and it must not pretend to know what the
        // reviewer should have said.
        expect(DENIAL_REPLACEMENT).toContain('the diff adds or alters interface code');
        expect(DENIAL_REPLACEMENT).toContain('the vote stands');
        expect(DENIAL_REPLACEMENT).not.toMatch(/fail|defect|bug|reject/i);
    });
});

describe('the reviewer definition itself', () => {
    const ui = REVIEWERS.find((r) => r.name === 'user-impact');

    it('asks what the user will see BEFORE asking whether it harms them', () => {
        /* The root cause: every previous question asked about harm, so "no harm"
         * came back phrased as "no change". */
        expect(ui.focus[0]).toMatch(/SEE or FEEL differently/);
    });

    it('forbids the denial in the prompt as well as in code', () => {
        expect(ui.rules.join(' ')).toMatch(/NEVER write "no user-facing changes"/);
        expect(ui.rules.join(' ')).toMatch(/A pure addition is still a change/);
    });

    it('keeps the harm questions — the lane still has a job', () => {
        const all = ui.focus.join(' ');
        expect(all).toMatch(/confuse or mislead/);
        expect(all).toMatch(/remove or hide/);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * AND IT IS ACTUALLY APPLIED
 * ═══════════════════════════════════════════════════════════════════════════
 * The block above tests the rule. A mutation that disabled the REPLACEMENT in
 * runReviewer — leaving the rule correct and calling it nowhere — passed every
 * one of those tests. That is this repository's most repeated defect, and it
 * survived a first pass here too.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('runReviewer applies it, not just exports it', () => {
    const lane = { role: REVIEWERS.find((r) => r.name === 'user-impact'), primary: 'cohere', fallbacks: [] };
    const stub = (reply) => async (opts) => ({ text: reply, provider: opts.only[0] });

    const denial = JSON.stringify({
        verdict: 'pass',
        reason: 'No user-facing changes that could cause confusion, removal of features, or performance degradation.',
        evidence: '', concerns: [],
    });
    const honest = JSON.stringify({
        verdict: 'pass',
        reason: 'Adds a settings row and a modal; the wording is plain.',
        evidence: '', concerns: [],
    });

    it('replaces the false sentence on a diff that changes the interface', async () => {
        const v = await runReviewer(lane, uiDiff, false, stub(denial));
        expect(v.vote, 'the VOTE must not change — a harmless addition is a pass').toBe('pass');
        expect(v.reason).toBe(DENIAL_REPLACEMENT);
        expect(v.correctedReason, 'the original wording is lost instead of recorded')
            .toContain('No user-facing changes');
    });

    it('leaves an honest reason exactly as written', async () => {
        const v = await runReviewer(lane, uiDiff, false, stub(honest));
        expect(v.vote).toBe('pass');
        expect(v.reason).toBe('Adds a settings row and a modal; the wording is plain.');
        expect(v.correctedReason).toBe(null);
    });

    it('leaves the denial alone when the diff really is invisible', async () => {
        const v = await runReviewer(lane, backendDiff, false, stub(denial));
        expect(v.reason).toContain('No user-facing changes');
        expect(v.correctedReason).toBe(null);
    });
});
