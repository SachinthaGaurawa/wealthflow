// =============================================================================
// The fix agent's layout lane (issue #514: "CC Instalments overlaps on a smartphone").
// Model and browser are injected here; the real-browser case at the bottom runs only where
// Chromium exists (the sandbox and the CI browser jobs), and says so when it is skipped.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    layoutLaneFor, validateCss, validateLaneFile, appendFix, judgeLayout, runLayoutLane, cssContext, layoutPrompt,
    LANE_FILE, MAX_CSS_CHARS,
} from '../autonomy/css-lane.mjs';
import { screenFor, describeProbe } from '../autonomy/layout-probe.mjs';

const SCOPE = '#page-ccinstall';
const GOOD = `${SCOPE} .tbl-wrap table :is(thead th, tbody td):last-child { position: static; box-shadow: none; }`;

const probe = (perWidth) => ({
    ok: true, screen: 'cc-instalments', sample: '<tr><td>x</td></tr>',
    widths: Object.entries(perWidth).map(([width, n]) => ({
        width: Number(width), overflowPx: 0, clipped: [],
        overlaps: Array.from({ length: n }, () => ({ a: 'th "BANK"', b: 'th "ACTIONS"', px: '40x20' })),
    })),
    get problems() { return this.widths.reduce((s, w) => s + w.overlaps.length, 0); },
});

describe('css lane: when it applies', () => {
    const issue = (title, body = '') => ({ title, body: `### User feedback\n> ${body}\n### System diagnosis\n| Device | iPhone |` });
    it('needs a layout complaint AND a screen the probe can open', () => {
        expect(layoutLaneFor(issue('[CRITICAL] CC installments overlap', 'Thats resolutions not working for the smart phone. Overlapped.'))).toMatchObject({ applies: true, screen: 'cc-instalments' });
        expect(layoutLaneFor(issue('CC one-time payments are cut off on my phone'))).toMatchObject({ applies: true, screen: 'cc-onetime' });
    });
    it('does not take a report with no layout words, or with no screen it can measure', () => {
        expect(layoutLaneFor(issue('CC instalments total is wrong', 'the monthly amount is 12000 not 13000')).applies).toBe(false);
        const noScreen = layoutLaneFor(issue('The dashboard overlaps on my phone'));
        expect(noScreen.applies).toBe(false);
        expect(noScreen.why).toMatch(/no screen/);
    });
    it('reads only what the person wrote, not the diagnostics', () => {
        const i = { title: 'Wrong total', body: '### User feedback\n> the total is wrong on CC instalments\n### System diagnosis\n| Device | mobile phone layout |' };
        expect(layoutLaneFor(i).applies).toBe(false);
    });
    it('maps wording to screens', () => {
        expect(screenFor('CC installments')).toBe('cc-instalments');
        expect(screenFor('Credit Card Instalments page')).toBe('cc-instalments');
        expect(screenFor('cc one-time')).toBe('cc-onetime');
        expect(screenFor('settings')).toBe('');
    });
});

describe('css lane: the CSS gate', () => {
    it('accepts a scoped, layout-only rule', () => {
        expect(validateCss(GOOD, { scope: SCOPE })).toMatchObject({ ok: true, rules: 1 });
        expect(validateCss(`@media (max-width: 600px) { ${SCOPE} td { padding-right: 56px; white-space: normal; } }`, { scope: SCOPE }).ok).toBe(true);
    });
    it.each([
        ['a rule that does not name the screen', 'table td { padding: 0 }', /does not name/],
        ['a selector list where one part is unscoped', `${SCOPE} td, body { padding: 0 }`, /does not name/],
        ['hiding content', `${SCOPE} td { display: none }`, /hide content/],
        ['a zero size', `${SCOPE} td { width: 0 }`, /hide content/],
        ['invisible text', `${SCOPE} td { opacity: 0 }`, /hide content|not a layout property/],
        ['url()', `${SCOPE} td { background: url(http://evil/x.png) }`, /url\(\)/],
        ['@import', `@import 'x.css'; ${SCOPE} td { padding: 0 }`, /@import|url/],
        ['a non-layout property', `${SCOPE} td { color: red }`, /not a layout property/],
        ['content injection', `${SCOPE} td::after { content: 'x'; padding: 0 }`, /not allowed|not a layout property/],
        ['a keyframes animation', `@keyframes a { from { padding: 0 } } ${SCOPE} td { padding: 0 }`, /@media/],
        ['nested @media', `@media (max-width:1px) { @media (max-width:2px) { ${SCOPE} td { padding: 0 } } }`, /one level/],
        ['unbalanced braces', `${SCOPE} td { padding: 0 `, /unbalanced|outside/],
        ['an html tag', `${SCOPE} td { padding: 0 } </style><script>`, /not allowed|outside/],
        ['nothing', '   ', /no CSS/],
        // #514 round 3: the model "fixed" 84 problems by making the table flex and cutting every cell with an ellipsis.
        ['a flex table row (breaks the columns)', `${SCOPE} tr { display: flex; flex-wrap: wrap }`, /table row, cell or heading/],
        ['flex cells', `${SCOPE} td { flex: 1 1 120px }`, /table row, cell or heading/],
        ['an ellipsis', `${SCOPE} .tbl-wrap { text-overflow: ellipsis }`, /not a layout property/],
        ['overflow hidden', `${SCOPE} .tbl-wrap { overflow: hidden }`, /cut content off/],
        ['overflow clip on one axis', `${SCOPE} .tbl-wrap { overflow-x: clip }`, /cut content off/],
        ['an absolutely positioned cell', `${SCOPE} td:last-child { position: absolute }`, /static or relative/],
    ])('refuses %s', (_name, css, why) => {
        const v = validateCss(css, { scope: SCOPE });
        expect(v.ok).toBe(false);
        expect(v.problems.join(' | ')).toMatch(why);
    });
    it('still accepts the safe toolkit: a scrolling wrapper, an un-stuck cell, room in the cells', () => {
        for (const css of [
            `${SCOPE} .tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch }`,
            `${SCOPE} td:last-child, ${SCOPE} th:last-child { position: static; box-shadow: none }`,
            `@media (max-width: 768px) { ${SCOPE} td, ${SCOPE} th { padding: 8px 6px; min-width: 88px; white-space: nowrap } }`,
        ]) expect(validateCss(css, { scope: SCOPE }), css).toMatchObject({ ok: true });
    });
    it('refuses a missing scope and an oversize block', () => {
        expect(validateCss(GOOD, {}).ok).toBe(false);
        expect(validateCss(`${SCOPE} td { padding: 0; }`.repeat(Math.ceil(MAX_CSS_CHARS / 20)), { scope: SCOPE }).problems.join()).toMatch(/too long|declarations/);
    });
    it('never throws on junk', () => {
        for (const x of [undefined, null, 5, '{', '}', '{{}}', '@media', '/*', '\u0000']) expect(() => validateCss(x, { scope: SCOPE })).not.toThrow();
    });
});

describe('css lane: the file and its blocks', () => {
    it('appends a headed block that the file validator reads back', () => {
        const file = appendFix('/* header */\n', GOOD, { issue: 514, scope: SCOPE, title: 'CC instalments overlap */ x' });
        expect(file).toContain('lane-block: 514 scope=#page-ccinstall');
        expect(validateLaneFile(file)).toMatchObject({ ok: true, blocks: 1 });
        const two = appendFix(file, `${SCOPE} td { padding: 1px }`, { issue: 515, scope: SCOPE });
        expect(validateLaneFile(two)).toMatchObject({ ok: true, blocks: 2 });
    });
    it('catches a hand edit that weakens a block, and loose CSS outside any block', () => {
        const file = appendFix('', GOOD, { issue: 514, scope: SCOPE });
        const loose = validateLaneFile(file + `\nbody { margin: 0 }\n`);          // it lands inside the last block, which now holds an unscoped rule
        expect(loose.ok).toBe(false);
        expect(loose.problems.join()).toMatch(/does not name/);
        expect(validateLaneFile(file.replace(SCOPE + ' .tbl-wrap', '.tbl-wrap')).ok).toBe(false);
        expect(validateLaneFile('body { margin: 0 }\n' + file).problems.join()).toMatch(/before the first/);
    });
    it('the file in the repo is valid today', () => {
        expect(validateLaneFile(fs.readFileSync(LANE_FILE, 'utf8')).ok).toBe(true);
    });
});

describe('css lane: the verdict', () => {
    it('fixed, improved, unchanged, worse, barely and unmeasured', () => {
        const b = probe({ 320: 4, 768: 4 });
        expect(judgeLayout(b, probe({ 320: 0, 768: 0 }))).toMatchObject({ ok: true, verdict: 'fixed' });
        expect(judgeLayout(b, probe({ 320: 1, 768: 1 }))).toMatchObject({ ok: true, verdict: 'improved' });
        expect(judgeLayout(b, probe({ 320: 4, 768: 4 }))).toMatchObject({ ok: false, verdict: 'unchanged' });
        expect(judgeLayout(b, probe({ 320: 0, 768: 5 }))).toMatchObject({ ok: false, verdict: 'worse' });
        expect(judgeLayout(b, probe({ 320: 3, 768: 2 }))).toMatchObject({ ok: false, verdict: 'barely' });
        expect(judgeLayout(b, { ok: false, reason: 'no browser' })).toMatchObject({ ok: false, verdict: 'unmeasured' });
        expect(judgeLayout({ ok: false, reason: 'no browser' }, b)).toMatchObject({ ok: false, verdict: 'unmeasured' });
        expect(judgeLayout(probe({ 320: 0 }), probe({ 320: 0 }))).toMatchObject({ ok: false, verdict: 'nothing-to-fix' });
    });
    it('a change that fixes one width by breaking another is refused', () => {
        expect(judgeLayout(probe({ 320: 2, 768: 2 }), probe({ 320: 0, 768: 3 })).verdict).toBe('worse');
    });
    it('describes repeated rows once, with a count', () => {
        const txt = describeProbe(probe({ 360: 6 }));
        expect(txt).toMatch(/At 360px wide: th overlaps th \(6 times/);
        expect(describeProbe({ ok: false, reason: 'boom' })).toMatch(/could not be measured \(boom\)/);
    });
});

describe('css lane: the run', () => {
    const issue = { number: 514, title: '[CRITICAL] CC installments overlap', body: '### User feedback\n> overlapped on my smartphone, make it work on every resolution' };
    const ok = (t, p = 'deepseek') => ({ text: t, provider: p });
    const base = () => fs.mkdtempSync('/tmp/lane-');
    const repo = () => { const d = base(); fs.writeFileSync(d + '/index.html', '<div class="page" id="page-ccinstall"><div class="tbl-wrap"><table></table></div></div><div class="page" id="x"></div>'); fs.writeFileSync(d + '/wf-ui.css', '.tbl-wrap table { width: 100%; }'); fs.writeFileSync(d + '/' + LANE_FILE, '/* empty */\n'); return d; };
    const scripted = (replies) => { const calls = []; const fn = async (a) => { calls.push(a); const r = replies.shift(); if (!r) throw new Error('no reply scripted'); return typeof r === 'function' ? r(a) : r; }; fn.calls = calls; return fn; };

    it('writes the file only after red then green and an independent PASS', async () => {
        const chatImpl = scripted([ok(GOOD), ok('{"verdict":"PASS","severity":"none","findings":[],"reason":"layout only"}', 'mistral')]);
        const states = [probe({ 320: 4, 768: 4 }), probe({ 320: 0, 768: 0 })];
        const probeImpl = async () => states.shift();
        const r = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl, probeImpl });
        expect(r).toMatchObject({ ok: true, lane: 'layout', file: LANE_FILE, verified: true, test: null });
        expect(r.layout.verdict).toBe('fixed');
        expect(r.code).toContain('lane-block: 514 scope=#page-ccinstall');
        expect(validateLaneFile(r.code).ok).toBe(true);
        expect(chatImpl.calls[1].exclude).toEqual(['deepseek']);          // the reviewer is never the author
        expect(chatImpl.calls[0].prompt).toMatch(/MEASURED IN A REAL BROWSER/);
    });
    it('feeds what is still wrong back to the author and tries again', async () => {
        const chatImpl = scripted([ok(GOOD), ok(`${SCOPE} td { padding-right: 60px; }`), ok('{"verdict":"PASS","severity":"none","findings":[],"reason":"ok"}', 'mistral')]);
        const states = [probe({ 320: 4 }), probe({ 320: 4 }), probe({ 320: 0 })];
        const r = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl, probeImpl: async () => states.shift() });
        expect(r.ok).toBe(true);
        expect(chatImpl.calls[1].prompt).toMatch(/WHAT IS STILL WRONG/);
    });
    it('stands down, writing nothing, when the CSS never improves the measurement', async () => {
        const chatImpl = scripted([ok(GOOD), ok(GOOD), ok(GOOD)]);
        const states = [probe({ 320: 4 }), probe({ 320: 4 }), probe({ 320: 4 }), probe({ 320: 4 })];
        const r = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl, probeImpl: async () => states.shift() });
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('proof');
        expect(r.reason).toMatch(/did not measurably fix/);
        expect(r.code).toBeUndefined();
    });
    it('a refused CSS never reaches the browser', async () => {
        let probes = 0;
        const chatImpl = scripted([ok('table { display: none }'), ok('table { display: none }'), ok('table { display: none }')]);
        const r = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl, probeImpl: async () => (probes++ === 0 ? probe({ 320: 4 }) : (() => { throw new Error('must not be measured'); })()) });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/refused by the CSS gate/);
    });
    it('does not guess when the browser cannot start', async () => {
        const r = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl: async () => { throw new Error('model must not be asked'); }, probeImpl: async () => ({ ok: false, reason: 'the browser could not start: x', widths: [], problems: 0 }) });
        expect(r).toMatchObject({ ok: false, stage: 'measure' });
        expect(r.reason).toMatch(/could not start/);
    });
    it('does not invent a fix when nothing was found wrong', async () => {
        const r = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl: async () => { throw new Error('model must not be asked'); }, probeImpl: async () => probe({ 320: 0 }) });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/nothing to prove/);
    });
    it('a reviewer veto, or no reviewer, stops it', async () => {
        const mk = (review) => scripted([ok(GOOD), review]);
        const states = () => { const s = [probe({ 320: 4 }), probe({ 320: 0 })]; return async () => s.shift(); };
        const veto = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl: mk(ok('{"verdict":"FAIL","severity":"high","findings":[],"reason":"hides the delete button"}', 'mistral')), probeImpl: states() });
        expect(veto).toMatchObject({ ok: false, stage: 'security' });
        const none = await runLayoutLane({ issue, repoDir: repo(), env: {}, log: () => {}, chatImpl: mk({ text: '', provider: 'none' }), probeImpl: states() });
        expect(none).toMatchObject({ ok: false, stage: 'security_unavailable' });
    });
    it('the author is given the screen markup, a rendered row and the existing CSS', () => {
        const d = repo();
        const ctx = cssContext({ screen: 'cc-instalments', repoDir: d, sample: '<tr class="x"></tr>' });
        expect(ctx.markup).toMatch(/page-ccinstall/);
        expect(ctx.css).toMatch(/tbl-wrap/);
        const p = layoutPrompt({ issueText: 'overlap', screen: 'cc-instalments', scope: SCOPE, measured: 'At 320px wide: ...', ctx, sample: '<tr></tr>' });
        expect(p).toMatch(/EVERY selector must contain #page-ccinstall/);
        expect(p).toMatch(/Never hide anything/);
    });
    it('declines a report that is not a layout report', async () => {
        const r = await runLayoutLane({ issue: { number: 1, title: 'wrong total', body: '### User feedback\n> total is wrong' }, repoDir: repo(), env: {}, log: () => {}, chatImpl: async () => { throw new Error('no'); }, probeImpl: async () => { throw new Error('no'); } });
        expect(r).toMatchObject({ ok: false, stage: 'lane' });
    });
});

describe('css lane: wired into the agent and its workflow', () => {
    const agent = fs.readFileSync('autonomous-fix-agent.js', 'utf8');
    const wf = fs.readFileSync('.github/workflows/autonomous-fix.yml', 'utf8');
    it('the agent sends a layout report to the lane instead of the JavaScript swarm', () => {
        expect(agent).toMatch(/layoutLaneFor\(\{ title: issue\.title, body: shot\.body \}\)/);
        expect(agent).toMatch(/lane\.applies\s*\n?\s*\? await runLayoutLane\(/);
    });
    it('the workflow installs Chromium and does not run node --check on a CSS file', () => {
        expect(wf).toMatch(/npx playwright install chromium/);
        expect(wf).toMatch(/\*\.js\|\*\.mjs\|\*\.cjs\) node --check "\$FIX_FILE"/);
    });
});

// The real thing, where a browser exists: the overlap on CC Instalments is found, and a throwaway fixture rule
// makes it go away. The fixture only checks that the measurement can move; it is not the fix and is never shipped.
const chromeHere = (() => {
    try {
        if (process.env.WF_CHROME && fs.existsSync(process.env.WF_CHROME)) return true;
        return fs.readdirSync('/opt/pw-browsers').some((d) => /^chromium/.test(d));
    } catch { return false; }
})();
describe.skipIf(!chromeHere)('css lane: real Chromium', () => {
    it('measures red before and green after a rule that removes the sticky overlay', async () => {
        const { probeLayout } = await import('../autonomy/layout-probe.mjs');
        const before = await probeLayout({ screen: 'cc-instalments', widths: [360, 1024], ignoreAgentFixes: true });
        expect(before.ok, before.reason).toBe(true);
        expect(before.problems).toBeGreaterThan(0);
        const after = await probeLayout({ screen: 'cc-instalments', widths: [360, 1024], extraCss: GOOD, ignoreAgentFixes: true });
        expect(after.ok, after.reason).toBe(true);
        expect(judgeLayout(before, after)).toMatchObject({ ok: true, verdict: 'fixed' });
    }, 110_000);

    it('does not call the flex-and-ellipsis rewrite from #514 a fix, even if it got past the gate', async () => {
        const { probeLayout } = await import('../autonomy/layout-probe.mjs');
        const bad = `${SCOPE} tr{display:flex;flex-wrap:wrap} ${SCOPE} th, ${SCOPE} td{flex:1 1 120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`;
        const widths = [360, 768];
        const before = await probeLayout({ screen: 'cc-instalments', widths, ignoreAgentFixes: true });
        const after = await probeLayout({ screen: 'cc-instalments', widths, extraCss: bad, ignoreAgentFixes: true });
        expect(after.ok, after.reason).toBe(true);
        // cut-off amounts count as problems again (they used to be exempt because they ended in an ellipsis)
        expect(after.widths.some((w) => w.clipped.length > 0)).toBe(true);
        expect(judgeLayout(before, after).verdict).not.toBe('fixed');
    }, 110_000);
    it('the safe toolkit measures as fixed', async () => {
        const { probeLayout } = await import('../autonomy/layout-probe.mjs');
        const good = `${SCOPE} .tbl-wrap{overflow-x:auto} ${SCOPE} .tbl-wrap table :is(thead th, tbody td):last-child{position:static;box-shadow:none}`;
        expect(validateCss(good, { scope: SCOPE }).ok).toBe(true);
        const before = await probeLayout({ screen: 'cc-instalments', widths: [360, 768], ignoreAgentFixes: true });
        const after = await probeLayout({ screen: 'cc-instalments', widths: [360, 768], extraCss: good, ignoreAgentFixes: true });
        expect(judgeLayout(before, after)).toMatchObject({ ok: true, verdict: 'fixed' });
        expect(after.widths.every((w) => (w.misaligned || []).length === 0)).toBe(true);
    }, 110_000);
});
