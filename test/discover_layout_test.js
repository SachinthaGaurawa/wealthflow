// =============================================================================
// Layout problems found by looking, before the owner has to report them (owner, 2026-11-07: "think different").
// #514 and #524 were found by the owner on a phone. The probe that measures layout lived only inside the layout lane, so
// nothing walked the pages unprompted. discover now does, and files what it MEASURES as an issue the fix agent's layout lane
// picks up. These pin: findings come only from a sweep that ran, the worst pages first and capped, a second look that finds
// nothing is not filed, the issue routes into the lane, and a different breakage on the same page is a new finding.
// No browser: the sweep and probe are injected.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { layoutFindings, renderIssue, fingerprint } from '../autonomy/discover.mjs';
import { layoutLaneFor } from '../autonomy/css-lane.mjs';

const MEASURED = 'At 390px wide: div.stat-label overlaps div.stat-val (18x10) — e.g. "Alpha" with "LKR 1"; text squeezed into a sliver: div.stat-label "Alpha beta" is squeezed to 41px wide (3 lines).';
const probeOk = (measured) => async () => ({ ok: true, widths: [], problems: 1, _m: measured });
const describeFrom = (r) => (r && r._m) || 'No overlap, overflow or cut-off text was found at 390px wide.';

describe('layout findings from a sweep', () => {
    it('files the worst pages first, at most three, each with its measurement', async () => {
        const ranked = [{ screen: 'a', score: 3 }, { screen: 'b', score: 9 }, { screen: 'c', score: 5 }, { screen: 'd', score: 1 }];
        const out = await layoutFindings('.', { sweepImpl: async () => ({ ok: true, ranked }), probeImpl: probeOk(MEASURED), describeImpl: describeFrom });
        expect(out.map((f) => f.screen)).toEqual(['b', 'c', 'a']);
        expect(out[0]).toMatchObject({ kind: 'layout-overlap', severity: 'high', width: 320 });   // ties keep the narrowest width
        expect(out[0].measured).toContain('squeezed into a sliver');
    });
    it('walks the smallest phone, common phones and a wide screen, and keeps the worst width for a page broken at several', async () => {
        const seen = [];
        const sweepImpl = async ({ width }) => { seen.push(width); return { ok: true, ranked: [{ screen: 'liquidity', score: width === 390 ? 12 : 4 }] }; };
        const out = await layoutFindings('.', { sweepImpl, probeImpl: probeOk(MEASURED), describeImpl: describeFrom });
        expect(seen).toEqual([320, 390, 430, 1024]);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ screen: 'liquidity', width: 390, score: 12 });
    });
    it('files nothing when the sweep did not run: no browser is not a clean bill of health, and not a finding either', async () => {
        const out = await layoutFindings('.', { sweepImpl: async () => ({ ok: false, reason: 'the browser could not start', ranked: [] }), probeImpl: probeOk(MEASURED), describeImpl: describeFrom });
        expect(out).toEqual([]);
    });
    it('does not file a page whose second look finds nothing', async () => {
        const out = await layoutFindings('.', { sweepImpl: async () => ({ ok: true, ranked: [{ screen: 'liquidity', score: 3 }] }), probeImpl: probeOk(null), describeImpl: describeFrom });
        expect(out).toEqual([]);
    });
    it('never throws', async () => {
        const out = await layoutFindings('.', { sweepImpl: async () => { throw new Error('boom'); }, probeImpl: probeOk(MEASURED), describeImpl: describeFrom });
        expect(out).toEqual([]);
    });
});

describe('the issue it files', () => {
    const mk = async (screen) => (await layoutFindings('.', { sweepImpl: async () => ({ ok: true, ranked: [{ screen, score: 5 }] }), probeImpl: probeOk(MEASURED), describeImpl: describeFrom }))[0];
    it('says what was measured and where, and tells the author not to shred words', async () => {
        const r = renderIssue(await mk('liquidity'));
        expect(r.title).toBe('[HIGH] Layout overlap on phones: liquidity');
        expect(r.labels).toEqual(['bug', 'ui/ux', 'autonomous']);
        expect(r.body).toContain('squeezed into a sliver');
        expect(r.body).toMatch(/Do not break words into pieces/);
    });
    it('a finding at a laptop width is titled for wide screens, not phones', async () => {
        const f = (await layoutFindings('.', { sweepImpl: async ({ width }) => ({ ok: true, ranked: width === 1024 ? [{ screen: 'dashboard', score: 2 }] : [] }), probeImpl: probeOk('At 1024px wide: span.a overlaps span.b (13x13).'), describeImpl: describeFrom }))[0];
        const r = renderIssue(f);
        expect(r.title).toBe('[HIGH] Layout overlap on wide screens: dashboard');
        expect(r.body).toContain('a laptop or tablet');
        expect(layoutLaneFor({ title: r.title, body: r.body }).applies).toBe(true);
    });
    it('names its screen explicitly, so the words it quotes cannot send it to another page (#547 went to CC Instalments)', async () => {
        const f = (await layoutFindings('.', { sweepImpl: async () => ({ ok: true, ranked: [{ screen: 'dashboard', score: 2 }] }), probeImpl: probeOk('At 1024px wide: span.dash-pie-name overlaps span.dash-pie-amt (2 times, e.g. 13x13) — e.g. "Card Installments" with "LKR 1.49M".'), describeImpl: describeFrom }))[0];
        const r = renderIssue(f);
        expect(r.body).toContain('<!-- wf-layout-screen: dashboard width=');
        const lane = layoutLaneFor({ title: r.title, body: r.body });
        expect(lane).toMatchObject({ applies: true, screen: 'dashboard' });
        // the same text WITHOUT the marker is the bug this pins: the words alone name CC Instalments
        expect(layoutLaneFor({ title: r.title, body: r.body.replace(/<!--[^>]*-->\n/, '') }).screen).toBe('cc-instalments');
    });
    it('ignores a marker that names no screen the probe can open', () => {
        const lane = layoutLaneFor({ title: 'Layout overlap on phones', body: '<!-- wf-layout-screen: nonsense -->\nthe layout overlaps on my phone, the liquidity page' });
        expect(lane.screen).toBe('liquidity');
    });
    it('routes into the layout lane on the right screen (named pages and the credit-card screens)', async () => {
        for (const [screen, expected] of [['liquidity', 'liquidity'], ['cc-instalments', 'cc-instalments']]) {
            const r = renderIssue(await mk(screen));
            const lane = layoutLaneFor({ title: r.title, body: r.body });
            expect(lane.applies, screen).toBe(true);
            expect(lane.screen, screen).toBe(expected);
        }
    });
    it('a different breakage on the same page is a new finding; the same breakage re-measured is not', async () => {
        const f = async (m) => (await layoutFindings('.', { sweepImpl: async () => ({ ok: true, ranked: [{ screen: 'liquidity', score: 5 }] }), probeImpl: probeOk(m), describeImpl: describeFrom }))[0];
        const a = await f(MEASURED);
        const b = await f(MEASURED.replace(/18x10/, '30x12').replace('41px', '52px').replace('Alpha', 'Gamma'));
        const c = await f('At 390px wide: the page is 40px wider than the screen.');
        expect(fingerprint(a.kind, a.key)).toBe(fingerprint(b.kind, b.key));
        expect(fingerprint(a.kind, a.key)).not.toBe(fingerprint(c.kind, c.key));
    });
});
