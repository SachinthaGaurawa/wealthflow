/* The probe that MEASURES a browser module before and after a generated change (autonomy/proof-probe.mjs).
 *
 * Run 41695559384 (issue #501): every gate passed and the proving test then failed three times with the same wrong
 * assumption, because the test author was told what the module renders instead of being shown. These tests pin the
 * parts that make the measurement trustworthy: it reports what the real module renders, it notices a change, it says
 * so when nothing visible changed, it cannot be held up by the code it runs, and that code never sees a secret.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { observeModule, describeObservation, scaffoldIds, wordsOnlyAfter, safeEnv } from '../autonomy/proof-probe.mjs';
import { testPrompt, testRepairPrompt } from '../autonomy/agent-swarm.mjs';

const FILE = 'wealthflow-update-system.js';
const SRC = fs.readFileSync(path.join(import.meta.dirname, '..', FILE), 'utf8');

describe('safeEnv: model-written code never sees the agent\'s secrets', () => {
    const dirty = {
        PATH: '/usr/bin', HOME: '/home/runner', GITHUB_TOKEN: 'ghs_secret', CEREBRAS_API_KEY: 'k1', WealthFlow_API_Key: 'k2',
        ANTHROPIC_API_KEY: 'k3', FIREBASE_SERVICE_ACCOUNT: '{"private_key":"x"}', GH_PAT: 'p', RANDOM_THING: 'y',
    };
    it('keeps what Node and Vitest need', () => {
        const e = safeEnv({}, dirty);
        expect(e.PATH).toBe('/usr/bin');
        expect(e.HOME).toBe('/home/runner');
        expect(e.CI).toBe('1');
    });
    it('drops every key, token and service account', () => {
        const e = safeEnv({}, dirty);
        for (const k of ['GITHUB_TOKEN', 'CEREBRAS_API_KEY', 'WealthFlow_API_Key', 'ANTHROPIC_API_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'GH_PAT', 'RANDOM_THING']) expect(e[k]).toBeUndefined();
        expect(JSON.stringify(e)).not.toMatch(/ghs_secret|private_key/);
    });
});

describe('helpers', () => {
    it('scaffoldIds finds the ids a module draws into', () => {
        const ids = scaffoldIds(`document.getElementById('wfUpdateCard'); document.querySelector("#wfSbVer"); x.getElementById(name)`);
        expect(ids).toEqual(['wfUpdateCard', 'wfSbVer']);
    });
    it('wordsOnlyAfter lists what the change added, not what was already there', () => {
        expect(wordsOnlyAfter('WealthFlow v7.69.39 up to date', 'WealthFlow v7.69.39 build abc123 up to date')).toEqual(['build', 'abc123']);
        expect(wordsOnlyAfter('same text here', 'same text here')).toEqual([]);
    });
});

describe('observeModule on the real update-system module', () => {
    it('reports its public API and the text it renders into the Settings card', () => {
        const o = observeModule(FILE);
        expect(o.ok).toBe(true);
        expect(o.api.wfUpdate).toEqual(expect.arrayContaining(['init', 'refresh', 'simulate', 'check']));
        expect(o.text.wfUpdateCard).toMatch(/Software Update/);
        expect(o.text.wfUpdateCard).toMatch(/Current version/);
        expect(o.fetched).toContain('version.json');
    }, 30_000);

    it('sees a change in what is rendered, and names the new words', () => {
        const patched = SRC.replace("'WealthFlow v' + ", "'WealthFlow build ' + ");
        expect(patched).not.toBe(SRC);
        const before = observeModule(FILE), after = observeModule(FILE, { source: patched });
        const text = describeObservation(before, after, { filename: FILE });
        expect(text).toMatch(/BEFORE the change: "WealthFlow v\d/);
        expect(text).toMatch(/AFTER the change:  "WealthFlow build \d/);
        expect(text).toMatch(/words that exist only AFTER the change: .*build/);
        expect(text).not.toMatch(/WARNING/);
    }, 60_000);

    it('says so when the change is invisible, instead of letting a test guess', () => {
        const same = SRC + '\n/* a comment changes nothing a person can see */\n';
        const text = describeObservation(observeModule(FILE), observeModule(FILE, { source: same }), { filename: FILE });
        expect(text).toMatch(/WARNING: .*IDENTICAL before and after/);
    }, 60_000);

    it('answers /api/version with a sha so a build-id feature can show one', () => {
        // a candidate that asks for it and renders it into the card
        const asks = SRC.replace('function _renderSettingsCard', `window.__bid = null; fetch('/api/version').then(function (r) { return r.json(); }).then(function (j) { window.__bid = j.sha; }).catch(function () {});\n    function _renderSettingsCard`);
        const o = observeModule(FILE, { source: asks });
        expect(o.ok).toBe(true);
        expect(o.fetched).toContain('/api/version');
    }, 30_000);
});

describe('observeModule cannot be held up or fooled by the code it runs', () => {
    it('a module that starts an endless timer still returns promptly', () => {
        const t0 = Date.now();
        const o = observeModule('x.js', { source: `(function(){ window.Thing = { init: function(){ setInterval(function(){}, 1); document.getElementById('box').textContent = 'hello'; } }; })();` });
        expect(o.ok).toBe(true);
        expect(o.text.box).toBe('hello');
        expect(Date.now() - t0).toBeLessThan(15_000);
    }, 30_000);

    it('a module that throws on load is "does not load", not a crash of the agent', () => {
        const o = observeModule('x.js', { source: 'throw new Error("boom")' });
        expect(o.ok).toBe(false);
        expect(o.error).toMatch(/does not load: boom/);
    }, 30_000);

    it('a module that never settles is cut off, and says nothing it did not measure', () => {
        const o = observeModule('x.js', { source: `window.T = { init: function(){ return new Promise(function(){}); } };` });
        expect(o.ok).toBe(true);
        expect(o.api.T).toEqual(['init']);
    }, 30_000);

    it('cannot read the agent\'s environment', () => {
        process.env.WF_PROBE_SECRET = 'leak-me';
        try {
            const o = observeModule('x.js', { source: `window.T = { init: function(){ var v = (typeof process !== 'undefined' && process.env && process.env.WF_PROBE_SECRET) || 'none'; document.getElementById('box').textContent = v; } };` });
            expect(o.ok).toBe(true);
            expect(o.text.box).toBe('none');          // no `process` in the page at all
        } finally { delete process.env.WF_PROBE_SECRET; }
    }, 30_000);

    it('nothing to say when the file could not be measured at all', () => {
        expect(describeObservation({ ok: false }, { ok: false })).toBe('');
    });
});

describe('the test author is given what was measured', () => {
    const obs = describeObservation(
        { ok: true, api: { wfUpdate: ['init', 'refresh'] }, text: { wfUpdateCard: 'WealthFlow v7.69.39' }, fetched: [] },
        { ok: true, api: { wfUpdate: ['init', 'refresh'] }, text: { wfUpdateCard: 'WealthFlow v7.69.39 build abc123' }, fetched: ['/api/version'] },
        { filename: FILE });
    it('the first prompt carries the measurement', () => {
        const p = testPrompt('show the build id', FILE, 'a', 'b', obs);
        expect(p).toMatch(/WHAT THE MODULE ACTUALLY DOES/);
        expect(p).toMatch(/AFTER the change:  "WealthFlow v7.69.39 build abc123"/);
    });
    it('the repair prompt keeps it, next to the failure', () => {
        const p = testRepairPrompt('show the build id', FILE, 'a', 'b', 'old test', { reason: 'r', output: 'o' }, obs);
        expect(p).toMatch(/WHAT THE MODULE ACTUALLY DOES/);
        expect(p).toMatch(/YOUR PREVIOUS TEST WAS EXECUTED AND REJECTED/);
    });
    it('tells the author its test needs its own fetch stub and a wait, because the loader is offline (issue #507)', () => {
        const p = testPrompt('show the build id', FILE, 'a', 'b', obs);
        expect(p).toMatch(/loader's own `fetch` REJECTS/);
        expect(p).toMatch(/passes a `fetchImpl`/);
        expect(p).toMatch(/vi\.waitFor/);
        expect(p).toMatch(/YOUR test does not get that stub/);
    });
    it('stays quiet about fetch when the fixed module asked for nothing', () => {
        const quiet = describeObservation(
            { ok: true, api: { wfUpdate: ['init'] }, text: { wfUpdateCard: 'a' }, fetched: [] },
            { ok: true, api: { wfUpdate: ['init'] }, text: { wfUpdateCard: 'a b' }, fetched: [] },
            { filename: FILE });
        expect(quiet).not.toMatch(/YOUR test does not get that stub/);
    });
    it('without a measurement the prompt is what it was', () => {
        expect(testPrompt('x', FILE, 'a', 'b')).not.toMatch(/WHAT THE MODULE ACTUALLY DOES/);
    });
});
