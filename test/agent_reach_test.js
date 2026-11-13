/* The fix agent's reach, 2026-11-12. Two reports the system files about itself could never be acted on by its own agent:
 *   #559  the reader's printed Total Payment check lives in statement-direction.mjs; three attempts went to other files
 *   #609  the board watch says "read ai-models.mjs, ai-chat.mjs, api/ai.js"; the author answered that none of them was a file it may edit
 * because an editable file was "ends in .js, at the top of the repository". These tests pin the reach, the order (a named file first),
 * the honest stop (named, and none in reach), and the one rule that would have caught it: a watcher may not name a file its agent
 * cannot open without saying so. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { MJS_REACH, OWNERS_HEADING, namedFiles, ownerFiles, reachOf, outOfReachReason, moduleShape, esmTestGuide } from '../autonomy/reach.mjs';
import { isSensitive, candidateFiles, testPrompt, runSwarm } from '../autonomy/agent-swarm.mjs';
import { OWNERS, OWNERS_HEADING as REPORT_HEADING, reportBody as readerReport } from '../wf-statement-self-report.mjs';
import { reportBody as boardReport, assess } from '../autonomy/board-watch.mjs';
import { PROVIDERS, availableProviders, describeAvailability } from '../wf-llm-router.mjs';
import { RETIRED_SERVICES } from '../ai-models.mjs';

const exists = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const reach = (f) => reachOf(f, { isSensitive });

describe('which files the agent may open', () => {
    it('a .js module at the top of the repository, as before', () => {
        expect(reach('wealthflow-statement-router.js')).toEqual({ ok: true, why: '' });
        expect(reach('wealthflow-card-plans.js').ok).toBe(true);
    });
    it('the reader and board modules a watcher names are open, each with its reason', () => {
        for (const f of ['statement-direction.mjs', 'statement-merchants.mjs', 'statement-merchant-name.mjs', 'ai-models.mjs', 'ai-chat.mjs']) {
            expect(reach(f).ok, f).toBe(true);
            expect(String(MJS_REACH.get(f)).length, f).toBeGreaterThan(20);
            expect(exists(f), f).toBe(true);
        }
    });
    it('every other .mjs stays closed: the router that drives the agent, the mail and text senders, the tenant portal, the vault', () => {
        for (const f of ['wf-llm-router.mjs', 'wf-charter.mjs', 'gmail-link.mjs', 'textlk.mjs', 'sms-engine.mjs', 'tenant-portal.mjs', 'statement-cloud-vault.mjs',
            'statement-ledger.mjs', 'statement-registry.mjs', 'statement-reader.mjs', 'admin-db.mjs', 'wf-api-guard.mjs', 'inbox-store.mjs', 'fetch-timeout.mjs', 'consensus-review.mjs', 'build.mjs']) {
            expect(reach(f).ok, f).toBe(false);
        }
    });
    it('the list holds exactly what was decided: a new .mjs is closed until a person opens it by name', () => {
        expect([...MJS_REACH.keys()].sort()).toEqual(['ai-chat.mjs', 'ai-models.mjs', 'statement-direction.mjs', 'statement-merchant-name.mjs', 'statement-merchants.mjs']);
        const open = fs.readdirSync('.').filter((f) => /\.mjs$/.test(f) && reach(f).ok).sort();
        expect(open).toEqual([...MJS_REACH.keys()].sort());
    });
    it('an opened name that is also on the protected list stays protected', () => {
        const opened = new Map([['google-oauth.mjs', 'a mistake'], ['statement-cloud-vault.mjs', 'a mistake']]);
        expect(reachOf('google-oauth.mjs', { isSensitive, opened }).ok).toBe(false);
        expect(reachOf('statement-cloud-vault.mjs', { isSensitive, opened }).ok).toBe(false);
    });
    it('says why not, in words a person can act on', () => {
        expect(reach('api/ai.js').why).toMatch(/inside api\//);
        expect(reach('sw.js').why).toMatch(/protected list/);
        expect(reach('statement-ledger.mjs').why).toMatch(/has not been opened/);
        expect(reach('index.html').why).toMatch(/not a script module/);
        expect(reach('thing.test.js').why).toMatch(/a test/);
        expect(reachOf('big.js', { isSensitive, size: 900_000, maxBytes: 400_000 }).why).toMatch(/more than the agent can patch/);
        expect(reach('').ok).toBe(false);
    });
    it('the files offered for a whole-file rewrite now include the opened modules that are small enough', () => {
        const picked = candidateFiles(fs.readdirSync('.'), { repoDir: process.cwd() });
        expect(picked).toContain('ai-models.mjs');
        expect(picked).toContain('statement-direction.mjs');
        expect(picked).not.toContain('wf-llm-router.mjs');
        for (const f of picked) expect(isSensitive(f), f).toBe(false);
    });
});

describe('the files a report names', () => {
    it('are found in the order written, only when they exist, with or without quotes', () => {
        const text = 'read `ai-models.mjs`, `ai-chat.mjs`, `api/ai.js` and no-such-file.js; also ai-models.mjs again and package.json.';
        expect(namedFiles(text, { exists })).toEqual(['ai-models.mjs', 'ai-chat.mjs', 'api/ai.js', 'package.json']);
    });
    it('never follow a path out of the repository', () => {
        expect(namedFiles('see ../../etc/passwd.js and ./../secret.json', { exists: () => true })).toEqual([]);
    });
    it('under "Where the code is" are the owners, up to the next heading', () => {
        const text = ['## Report', 'mentions `sw.js` in passing', '### ' + OWNERS_HEADING, '- `statement-direction.mjs`: printedPaymentsCheck', '- `api/ai.js`', '### What to do', 'look at `index.html`'].join('\n');
        expect(ownerFiles(text, { exists })).toEqual(['statement-direction.mjs', 'api/ai.js']);
        expect(ownerFiles('no such heading, only `sw.js`', { exists })).toEqual([]);
    });
});

describe('a watcher may not name a file its own agent cannot open', () => {
    it('the reader and the pipeline use the same heading', () => { expect(REPORT_HEADING).toBe(OWNERS_HEADING); });
    it('every kind of reader self-report names owners that exist, hold the functions it names, and are within reach', () => {
        for (const [kind, owners] of Object.entries(OWNERS)) {
            expect(owners.length, kind).toBeGreaterThan(0);
            for (const [file, names] of owners) {
                expect(exists(file), `${kind}: ${file}`).toBe(true);
                expect(reach(file).ok, `${kind}: ${file} is not a file the agent may edit`).toBe(true);
                const src = fs.readFileSync(file, 'utf8');
                for (const name of names.split(',').map((n) => n.trim())) expect(src, `${kind}: ${file} has no ${name}`).toMatch(new RegExp('\\b(function|const)\\s+' + name + '\\b'));
            }
            const body = readerReport(kind, { bank: 'Bank', shape: {}, rows: 3 });
            expect(ownerFiles(body, { exists }), kind).toEqual(owners.map(([file]) => file));
            expect(body.replace(/`[^`]*`/g, ''), kind).not.toMatch(/\d{4,}/);
        }
    });
    it('the board watch names only files within reach under its heading', () => {
        const body = boardReport(assess({ ok: true, report: { board: { asked: 2, answered: 1, floor: 5 }, providers: [{ name: 'A', ok: true }, { name: 'B', ok: false, error: 'deadline exceeded' }] } }));
        const owners = ownerFiles(body, { exists });
        expect(owners.length).toBeGreaterThan(0);
        for (const f of owners) expect(reach(f).ok, f).toBe(true);
    });
});

/* ── through runSwarm, in a throw-away repository ─────────────────────────────────────────────────────────────────── */
function repoWith(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-reach-'));
    for (const [name, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
    return dir;
}
const NO_KEYS = { PATH: process.env.PATH };                 // no provider key: any model call fails, so a run that needs none proves none was made

describe('replay #609: the report names files, and the agent takes them first', () => {
    const body = 'Fix agent: for each provider in the second list, find why it fails (read `ai-models.mjs`, `ai-chat.mjs`, `api/ai.js`) and change the code.';
    it('before: none of the three was a file the agent may edit; now two are, and they head the order with no model asked to choose', async () => {
        const dir = repoWith({
            'ai-models.mjs': 'export function choose() { return ""; }\n', 'ai-chat.mjs': 'export function askChat() {}\n', 'api/ai.js': 'export default function handler() {}\n',
            'statement-sync.js': '// providers providers providers fails fails fails code code\n', 'wealthflow-merchants.js': '// provider list second fails\n',
        });
        const lines = [];
        const out = await runSwarm({ issue: { title: 'AI board health: only 4 of 12 providers answer (floor 5)', body, number: 609, kind: 'bug' }, repoDir: dir, env: NO_KEYS, writeTest: false, log: (l) => lines.push(String(l)) }).catch((e) => ({ ok: false, stage: 'threw', reason: String(e && e.message) }));
        const log = lines.join('\n');
        expect(log).toMatch(/the report names ai-models\.mjs, ai-chat\.mjs: taken first, no model asked to choose/);
        expect(log).toMatch(/trying ai-models\.mjs/);
        expect(log).not.toMatch(/trying statement-sync\.js/);
        expect(out.stage).not.toBe('select');
        expect(out.stage).not.toBe('reach');
    });
});

describe('replay #559 as it is filed now: the report says where the code is', () => {
    it('the reader\'s report for a printed total that differs leads the agent to statement-direction.mjs', async () => {
        const dir = repoWith({
            'statement-direction.mjs': 'export function printedPaymentsCheck(parsed) { return "differs"; }\n',
            'statement-sync.js': '// statement reader payments printed total payment credit lines layout convention review\n',
            'wealthflow-merchants.js': '// statement payment total\n',
        });
        const lines = [];
        const out = await runSwarm({ issue: { title: 'Statement reader: payments do not add up', body: readerReport('printed-total-differs', { bank: 'Bank', shape: {}, rows: 9 }), number: 559, kind: 'bug' }, repoDir: dir, env: NO_KEYS, writeTest: false, log: (l) => lines.push(String(l)) }).catch((e) => ({ ok: false, stage: 'threw', reason: String(e && e.message) }));
        expect(lines.join('\n')).toMatch(/trying statement-direction\.mjs/);
        expect(out.stage).not.toBe('reach');
    });
});

describe('named, and none of it in reach: said at once, nothing asked, nothing counted', () => {
    it('stops at "reach" with the reason per file and makes no model call', async () => {
        const dir = repoWith({ 'api/ai.js': 'export default function handler() {}\n', 'sw.js': '// service worker\n', 'wealthflow-thing.js': '// endpoint deadline keys\n' });
        const body = ['## A report', 'The endpoint misses its deadline.', '', '### ' + OWNERS_HEADING, '- `api/ai.js`: the deadline', '- `sw.js`: the cache', '', '### What to do', 'Change it.'].join('\n');
        const lines = [];
        const out = await runSwarm({ issue: { title: 'Endpoint deadline', body, number: 1, kind: 'bug' }, repoDir: dir, env: NO_KEYS, writeTest: false, log: (l) => lines.push(String(l)) });
        expect(out).toMatchObject({ ok: false, stage: 'reach', named: ['api/ai.js', 'sw.js'] });
        expect(out.reason).toMatch(/`api\/ai\.js` \(it is inside api\//);
        expect(out.reason).toMatch(/`sw\.js` \(it is on the protected list/);
        expect(out.reason).toMatch(/No model was asked and no attempt was spent/);
        expect(lines.join('\n')).not.toMatch(/trying /);
        expect(out.providers).toEqual({});
    });
    it('a file named only in passing (no owners heading) never stops a run', async () => {
        const dir = repoWith({ 'api/ai.js': 'export default function handler() {}\n', 'wealthflow-thing.js': '// endpoint deadline keys\n' });
        const out = await runSwarm({ issue: { title: 'Endpoint deadline', body: 'It happens in `api/ai.js`, I think. endpoint deadline', number: 2, kind: 'bug' }, repoDir: dir, env: NO_KEYS, writeTest: false, log: () => {} }).catch((e) => ({ ok: false, stage: 'threw' }));
        expect(out.stage).not.toBe('reach');
    });
    it('the fix agent hands such an issue over without counting an attempt', () => {
        const agent = fs.readFileSync('autonomous-fix-agent.js', 'utf8');
        const at = agent.indexOf("result.stage === 'reach'");
        expect(at).toBeGreaterThan(0);
        const branch = agent.slice(at, agent.indexOf('continue;', at));
        expect(branch).toContain('Q.LABELS.stuck');
        expect(branch).not.toContain('state.attempts += 1');
        expect(branch).not.toContain('wf-agent-attempt');
        expect(at).toBeLessThan(agent.indexOf('state.attempts += 1', at));      // it comes before the branch that counts
    });
    it('the sentence names every file and what a person can do', () => {
        const s = outOfReachReason([{ file: 'api/ai.js', why: 'it is inside api/' }]);
        expect(s).toContain('`api/ai.js` (it is inside api/)');
        expect(s).toMatch(/opened to the agent .* or the change is made by a person/);
    });
});

describe('a module with exports is tested by importing it', () => {
    it('tells an ES module from a browser script', () => {
        expect(moduleShape('export function a() {}\nexport const b = 1;\nexport { c, d as e };\nexport default { a };')).toEqual({ esm: true, exports: ['a', 'b', 'c', 'e'], hasDefault: true });
        expect(moduleShape("import x from './y.mjs';\nconst z = 1;").esm).toBe(true);
        expect(moduleShape('(function () { window.wfThing = { go() {} }; })();')).toEqual({ esm: false, exports: [], hasDefault: false });
        expect(moduleShape('// export function inComment() {}\n(function () {})();').esm).toBe(false);
    });
    it('the real modules are read for what they are', () => {
        expect(moduleShape(fs.readFileSync('statement-direction.mjs', 'utf8')).exports).toContain('printedPaymentsCheck');
        expect(moduleShape(fs.readFileSync('ai-models.mjs', 'utf8')).exports).toContain('choose');
    });
    it('the proving-test instructions for an ES module say import, and no longer say "browser IIFE with no export"', () => {
        const after = 'export function printedPaymentsCheck(parsed) { return "ok"; }\n';
        const prompt = testPrompt('the check misses a marker', 'statement-direction.mjs', 'export function printedPaymentsCheck() { return "differs"; }\n', after);
        expect(prompt).toContain('statement-direction.mjs is an ES MODULE');
        expect(prompt).toContain('import { printedPaymentsCheck } from "../statement-direction.mjs";');
        expect(prompt).toMatch(/NEVER copy a real statement line/);
        expect(prompt).not.toContain('is a browser IIFE');
        expect(prompt).not.toContain('loadBrowserModule');
        expect(prompt).toContain('MUST FAIL');                                   // the red-then-green rule is unchanged
    });
    it('the instructions for a browser script are what they were', () => {
        const prompt = testPrompt('a card shows the wrong text', 'wealthflow-thing.js', '(function () { window.wfThing = {}; })();', '(function () { window.wfThing = { go() {} }; })();');
        expect(prompt).toContain('wealthflow-thing.js is a browser IIFE');
        expect(prompt).toContain('loadBrowserModule("wealthflow-thing.js"');
        expect(prompt).not.toContain('ES MODULE');
    });
    it('the guide still helps when the exports cannot be read', () => {
        expect(esmTestGuide('x.mjs', { esm: true, exports: [] }).join('\n')).toContain('Read its exports from the code below');
    });
    it('a module with only a default export is imported as a default, never as a made-up name', () => {
        const shape = moduleShape('const api = { go() {} };\nexport default api;\n');
        expect(shape).toEqual({ esm: true, exports: [], hasDefault: true });
        const guide = esmTestGuide('x.mjs', shape).join('\n');
        expect(guide).toContain('import theModule from "../x.mjs";');
        expect(guide).not.toContain('{ theFunction }');
    });
});

/* ── 2026-11-13: a service its owner ended holds no seat, in the pipeline either ─────────────────────────────────────── */
describe('GitHub Models, ended by GitHub on 2026-07-30, is asked by nobody in the update system', () => {
    const env = { GROQ_API_KEY: 'g', GITHUB_MODELS_TOKEN: 'still-set-in-the-repository' };
    it('the pipeline router does not count it as a provider, although its secret is still set', () => {
        expect(availableProviders(env).map((p) => p.id)).toEqual(['groq']);
        expect(describeAvailability(env).count).toBe(1);
    });
    it('and it is not named as a missing key either: nobody is asked to add a key for a service that is gone', () => {
        expect(describeAvailability({ GROQ_API_KEY: 'g' }).missing).not.toContain('github-models');
        expect(fs.readFileSync('autonomous-fix-agent.js', 'utf8')).not.toContain('GITHUB_MODELS_TOKEN');
    });
    it('the entry stays in the list, marked, so an old report still reads; the mark and the app\'s list say the same date', () => {
        const entry = PROVIDERS.find((p) => p.id === 'github-models');
        expect(entry.retired).toBe(RETIRED_SERVICES.GitHubModels.since);
        expect(PROVIDERS.filter((p) => p.retired).map((p) => p.id)).toEqual(['github-models']);
    });
});
