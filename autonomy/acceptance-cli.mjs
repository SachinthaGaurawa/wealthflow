/* =============================================================================
 * autonomy/acceptance-cli.mjs — check a shipped feature on a phone, and ask for a revision when it is not right   (owner, 2026-11-20)
 * -----------------------------------------------------------------------------
 *   node autonomy/acceptance-cli.mjs --issue 635 [--dry]
 *
 * Run by .github/workflows/acceptance-check.yml when a feedback issue closes. It finds the module the fix agent shipped for the issue, runs it on a phone-size
 * browser with the owner's own words as the script (autonomy/acceptance.mjs), and then:
 *   · passed       → one comment saying what was checked;
 *   · problems     → one comment quoting the screen, the issue is reopened and the fix agent is started in revision mode (autonomy/build-lane.mjs);
 *   · second round → label ai-stuck and ask the owner (never a third automatic try).
 * Nothing is merged or deployed here; a revision goes through the same pull request, tests, board and release gates as any other change.
 * Exit codes: 0 done (whatever the verdict), 1 broken.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Q from './work-queue.mjs';
import { runAcceptance, acceptanceSummary, findingsBrief } from './acceptance.mjs';
import { shippedModuleFrom, roundsWithProblems, decide, checkComment, MAX_ROUNDS } from './acceptance-flow.mjs';
import { symptomHome, homeFacts } from './symptom-home.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The report as words: the pictures were read when it was filed (their reading is in the body), the pictures themselves are not words. */
export function reportText(issue) {
    const body = String(issue.body || '')
        .replace(/<details>[\s\S]*?<\/details>/g, '')
        .replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, '[image]')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\n{3,}/g, '\n\n');
    return { title: String(issue.title || ''), body: body.slice(0, 7000) };
}

/** Has this issue already been checked since the last fix? (a repeated close event must not run it twice) */
export function alreadyChecked(comments) {
    let checked = false;
    for (const c of comments || []) {
        if (String((c && c.user && c.user.login) || '') !== 'github-actions[bot]') continue;
        const body = String(c.body || '');
        if (/<!--\s*wf-acceptance\s+round=\d+/.test(body)) checked = true;
        else if (/<!--\s*wf-agent-attempt\s*-->/.test(body) && /Fix drafted/.test(body)) checked = false;
    }
    return checked;
}

async function main() {
    const args = process.argv.slice(2);
    const number = Number(args[args.indexOf('--issue') + 1]);
    const dry = args.includes('--dry');
    if (!Number.isInteger(number) || number < 1) { console.error('usage: acceptance-cli.mjs --issue <number> [--dry]'); process.exit(1); }
    const log = (m) => console.log(m);

    const issue = await Q.getIssue(number);
    if (issue.pull_request) { log(`#${number} is a pull request — nothing to check`); return; }
    const comments = await Q.issueComments(number);
    const file = shippedModuleFrom(comments);
    if (!file) { log(`#${number}: the agent shipped no new module for it — nothing to run on a phone`); return; }
    if (alreadyChecked(comments)) { log(`#${number}: already checked since the last fix — not running twice`); return; }
    // only a module the build lane ADDED for this very issue is checked here (wireModule leaves that line in index.html); a fix to an existing file has its own gates
    const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    if (!page.includes(`${file}, added by the build lane for #${number} -->`)) { log(`#${number}: ${file} was not added by the build lane for this issue — nothing to run`); return; }
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) { log(`#${number}: ${file} is not on this branch — nothing to run`); return; }
    const code = fs.readFileSync(full, 'utf8');
    const api = (/root\.(WF[A-Za-z0-9]{2,30})\s*=/.exec(code) || /window\.(WF[A-Za-z0-9]{2,30})\s*=/.exec(code) || [])[1] || '';
    const rep = reportText(issue);
    let facts = '';
    try { const home = symptomHome(`${rep.title}\n${rep.body}`, { repoDir: ROOT }); if (home.found) facts = homeFacts(home); } catch (_) { /* no screen lookup, the report alone */ }

    const round = roundsWithProblems(comments) + 1;
    log(`#${number}: running ${file} on a phone (round ${round}/${MAX_ROUNDS})`);
    const result = await runAcceptance({
        issue: rep, module: { name: file, api, code }, facts, repoDir: ROOT, log,
        outDir: process.env.WF_ACCEPTANCE_DIR ? path.join(process.env.WF_ACCEPTANCE_DIR, `issue-${number}`) : '',
    });
    const verdict = decide({ result, round });
    log(`#${number}: ${result.status} → ${verdict.action}${verdict.why ? ` (${verdict.why})` : ''}`);
    const summary = acceptanceSummary(result);
    if (dry) { console.log(summary); console.log(findingsBrief(result.findings)); return; }

    if (verdict.action === 'none') { log('the run could not start; nothing is written, so the next close event can try again'); return; }
    if (verdict.action === 'pass' || verdict.action === 'inconclusive') {
        await Q.comment(number, checkComment({ round, file, status: result.status, summary, action: 'pass' }));
        return;
    }
    const brief = findingsBrief(result.findings);
    await Q.comment(number, checkComment({ round, file, status: result.status, summary, brief, action: verdict.action }));
    if (verdict.action === 'give_up') { await Q.addLabels(number, [Q.LABELS.stuck]).catch(() => {}); return; }
    await Q.reopenIssue(number);
    await Q.dispatchWorkflow('autonomous-fix.yml', { issue: String(number) }).catch((e) => log(`could not start the fix agent now (${e.message}); the next scheduled run picks the reopened issue up`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((e) => { console.error(`acceptance-cli: ${e && e.stack || e}`); process.exit(1); });
}
