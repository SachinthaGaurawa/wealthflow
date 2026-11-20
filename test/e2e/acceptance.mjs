/** Browser check for autonomy/acceptance.mjs: the change is run on a phone-size screen in real Chromium, and what appeared is what the judges are shown.
 * Models are scripted (no provider key needed); the browser, the app, the module and the measuring are real.
 *   1. the real CC Instalments sheet (wealthflow-cc-instalment-detail.js, #635) is opened by a tap and its text reaches the evidence next to the table row's text;
 *   2. a module that draws nothing on tap is caught by a PROGRAM (a tap that changed nothing), whatever the judges say;
 *   3. a judge that invents a quote is thrown away, one that quotes the screen is kept, and two judges on different providers are asked;
 *   4. the plan is applied through five fixed verbs only (a step that names a selector the page does not have is reported, not run).
 * Run from the repository root:  node test/e2e/acceptance.mjs      WF_ACCEPT_ARTIFACTS selects the screenshot folder (default /tmp/wealthflow-acceptance)
 */
import fs from 'node:fs';
import path from 'node:path';
import { runAcceptance } from '../../autonomy/acceptance.mjs';

const out = process.env.WF_ACCEPT_ARTIFACTS || '/tmp/wealthflow-acceptance';
fs.mkdirSync(out, { recursive: true });
const fail = [];
const check = (c, m) => { if (!c) fail.push(m); };

const books = {
    ccinstall: [
        { id: 'a1', product: 'Principle', bank: 'HNB Credit Card', card_last4: '1111', buyer: 'Self', total: 120000, rate: 0, duration: 12, monthly: 10000, date: '2026-08-23', notes: 'Card installment charge', completed: false },
        { id: 'a2', product: 'SINGER Washing Machine', bank: 'Sampath Bank', card_last4: '2222', buyer: 'Self', total: 60000, rate: 0, duration: 6, monthly: 10000, date: '2026-10-24', notes: 'Card installment charge', completed: false },
    ],
};
const plan = (tap = '#cciBody tr:first-child td:first-child') => ({
    criteria: ['Tap a row and see which products', 'The counts agree with the table'], books,
    steps: [{ do: 'page', name: 'ccinstall' }, { do: 'render', fn: 'renderCCI' }, { do: 'shot', label: 'list' }, { do: 'tap', selector: tap }, { do: 'shot', label: 'sheet' }],
});
const issue = { title: 'CC Instalments: I cannot tap a row to see which products', body: 'I tap a row on my phone and nothing opens. I want to see which products are in the plan.' };
const NO_VISION = async () => ({ ok: false });

/** scripted models: the tester returns `p`; judge A and judge B answer from `judge(role, evidence)` */
function models(p, judge) {
    const calls = [];
    const chat = async (o) => {
        calls.push({ kind: /You are the TESTER/.test(o.prompt) ? 'tester' : 'judge', exclude: o.exclude || [] });
        if (/You are the TESTER/.test(o.prompt)) return { text: JSON.stringify(p), provider: 'tester-ai' };
        const role = /JUDGE A/.test(o.prompt) ? 'A' : 'B';
        const evidence = o.prompt.split('EVIDENCE')[1] || '';
        return { text: JSON.stringify(judge(role, evidence)), provider: role === 'A' ? 'judge-a' : 'judge-b' };
    };
    return { chat, calls };
}

// 1. the real sheet, opened by a tap, with two honest judges
{
    const code = fs.readFileSync('wealthflow-cc-instalment-detail.js', 'utf8');
    const m = models(plan(), () => ({ verdict: 'ok', findings: [] }));
    const r = await runAcceptance({ issue, module: { name: 'wealthflow-cc-instalment-detail.js', api: 'WFCCInstalmentDetail', code }, deps: { chat: m.chat, describe: NO_VISION }, outDir: path.join(out, 'real'), log: (x) => console.log(x) });
    check(r.status === 'passed', `the real sheet should pass with two quiet judges, got ${r.status} ${r.reason || ''} ${JSON.stringify(r.blocking.map((b) => b.why))}`);
    check(r.shots.length >= 3 && r.shots.every((f) => fs.existsSync(f)), 'screenshots should exist for the list, the tap and the sheet');
    check(/Principle/.test(r.evidence) && /2\/12/.test(r.evidence), 'the evidence should hold the table row (2/12) the judges compare the sheet with');
    check(/A sheet is open \(#wfCciDetailHost\)/.test(r.evidence) && /Schedule/.test(r.evidence), 'the evidence should hold the text of the sheet the tap opened');
    check(!/A sheet is open \(#sidebar\)/.test(r.evidence), 'the side menu that was already there must not be counted as a sheet the tap opened');
    check(m.calls.filter((c) => c.kind === 'judge').length === 2, 'two judges should be asked');
    check(m.calls.filter((c) => c.kind === 'judge')[1].exclude.includes('judge-a'), 'the second judge must be on a different provider than the first');
}

// 2. a program catches a tap that changes nothing, even when both judges say all is well (the module draws a box and the tap on it does nothing)
{
    const dead = "(function (root) { 'use strict'; function mount() { var d = document.createElement('div'); d.id = 'accProbe'; d.textContent = 'Tap me for the products'; d.style.cssText = 'position:fixed;bottom:80px;left:10px;padding:14px;background:#eee;z-index:5'; document.body.appendChild(d); } if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount(); root.WFDeadProbe = { mount: mount }; })(typeof window !== 'undefined' ? window : globalThis);\n";
    const p = plan('#accProbe');
    const m = models(p, () => ({ verdict: 'ok', findings: [] }));
    const r = await runAcceptance({ issue, module: { name: 'wealthflow-dead-probe.js', api: 'WFDeadProbe', code: dead }, deps: { chat: m.chat, describe: NO_VISION }, outDir: path.join(out, 'dead') });
    check(r.status === 'problems', `a tap that changes nothing must be a problem, got ${r.status} ${r.reason || ''}`);
    check(r.blocking.some((f) => f.measure === 'dead_tap'), 'the dead tap should be measured by the program, not by a judge');
}

// 3. quotes are checked: an invented one is dropped, a real one is kept, and one raised by both judges is agreed
{
    const code = fs.readFileSync('wealthflow-cc-instalment-detail.js', 'utf8');
    const m = models(plan(), (role) => ({ verdict: 'problems', findings: [
        { kind: 'unclear', severity: 'medium', quote: 'Remaining LKR 100,000.00 (10 months)', why: 'months and money in one line', fix: 'split them' },
        ...(role === 'A' ? [{ kind: 'contradiction', severity: 'high', quote: 'The sheet says paid 9 of 12', why: 'invented', fix: '' }] : []),
    ] }));
    const r = await runAcceptance({ issue, module: { name: 'wealthflow-cc-instalment-detail.js', api: 'WFCCInstalmentDetail', code }, deps: { chat: m.chat, describe: NO_VISION }, outDir: path.join(out, 'quotes') });
    check(r.status === 'problems', `a finding both judges quote from the screen should block, got ${r.status}`);
    check(r.findings.length === 1 && r.findings[0].agreed, `one agreed finding expected, got ${JSON.stringify(r.findings.map((f) => [f.quote, f.agreed]))}`);
    check(!r.findings.some((f) => /paid 9 of 12/.test(f.quote)), 'the invented quote must be thrown away');
    check(r.dropped === 1, `exactly one finding should have been dropped, got ${r.dropped}`);
}

// 4. a step aimed at something that is not on the page is reported, and cannot pass the run as if it had been looked at
{
    const code = fs.readFileSync('wealthflow-cc-instalment-detail.js', 'utf8');
    const m = models(plan('#thisDoesNotExist'), () => ({ verdict: 'ok', findings: [] }));
    const r = await runAcceptance({ issue, module: { name: 'wealthflow-cc-instalment-detail.js', api: 'WFCCInstalmentDetail', code }, deps: { chat: m.chat, describe: NO_VISION }, outDir: path.join(out, 'missed') });
    check(r.status === 'inconclusive', `a script that never reached the thing it should tap must be inconclusive, got ${r.status}`);
    check(/COULD NOT RUN: nothing on the page matches #thisDoesNotExist/.test(r.evidence), 'the missed step should be named in the evidence');
}

if (fail.length) { console.error('\nFAILED:\n - ' + fail.join('\n - ')); process.exit(1); }
console.log('acceptance run: ok (real sheet, dead tap, verified quotes, missed step)');
