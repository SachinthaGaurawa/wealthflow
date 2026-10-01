import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* EVERY NAME A LOCAL MODULE IMPORTS IS A NAME ITS SOURCE EXPORTS.
 * The owner's diagnostics (2026-10-01, an iPhone, Settings open) recorded "Importing binding name 'CONSUMER_MAIL' is not found." — the
 * browser's message for a module that imports a name its neighbour does not export, which leaves the Senders screen dead until something
 * clears the old copy. wealthflow-sender-discovery.js has imported CONSUMER_MAIL from wealthflow-mail-ingest.mjs since 2026-09-11, and
 * that file only began to export it on 2026-09-28: for those seventeen days a build of the app could not link. build_test.js proves the
 * build is faithful to the source; nothing proved the SOURCE was linkable. This reads every shipped file, finds each
 * `import { a, b } from './local'` and holds the exporting file to it. */

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'test', 'dist', '.github']);

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out); else if (/\.m?js$/.test(entry.name)) out.push(full);
    }
    return out;
}
export function exportsOf(source) {
    const names = new Set();
    for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
    for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
    if (/export\s+default\b/.test(source)) names.add('default');
    if (/export\s*\*\s*from/.test(source)) names.add('*');
    return names;
}
export function importProblems(root = ROOT) {
    const problems = [];
    for (const file of walk(root)) {
        const source = fs.readFileSync(file, 'utf8');
        for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
            const target = path.resolve(path.dirname(file), m[2]);
            if (!fs.existsSync(target)) { problems.push(`${path.relative(root, file)} imports ${m[2]}, which does not exist`); continue; }
            const exported = exportsOf(fs.readFileSync(target, 'utf8'));
            if (exported.has('*')) continue;
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name && !exported.has(name)) problems.push(`${path.relative(root, file)} imports { ${name} } from ${m[2]}, which does not export it`);
            }
        }
    }
    return problems;
}

describe('the source is linkable', () => {
    it('every named import of a local module is a named export of it', () => {
        expect(importProblems()).toEqual([]);
    });
    it('the check itself sees a missing export (it is not vacuous)', () => {
        const dir = fs.mkdtempSync(path.join(fs.realpathSync(import.meta.dirname), '..', 'node_modules', '.wf-bind-'));
        try {
            fs.writeFileSync(path.join(dir, 'a.mjs'), "export const ONE = 1;\nexport function two() {}\n");
            fs.writeFileSync(path.join(dir, 'b.mjs'), "import { ONE, two, CONSUMER_MAIL } from './a.mjs';\nvoid [ONE, two, CONSUMER_MAIL];\n");
            fs.writeFileSync(path.join(dir, 'c.mjs'), "import { ONE } from './nope.mjs';\nvoid ONE;\n");
            const root = dir, found = [];
            for (const file of ['b.mjs', 'c.mjs']) {
                const source = fs.readFileSync(path.join(dir, file), 'utf8');
                for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
                    const target = path.resolve(root, m[2]);
                    if (!fs.existsSync(target)) { found.push('missing ' + m[2]); continue; }
                    const exported = exportsOf(fs.readFileSync(target, 'utf8'));
                    for (const part of m[1].split(',')) { const name = part.trim(); if (name && !exported.has(name)) found.push(name); }
                }
            }
            expect(found).toEqual(['CONSUMER_MAIL', 'missing ./nope.mjs']);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
});
