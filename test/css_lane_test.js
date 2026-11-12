// =============================================================================
// The fix agent's layout lane (issue #514: "CC Instalments overlaps on a smartphone").
// Model and browser are injected here; the real-browser case at the bottom runs only where
// Chromium exists (the sandbox and the CI browser jobs), and says so when it is skipped.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    layoutLaneFor, validateCss, validateLaneFile, appendFix, judgeLayout, runLayoutLane, cssContext, layoutPrompt,
    serializeRules, pruneToWhatMatters,
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
    });
    it('opens the page the report names, or sweeps every page when it names none (#524 sat in Settings, named nothing)', () => {
        expect(layoutLaneFor(issue('The dashboard overlaps on my phone'))).toMatchObject({ applies: true, screen: 'dashboard' });
        expect(layoutLaneFor(issue('Everything overlaps on my phone'))).toMatchObject({ applies: true, screen: '', sweep: true });
    });
    it('catches the way the owner spells it, and the English the translator wrote for a Sinhala report', () => {
        expect(layoutLaneFor(issue('x', 'Did you see this. This is in CC installments. Overalaped.'))).toMatchObject({ applies: true, screen: 'cc-instalments' });
        const si = { title: '[CRITICAL] x', body: '### User feedback\n> \u0D9C\u0DD0\u0DA7\u0DBD\u0DD4\u0DC0\u0D9A\u0DCA\n### English translation (AI)\n> The labels overlap on the CC Instalments page on my phone.\n### System diagnosis\n| Device | iPhone |' };
        expect(layoutLaneFor(si)).toMatchObject({ applies: true, screen: 'cc-instalments' });
    });
    it('falls back to the page the person had open just before sending (the feedback form lives in Settings)', () => {
        const b = '### User feedback\n> it overlaps\n### System diagnosis\n| App page | settings |\n| Pages open just before (oldest to newest) | dashboard > ccinstall > settings |';
        expect(layoutLaneFor({ title: 'x', body: b })).toMatchObject({ applies: true, screen: 'cc-instalments' });
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
    it('refuses the shortcuts that shred text to silence an overlap (#531)', () => {
        for (const d of ['overflow-wrap: anywhere', 'word-break: break-all', 'word-break: break-word']) {
            const v = validateCss(`${SCOPE} .stat-label { white-space: normal; ${d}; }`, { scope: SCOPE });
            expect(v.ok, d).toBe(false);
            expect(v.problems.join(' ')).toMatch(/breaks words into pieces/);
        }
        expect(validateCss(`${SCOPE} .stat-card { grid-template-columns: 1fr; }`, { scope: SCOPE }).ok).toBe(true);
        expect(validateCss(`${SCOPE} .stat-label { overflow-wrap: normal; word-break: normal; }`, { scope: SCOPE }).ok).toBe(true);
    });
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
        expect(agent).toMatch(/layoutLaneFor\(\{ title: issue\.title, body: shot\.body, labels: issue\.labels \}\)/);
        expect(agent).toMatch(/if \(lane\.applies\) \{\s*result = await runLayoutLane\(/);
        // 2026-11-12 (#559): a lane an earlier try already measured clean is not taken again, and a defect report with a layout word continues as code
        expect(agent).toMatch(/laneRuledOut\(trail, 'layout'\)/);
        expect(agent).toMatch(/nothingToMeasure\(result\) && !lane\.marked && kind !== 'ui'/);
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
    // #524: at phone width the label of a CC Instalments stat card is drawn over its figure. The boxes of the two elements
    // can sit side by side while the painted text runs out of its own box, so the probe measures the text itself.
    const STAT_FIX = `${SCOPE} #cciStats .stat-card { display: block; }`;
    it('measures red before and green after a rule that stops the stat-card label running over its figure', async () => {
        const { probeLayout } = await import('../autonomy/layout-probe.mjs');
        const before = await probeLayout({ screen: 'cc-instalments', widths: [430], ignoreAgentFixes: true });
        expect(before.ok, before.reason).toBe(true);
        expect(before.problems).toBeGreaterThan(0);
        expect(before.widths[0].spilled.length).toBeGreaterThan(0);
        const after = await probeLayout({ screen: 'cc-instalments', widths: [430], extraCss: STAT_FIX, ignoreAgentFixes: true });
        expect(after.ok, after.reason).toBe(true);
        expect(judgeLayout(before, after)).toMatchObject({ ok: true, verdict: 'fixed' });
    }, 110_000);

    it('does not call the rule that merged for #524 a fix: it stood the label one letter per line (#531)', async () => {
        const { probeLayout } = await import('../autonomy/layout-probe.mjs');
        // What the agent shipped: the overlap is gone and the label is a column of single letters in a 24px grid track.
        const SILENCE = `@media (max-width: 640px) { ${SCOPE} .stat-label { white-space: normal; overflow-wrap: anywhere; word-break: break-word; } }`;
        const before = await probeLayout({ screen: 'cc-instalments', widths: [430], ignoreAgentFixes: true });
        const after = await probeLayout({ screen: 'cc-instalments', widths: [430], extraCss: SILENCE, ignoreAgentFixes: true });
        expect(after.ok, after.reason).toBe(true);
        expect(after.widths[0].squeezed.length).toBeGreaterThan(0);
        expect(after.widths[0].squeezed.join(' ')).toMatch(/grid-template-columns/);
        expect(judgeLayout(before, after).verdict).not.toBe('fixed');
    }, 110_000);

    it('does not count the pinned Actions column covering its neighbour as a problem, and never calls it a fix', async () => {
        const { probeLayout } = await import('../autonomy/layout-probe.mjs');
        const r = await probeLayout({ screen: 'cc-instalments', widths: [360], ignoreAgentFixes: true });
        expect(r.ok, r.reason).toBe(true);
        expect(r.widths[0].pinnedCover).toBeGreaterThan(0);
        expect(r.widths[0].overlaps.length).toBe(0);
        expect(r.problems).toBe(0);
    }, 110_000);

    it('a hyphenated word that wraps after its hyphen is not a broken word (Settings "one-time", filed as #542 by mistake)', async () => {
        const { measureInPage } = await import('../autonomy/layout-probe.mjs');
        const { bootApp } = await import('./e2e/harness.mjs');
        const app = await bootApp({ repoDir: process.cwd() });
        try {
            const { page } = app;
            const run = async (html) => { await page.setContent(`<div id="box" style="width:300px">${html}</div>`); return page.evaluate(measureInPage, '#box'); };
            // 120px fits "one-" (96px) but not "one-time" (192px): the browser wraps it after the hyphen, which is how hyphens work.
            const hyphen = await run('<span style="display:inline-block;width:120px;font:40px monospace">one-time</span>');
            expect(hyphen.squeezed, JSON.stringify(hyphen.squeezed)).toEqual([]);
            // a plain word that cannot fit is broken into pieces: still caught.
            const shred = await run('<span style="display:inline-block;width:120px;font:40px monospace;overflow-wrap:anywhere">Monthly</span>');
            expect(shred.squeezed.length).toBeGreaterThan(0);
        } finally { await app.close(); }
    }, 110_000);

    it('text an ellipsis already hides is not an overlap, and a legend pushed into a sideways scroll is a problem (Dashboard, #547 / #551)', async () => {
        const { measureInPage } = await import('../autonomy/layout-probe.mjs');
        const { bootApp } = await import('./e2e/harness.mjs');
        const app = await bootApp({ repoDir: process.cwd() });
        try {
            const { page } = app;
            const run = async (html) => { await page.setContent(`<div id="box" style="width:200px;font:12px monospace">${html}</div>`); return page.evaluate(measureInPage, '#box'); };
            // name | amount in a 200px legend row: the name is longer than its column and ends in an ellipsis. Nothing is painted under the amount.
            const row = (extra) => `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${extra}">Card Installments with a very long name</span><span>LKR 1.49M</span></div>`;
            const ellipsis = await run(row(''));
            expect(ellipsis.overlaps, JSON.stringify(ellipsis.overlaps)).toEqual([]);
            // the same letters with no clipping DO paint over the amount: still caught
            const spill = await run(row('overflow:visible;text-overflow:clip'));
            expect(spill.overlaps.length).toBeGreaterThan(0);
            // a box that scrolls sideways with content out of view is reported; a table's own scroll wrapper is not
            const legend = await run('<div style="overflow:auto;width:120px"><div style="width:140px;white-space:nowrap">Card Installments 78%</div></div>');
            expect(legend.clipped.join('|')).toMatch(/scrolls sideways/);
            const wrapped = await run('<div style="overflow:auto;width:120px"><table style="width:140px"><tr><td>a</td><td>b</td></tr></table></div>');
            expect(wrapped.clipped).toEqual([]);
        } finally { await app.close(); }
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

    it('a sweep with no page named lists only the pages that have a problem, worst first; CC Instalments (#524) no longer does', async () => {
        // This used to assert that cc-instalments ranked first, which was true only while #524 was unfixed. The agent's fix
        // (#536) landed, so the sweep now reports whatever page is worst TODAY. What stays true is the contract below.
        const { sweepScreens } = await import('../autonomy/layout-probe.mjs');
        const r = await sweepScreens({ repoDir: process.cwd(), width: 430 });
        expect(r.ok, r.reason).toBe(true);
        for (const x of r.ranked) expect(x.score).toBeGreaterThan(0);
        const scores = r.ranked.map((x) => x.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
        expect(r.ranked.map((x) => x.screen)).not.toContain('cc-instalments');   // the #524 regression guard
    }, 115_000);
});

describe('css lane: the model is shown the elements the measurement names (#524 attempt 2)', () => {
    const measured = 'At 430px wide: div.stat-label overlaps div.stat-val (19x10) — e.g. "Monthly CC Payments" with "LKR 383,000"';
    it('reads the class names out of the measurement', async () => {
        const { focusClasses } = await import('../autonomy/css-lane.mjs');
        expect(focusClasses(measured)).toEqual(['stat-label', 'stat-val']);
        expect(focusClasses('th "BANK" overlaps th "ACTIONS"')).toEqual([]);
        expect(focusClasses(null)).toEqual([]);
    });
    it('puts the rule that causes it, and the script that builds it, in front of the model', async () => {
        const { cssContext, layoutPrompt } = await import('../autonomy/css-lane.mjs');
        const ctx = cssContext({ screen: 'cc-instalments', measured });
        expect(ctx.focus).toContain('stat-label');
        expect(ctx.css).toMatch(/max-width: 640px[^}]*stat-card[^}]*display: grid/);
        expect(ctx.builds).toMatch(/#cciStats is filled by:.*stat-card.*stat-label/);
        const p = layoutPrompt({ issueText: 'x', screen: 'cc-instalments', scope: SCOPE, measured, ctx, sample: '' });
        expect(p).toMatch(/FIX WHAT THE MEASUREMENT NAMES/);
        expect(p).toMatch(/HOW THE ELEMENTS IN THE MEASUREMENT ARE BUILT/);
    });
    it('accepts a rule that fixes the stat card and nothing else', () => {
        expect(validateCss(`${SCOPE} #cciStats .stat-card { display: block; }`, { scope: SCOPE })).toMatchObject({ ok: true });
        expect(validateCss(`@media (max-width: 640px) { ${SCOPE} #cciStats .stat-card { grid-template-columns: minmax(0, 1fr); } }`, { scope: SCOPE }).ok).toBe(true);
    });
});

// Attempt 3 on #524: the author's stat-card rule fixed the measured problem, but the same block also re-declared table rules that undid
// block 514, so the reviewer vetoed all of it. The program now removes each rule in turn and keeps only those the browser needs.
describe('css lane: only the rules the measurement needs', () => {
    const STAT = `${SCOPE} .stat-card { grid-template-columns: 1fr; }`;
    const TABLE = `@media (max-width: 768px) {\n  ${SCOPE} .tbl-wrap th, ${SCOPE} .tbl-wrap td { white-space: nowrap; padding: 8px 6px; }\n}`;
    const AUTHOR = `${STAT}\n${TABLE}\n${SCOPE} .tbl-wrap { overflow-x: auto; }`;
    // a fake browser: the stat-card rule is what removes the 4 measured problems; nothing else changes the count
    const browser = () => { const seen = []; const fn = async ({ extraCss = '' }) => { seen.push(extraCss); return probe({ 390: /\.stat-card/.test(extraCss) ? 0 : 4 }); }; fn.seen = seen; return fn; };
    const before = probe({ 390: 4 });

    it('writes rules back as CSS the gate accepts, media rules grouped and order kept', () => {
        const css = serializeRules([
            { selector: `${SCOPE} .a`, body: 'gap: 4px', media: '' },
            { selector: `${SCOPE} .b`, body: 'gap: 2px;', media: '@media (max-width: 768px)' },
            { selector: `${SCOPE} .c`, body: 'gap: 1px', media: '@media (max-width: 768px)' },
        ]);
        expect(css).toMatch(/@media \(max-width: 768px\) \{[\s\S]*\.b[\s\S]*\.c[\s\S]*\}/);
        expect(css.match(/@media/g)).toHaveLength(1);
        expect(validateCss(css, { scope: SCOPE }).ok).toBe(true);
    });
    it('drops the table rules the stat-card fix does not need, and keeps the stat-card rule', async () => {
        const probeImpl = browser();
        const after = await probeImpl({ extraCss: AUTHOR });
        const r = await pruneToWhatMatters({ css: AUTHOR, scope: SCOPE, before, after, judged: judgeLayout(before, after), probeImpl, screen: 'cc-instalments', repoDir: '.', widths: [390] });
        expect(r.dropped).toBe(2);
        expect(r.css).toContain('.stat-card');
        expect(r.css).not.toMatch(/tbl-wrap|nowrap/);
        expect(validateCss(r.css, { scope: SCOPE }).ok).toBe(true);
        expect(r.judged.verdict).toBe('fixed');
    });
    it('keeps a rule whose removal brings the problem back', async () => {
        const probeImpl = async ({ extraCss = '' }) => probe({ 390: /overflow-x/.test(extraCss) && /\.stat-card/.test(extraCss) ? 0 : 4 });
        const after = await probeImpl({ extraCss: AUTHOR });
        const r = await pruneToWhatMatters({ css: AUTHOR, scope: SCOPE, before, after, judged: judgeLayout(before, after), probeImpl, screen: 'cc-instalments', repoDir: '.', widths: [390] });
        expect(r.css).toContain('overflow-x');
        expect(r.css).toContain('.stat-card');
        expect(r.css).not.toMatch(/nowrap/);
    });
    it('leaves a single rule alone and never measures for it', async () => {
        const probeImpl = async () => { throw new Error('must not be measured'); };
        const r = await pruneToWhatMatters({ css: STAT, scope: SCOPE, before, after: probe({ 390: 0 }), judged: { ok: true, verdict: 'fixed' }, probeImpl, screen: 'x', repoDir: '.', widths: [390] });
        expect(r).toMatchObject({ dropped: 0, css: STAT, probes: 0 });
    });
    it('a browser failure while pruning keeps the proven block as it was', async () => {
        const after = probe({ 390: 0 });
        const r = await pruneToWhatMatters({ css: AUTHOR, scope: SCOPE, before, after, judged: judgeLayout(before, after), probeImpl: async () => { throw new Error('chrome died'); }, screen: 'x', repoDir: '.', widths: [390] });
        expect(r.dropped).toBe(0);
        expect(r.css).toBe(AUTHOR);
    });
    it('the lane sends the reviewer only the pruned block', async () => {
        const issue = { number: 524, title: '[CRITICAL] CC installments overlap', body: '### User feedback\n> overlapped on my smartphone' };
        const d = fs.mkdtempSync('/tmp/lane-');
        fs.writeFileSync(d + '/index.html', '<div class="page" id="page-ccinstall"><div class="stat-card"></div></div>');
        fs.writeFileSync(d + '/wf-ui.css', '.stat-card { display: grid; }');
        fs.writeFileSync(d + '/' + LANE_FILE, '/* empty */\n');
        const calls = [];
        const chatImpl = async (a) => { calls.push(a); return calls.length === 1 ? { text: AUTHOR, provider: 'deepseek' } : { text: '{"verdict":"PASS","severity":"none","findings":[],"reason":"ok"}', provider: 'mistral' }; };
        const probeImpl = async ({ extraCss } = {}) => (extraCss === undefined ? before : probe({ 390: /\.stat-card/.test(extraCss) ? 0 : 4 }));
        const r = await runLayoutLane({ issue: { ...issue, body: issue.body }, repoDir: d, env: {}, log: () => {}, chatImpl, probeImpl });
        expect(r.ok).toBe(true);
        expect(r.code).toContain('.stat-card');
        expect(r.code).not.toMatch(/nowrap/);
        expect(calls[1].prompt).toMatch(/removing them one at a time/);
        expect(calls[1].prompt).not.toMatch(/white-space: nowrap/);
    });
});
