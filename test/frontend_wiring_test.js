import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// A script that no page loads is not a feature, it is a file. This has happened:
// two "hydration" scripts were added that index.html never referenced, so they
// never ran — and wired in as written they would have opened an IndexedDB the app
// does not use and re-rendered the open screen on every status change. Every
// browser-side script at the top level must therefore be reachable from index.html
// (a <script src>, a dynamic script.src, or an import from something that is), or
// be named here with the reason it is not.
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');

const NOT_LOADED = {
    'HANDLEAISCAN_PATCH.js': 'a patch dump to paste into index.html, not a module (autonomy/agent-swarm.mjs ignores it too)',
    'pwa-updater.js': 'a second update poller; index.html loads wealthflow-live-update.js for that job — only its own test references this one',
};

function reachable() {
    const seen = new Set();
    const stack = [...html.matchAll(/<script[^>]*\bsrc=["']([^"'?#]+)/g)].map(m => m[1]).filter(s => !/^(?:https?:)?\/\//.test(s));
    for (const m of html.matchAll(/\.src\s*=\s*['"]([^'"?#]+\.m?js)['"]/g)) stack.push(m[1]);
    while (stack.length) {
        const file = path.normalize(stack.pop().replace(/^\.?\//, ''));
        if (seen.has(file) || !fs.existsSync(path.join(root, file))) continue;
        seen.add(file);
        for (const m of read(file).matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) stack.push(path.join(path.dirname(file), m[1]));
    }
    return seen;
}

describe('browser-side scripts are connected to the app', () => {
    it('every top-level script that drives the page is loaded by index.html', () => {
        const loaded = reachable();
        const browserSide = fs.readdirSync(root).filter(f => /\.m?js$/.test(f) && /window\.addEventListener|document\.(?:querySelector|getElementById)/.test(read(f)));
        const orphans = browserSide.filter(f => !loaded.has(f) && !NOT_LOADED[f]);
        expect(orphans).toEqual([]);
    });
    it('a script named as not loaded really is not loaded (so the list cannot rot)', () => {
        const loaded = reachable();
        for (const f of Object.keys(NOT_LOADED)) expect(loaded.has(f), f).toBe(false);
    });
    it('there is no second copy of a server module tucked into a frontend folder', () => {
        expect(fs.existsSync(path.join(root, 'frontend'))).toBe(false);
    });
    it('nothing calls a hydration hook that no script defines', () => {
        const defined = fs.readdirSync(root).filter(f => /\.m?js$/.test(f)).some(f => /window\._wfInvalidateLocalStore\s*=/.test(read(f)));
        const called = fs.readdirSync(root).filter(f => /\.m?js$/.test(f)).some(f => /_wfInvalidateLocalStore\s*\(/.test(read(f)));
        expect(called && !defined).toBe(false);
    });
});
