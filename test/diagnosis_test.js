/* The update-system diagnosis (wealthflow-diagnosis.js): the chain from "you file a report" to "it runs on this device".
 *
 * The owner's complaint was never that something failed; it was that when it failed, nothing said WHERE. So these tests
 * feed judge() the exact evidence of each way the chain has really broken (a release that waited for a tap, notes that
 * quoted his feedback, an agent that lost at the proof stage, an update that never landed, a crash on an old build) and
 * assert that the FIRST broken link is named, that "could not be measured" is never counted as healthy, and that nothing
 * he wrote leaves the device.
 */
import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';
import { diagnosticsSection } from '../feedback-triage.js';

const NOW = Date.parse('2026-11-03T18:00:00Z');
const H = 3600 * 1000;

const goodServer = (over = {}) => ({
    at: NOW - 60_000,
    version: { ok: true, sha: 'abc123def456', version: '7.69.39', env: 'production' },
    manifest: { ok: true, latest: '7.69.39', noteCount: 3, problem: null },
    autonomy: { ok: true, overall: 'healthy', canActuallyFixBugs: true, headline: 'Automatic updates are working.', lastRealChange: { daysAgo: 0, summary: 'Fix agent: repair the proving test' }, emptyVersionBumpsRecently: 0, failing: [] },
    ...over,
});
const healthy = (over = {}) => ({
    now: NOW, online: true, running: '7.69.39', installed: '7.69.39', claim: null, failedTarget: null, anomaly: null,
    popupSeen: '7.69.39', feedback: [], crashes: { total: 0, recorded: 0, onThisBuild: 0, byBuild: {} },
    sw: { supported: true, registered: true, controller: true, waiting: false }, server: goodServer(), deploy: {}, ...over,
});

const { window: { WFDiagnosis: D } } = loadBrowserModule('wealthflow-diagnosis.js', { globals: { setInterval: () => 0, setTimeout: () => 0 } });
const link = (r, id) => r.chain.find((l) => l.id === id);

describe('judge: a healthy chain', () => {
    it('is healthy, with no issues and no first break', () => {
        const r = D.judge(healthy());
        expect(r.verdict).toBe('healthy');
        expect(r.firstBreak).toBeNull();
        expect(r.counts).toEqual({ ok: 10, warn: 0, fail: 0, unknown: 0 });
        expect(r.issues).toEqual([]);
        expect(r.chain.map((l) => l.id)).toEqual(['feedback', 'agent', 'release', 'deploy', 'notes', 'offer', 'install', 'worker', 'welcome', 'stability']);
    });
});

describe('judge: each way the chain has really broken', () => {
    it('an issue that reached the attempt limit is a FAIL at "feedback" and names the issue', () => {
        const r = D.judge(healthy({ feedback: [{ issue: 492, status: 'needs-attention', at: NOW - 30 * H }] }));
        expect(r.verdict).toBe('broken');
        expect(r.firstBreak).toBe('feedback');
        expect(link(r, 'feedback').detail).toMatch(/#492.*waiting for a person/);
        expect(r.issues[0]).toMatchObject({ severity: 'error', area: 'update-system' });
    });

    it('a report saved but never filed as a work item is flagged, but only once it has had time and the device is online', () => {
        const fresh = D.judge(healthy({ feedback: [{ issue: null, status: 'pending', at: NOW - 60_000 }] }));
        expect(link(fresh, 'feedback').state).toBe('ok');
        const old = D.judge(healthy({ feedback: [{ issue: null, status: 'pending', at: NOW - 2 * H }] }));
        expect(link(old, 'feedback').state).toBe('warn');
        const offline = D.judge(healthy({ online: false, feedback: [{ issue: null, status: 'pending', at: NOW - 2 * H }] }));
        expect(link(offline, 'feedback').state).toBe('ok');
    });

    it('filed but untouched for two days is a warning; being worked on is fine', () => {
        expect(link(D.judge(healthy({ feedback: [{ issue: 7, status: 'open', at: NOW - 60 * H }] })), 'feedback').state).toBe('warn');
        expect(link(D.judge(healthy({ feedback: [{ issue: 7, status: 'in-progress', at: NOW - 60 * H }] })), 'feedback').state).toBe('ok');
        expect(link(D.judge(healthy({ feedback: [{ issue: 7, status: 'completed', at: NOW - 600 * H }] })), 'feedback').state).toBe('ok');
    });

    it('a status endpoint that is not configured is reported, not read as "nothing finished"', () => {
        const r = D.judge(healthy({ feedback: [{ issue: 7, status: 'open', at: NOW - H }], feedbackStatusDown: 'not_configured' }));
        expect(link(r, 'feedback').state).toBe('warn');
        expect(link(r, 'feedback').detail).toMatch(/not_configured/);
    });

    it('an agent the server says cannot fix anything is a FAIL and carries the failing checks', () => {
        const r = D.judge(healthy({ server: goodServer({ autonomy: { ok: true, overall: 'broken', canActuallyFixBugs: false, failing: [{ id: 'models', status: 'broken', summary: 'No model provider is reachable' }] } }) }));
        expect(r.firstBreak).toBe('agent');
        expect(link(r, 'agent').detail).toMatch(/models: No model provider is reachable/);
    });

    it('degraded providers are a warning, not a failure', () => {
        const r = D.judge(healthy({ server: goodServer({ autonomy: { ok: true, overall: 'degraded', canActuallyFixBugs: true, failing: [{ id: 'models', status: 'warn', summary: '3 of 13 providers answer' }] } }) }));
        expect(r.verdict).toBe('degraded');
        expect(link(r, 'agent').state).toBe('warn');
    });

    it('empty version bumps are named', () => {
        const r = D.judge(healthy({ server: goodServer({ autonomy: { ok: true, overall: 'healthy', canActuallyFixBugs: true, emptyVersionBumpsRecently: 4, lastRealChange: { daysAgo: 9 } } }) }));
        expect(link(r, 'release').state).toBe('warn');
        expect(link(r, 'release').detail).toMatch(/4 recent version bump/);
    });

    it('release notes that are an object, raw JSON, or the owner\'s own feedback are a FAIL', () => {
        for (const note of [{ a: 1 }, '[object Object]', '{"title":"x"}', 'Addressed: your feedback about the card']) {
            const r = D.judge(healthy({ server: goodServer({ manifest: { ok: true, latest: '7.69.39', problem: D.noteProblem(note) } }) }));
            expect(link(r, 'notes').state, JSON.stringify(note)).toBe('fail');
        }
        expect(D.noteProblem('A new card shows the build id.')).toBeNull();
        expect(D.noteProblem(['Fixed A.', 'Fixed B.'])).toBeNull();
        expect(D.noteProblem(['Fixed A.', { x: 1 }])).toMatch(/not text/);
        expect(D.noteProblem(undefined)).toMatch(/no note/);
    });

    it('the structured notes the releases really ship are accepted; broken ones are not', () => {
        const good = { headline: "What's New", date: '2026-11-03', sections: [{ title: 'What changed for you', items: ['Feedback to fix chain: repair the proving test (#500)'] }] };
        expect(D.noteProblem(good)).toBeNull();
        expect(D.noteProblem({ headline: 'x', sections: [] })).toMatch(/no items/);
        expect(D.noteProblem({ headline: 'x', sections: [{ title: 't' }] })).toMatch(/not text/);
        expect(D.noteProblem({ headline: 'x', sections: [{ title: 't', items: [{ a: 1 }] }] })).toMatch(/not text/);
        expect(D.noteProblem({ headline: 'x', sections: [{ title: 't', items: ['Addressed: your feedback about the card'] }] })).toMatch(/feedback/);
        expect(D.noteProblem({ headline: 'x' })).toMatch(/without sections/);
    });

    it('the notes of the version.json that is actually in this repository pass', async () => {
        const fs = await import('node:fs');
        const j = JSON.parse(fs.readFileSync(new URL('../version.json', import.meta.url), 'utf8'));
        expect(D.noteProblem(j.notes[j.latest])).toBeNull();
    });

    it('a server and a manifest that disagree on the version are named', () => {
        const r = D.judge(healthy({ server: goodServer({ manifest: { ok: true, latest: '7.69.38', problem: null } }) }));
        expect(link(r, 'deploy').state).toBe('warn');
        expect(link(r, 'deploy').detail).toMatch(/7\.69\.39.*7\.69\.38/);
    });

    it('an unreachable /api/version is a FAIL at "deploy"', () => {
        const r = D.judge(healthy({ server: goodServer({ version: { ok: false, error: 'HTTP 500' } }) }));
        expect(r.firstBreak).toBe('deploy');
        expect(link(r, 'deploy').detail).toMatch(/HTTP 500/);
    });

    it('an update that has been available for three days is a warning; one offered an hour ago is not', () => {
        const newer = { version: { ok: true, sha: 'f00', version: '7.70.0', env: 'production' }, manifest: { ok: true, latest: '7.70.0', problem: null } };
        const old = D.judge(healthy({ server: goodServer(newer), offerSeen: { target: '7.70.0', at: NOW - 72 * H } }));
        expect(link(old, 'offer').state).toBe('warn');
        expect(link(old, 'offer').detail).toMatch(/7\.70\.0 has been available for 3 days/);
        const fresh = D.judge(healthy({ server: goodServer(newer), offerSeen: { target: '7.70.0', at: NOW - H } }));
        expect(link(fresh, 'offer').state).toBe('ok');
    });

    it('an update the person postponed, skipped or set for later is a choice, not a fault', () => {
        const newer = { version: { ok: true, sha: 'f00', version: '7.70.0', env: 'production' }, manifest: { ok: true, latest: '7.70.0', problem: null } };
        const base = { server: goodServer(newer), offerSeen: { target: '7.70.0', at: NOW - 72 * H } };
        expect(link(D.judge(healthy({ ...base, updateChoice: { version: '7.70.0', action: 'skip' } })), 'offer').state).toBe('ok');
        expect(link(D.judge(healthy({ ...base, updateChoice: { version: '7.70.0', action: 'later', until: NOW + H } })), 'offer').state).toBe('ok');
        expect(link(D.judge(healthy({ ...base, updateChoice: { version: '7.70.0', action: 'idle' } })), 'offer').state).toBe('ok');
        // a postponement that ran out, or one made for another version, no longer excuses it
        expect(link(D.judge(healthy({ ...base, updateChoice: { version: '7.70.0', action: 'later', until: NOW - H } })), 'offer').state).toBe('warn');
        expect(link(D.judge(healthy({ ...base, updateChoice: { version: '7.69.9', action: 'skip' } })), 'offer').state).toBe('warn');
    });

    it('standby: a device whose update did not land reports it once, with two version numbers and no free text', () => {
        const ev = healthy({ running: '7.69.39', failedTarget: { target: '7.70.0', at: NOW - H }, claim: null });
        const p = D.standbyPayload(ev);
        expect(p.body.source).toBe('auto-diagnosis');
        expect(p.body.text).toBe('[Auto diagnosis] The update to 7.70.0 did not land on a device that is still running 7.69.39.');
        expect(p.fp).toBe('install-failed:7.70.0:7.69.39');
        expect(D.standbyPayload(healthy())).toBe(null);                                              // nothing failed: nothing said
        expect(D.standbyPayload(healthy({ running: '7.70.0', failedTarget: { target: '7.70.0' } }))).toBe(null);  // it landed after all
    });

    it('a device AHEAD of the server (rollback / stale deploy) is named', () => {
        const r = D.judge(healthy({ running: '7.69.40' }));
        expect(link(r, 'offer').state).toBe('warn');
        expect(link(r, 'offer').detail).toMatch(/ahead of the deploy/);
    });

    it('an update that did not land is a FAIL; a claim that never settled is a warning', () => {
        const failed = D.judge(healthy({ failedTarget: { target: '7.69.40', at: NOW - 2 * H } }));
        expect(failed.firstBreak).toBe('install');
        expect(link(failed, 'install').detail).toMatch(/to 7\.69\.40 did NOT land/);
        const claim = D.judge(healthy({ claim: { target: '7.69.40', at: NOW - 30 * 60_000, fetched: 14, total: 82 } }));
        expect(link(claim, 'install').state).toBe('warn');
        expect(link(claim, 'install').detail).toMatch(/14\/82 files/);
    });

    it('a service worker that is missing, or waiting too long, is a warning', () => {
        expect(link(D.judge(healthy({ sw: { supported: true, registered: false } })), 'worker').state).toBe('warn');
        expect(link(D.judge(healthy({ sw: { supported: true, registered: true, waiting: true }, waitingSince: NOW - H })), 'worker').state).toBe('warn');
        expect(link(D.judge(healthy({ sw: { supported: true, registered: true, waiting: true }, waitingSince: NOW - 60_000 })), 'worker').state).toBe('ok');
        expect(link(D.judge(healthy({ sw: { supported: false } })), 'worker').state).toBe('ok');
    });

    it('the owner\'s own device: four old crashes, none on the running build, is NOT an error', () => {
        const r = D.judge(healthy({ running: '7.69.38', installed: '7.69.38', popupSeen: '7.69.38', server: goodServer({ version: { ok: true, sha: 'x', version: '7.69.38', env: 'production' }, manifest: { ok: true, latest: '7.69.38', problem: null } }),
            crashes: { total: 4, recorded: 4, onThisBuild: 0, byBuild: { '7.69.35': 3, '7.69.34': 1 }, lastBuild: '7.69.35', lastPage: 'page-dashboard' } }));
        expect(link(r, 'stability').state).toBe('ok');
        expect(link(r, 'stability').detail).toMatch(/4 earlier crash.*7\.69\.34 ×1, 7\.69\.35 ×3.*none on 7\.69\.38/);
        expect(r.verdict).toBe('healthy');
    });

    it('a crash ON the running build is a FAIL with the page', () => {
        const r = D.judge(healthy({ crashes: { total: 2, recorded: 2, onThisBuild: 1, byBuild: { '7.69.39': 1 }, lastPage: 'page-reports' } }));
        expect(link(r, 'stability').state).toBe('fail');
        expect(link(r, 'stability').detail).toMatch(/1 crash.*page-reports/);
    });
});

describe('judge: honesty about what it could not measure', () => {
    it('with no server evidence at all, the server links are "unknown" and the verdict is not "healthy"', () => {
        const r = D.judge(healthy({ server: null }));
        expect(r.verdict).not.toBe('healthy');
        for (const id of ['agent', 'release', 'deploy', 'notes', 'offer']) expect(link(r, id).state, id).toBe('unknown');
        expect(r.issues.some((i) => /No server evidence has been collected/.test(i.message))).toBe(true);
    });

    it('"unknown" never becomes the first break, and a real failure beats it', () => {
        const r = D.judge(healthy({ server: null, failedTarget: { target: '7.69.40', at: NOW - H } }));
        expect(r.firstBreak).toBe('install');
        expect(r.verdict).toBe('broken');
    });

    it('stale server evidence is reported as such', () => {
        const r = D.judge(healthy({ server: goodServer({ at: NOW - 9 * H }) }));
        expect(r.issues.some((i) => /9 h old/.test(i.message))).toBe(true);
    });

    it('statement entries waiting for review are listed with their reasons', () => {
        const r = D.judge(healthy({ statementReview: { total: 23, byReason: { 'unproven-direction': 22, 'invalid-transaction': 1 } } }));
        const i = r.issues.find((x) => x.area === 'statements');
        expect(i.message).toMatch(/23 statement entries are waiting for review \(unproven-direction 22, invalid-transaction 1\)/);
    });

    it('never throws on arbitrary evidence', () => {
        for (const ev of [undefined, null, {}, { server: {} }, { feedback: 'x' }, { sw: 5, crashes: 'no' }, { running: 'nonsense' }]) {
            expect(() => D.judge(ev)).not.toThrow();
        }
    });
});

describe('collect / refresh on a real DOM module', () => {
    const MANIFEST = { latest: '7.69.39', notes: { '7.69.39': ['A new card shows the build id.'] } };
    const reply = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });
    const site = async (url) => {
        if (/api\/version/.test(url)) return reply({ sha: 'abc123def456', version: '7.69.39', env: 'production' });
        if (/version\.json/.test(url)) return reply(MANIFEST);
        if (/autonomy-status/.test(url)) return reply({ ok: true, overall: 'healthy', canActuallyFixBugs: true, headline: 'ok', checks: [{ id: 'models', status: 'ok', summary: 'fine' }, { id: 'tests', status: 'warn', summary: 'lenient' }] });
        return reply({}, false, 404);
    };
    const boot = (seed = {}, globals = {}) => loadBrowserModule('wealthflow-diagnosis.js', {
        localStorage: seed, fetchImpl: site, html: '',
        globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: '7.69.39', ...globals },
    });

    it('collect() is synchronous and honest before anything has been fetched', () => {
        const { window } = boot();
        const c = window.WFDiagnosis.collect();
        expect(c.evidenceAgeSec).toBeNull();
        expect(c.verdict).not.toBe('healthy');
        expect(c.chain.find((l) => l.id === 'deploy').state).toBe('unknown');
    });

    it('refresh() gathers the three server answers, and the next collect() uses them', async () => {
        const { window, localStorage } = boot();
        const ev = await window.WFDiagnosis.refresh();
        expect(ev.version).toMatchObject({ ok: true, sha: 'abc123def456', version: '7.69.39' });
        expect(ev.manifest).toMatchObject({ ok: true, latest: '7.69.39', problem: null });
        expect(ev.autonomy.failing).toEqual([{ id: 'tests', status: 'warn', summary: 'lenient' }]);
        const c = window.WFDiagnosis.collect();
        expect(c.chain.find((l) => l.id === 'deploy').state).toBe('ok');
        expect(c.chain.find((l) => l.id === 'offer').detail).toMatch(/Running 7\.69\.39, the newest/);
        expect(c.evidenceAgeSec).toBeLessThan(5);
        expect(JSON.parse(localStorage.getItem('wf_diag_evidence')).version.sha).toBe('abc123def456');
    });

    it('an autonomy status the server could not measure stays "unknown": it is neither a confirmed failure nor a clean bill', async () => {
        const unmeasured = async (url) => (/autonomy-status/.test(url)
            ? reply({ ok: false, overall: 'unknown', canActuallyFixBugs: false, headline: 'Update system status could not be determined.', error: 'self-check threw' })
            : site(url));
        const m = loadBrowserModule('wealthflow-diagnosis.js', { fetchImpl: unmeasured, html: '', globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: '7.69.39' } });
        const ev = await m.window.WFDiagnosis.refresh();
        expect(ev.autonomy).toMatchObject({ ok: false });
        expect(ev.autonomy.error).toMatch(/self-check threw/);
        const c = m.window.WFDiagnosis.collect();
        expect(c.chain.find((l) => l.id === 'agent').state).toBe('unknown');
        expect(c.chain.find((l) => l.id === 'release').state).toBe('unknown');
    });

    it('a "broken" status is still a measurement even though the endpoint sends ok:false with it', async () => {
        const broken = async (url) => (/autonomy-status/.test(url)
            ? reply({ ok: false, overall: 'broken', canActuallyFixBugs: false, headline: 'NOT working', checks: [{ id: 'models', status: 'broken', summary: 'no provider answers' }] })
            : site(url));
        const m = loadBrowserModule('wealthflow-diagnosis.js', { fetchImpl: broken, html: '', globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: '7.69.39' } });
        await m.window.WFDiagnosis.refresh();
        expect(m.window.WFDiagnosis.collect().chain.find((l) => l.id === 'agent').state).toBe('fail');
    });

    it('the evidence survives a restart: a new page load reads it back, with its age', async () => {
        const first = boot();
        await first.window.WFDiagnosis.refresh();
        const saved = first.localStorage.getItem('wf_diag_evidence');
        const second = boot({ wf_diag_evidence: saved });
        expect(second.window.WFDiagnosis.collect().chain.find((l) => l.id === 'deploy').state).toBe('ok');
    });

    it('a server that is down is reported as down, not silently healthy', async () => {
        const down = loadBrowserModule('wealthflow-diagnosis.js', { fetchImpl: async () => { throw new Error('offline'); }, globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: '7.69.39' } });
        await down.window.WFDiagnosis.refresh();
        const c = down.window.WFDiagnosis.collect();
        expect(c.chain.find((l) => l.id === 'deploy').state).toBe('fail');
        expect(c.chain.find((l) => l.id === 'deploy').detail).toMatch(/offline/);
        expect(c.verdict).toBe('broken');
    });

    it('remembers when an update was first offered, so "available for 3 days" can be told later', async () => {
        const newer = async (url) => (/api\/version/.test(url) ? reply({ sha: 'f00', version: '7.70.0', env: 'production' }) : /version\.json/.test(url) ? reply({ latest: '7.70.0', notes: { '7.70.0': 'x.' } }) : site(url));
        const m = loadBrowserModule('wealthflow-diagnosis.js', { fetchImpl: newer, globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: '7.69.39' } });
        await m.window.WFDiagnosis.refresh();
        const seen = JSON.parse(m.localStorage.getItem('wf_diag_seen'));
        expect(seen.offer.target).toBe('7.70.0');
        expect(typeof seen.offer.at).toBe('number');
    });

    it('turns the feedback queue into issue number, status and age, and never carries what was written', () => {
        const queue = [{ text: 'SECRET-WORDS-ABOUT-MY-SALARY', type: 'bug', issue: 501, _status: 'in-progress', createdAt: new Date(Date.now() - 3600_000).toISOString() }];
        const { window } = boot({ wf_feedback_queue: JSON.stringify(queue) });
        const full = window.WFDiagnosis.collect();
        expect(full.evidence.feedback).toEqual([expect.objectContaining({ issue: 501, status: 'in-progress', type: 'bug' })]);
        expect(JSON.stringify(full)).not.toMatch(/SECRET-WORDS/);
        expect(JSON.stringify(window.WFDiagnosis.collect({ compact: true }))).not.toMatch(/SECRET-WORDS/);
    });

    it('splits crashes by build using the stability module\'s own records', () => {
        const stab = { crashes: () => [{ build: '7.69.35', page: 'page-dashboard' }, { build: '7.69.35', page: 'page-dashboard' }, { build: '7.69.34', page: 'page-reports' }], totalCrashCount: () => 4 };
        const { window } = boot({}, { WFStability: stab });
        const e = window.WFDiagnosis.collect().evidence.crashes;
        expect(e).toMatchObject({ total: 4, recorded: 3, onThisBuild: 0, byBuild: { '7.69.35': 2, '7.69.34': 1 }, lastBuild: '7.69.34' });
        expect(window.WFDiagnosis.collect().chain.find((l) => l.id === 'stability').state).toBe('ok');
    });

    it('compact output is small and has no issue prose or raw evidence', () => {
        const { window } = boot();
        const c = window.WFDiagnosis.collect({ compact: true });
        expect(c.evidence).toBeUndefined();
        expect(c.issues).toBeUndefined();
        expect(JSON.stringify(c).length).toBeLessThan(2500);
        expect(c.chain[0]).toEqual({ id: 'feedback', state: 'ok', detail: expect.any(String) });
    });
});

describe('the filed issue carries the chain', () => {
    it('shows the verdict and only the links that are not healthy', () => {
        const d = { updateSystem: { verdict: 'broken', summary: '8 of 10 links healthy. First break: "x"', chain: [
            { id: 'feedback', state: 'ok', detail: 'fine' },
            { id: 'install', state: 'fail', detail: 'The last update to 7.69.40 did NOT land | with a pipe\nand a newline' },
            { id: 'worker', state: 'warn', detail: 'waiting' },
        ] } };
        const md = diagnosticsSection(d);
        expect(md).toMatch(/Update system on this device: `broken`/);
        expect(md).toMatch(/\| install \| fail \| The last update to 7\.69\.40 did NOT land with a pipe and a newline \|/);
        expect(md).toMatch(/\| worker \| warn \| waiting \|/);
        expect(md).not.toMatch(/\| feedback \|/);
    });
    it('says nothing, and does not throw, on a malformed chain', () => {
        for (const u of [null, 5, {}, { chain: 'x' }, { chain: [null, 3] }]) expect(() => diagnosticsSection({ updateSystem: u })).not.toThrow();
    });
});
