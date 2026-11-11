#!/usr/bin/env node
/* autonomy/ideate.mjs — one run of the self-ideation loop (the daily workflow calls this).
 * Studies the app, thinks of at most one improvement, decides on it (autonomy/ideas.mjs) and, if the system approves, files it for the fix agent.
 * Prints one line, writes the run summary, and sets the step output `approved=true|false`. Never exits non-zero for "no idea today":
 * declining is a success, and the least important job on the schedule must not be the one that turns the Actions tab red. */
import fs from 'node:fs';
import { proposeOnce } from './propose.mjs';

const dry = process.env.DRY_RUN === 'true' || process.argv.includes('--dry');
let r;
try { r = await proposeOnce({ dryRun: dry }); } catch (e) { r = { filed: null, reason: `idea engine error (non-fatal): ${e.message}` }; }

let md;
if (r.filed) {
    console.log(`${r.approved ? 'approved' : 'declined'} #${r.filed.number}: ${r.filed.title} — ${r.reason}`);
    md = `### Idea ${r.approved ? 'approved by the system' : 'declined by the system'}\n\n#${r.filed.number} — ${r.filed.title}\n\n${r.reason}\n`;
} else {
    console.log(`no idea filed this run: ${r.reason}`);
    md = `### No idea filed this run\n\n${r.reason}\n`;
    if (r.proposal) md += `\n<details><summary>draft</summary>\n\n\`\`\`json\n${JSON.stringify(r.proposal, null, 2)}\n\`\`\`\n</details>\n`;
}
for (const [file, text] of [[process.env.GITHUB_STEP_SUMMARY, md + '\n'], [process.env.GITHUB_OUTPUT, `approved=${r.approved ? 'true' : 'false'}\n`]]) {
    if (file) { try { fs.appendFileSync(file, text); } catch { /* summary is a courtesy */ } }
}
