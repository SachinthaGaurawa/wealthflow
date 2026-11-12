// Who filed a report, and what the earlier tries already ruled out (autonomy/route.mjs).
// The fixture is issue #559 as it was really filed (counts and fixed words only, already public).
import { describe, it, expect } from 'vitest';
import { isSystemFiled, systemRole, layoutAllowed, attemptTrail, laneRuledOut, attemptBrief, nothingToMeasure } from '../autonomy/route.mjs';
import { roleFor } from '../autonomy/work-queue.mjs';
import { layoutLaneFor } from '../autonomy/css-lane.mjs';

const READER_559 = {
    title: "Statement reader: a card statement's payments do not add up to its printed Total Payment",
    labels: [{ name: 'bug' }, { name: 'autonomous' }, { name: 'critical' }, { name: 'statement-reading' }, { name: 'wf-printed-total-differs' }],
    body: [
        '## Statement reader: self-report', '',
        '**Kind:** `printed-total-differs`  ·  **Institution:** HNB Card  ·  **Rows read:** 9', '',
        '### What happened',
        'The credit lines with payment words, as read, do not sum to the "Total Payment" the statement itself prints, and the model\'s second reading did not reach it either. The layout convention was closed for that statement, so its lines wait for review.',
        '', '### What to do',
        'Find what the reader misses on this kind of statement and make the rules read it. Add a test with an INVENTED statement.',
    ].join('\n'),
};
const MEASURE_WHY = 'No overlap, overflow or cut-off text was found at 320, 360, 390, 430, 600, 768, 1024px wide. There is nothing to prove a CSS change against, so no change was made.';
const attempt = (n, { lane = '', stage = 'measure', why = MEASURE_WHY } = {}) => ({
    author_association: 'NONE',
    body: `<!-- wf-agent-attempt -->\n### [AI] Autonomous attempt ${n}/3 — no change made\n\n${lane ? `**Lane:** \`${lane}\`\n` : ''}**Stopped at:** \`${stage}\`\n**Why:** ${why}\n\nNothing was committed.`,
});

describe('a report a program filed is routed by its label, never by its wording', () => {
    it('the statement reader report that was sent to the layout lane three times is a code defect', () => {
        expect(isSystemFiled(READER_559)).toBe(true);
        expect(systemRole(READER_559)).toBe('bug');
        expect(roleFor(READER_559)).toBe('bug');                         // was "ui", for the word "layout"
        const lane = layoutLaneFor(READER_559);
        expect(lane.applies).toBe(false);                                // was true, and the pages were measured three times
        expect(lane.why).toMatch(/filed by a program/);
    });
    it('a layout finding the system measured keeps its lane, through its marker', () => {
        const f = { title: '[HIGH] Layout overlap on phones: dashboard', labels: ['bug', 'autonomous', 'ui/ux'], body: '<!-- wf-layout-screen: dashboard width=390 -->\n## Text overlaps or is cut off on a phone' };
        expect(isSystemFiled(f)).toBe(true);
        expect(systemRole(f)).toBe('ui');
        expect(layoutAllowed(f).ok).toBe(true);
        const lane = layoutLaneFor(f);
        expect(lane.applies).toBe(true);
        expect(lane.marked).toBe(true);
    });
    it('an idea, a security finding and an unlabelled finding each get the role their label says', () => {
        expect(systemRole({ labels: ['feature-proposal', 'autonomous'], body: 'a layout error leak' })).toBe('feature');
        expect(systemRole({ labels: ['autonomous', 'security'], body: 'button colour' })).toBe('security');
        expect(systemRole({ labels: ['autonomous', 'enhancement'], body: 'crash' })).toBe('feature');
        expect(systemRole({ labels: ['autonomous'], body: 'the layout of the font' })).toBe('bug');
    });
});

describe("a person's report is still read by its words", () => {
    const fb = (text, labels = ['user-feedback', 'autonomous']) => ({ title: text.slice(0, 60), labels, body: `### User feedback\n> ${text}\n\n### Diagnostics\n| Viewport | 390x844 |` });
    it('is not program-filed even though the pipeline labelled it autonomous', () => {
        expect(isSystemFiled(fb('The buttons overlap on my phone'))).toBe(false);
        expect(systemRole(fb('The buttons overlap on my phone'))).toBe(null);
        expect(layoutAllowed(fb('x')).ok).toBe(true);
    });
    it('an overlap complaint still goes to the layout lane and a wrong total is still a defect', () => {
        expect(layoutLaneFor(fb('The buttons overlap on my phone in the dashboard')).applies).toBe(true);
        expect(roleFor(fb('The total shows a wrong amount'))).toBe('bug');
    });
    it('an issue typed by hand on GitHub (no autonomous label) is a person', () => {
        expect(isSystemFiled({ title: 'Show the build id', labels: ['enhancement'], body: 'Please add the build id' })).toBe(false);
    });
});

describe('a try is told what the earlier tries ruled out', () => {
    it('reads the three real attempts on #559 (written before the Lane line existed) as layout-lane measurements', () => {
        const trail = attemptTrail([attempt(1), attempt(2), attempt(3)]);
        expect(trail.map((t) => t.lane)).toEqual(['layout', 'layout', 'layout']);
        expect(trail.every((t) => t.stage === 'measure')).toBe(true);
        expect(laneRuledOut(trail, 'layout')).toBe(true);
    });
    it('one measurement that found nothing is enough to rule the layout lane out for the next try', () => {
        expect(laneRuledOut(attemptTrail([attempt(1, { lane: 'layout' })]), 'layout')).toBe(true);
    });
    it('a layout try that failed for another reason does not rule the lane out', () => {
        const t = attemptTrail([attempt(1, { lane: 'layout', stage: 'measure', why: 'the browser could not start' }), attempt(2, { lane: 'layout', stage: 'review', why: 'Agent 5 veto' })]);
        expect(laneRuledOut(t, 'layout')).toBe(false);
    });
    it('a code lane is never ruled out: another file or approach may work', () => {
        const t = attemptTrail([attempt(1, { lane: 'swarm', stage: 'author', why: 'model returned no change' })]);
        expect(laneRuledOut(t, 'swarm')).toBe(false);
        expect(laneRuledOut(t, 'layout')).toBe(false);
    });
    it("a maintainer's reset starts the trail again; a stranger's does not", () => {
        const reset = (who) => ({ author_association: who, body: '<!-- wf-agent-reset -->' });
        expect(attemptTrail([attempt(1), reset('OWNER'), attempt(1, { lane: 'swarm', stage: 'proof', why: 'x' })]).map((t) => t.lane)).toEqual(['swarm']);
        expect(attemptTrail([attempt(1), reset('NONE')]).length).toBe(1);
    });
    it('the brief names each earlier try and tells the author to differ; with no tries it is empty', () => {
        expect(attemptBrief([])).toBe('');
        const b = attemptBrief(attemptTrail([attempt(1, { lane: 'swarm', stage: 'author', why: 'wealthflow-cards.js: model returned no change' }), { body: '<!-- wf-agent-attempt -->\n### [AI] Fix drafted (attempt 2/3)\n\nI changed `wealthflow-cards.js`.' }]));
        expect(b).toMatch(/Try 1 \(swarm lane\) stopped at `author`/);
        expect(b).toMatch(/Try 2 stopped at `drafted`/);
        expect(b).toMatch(/do NOT repeat/);
    });
    it('nothingToMeasure is true only for a clean measurement', () => {
        expect(nothingToMeasure({ ok: false, stage: 'measure', reason: MEASURE_WHY })).toBe(true);
        expect(nothingToMeasure({ ok: false, stage: 'measure', reason: 'Chromium could not start' })).toBe(false);
        expect(nothingToMeasure({ ok: true, stage: 'ready' })).toBe(false);
        expect(nothingToMeasure(null)).toBe(false);
    });
});
