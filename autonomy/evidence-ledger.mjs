/* =============================================================================
 * autonomy/evidence-ledger.mjs — what a pull request can truthfully claim, written by a program
 * -----------------------------------------------------------------------------
 * WHY (operating charter rules 2 and 8: "know what you know", "never claim a check that did not run")
 *   A model describing its own work tends to sound surer than the evidence is. The charter tells the models not to, but
 *   an instruction is not a guarantee. This ledger does not ask a model anything: it reads what the pipeline actually
 *   recorded (the lane that ran, whether the proving test went red then green, the sabotage check's count, who reviewed,
 *   whether the screenshot was read and by whom) and prints two lists in the PR description: what was VERIFIED by a
 *   program in this run, and what was NOT, always including the two things no run here can verify (a real phone, the
 *   owner's live data).
 *
 *   The reviewer of the PR then sees the limits first, in the same place every time, whatever the author model wrote.
 *
 * Pure: no I/O. Every line comes from a field; a missing field becomes a "not verified" line, never a guess.
 * ===========================================================================*/

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * @param {object} o
 * @param {object} [o.result]       the swarm / lane result (lane, verified, mutation, review, providers, layout)
 * @param {object} [o.shot]         screenshotContext result ({ status, provider, note }) or null when the report had no picture
 * @param {object} [o.translation]  withTranslation result ({ status, note }) or null
 * @param {string|null} [o.testWritten]
 * @param {string[]} [o.rules]      ids of the standing rules shown to the author (autonomy/lessons.mjs)
 * @returns {{ verified:string[], notVerified:string[], markdown:string }}
 */
export function evidenceLedger({ result = {}, shot = null, translation = null, testWritten = null, rules = [] } = {}) {
    const verified = [];
    const notVerified = [];
    const lane = result.lane || 'swarm';
    const provs = result.providers || {};

    if (lane === 'layout') {
        const L = result.layout || {};
        const widths = (L.widths || []).join(', ');
        if (L.verdict) verified.push(`Layout measured in real Chromium on invented books at ${widths || 'the named'} px, before and after: ${String(L.verdict).toUpperCase()}.`);
        else notVerified.push('The layout measurement did not report a verdict.');
    } else if (lane === 'build') {
        verified.push(`New module \`${clip(result.file, 80)}\` passed the machine check that it cannot write to the books, call Firebase, use eval or inject scripts.`);
        notVerified.push('Whether the new module is useful to the owner: only the owner can judge that.');
    } else if (testWritten && result.verified) {
        verified.push(`Proving test \`${clip(testWritten, 80)}\` ran twice: it fails on the original file and passes on the changed one.`);
        const m = result.mutation;
        if (m && !m.skipped && Number.isFinite(m.total)) {
            verified.push(`Sabotage check: the test caught ${m.killed} of ${m.total} deliberately broken versions of the fix.`);
            if (m.weak) notVerified.push('The proving test is weak (it missed too many broken versions); treat it as thin evidence.');
        } else {
            notVerified.push('No sabotage check ran, so nothing shows the test would notice a different wrong fix.');
        }
    } else if (testWritten) {
        notVerified.push(`Proving test \`${clip(testWritten, 80)}\` was NOT confirmed red then green.`);
    } else {
        notVerified.push('There is no proving test.');
    }

    if (result.review && result.review.verdict) {
        const same = provs.author && provs.security && provs.author === provs.security;
        verified.push(`Security review by ${clip(provs.security || 'an unnamed provider', 40)}: ${clip(result.review.verdict, 30)}${same ? ' (same provider as the author, so not independent)' : ''}.`);
        if (same) notVerified.push('The security reviewer and the author were the same provider.');
    } else {
        notVerified.push('No independent security review is recorded.');
    }

    if (shot) {
        if (shot.status === 'read') {
            const checked = shot.checked ? `, second reader: ${shot.checked}` : '';
            verified.push(`The report's screenshot was read by ${clip(shot.provider || 'a vision model', 40)}${checked}.`);
            notVerified.push('A reading of a picture is a model\'s account of it, not the picture itself.');
        } else if (shot.status === 'unreadable' || shot.status === 'oversize') {
            notVerified.push(`The report's screenshot was NOT read (${shot.status}); the change was worked from the text alone.`);
        }
    }

    if (translation && translation.status === 'untranslated') {
        notVerified.push('The report is not in English and no translation was available; it was routed by keywords only.');
    } else if (translation && translation.status && translation.status !== 'none') {
        verified.push(`The report was translated to English beside the original words (${clip(translation.note, 80)}).`);
    }

    notVerified.push('Not looked at on a real phone: a measurement or a test is not a person using the app.');
    notVerified.push('Not run against the owner\'s live data.');

    const ruleLine = rules.length ? `\n_Standing rules shown to the author: ${rules.map((r) => `\`${clip(r, 40)}\``).join(', ')}._` : '';
    const markdown = [
        '### Evidence ledger',
        '_Written by a program from what this run recorded, not by a model (operating charter: docs/update-charter.md)._',
        '',
        '**Verified in this run**',
        ...(verified.length ? verified.map((v) => `- ${v}`) : ['- Nothing was verified by a program.']),
        '',
        '**Not verified**',
        ...notVerified.map((v) => `- ${v}`),
    ].join('\n') + ruleLine;
    return { verified, notVerified, markdown };
}
