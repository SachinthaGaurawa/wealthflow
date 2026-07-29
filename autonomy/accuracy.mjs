/* =============================================================================
 * autonomy/accuracy.mjs — the detectors are graded by the outcomes they caused
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Every detector in discover.mjs was written believing it was correct. Three
 *   were not, and each was caught only because a human happened to look:
 *
 *     • `typeof window[name]` marked six WORKING buttons broken — a top-level
 *       `const` is a global lexical binding, not a window property
 *     • the comment stripper desynced on a regex holding unbalanced quotes and
 *       reported the scanner's own documentation as bugs
 *     • `/manifest.json` was reported missing while the file sat in the repo root
 *
 *   Noticing those by hand does not scale, and the failure mode is quiet: a
 *   detector that cries wolf does not crash, it just steadily teaches you to
 *   ignore the queue. By the time that is obvious, the queue is already useless.
 *
 *   So the system grades itself with the only signal that is not its own
 *   opinion: WHAT HAPPENED TO THE ISSUES IT FILED. A finding a human fixed was
 *   real. A finding a human closed as not-planned was, in that human's
 *   judgement, not worth having been told about. That is the ground truth, and
 *   it costs nothing to collect because GitHub already stores it.
 *
 * WHAT IT DOES WITH THAT
 *   A detector whose findings are mostly rejected gets QUARANTINED — it keeps
 *   running and reporting locally, but stops filing issues. Deliberately not
 *   deleted: the fix is usually a better check, not no check, and a quarantined
 *   detector that starts being right again is easy to re-enable.
 *
 * WHY A HUMAN CAN ALWAYS OVERRULE IT
 *   The threshold is a heuristic, and heuristics are exactly the kind of thing
 *   that should not silently switch off a security scanner. `dep-vuln` is
 *   therefore never quarantined: npm audit is authoritative, and "I am not
 *   fixing this CVE today" is not the same as "this CVE is not real".
 * ===========================================================================*/

import * as Q from './work-queue.mjs';

/** Marker recording WHICH detector filed an issue. */
export const DETECTOR_TAG = 'wf-detector';

/** Detectors that are never auto-quarantined, however they are judged. */
export const NEVER_QUARANTINE = new Set(['dep-vuln']);

/** Judged findings needed before a rate means anything at all. */
export const MIN_SAMPLE = 4;

/** Rejection rate above which a detector stops filing. */
export const QUARANTINE_AT = 0.5;

export function stampDetector(body, kind) {
    return `${body}\n<!-- ${DETECTOR_TAG}:${kind} -->\n`;
}

export function detectorOf(issue) {
    const m = new RegExp(`<!--\\s*${DETECTOR_TAG}:([a-z-]+)\\s*-->`).exec(String(issue?.body || ''));
    return m ? m[1] : null;
}

/**
 * How a human judged one filed finding.
 *
 *   fixed    — closed as completed: the finding was real and got acted on
 *   rejected — closed as not planned, or labelled wontfix/invalid: a human
 *              looked and decided it should not have been raised
 *   open     — no judgement yet; counts toward nothing
 *
 * `state_reason` is the honest signal here. Closing an issue is ambiguous on its
 * own — it can mean "done" or "go away" — and treating every close as agreement
 * would flatter the detectors, which is the one direction this must not err in.
 */
export function judge(issue) {
    if (!issue || issue.state !== 'closed') return 'open';
    const labels = (issue.labels || []).map((l) => String(l?.name || l).toLowerCase());
    if (labels.includes('wontfix') || labels.includes('invalid')) return 'rejected';
    const reason = String(issue.state_reason || '').toLowerCase();
    if (reason === 'not_planned') return 'rejected';
    if (reason === 'completed') return 'fixed';
    return 'open';                       // closed with no stated reason — do not guess
}

/** Build the per-detector ledger from every issue the scanner ever filed. */
export function tally(issues) {
    const byKind = new Map();
    for (const issue of issues || []) {
        const kind = detectorOf(issue);
        if (!kind) continue;                          // filed before kind stamping, or by a human
        if (!byKind.has(kind)) byKind.set(kind, { kind, filed: 0, fixed: 0, rejected: 0, open: 0 });
        const row = byKind.get(kind);
        row.filed += 1;
        row[judge(issue)] += 1;
    }
    const out = [];
    for (const row of byKind.values()) {
        const judged = row.fixed + row.rejected;
        const rejectionRate = judged ? row.rejected / judged : 0;
        out.push({
            ...row,
            judged,
            rejectionRate,
            quarantined: !NEVER_QUARANTINE.has(row.kind)
                && judged >= MIN_SAMPLE
                && rejectionRate > QUARANTINE_AT,
        });
    }
    return out.sort((a, b) => b.rejectionRate - a.rejectionRate || b.filed - a.filed);
}

/** The set of detector kinds currently barred from filing. */
export function quarantinedKinds(ledger) {
    return new Set((ledger || []).filter((r) => r.quarantined).map((r) => r.kind));
}

/**
 * Load the ledger from GitHub. Never throws: if the history cannot be read, the
 * result is an EMPTY ledger, which quarantines nothing. Failing that way round
 * matters — an unreadable history must not be able to silence the scanner.
 */
export async function loadLedger({ env = process.env } = {}) {
    try {
        return tally(await Q.allIssues({ env }));
    } catch {
        return [];
    }
}

/** One-line-per-detector summary for a job log or step summary. */
export function formatLedger(ledger) {
    if (!ledger.length) return 'No graded findings yet — every detector is on probation by default.';
    const rows = ledger.map((r) => {
        const pct = r.judged ? `${Math.round(r.rejectionRate * 100)}%` : '—';
        const flag = r.quarantined ? '  ⛔ QUARANTINED'
            : NEVER_QUARANTINE.has(r.kind) ? '  (never quarantined)'
                : r.judged < MIN_SAMPLE ? `  (only ${r.judged} judged; need ${MIN_SAMPLE})` : '';
        return `  ${r.kind.padEnd(26)} filed ${String(r.filed).padStart(3)}  fixed ${String(r.fixed).padStart(3)}  rejected ${String(r.rejected).padStart(3)}  reject-rate ${pct.padStart(4)}${flag}`;
    });
    return rows.join('\n');
}
