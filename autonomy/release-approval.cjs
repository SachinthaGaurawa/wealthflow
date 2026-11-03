'use strict';
/* =============================================================================
 * autonomy/release-approval.cjs — may this release go out WITHOUT a human tap?
 * -----------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE, PURE FILE
 *   release.cjs used to decide this inline. The decision was "wait for
 *   approval.approved === true", the tap never came, and for weeks every
 *   scheduled run exited 2 and was reported as a green "not a failure" while 86
 *   real commits sat un-announced. A decision that important must be testable
 *   without Firestore, git or a clock.
 *
 * THE RULE
 *   · Without --auto-approve nothing changes: the old human gate stands.
 *   · With --auto-approve the CALLER (auto-release.yml) has already proven the
 *     three things a human tap was standing in for — a substantive change, a
 *     green test suite on the exact commit, a healthy production — so the brain's
 *     feedback tally (`shouldRelease`, `consumed`, `approval`) no longer vetoes.
 *   · The brain's `urgent` flag NEVER forces a mandatory update on its own under
 *     --auto-approve. Forcing every device onto a build is the one decision a
 *     feedback count must not make. Only an explicit --urgent (the security
 *     workflow) can.
 * ===========================================================================*/

/**
 * @param {{brain?:object|null, autoApprove?:boolean, force?:boolean}} o
 * @returns {{go:boolean, exit?:number, reason:string, urgentFromBrain:boolean, autoApproved:boolean}}
 */
function decideApproval({ brain = null, autoApprove = false, force = false } = {}) {
    if (!brain) return { go: true, reason: 'no brain proposal: plain bump', urgentFromBrain: false, autoApproved: false };

    if (!autoApprove) {
        if (!brain.shouldRelease) {
            return { go: false, exit: 2, reason: 'brain says a release is NOT due (reason: ' + (brain.reason || 'none') + ')', urgentFromBrain: false, autoApproved: false };
        }
        if (brain.consumed && !force) {
            return { go: false, exit: 2, reason: 'brain proposal already consumed (use --force to re-release)', urgentFromBrain: false, autoApproved: false };
        }
        const ap = brain.approval;
        if (ap && ap.required && !ap.approved && !force) {
            return { go: false, exit: 2, reason: 'brain proposal awaits approval (approval.approved=false)', urgentFromBrain: false, autoApproved: false };
        }
        return { go: true, reason: 'approved', urgentFromBrain: !!brain.urgent, autoApproved: false };
    }

    const ap = brain.approval;
    const pending = !!(ap && ap.required && !ap.approved);
    return {
        go: true,
        reason: pending
            ? 'approved by the release gates (substantive change + green tests + healthy production)'
            : 'approved',
        urgentFromBrain: false,
        autoApproved: pending || !brain.shouldRelease || !!brain.consumed,
    };
}

/**
 * Which brain text, if any, may be shipped as the release's notes?
 *
 * The brain's `notes` are a tally of FEEDBACK ("Addressed: ...", "Urgent security update"),
 * written when a proposal is drafted — before any fix exists. The first release that went out
 * without a human tap (v7.69.36) published exactly that: a raw JSON string headed "Urgent
 * security update" over feedback items marked "Addressed", though nothing security-related
 * had shipped. What a release says must come from what it contains (the commits in its range,
 * autonomy/release-notes.cjs), so under --auto-approve the brain's text is never used. Without
 * it (a human approved that proposal) a plain string or `summary` is still honoured, and an
 * object is never serialised into the notes.
 *
 * @returns {string} '' when nothing from the brain may be shipped
 */
function brainNoteForRelease({ brainNotes = null, autoApprove = false } = {}) {
    if (autoApprove) return '';
    if (typeof brainNotes === 'string') return brainNotes.trim();
    if (brainNotes && typeof brainNotes.summary === 'string') return brainNotes.summary.trim();
    return '';
}

module.exports = { decideApproval, brainNoteForRelease };
