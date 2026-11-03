/* The author is shown what its change REALLY did, and may try again.
 *
 * WHAT HAPPENED (run 41698322633, issue #501, after #503): "show the build id next to the version" was drafted as a
 * change that read `_manifest.build`. version.json has no such field, so nothing new was ever drawn. Every gate passed
 * and the measurement printed the proof in plain sight (the card text was IDENTICAL before and after), and then three
 * proving-test rounds were spent on a change that could never be proven, because nothing fed the measurement back to
 * the one who wrote the change.
 *
 * These tests run the real runSwarm() with a scripted model and the REAL probe (a child process in a real DOM) and check:
 *   - a change with no visible effect goes back to the author with the measurement and the list of fields that exist,
 *   - the revised change is vetted by the independent security reviewer again, exactly like the first one,
 *   - a revision that does draw the text ends the loop; one that does not is retried at most MAX_REVISIONS times,
 *   - a bug fix (which may legitimately draw nothing new) is not sent round,
 *   - the helpers say what they claim.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = { replies: [], calls: [] };
vi.mock('../autonomy/llm-router.mjs', async () => {
    const actual = await vi.importActual('../autonomy/llm-router.mjs');
    return {
        ...actual,
        chat: async (o) => {
            script.calls.push(o);
            const next = script.replies.shift();
            if (next === undefined) throw new Error('script exhausted');
            if (next instanceof Error) throw next;
            return { text: next, provider: o.exclude && o.exclude.includes('p1') ? 'p2' : 'p1' };
        },
    };
});

const { runSwarm, revisionPrompt, changedRegion, MAX_REVISIONS } = await import('../autonomy/agent-swarm.mjs');
const { observedNoChange, groundFacts, VERSION_ENDPOINT_FIELDS } = await import('../autonomy/proof-probe.mjs');
const versionHandler = (await import('../version.js')).default;

const FILE = 'wealthflow-card.js';
const MODULE = [
    '(function () {',
    '    window.wfCard = {',
    '        init: function () {',
    "            var el = document.getElementById('wfCard');",
    "            el.textContent = 'Version ' + '1.0';",
    '        },',
    '    };',
    '})();',
    '',
].join('\n');
const ISSUE = 'Show the build id next to the version in the card so I can see which build I run.';
const PASS = '{"verdict":"PASS","severity":"none","findings":[],"reason":"display only"}';
const patch = (replace) => ['<<<<<<< SEARCH', "            el.textContent = 'Version ' + '1.0';", '=======', replace, '>>>>>>> REPLACE'].join('\n');
/** the "author" returns the whole file, changed in a way no person could see */
const invisible = (tag) => MODULE.replace("var el = document.getElementById('wfCard');", `var el = document.getElementById('wfCard'); /* ${tag} */`);

describe('observedNoChange', () => {
    const ok = (text) => ({ ok: true, text });
    it('is true only when something was drawn and every element is unchanged', () => {
        expect(observedNoChange(ok({ a: 'x' }), ok({ a: 'x' }))).toBe(true);
    });
    it('is false when any element changed', () => {
        expect(observedNoChange(ok({ a: 'x' }), ok({ a: 'x y' }))).toBe(false);
        expect(observedNoChange(ok({ a: 'x' }), ok({ a: 'x', b: 'new' }))).toBe(false);
    });
    it('is "unknown", not "no change", when nothing was drawn or a run could not be measured', () => {
        expect(observedNoChange(ok({}), ok({}))).toBe(false);
        expect(observedNoChange({ ok: false }, ok({ a: 'x' }))).toBe(false);
        expect(observedNoChange(ok({ a: 'x' }), { ok: false })).toBe(false);
        expect(observedNoChange(null, undefined)).toBe(false);
    });
});

describe('helpers', () => {
    it('changedRegion finds the lines a change touched', () => {
        expect(changedRegion('a\nb\nc\nd', 'a\nB\nc\nd')).toEqual({ from: 2, to: 2 });
        expect(changedRegion('a\nb\nc\nd', 'a\nb\nX\nY\nc\nd').from).toBe(3);
    });
    it('groundFacts lists the REAL fields of version.json, so the author cannot invent one', () => {
        const facts = groundFacts({ repoDir: path.join(import.meta.dirname, '..') });
        const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'version.json'), 'utf8')));
        for (const k of keys) expect(facts).toContain(k);
        expect(facts).not.toMatch(/\bbuild\b.*top-level/);
    });
    it('the /api/version fields named to the author are exactly what the real handler returns', () => {
        let body = null;
        versionHandler({}, { setHeader() {}, status() { return { json(b) { body = b; } }; } });
        expect(Object.keys(body).sort()).toEqual([...VERSION_ENDPOINT_FIELDS].sort());
    });
    it('revisionPrompt carries the change, the measurement and the facts, and says to start from the original', () => {
        const p = revisionPrompt(ISSUE, FILE, 'EXCERPT-TEXT', 50, { changeText: 'THE-CHANGE', observation: 'THE-MEASUREMENT', facts: 'THE-FACTS' });
        for (const part of ['EXCERPT-TEXT', 'THE-CHANGE', 'THE-MEASUREMENT', 'THE-FACTS', 'IDENTICAL', 'ORIGINAL']) expect(p).toContain(part);
    });
});

describe('runSwarm — a change with no visible effect goes back to its author', () => {
    let dir, logs;
    beforeEach(() => {
        script.replies = []; script.calls = []; logs = [];
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-revise-'));
        fs.mkdirSync(path.join(dir, 'test'));
        fs.writeFileSync(path.join(dir, FILE), MODULE);
        fs.writeFileSync(path.join(dir, 'version.json'), JSON.stringify({ latest: '1.0.0', version: '1.0.0', notes: [] }));
    });
    const run = (kind = 'feature') => runSwarm({ issue: { title: 'Show the build id', body: ISSUE, number: 7, kind }, repoDir: dir, env: {}, writeTest: false, log: (m) => logs.push(String(m)) });

    it('re-drafts once with the measurement, re-vets the new change, and ends as soon as the text is really drawn', async () => {
        script.replies = [FILE, invisible('first try'), PASS, patch("            el.textContent = 'Version ' + '1.0' + ' · build abc123';"), PASS];
        const r = await run();
        expect(r.ok).toBe(true);
        expect(r.code).toContain('build abc123');
        const log = logs.join('\n');
        expect(log).toMatch(/revision 1\/2: the change had no visible effect/);
        expect(log).toMatch(/after 1 revision\(s\) the change is visible/);
        // select, author, review, revision, review — the revised change passed the same independent review
        expect(script.calls.length).toBe(5);
        expect(script.calls[4].system).toMatch(/Chaos Security Auditor/);
        expect(script.calls[4].exclude).toContain('p1');
        // the revision prompt really carried the evidence
        const rp = script.calls[3].prompt;
        expect(rp).toMatch(/IDENTICAL/);
        expect(rp).toMatch(/FACTS ABOUT THE DATA/);
        expect(rp).toMatch(/exactly: sha, version, env, ts/);
        expect(r.observation).toMatch(/AFTER the change:\s+"Version 1\.0 · build abc123"/);
    }, 120_000);

    it('stops after MAX_REVISIONS and still hands the last change on honestly', async () => {
        expect(MAX_REVISIONS).toBe(2);
        script.replies = [
            FILE, invisible('first try'), PASS,
            patch("            el.textContent = 'Version ' + '1.0'; /* second */"), PASS,
            patch("            el.textContent = 'Version ' + '1.0'; /* third */"), PASS,
        ];
        const r = await run();
        expect(r.ok).toBe(true);
        expect(script.calls.length).toBe(7);
        expect(logs.join('\n')).toMatch(/revision 2\/2/);
        expect(logs.join('\n')).not.toMatch(/the change is visible/);
        expect(r.observation).toMatch(/WARNING: .*IDENTICAL/);
    }, 120_000);

    it('a revision the security reviewer vetoes ends the run, like any change would', async () => {
        script.replies = [FILE, invisible('first try'), PASS, patch("            el.textContent = 'Version ' + '1.0' + innerHTMLfromUser;"), '{"verdict":"FAIL","severity":"high","findings":["xss"],"reason":"unescaped input"}'];
        const r = await run();
        expect(r.ok).toBe(false);
        expect(r.stage).toBe('security');
        expect(r.reason).toMatch(/Agent 5 veto/);
    }, 120_000);

    it('a revision that cannot be applied leaves the first change in place and does not loop', async () => {
        script.replies = [FILE, invisible('first try'), PASS, '<<<<<<< SEARCH\nthis text is nowhere in the file\n=======\nx\n>>>>>>> REPLACE'];
        const r = await run();
        expect(r.ok).toBe(true);
        expect(script.calls.length).toBe(4);
        expect(logs.join('\n')).toMatch(/revision 1: the new patch could not be applied/);
    }, 120_000);

    it('a bug fix is not sent round: it may legitimately draw nothing new', async () => {
        script.replies = [FILE, invisible('first try'), PASS];
        const r = await run('bug');
        expect(r.ok).toBe(true);
        expect(script.calls.length).toBe(3);
        expect(logs.join('\n')).not.toMatch(/revision 1/);
    }, 120_000);
});
