/*  autonomy/proof-probe.mjs
 *  ---------------------------------------------------------------------------
 *  MEASURE what a browser module does, before and after a generated change, instead of letting a
 *  weak model guess it.
 *
 *  WHY THIS EXISTS (run 41695559384, issue #501, the first real feedback → fix run after #500)
 *  The author, the mechanical gates and the independent security review all passed. Then the
 *  proving test failed three times against the FIXED file with the same wrong assumption: it
 *  asserted "WealthFlow v1.0.0 · build abc123" while the module rendered "WealthFlow v7.69.38 · up to
 *  date". The model was told, in prose, that the version is read from the file; it never SAW what the
 *  module renders, so it wrote what it imagined. The repair rounds showed it the failure, truncated,
 *  and it changed nothing.
 *
 *  So the harness now looks first. It runs the module (the original and the candidate) in a real DOM,
 *  calls its public `init` / `refresh`, answers the network calls it makes with a stub, and reports:
 *    · the API the module attached to `window`,
 *    · the text each element it renders ends up holding,
 *    · the URLs it asked for,
 *    · which words exist only AFTER the change.
 *  The test author is given that, so its assertion is about observed behaviour. If the text did not
 *  change at all, that is said out loud too: it is the most useful thing a reviewer of a "show X next
 *  to Y" change can learn, and the log used to hide it.
 *
 *  The code runs in a CHILD PROCESS with a scrubbed environment. It is model-written code; it gets no
 *  provider key and no GitHub token, and a hang or a runaway timer cannot hold the agent.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/**
 * The environment generated code may see: enough to run Node and Vitest, none of the secrets the agent
 * itself holds (provider keys, GITHUB_TOKEN, the Firebase service account).
 */
export function safeEnv(extra = {}, from = process.env) {
    const keep = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'SystemRoot',
        'APPDATA', 'LOCALAPPDATA', 'ComSpec', 'PATHEXT', 'npm_config_cache', 'NODE_EXTRA_CA_CERTS', 'RUNNER_TEMP', 'XDG_CACHE_HOME'];
    const out = {};
    for (const k of keep) if (from[k] !== undefined) out[k] = from[k];
    return { ...out, CI: '1', ...extra };
}

/** Ids a module reaches for, so the probe can give it somewhere to draw. */
export function scaffoldIds(source) {
    const ids = new Set();
    const text = String(source || '');
    for (const re of [/getElementById\(\s*['"]([\w-]{1,60})['"]\s*\)/g, /querySelector(?:All)?\(\s*['"]#([\w-]{1,60})['"]/g]) {
        let m;
        while ((m = re.exec(text)) && ids.size < 40) ids.add(m[1]);
    }
    return [...ids];
}

const words = (s) => String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9.\-_/]{2,}/g) || [];

/** Words (3+ characters) that appear AFTER and not BEFORE, most useful first, at most `max`. */
export function wordsOnlyAfter(before, after, max = 14) {
    const had = new Map();
    for (const w of words(before)) had.set(w, (had.get(w) || 0) + 1);
    const out = [];
    for (const w of words(after)) {
        const n = had.get(w) || 0;
        if (n > 0) { had.set(w, n - 1); continue; }
        if (!out.includes(w)) out.push(w);
        if (out.length >= max) break;
    }
    return out;
}

const flat = (o) => Object.values((o && o.text) || {}).join(' ¶ ');

/**
 * Run one module (or a candidate version of it) in a throw-away child process and return what it did.
 * Never throws: an unmeasurable module is `{ ok: false, error }`, not a failed run.
 */
export function observeModule(file, { source = null, repoDir = ROOT, timeoutMs = 25_000 } = {}) {
    let tmp = null;
    try {
        const args = [fileURLToPath(import.meta.url), '--probe', file];
        if (typeof source === 'string') {
            tmp = path.join(os.tmpdir(), `wf-probe-${process.pid}-${Date.now()}.js`);
            fs.writeFileSync(tmp, source);
            args.push('--source-file', tmp);
        }
        const out = execFileSync(process.execPath, args, {
            cwd: repoDir, timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], env: safeEnv(), maxBuffer: 4 * 1024 * 1024,
        }).toString();
        const line = out.split('\n').reverse().find((l) => l.startsWith('__PROBE__'));
        if (!line) return { ok: false, error: 'the probe printed nothing' };
        return JSON.parse(line.slice('__PROBE__'.length));
    } catch (e) {
        return { ok: false, error: String((e && (e.stderr ? String(e.stderr).trim().split('\n').pop() : e.message)) || e).slice(0, 300) };
    } finally {
        if (tmp) { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } }
    }
}

/**
 * Put both measurements into words a test author can act on. Empty when neither could be measured
 * (a module with no DOM output, or one that does not load): then nothing is claimed.
 */
export function describeObservation(before, after, { filename = 'the module' } = {}) {
    if (!before?.ok && !after?.ok) return '';
    const L = ['WHAT THE MODULE ACTUALLY DOES — measured by running it in a real DOM, not guessed:'];
    const api = (after?.ok ? after : before).api || {};
    for (const [g, fns] of Object.entries(api)) if (fns.length) L.push(`  · window.${g} has: ${fns.slice(0, 40).join(', ')}  (these are the only methods you may call)`);
    if (before?.ok && after?.ok) {
        const ids = [...new Set([...Object.keys(before.text || {}), ...Object.keys(after.text || {})])];
        const changed = ids.filter((id) => (before.text || {})[id] !== (after.text || {})[id]);
        for (const id of (changed.length ? changed : ids).slice(0, 4)) {
            L.push(`  · element #${id}`);
            L.push(`      BEFORE the change: ${JSON.stringify(String((before.text || {})[id] || '').slice(0, 500))}`);
            L.push(`      AFTER the change:  ${JSON.stringify(String((after.text || {})[id] || '').slice(0, 500))}`);
        }
        const added = wordsOnlyAfter(flat(before), flat(after));
        if (added.length) L.push(`  · words that exist only AFTER the change: ${added.join(', ')}`);
        else L.push(`  · WARNING: with the network answers below, the text on screen is IDENTICAL before and after. Either the change is not visible in this setup, or it did not do what the issue asked. A test that asserts on new text will fail until the module really renders it.`);
        const asked = [...new Set([...(after.fetched || [])])];
        if (asked.length) L.push(`  · the fixed module asked for: ${asked.join(', ')}`);
        L.push('  · the network stub answered /api/version with {"sha":"abc123def456","version":"<version.json latest>"}, /version.json with the real manifest, anything else with 404.');
        if (after.errors?.length) L.push(`  · errors while running the fixed module: ${after.errors.slice(0, 3).join(' | ')}`);
    } else {
        L.push(`  · (${filename} could not be measured ${before?.ok ? 'after' : 'before'} the change: ${(before?.ok ? after : before)?.error || 'unknown'})`);
    }
    L.push('  · Never hard-code the version: it is whatever `window.<global>.CURRENT_VERSION` / the card says. Assert on a word from the "only AFTER" list.');
    return L.join('\n');
}

/**
 * True when BOTH runs were measured, something was drawn, and every element holds exactly the same text after
 * the change as before it. Nothing drawn at all is "unknown", never "no change".
 */
export function observedNoChange(before, after) {
    if (!before?.ok || !after?.ok) return false;
    const b = before.text || {}, a = after.text || {};
    const ids = new Set([...Object.keys(b), ...Object.keys(a)]);
    if (!ids.size) return false;
    for (const id of ids) if (b[id] !== a[id]) return false;
    return true;
}

/** What `GET /api/version` returns (version.js). A test keeps this line equal to the real handler's output. */
export const VERSION_ENDPOINT_FIELDS = ['sha', 'version', 'env', 'ts'];

/**
 * The data the module can really see, stated as facts. Run 41698322633 (issue #501): the author wrote
 * `_manifest.build`, a field that does not exist, so the new text was never drawn. A model that is told the field
 * list stops inventing fields.
 */
export function groundFacts({ repoDir = ROOT } = {}) {
    const L = ['FACTS ABOUT THE DATA THIS MODULE CAN SEE (do not read a field that is not listed here or visibly set in the excerpts):'];
    try {
        const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(repoDir, 'version.json'), 'utf8')));
        L.push(`  · version.json (the release manifest this module loads) has exactly these top-level fields: ${keys.join(', ')}.`);
    } catch { /* no manifest: say nothing about it */ }
    L.push(`  · GET /api/version answers with JSON that has exactly: ${VERSION_ENDPOINT_FIELDS.join(', ')}. \`sha\` is the short deploy (build) hash.`);
    return L.join('\n');
}

// ── the child-process side ──────────────────────────────────────────────────

async function probe(file, sourceFile) {
    const { loadBrowserModule } = await import(pathToFileURL(path.join(ROOT, 'test', 'helpers', 'load-browser-module.js')).href);
    // The module under test lives in the repo being fixed (the child's cwd); the loader is the agent's own.
    const repoFile = path.resolve(process.cwd(), file);
    const source = sourceFile ? fs.readFileSync(sourceFile, 'utf8') : fs.readFileSync(fs.existsSync(repoFile) ? repoFile : path.join(ROOT, file), 'utf8');
    const ids = scaffoldIds(source);
    const html = ids.map((id) => `<div id="${id}"></div>`).join('') + (ids.includes('app') ? '' : '<div id="app" class="show"></div>');

    let manifest = { latest: '0.0.0' };
    try { manifest = JSON.parse(fs.readFileSync(fs.existsSync(path.resolve(process.cwd(), 'version.json')) ? path.resolve(process.cwd(), 'version.json') : path.join(ROOT, 'version.json'), 'utf8')); } catch { /* the stub still answers */ }
    const fetched = [];
    const reply = (body, ok = true, status = 200) => ({ ok, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });
    const fetchImpl = async (input) => {
        const url = String((input && input.url) || input);
        fetched.push(url.replace(/[?#].*$/, ''));
        if (/\/api\/version/.test(url)) return reply({ sha: 'abc123def456', version: manifest.latest, env: 'production', ts: new Date().toISOString() });
        if (/version\.json/.test(url)) return reply(manifest);
        if (/autonomy-status/.test(url)) return reply({ ok: true, overall: 'healthy', canActuallyFixBugs: true, headline: 'Automatic updates are working.' });
        return reply({}, false, 404);
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const errors = [];
    const globals = {
        // model-written code must not be able to keep this process alive or spin: timers are short and unref'd
        setInterval: () => 0, clearInterval: () => {},
        setTimeout: (fn, ms, ...a) => { const t = setTimeout(fn, Math.min(Number(ms) || 0, 40), ...a); if (t && t.unref) t.unref(); return t; },
    };
    let m;
    try {
        m = loadBrowserModule(file, { html, fetchImpl, globals, source });
    } catch (e) {
        return { ok: false, error: 'does not load: ' + String((e && e.message) || e).slice(0, 200) };
    }
    await sleep(60);
    const api = {};
    for (const name of m.attached || []) {
        const obj = m.window[name];
        if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) continue;
        let fns = [];
        try { fns = Object.keys(obj).filter((k) => typeof obj[k] === 'function').sort(); } catch { fns = []; }
        if (!fns.length) continue;
        api[name] = fns;
        for (const entry of ['init', 'refresh']) {
            if (typeof obj[entry] !== 'function') continue;
            try { await Promise.race([Promise.resolve(obj[entry]()), sleep(400)]); } catch (e) { errors.push(`${name}.${entry}: ${String((e && e.message) || e).slice(0, 120)}`); }
        }
    }
    await sleep(120);
    await sleep(120);
    const text = {};
    for (const id of ids) {
        try {
            const t = String(m.document.getElementById(id)?.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) text[id] = t.slice(0, 1500);
        } catch { /* an element the stub DOM cannot answer for */ }
    }
    return { ok: true, api, text, fetched: [...new Set(fetched)].slice(0, 12), errors: errors.slice(0, 5) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv.includes('--probe')) {
    const i = process.argv.indexOf('--probe');
    const si = process.argv.indexOf('--source-file');
    probe(process.argv[i + 1], si > -1 ? process.argv[si + 1] : null)
        .then((r) => { process.stdout.write('\n__PROBE__' + JSON.stringify(r) + '\n'); process.exit(0); })
        .catch((e) => { process.stdout.write('\n__PROBE__' + JSON.stringify({ ok: false, error: String((e && e.message) || e).slice(0, 300) }) + '\n'); process.exit(0); });
}
