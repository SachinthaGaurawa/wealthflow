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

/* A NOTE ON THE FIXTURE WORDING BELOW.
 *
 * The first version of this file used realistic sentences — "Adds a settings row
 * and a modal; the wording is plain and nothing is hidden." On the very pull
 * request that introduced it, the user-impact reviewer returned:
 *
 *   "This change adds a new settings row and a modal, with clear and plain
 *    wording. It also introduces a new idle-cash notification, which could
 *    become noisy, but the cooldown period seems adequate."
 *
 * That is a paraphrase of two fixtures on this page. The reviewer had read the
 * diff's PROSE and handed it back as its own finding — the same failure
 * consensus-review.mjs already guards against twice — and because the sentences
 * were plausible, the result looked exactly like a reviewer that had finally
 * started doing its job. It was the opposite, and only comparing it against
 * these literals revealed that.
 *
 * So the fixtures are now unmistakably synthetic. They still exercise every
 * branch — the checks care about the DENIAL pattern, not about realism — and if
 * a future review quotes one, it is instantly visible as a quote rather than
 * passing for insight.
 */

import { describe, it, expect } from 'vitest';
import {
    deniesVisibleChange, addsUserVisibleSurface, DENIAL_REPLACEMENT, REVIEWERS, runReviewer,
    reasonIsGeneric, reasonNamesSomething, GENERIC_REPLACEMENT,
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
            'FIXTURE-A: the control states its value before writing it.',
            'FIXTURE-B: adds one row and one dialog; nothing is concealed.',
            'FIXTURE-C: the alert may repeat, though the interval appears sufficient.',
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
        expect(ui.rules.join(' ')).toMatch(/Never report that the change is invisible/);
        expect(ui.rules.join(' ')).toMatch(/A pure addition is still a change/);
    });

    it('states its rules as constraints, not as sentences that can be copied back', () => {
        /* SECOND ECHO, SAME PULL REQUEST. After the fixtures were made
         * synthetic, the reviewer returned:
         *
         *   "This change adds new UI that harms nobody, and the reason
         *    describes the new UI."
         *
         * which is this lane's own rule read back. The original wording — "New
         * UI that harms nobody is a PASS whose reason describes the new UI" —
         * was a complete, well-formed sentence, so it got used as one. The
         * result is circular: it announces that the reason describes the UI
         * instead of describing it.
         *
         * A rule must therefore not BE a usable answer. */
        const joined = ui.rules.join(' ');
        expect(joined, 'the rule is still phrased as a finished verdict sentence')
            .not.toMatch(/New UI that harms nobody is a PASS whose reason describes/);
        expect(joined, 'nothing asks the reason to name something in this diff')
            .toMatch(/should name the control, screen, message or setting/);
        /* AND BOUNDED. Asked simply for a concrete noun, the lane returned "The
         * user will see a new button labelled '_bv_save' and feel a vibration"
         * as a FAIL, citing a line that exists only in a TEST FIXTURE. It went
         * looking for a noun, found one in test data, and blocked on it. */
        expect(joined, 'the noun rule can still be read as "find something to flag"')
            .toMatch(/never a reason to FAIL/);
        expect(joined, 'nothing tells it fixtures are not the product')
            .toMatch(/Test files, fixtures and mock data are not the product/);
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
        reason: 'FIXTURE-D: the _bv_save button is plainly labelled.',
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
        expect(v.reason).toBe('FIXTURE-D: the _bv_save button is plainly labelled.');
        expect(v.correctedReason).toBe(null);
    });

    it('leaves the denial alone when the diff really is invisible', async () => {
        /* BOTH checks must stand down here. The denial is true, and the generic
         * check must not fire either: a backend-only diff gives the lane nothing
         * to name, so a general sentence is the correct answer rather than a
         * symptom. An earlier version replaced this and would have punished a
         * reviewer for being right. */
        const v = await runReviewer(lane, backendDiff, false, stub(denial));
        expect(v.reason).toContain('No user-facing changes');
        expect(v.correctedReason).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A REASON THAT NAMES NOTHING
 * ═══════════════════════════════════════════════════════════════════════════
 * On the pull request that added the denial check, this lane produced THREE
 * reviews and every one was a sentence lifted from the diff or the prompt:
 *
 *   1. a paraphrase of two test fixtures the change had just added
 *   2. its own rule read back — "adds new UI that harms nobody, and the reason
 *      describes the new UI"
 *   3. "This causes no HARM" — a phrase quoted inside that rule as an example
 *
 * Each fix removed one source of quotable text and it found the next. Four
 * prompt rewrites was enough to establish that no fifth would help.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a reason has to name something in the diff', () => {
    const hapticDiff = [
        '--- a/index.html', '+++ b/index.html',
        "+        const HAPTIC_GAIN = { off: 0, subtle: 0.5, standard: 1, heavy: 1.6 };",
        '+                        <option value="heavy">Heavy</option>',
    ].join('\n');

    it.each([
        ['the third echo, verbatim', 'This causes no HARM'],
        ['the second echo', 'This change adds new UI that harms nobody, and the reason describes the new UI.'],
        ['a sentence that fits any PR', 'The change is a clear improvement for the user.'],
    ])('catches %s', (_why, reason) => {
        expect(reasonIsGeneric(reason, hapticDiff)).toBe(true);
    });

    it('lets a real review through', () => {
        for (const r of [
            'The new Heavy haptic option vibrates noticeably longer than Standard.',
            'Adding an "off" level to HAPTIC_GAIN means the setting can now be silenced entirely.',
        ]) {
            expect(reasonIsGeneric(r, hapticDiff), r).toBe(false);
        }
    });

    it('ignores the vocabulary every review shares', () => {
        /* Otherwise "this change affects the user" would count as naming
         * something, because words like "change" and "user" appear in the code
         * of almost every diff.
         *
         * The added line here is real CODE, not a comment. The first version of
         * this test used `+ // this change affects the user`, which
         * addedCodeLines correctly discards as prose — so the token set was
         * empty, the assertion held whatever the filter did, and a mutation
         * deleting the filter survived. */
        const d = ['--- a/x.js', '+++ b/x.js', '+ function applyChange(user) { return user; }'].join('\n');
        expect(reasonNamesSomething('This change affects the user.', d)).toBe(false);
        // and a word that is NOT shared vocabulary still counts
        expect(reasonNamesSomething('applyChange now returns early.', d)).toBe(true);
    });

    it('does not treat an empty reason as generic', () => {
        /* An absent reason is a different failure with its own handling — the
         * unavailable path writes one. Reporting it here would replace a
         * message that already explains itself with one that does not. */
        const d = ['--- a/index.html', '+++ b/index.html', '+ <button>Go</button>'].join('\n');
        expect(reasonIsGeneric('', d)).toBe(false);
        expect(reasonIsGeneric(null, d)).toBe(false);
        expect(reasonIsGeneric('   ', d)).toBe(false);
    });

    it('says nothing it cannot establish', () => {
        expect(GENERIC_REPLACEMENT).toContain('names nothing in this diff');
        expect(GENERIC_REPLACEMENT).toContain('the vote stands');
        expect(GENERIC_REPLACEMENT).not.toMatch(/fail|defect|bug/i);
    });

    it('is applied by runReviewer, on this lane only', async () => {
        const stub = (reason) => async (opts) => ({
            text: JSON.stringify({ verdict: 'pass', reason, evidence: '', concerns: [] }),
            provider: opts.only[0],
        });
        const ui = { role: REVIEWERS.find((r) => r.name === 'user-impact'), primary: 'cohere', fallbacks: [] };
        const sec = { role: REVIEWERS.find((r) => r.name === 'security'), primary: 'mistral', fallbacks: [] };

        const a = await runReviewer(ui, hapticDiff, false, stub('This causes no HARM'));
        expect(a.vote, 'the vote must not change').toBe('pass');
        expect(a.reason).toBe(GENERIC_REPLACEMENT);

        /* Architecture and security legitimately answer in general terms — "no
         * vulnerabilities introduced" is complete and useful. Only this lane's
         * whole job is to say what the person will SEE. */
        const b = await runReviewer(sec, hapticDiff, false, stub('No vulnerabilities introduced.'));
        expect(b.reason).toBe('No vulnerabilities introduced.');
    });
});
