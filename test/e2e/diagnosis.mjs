/* "Copy diagnostics" in a real browser: the update-system chain is in the copied report, it names the FIRST broken link,
 * a crash on an old build is history (not an error), nothing the owner wrote is copied, and the copy never waits for the network.
 *
 * Run: node test/e2e/diagnosis.mjs     (set WF_CHROME to a Chromium binary if Playwright's own is not installed)
 */
import { bootDevices } from './devices.mjs';

const results = [];
const note = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail || '' }); console.log((ok ? 'ok    ' : 'FAIL  ') + name + (detail ? ' — ' + detail : '')); };

const w = await bootDevices(['d']);
const dev = w.devices.d;
const page = dev.page;

try {
    const running = await page.evaluate(() => window.WF_APP_VERSION);
    const healthyAutonomy = { ok: true, overall: 'healthy', canActuallyFixBugs: true, headline: 'Automatic updates are working.', lastRealChange: { daysAgo: 0, summary: 'a real change' }, emptyVersionBumpsRecently: 0, checks: [{ id: 'models', status: 'ok', summary: 'fine' }] };
    let autonomy = healthyAutonomy;
    let hangVersion = false;
    await page.route('**/api/version', (r) => (hangVersion ? null : r.fulfill({ json: { sha: 'abc123def456', version: running, env: 'production', ts: new Date().toISOString() } })));
    await page.route('**/api/autonomy-status*', (r) => r.fulfill({ json: autonomy }));

    /** Press "Copy diagnostics" the way a person does and return what reached the clipboard. */
    const copy = () => page.evaluate(async () => {
        let got = null;
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { got = t; } } });
        const t0 = performance.now();
        await window._wfCopyDiagnostics();
        return { text: got, ms: Math.round(performance.now() - t0) };
    });
    const parse = (c) => { try { return JSON.parse(c.text); } catch (_) { return null; } };
    const link = (j, id) => j.updateSystem.chain.find((l) => l.id === id);

    // ── 1. the report has the chain, and the chain is judged from real evidence
    await page.evaluate(() => window.WFDiagnosis.refresh());
    let j = parse(await copy());
    note('1. the copied report is valid JSON with the update-system chain', !!j && j.updateSystem && Array.isArray(j.updateSystem.chain) && j.updateSystem.chain.length === 10, j ? j.updateSystem.chain.map((l) => l.id + ':' + l.state).join(' ') : 'not JSON');
    note('1. the first line to read is the verdict', typeof j.updateSystemVerdict === 'string' && /^(healthy|degraded|broken|unknown) — \d+ of 10 links healthy/.test(j.updateSystemVerdict), j && j.updateSystemVerdict);
    note('1. the server links are measured (deploy, notes, agent all ok)', ['deploy', 'notes', 'agent'].every((id) => link(j, id).state === 'ok'), ['deploy', 'notes', 'agent'].map((id) => id + '=' + link(j, id).state + ' ' + link(j, id).detail.slice(0, 50)).join(' | '));
    note('1. the server evidence is fresh and says how old it is', j.updateSystem.evidenceAgeSec != null && j.updateSystem.evidenceAgeSec < 30, 'age ' + j.updateSystem.evidenceAgeSec + 's');
    note('1. the report names the running build and the deploy it saw', j.updateSystem.evidence.running === running && j.updateSystem.evidence.server.version.sha === 'abc123def456', running);

    // ── 2. crashes on an OLD build are history, not an error
    await page.evaluate((old) => {
        localStorage.setItem('wf_crash_detector', '2');
        localStorage.setItem('wf_crash_log', JSON.stringify([
            { when: new Date().toISOString(), build: old, page: 'page-dashboard', dom: 3534, charts: 0, aliveSec: 5 },
            { when: new Date().toISOString(), build: old, page: 'page-dashboard', dom: 3500, charts: 0, aliveSec: 7 },
        ]));
        localStorage.setItem('wf_crash_total_count', '2');
    }, '7.60.0');
    j = parse(await copy());
    const crashIssue = j.detectedIssues.find((i) => i.area === 'stability');
    note('2. crashes on an older build are an INFO line saying none happened on this build', crashIssue && crashIssue.severity === 'info' && new RegExp('none on this build \\(' + running.replace(/\./g, '\\.') + '\\)').test(crashIssue.message), crashIssue && crashIssue.message);
    note('2. the stability link is healthy and shows the per-build counts', link(j, 'stability').state === 'ok' && /7\.60\.0 ×2/.test(link(j, 'stability').detail), link(j, 'stability').detail);

    // ── 3. a crash on the RUNNING build is an error and breaks the verdict
    await page.evaluate((cur) => {
        const log = JSON.parse(localStorage.getItem('wf_crash_log'));
        log.push({ when: new Date().toISOString(), build: cur, page: 'page-reports', dom: 4000, charts: 1, aliveSec: 3 });
        localStorage.setItem('wf_crash_log', JSON.stringify(log));
        localStorage.setItem('wf_crash_total_count', '3');
    }, running);
    j = parse(await copy());
    const crashNow = j.detectedIssues.find((i) => i.area === 'stability' && i.severity === 'error');
    note('3. a crash on the running build is an error', !!crashNow && /1 crash.*page-reports|crash\(es\) detected/.test(crashNow.message), crashNow && crashNow.message.slice(0, 100));
    note('3. the stability link FAILS and the verdict is broken', link(j, 'stability').state === 'fail' && j.updateSystem.verdict === 'broken', j.updateSystemVerdict);
    await page.evaluate(() => { localStorage.removeItem('wf_crash_log'); localStorage.removeItem('wf_crash_total_count'); });

    // ── 4. a broken pipeline is named, first, with its failing check
    autonomy = { ok: false, overall: 'broken', canActuallyFixBugs: false, headline: 'NOT working', checks: [{ id: 'models', status: 'broken', summary: 'No model provider is reachable' }] };
    // twice: the first call may join a refresh the previous copy started before the server's answer changed
    await page.evaluate(async () => { await window.WFDiagnosis.refresh(); await window.WFDiagnosis.refresh(); });
    j = parse(await copy());
    note('4. a pipeline that cannot fix anything is the first break', j.updateSystem.firstBreak === 'agent' && link(j, 'agent').state === 'fail', j.updateSystem.summary.slice(0, 140));
    note('4. the failing check is quoted', /models: No model provider is reachable/.test(link(j, 'agent').detail), link(j, 'agent').detail.slice(0, 120));
    note('4. its issue sorts above the info lines in detectedIssues', j.detectedIssues[0].severity === 'error' && j.detectedIssues[0].area === 'update-system', j.detectedIssues[0].message.slice(0, 80));
    autonomy = healthyAutonomy;
    await page.evaluate(async () => { await window.WFDiagnosis.refresh(); await window.WFDiagnosis.refresh(); });

    // ── 5. feedback: a stuck report is named, and what was written never leaves the device
    await page.evaluate(() => {
        localStorage.setItem('wf_feedback_queue', JSON.stringify([
            { text: 'SECRET-SALARY-NOTE', type: 'bug', issue: 492, _status: 'needs-attention', createdAt: new Date(Date.now() - 30 * 3600e3).toISOString() },
            { text: 'ANOTHER-PRIVATE-LINE', type: 'feature', issue: 501, _status: 'in-progress', createdAt: new Date().toISOString() },
        ]));
    });
    const c5 = await copy();
    j = parse(c5);
    note('5. a report that reached the attempt limit is the first break and names its issue', j.updateSystem.firstBreak === 'feedback' && /#492/.test(link(j, 'feedback').detail), link(j, 'feedback').detail.slice(0, 120));
    note('5. nothing the owner wrote is in the copied report', !/SECRET-SALARY-NOTE|ANOTHER-PRIVATE-LINE/.test(c5.text));
    await page.evaluate(() => localStorage.removeItem('wf_feedback_queue'));

    // ── 6. an update that was started and never settled
    await page.evaluate(() => localStorage.setItem('wf_update_claimed', JSON.stringify({ target: '99.0.0', from: '1.0.0', at: Date.now() - 30 * 60e3, fetched: 14, total: 82 })));
    j = parse(await copy());
    note('6. an unsettled update claim is reported with its file count', link(j, 'install').state === 'warn' && /14\/82 files/.test(link(j, 'install').detail), link(j, 'install').detail.slice(0, 130));
    await page.evaluate(() => localStorage.removeItem('wf_update_claimed'));

    // ── 7. copying never waits for the network (a clipboard write must stay inside its tap)
    hangVersion = true;
    const slow = await copy();
    note('7. the copy finishes at once even if the server never answers', slow.ms < 1500 && !!parse(slow), slow.ms + ' ms');
    hangVersion = false;

    note('no uncaught page errors', dev.errors.length === 0, dev.errors.join(' | ').slice(0, 300));
} catch (e) {
    note('the run reached the end without an exception', false, String((e && e.stack) || e).slice(0, 500));
} finally {
    await w.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
