#!/usr/bin/env node
/* =============================================================================
 * autonomy/audit-summary.mjs — turn `npm audit --json` into a few honest lines.
 * -----------------------------------------------------------------------------
 * Used by .github/workflows/security-updates.yml for the before/after tables in
 * the job log and in the pull request it opens. Pure and deterministic: no
 * network, no model. Exported so test/audit_summary_test.js can pin the format.
 *
 *   node autonomy/audit-summary.mjs audit.json
 * ===========================================================================*/
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

/** @param {object} audit parsed `npm audit --json` (v7+ shape) */
export function summarise(audit) {
    const meta = (audit && audit.metadata && audit.metadata.vulnerabilities) || {};
    const counts = Object.fromEntries(ORDER.map((s) => [s, Number(meta[s]) || 0]));
    const total = Number(meta.total) || ORDER.reduce((n, s) => n + counts[s], 0);
    const vulns = Object.entries((audit && audit.vulnerabilities) || {}).map(([name, v]) => ({
        name,
        severity: String(v.severity || 'unknown'),
        direct: Boolean(v.isDirect),
        fixAvailable: v.fixAvailable === true ? 'yes' : (v.fixAvailable && typeof v.fixAvailable === 'object'
            ? (v.fixAvailable.isSemVerMajor ? `major (${v.fixAvailable.name}@${v.fixAvailable.version})` : 'yes')
            : 'no'),
        range: String(v.range || ''),
    })).sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity) || a.name.localeCompare(b.name));
    return { total, counts, vulns };
}

export function render(summary) {
    const head = `total ${summary.total}: ` + ORDER.map((s) => `${s} ${summary.counts[s]}`).join(' · ');
    if (!summary.vulns.length) return head + '\n(no vulnerable packages)';
    const rows = summary.vulns.map((v) => `${v.severity.padEnd(8)} ${v.name}${v.direct ? ' (direct)' : ''} ${v.range} — fix: ${v.fixAvailable}`);
    return [head, ...rows].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const file = process.argv[2];
    if (!file) { console.error('usage: audit-summary.mjs <audit.json>'); process.exit(2); }
    let audit;
    try { audit = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`audit-summary: cannot read ${file}: ${e.message}`); process.exit(1); }
    if (audit && audit.error) { console.error(`audit-summary: npm audit itself failed: ${audit.error.summary || audit.error.code || 'unknown error'}`); process.exit(1); }
    console.log(render(summarise(audit)));
}
