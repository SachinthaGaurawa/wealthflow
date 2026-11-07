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
 *   It also carries three parts of the owner's elite-expert prompt that only a program can keep honest:
 *     part 2  what each statement rests on: verified / strongly supported / inference / hypothesis / forecast / value
 *             judgment / unknown, sorted by rule from the record, not by a model's say-so;
 *     part 19 the confidence label (HIGH, MODERATE, LOW, UNDETERMINED) COMPUTED from the record, with its reasons and the
 *             evidence that would raise it. A model's own claim of confidence changes nothing;
 *     part 23 a decision record: strongest conclusion, what is established, what is inferred, the strongest alternative, what
 *             could make it wrong, what is unknown, and the next practical step for the owner.
 *
 * Pure: no I/O. Every line comes from a field; a missing field becomes a "not verified" line, never a guess.
 * ===========================================================================*/

import { injectionSignals } from './untrusted-text.mjs';

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * @param {object} o
 * @param {object} [o.result]       the swarm / lane result (lane, verified, mutation, review, providers, layout)
 * @param {object} [o.shot]         screenshotContext result ({ status, provider, note }) or null when the report had no picture
 * @param {object} [o.translation]  withTranslation result ({ status, note }) or null
 * @param {string|null} [o.testWritten]
 * @param {string[]} [o.rules]      ids of the standing rules shown to the author (autonomy/lessons.mjs)
 * @param {object} [o.card]         the task card (autonomy/task-card.mjs): its depth limits how confident the ledger may be
 * @param {object} [o.analysis]     the independent analysis (autonomy/analysis-pass.mjs) or null
 * @param {string} [o.reportText]   the owner's report, scanned for instruction-like text (autonomy/untrusted-text.mjs)
 * @returns {{ verified:string[], notVerified:string[], confidence:{label:string,reasons:string[],raise:string[]}, markdown:string }}
 */
export function evidenceLedger({ result = {}, shot = null, translation = null, testWritten = null, rules = [], card = null, analysis = null, reportText = '' } = {}) {
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

    // ── part 19: the confidence label, computed ────────────────────────────────────────────────────────────────────────────
    const confidence = confidenceFrom({ result, lane, provs, testWritten, shot, translation, card, analysis });

    // ── part 2: what each statement rests on ───────────────────────────────────────────────────────────────────────────────
    const inferences = [];
    if (shot && shot.status === 'read') inferences.push(`the screenshot was read by a model (${clip(shot.provider || 'a vision model', 40)}); that is its account of the picture`);
    if (translation && translation.status && translation.status !== 'none' && translation.status !== 'untranslated') inferences.push('the report was translated by a model');
    const unknown = [];
    if (analysis && analysis.status === 'ok') for (const u of analysis.unknowns || []) unknown.push(u);
    unknown.push('how it looks and feels on the owner\'s phone', 'how it behaves on the owner\'s live data');
    const strong = confidence.strong;
    const classes = [
        `- **A Verified:** ${verified.length} item${verified.length === 1 ? '' : 's'} above (a program ran or measured them in this run).`,
        `- **B Strongly supported:** ${strong ? 'yes: ' + strong : 'no: the independent checks that would support it are not all present'}.`,
        `- **C Inference:** ${inferences.length ? inferences.join('; ') : 'none recorded'}.`,
        `- **D Hypothesis:** ${analysis && analysis.status === 'ok' ? `the cause stated by the independent analysis (${analysis.cause.citation === 'found' ? 'its quote was found in the code' : analysis.cause.citation === 'not-found' ? 'its quote was NOT found in the code' : 'it quoted no line'})` : 'no independent analysis of the cause was recorded'}.`,
        '- **E Forecast:** how the change behaves once the update reaches the owner\'s phone; the canary checks the live app after release, nothing here has.',
        '- **F Value judgment:** whether it is easy to use is the owner\'s call; the board\'s release score is an opinion, the checks that ran are the evidence.',
        `- **G Unknown:** ${unknown.slice(0, 4).join('; ')}.`,
    ];

    // ── part 16: instruction-like text in the report ───────────────────────────────────────────────────────────────────────
    const signals = injectionSignals(reportText);
    const signalLine = signals.length ? `\n**Note:** the report contained instruction-like text (${signals.map((x) => x.id).join(', ')}). It was treated as data, not obeyed. A reviewer should read the report once with that in mind.` : '';

    // ── part 23: the decision record ───────────────────────────────────────────────────────────────────────────────────────
    const a = analysis && analysis.status === 'ok' ? analysis : null;
    const what = card && card.outcome ? card.outcome : 'the report';
    const record = [
        `1. **Strongest conclusion the evidence supports:** a ${lane} change${result.file ? ` to \`${clip(result.file, 60)}\`` : ''} for "${clip(what, 100)}", ${confidence.label} confidence within what a program could check.`,
        `2. **Directly established:** ${verified.length ? verified.slice(0, 2).map((v) => clip(v, 110)).join(' ') : 'nothing by a program in this run'}`,
        `3. **Inferred or assumption-dependent:** ${[...inferences, ...(a ? a.assumptions : [])].slice(0, 3).join('; ') || 'none recorded'}.`,
        `4. **Strongest credible alternative:** ${a && a.alternatives[0] ? a.alternatives[0].hypothesis : 'none was recorded'}.`,
        `5. **Could be wrong if:** ${a && a.failures[0] ? a.failures[0].what : 'an input or a device the checks did not cover'}.`,
        `6. **Still unknown:** ${unknown.slice(0, 2).join('; ')}.`,
        `7. **Evidence that would help most:** ${confidence.raise[0] || 'a check on a real phone'}.`,
        `8. **Next step for the owner:** after the update card appears, open the screen named in your report on your phone and compare it with what you reported. If it is not right, say so; the next attempt starts from that.`,
    ];

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
        '',
        '**What each statement rests on**',
        ...classes,
        '',
        `**Confidence, computed by a program: ${confidence.label}** (within what a program could check; never a guarantee)`,
        ...confidence.reasons.map((r) => `- ${r}`),
        ...(confidence.raise.length ? ['What would raise it:', ...confidence.raise.map((r) => `- ${r}`)] : []),
        '',
        '**Decision record**',
        ...record,
    ].join('\n') + signalLine + ruleLine;
    return { verified, notVerified, confidence, markdown };
}

const ratio = (m) => (m && !m.skipped && m.total > 0 ? m.killed / m.total : null);

/**
 * The confidence label, from the record alone (part 19). HIGH needs every independent check present and strong; COMPREHENSIVE
 * depth (money or saved data) needs the sabotage check to have caught at least 80% of the broken versions. A model's own
 * claim of certainty is not an input.
 * @returns {{ label:'HIGH'|'MODERATE'|'LOW'|'UNDETERMINED', reasons:string[], raise:string[], strong:string }}
 */
export function confidenceFrom({ result = {}, lane = 'swarm', provs = {}, testWritten = null, shot = null, translation = null, card = null, analysis = null } = {}) {
    const reasons = [];
    const raise = [];
    const depth = (card && card.depth) || 'deep';
    const independent = Boolean(result.review && result.review.verdict && provs.security && provs.author !== provs.security);
    const reviewed = Boolean(result.review && result.review.verdict);
    let low = false, moderate = false, strongBits = [];

    if (lane === 'layout') {
        const v = String((result.layout && result.layout.verdict) || '').toLowerCase();
        if (!v) { low = true; reasons.push('The layout measurement did not report a verdict.'); }
        else if (v === 'fixed') { strongBits.push('the screen was measured before and after and the problem is gone'); reasons.push('The layout problem was measured as fixed, in a browser, on invented books.'); }
        else { moderate = true; reasons.push(`The layout measurement says "${v}", not "fixed".`); raise.push('a clean measurement (the overlap fully gone)'); }
    } else if (lane === 'build') {
        reasons.push('A new module was only machine-checked; whether it is useful is for the owner to judge.');
        moderate = true;
        raise.push('the owner using the new module once on a real phone');
    } else if (testWritten && result.verified) {
        const r = ratio(result.mutation);
        strongBits.push('a proving test went red then green');
        reasons.push('The proving test failed on the original and passed on the change.');
        if (r === null) { moderate = true; reasons.push('No sabotage check ran, so the test was never shown to notice a different wrong fix.'); raise.push('a sabotage check that breaks the fix and sees the test fail'); }
        else if (result.mutation.weak) { moderate = true; reasons.push(`The test caught only ${result.mutation.killed} of ${result.mutation.total} sabotaged versions: thin evidence.`); raise.push('a stronger test that catches the sabotaged versions it missed'); }
        else {
            strongBits.push(`the test caught ${result.mutation.killed} of ${result.mutation.total} sabotaged versions`);
            if (depth === 'comprehensive' && r < 0.8) { moderate = true; reasons.push(`Because this touches money or saved data, the test must catch at least 80% of sabotaged versions; it caught ${result.mutation.killed} of ${result.mutation.total}.`); raise.push('a test that catches at least 80% of the sabotaged versions'); }
        }
    } else if (testWritten) {
        low = true; reasons.push('The proving test was not confirmed red then green.'); raise.push('a proving test that is executed and goes from red to green');
    } else {
        low = true; reasons.push('There is no proving test.'); raise.push('a proving test that is executed and goes from red to green');
    }

    if (lane !== 'build' || reviewed) {
        if (!reviewed) { low = true; reasons.push('No independent security review is recorded.'); raise.push('a security review by a model on a different provider'); }
        else if (!independent) { moderate = true; reasons.push('The reviewer ran on the author\'s own provider, so the review is not independent.'); raise.push('a reviewer on a different provider'); }
        else { strongBits.push(`reviewed by a different provider (${clip(provs.security, 30)})`); }
    } else {
        low = true; reasons.push('No independent security review is recorded.'); raise.push('a security review by a model on a different provider');
    }

    if (shot && (shot.status === 'unreadable' || shot.status === 'oversize')) { moderate = true; reasons.push('The report\'s screenshot was not read; the change was worked from the words alone.'); raise.push('a readable screenshot or a written description of what is on it'); }
    if (translation && translation.status === 'untranslated') { moderate = true; reasons.push('The report could not be translated; it was routed by keywords only.'); }
    if (analysis && analysis.status === 'ok' && analysis.cause && analysis.cause.citation === 'not-found') { reasons.push('The analyst\'s quote of the code was not found, so its account of the cause is unverified (the test still stands on its own).'); }

    raise.push('the owner opening the screen on a real phone after the update');

    const nothing = !result.review && !testWritten && !(result.layout && result.layout.verdict) && lane !== 'build';
    const label = nothing ? 'UNDETERMINED' : low ? 'LOW' : moderate ? 'MODERATE' : 'HIGH';
    return { label, reasons, raise: [...new Set(raise)].slice(0, 4), strong: strongBits.join('; ') };
}
