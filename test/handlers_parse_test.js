// Every function Vercel serves must PARSE under plain Node. Vitest transforms modules and does not raise a duplicate
// `import { x }` (a SyntaxError in Node), so a test that only imports or regex-matches a file can pass while the
// deployed function fails to load. This runs `node --check` on each one, the way the runtime reads it.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const routerSrc = fs.readFileSync('api/router.js', 'utf8');
const routed = [...routerSrc.matchAll(/import\('\.\.\/([^']+)'\)/g)].map((m) => m[1]);
const direct = fs.readdirSync('api').filter((f) => /\.(m?js)$/.test(f)).map((f) => 'api/' + f);
const shared = fs.readdirSync('.').filter((f) => /^wf-.*\.mjs$/.test(f));
const files = [...new Set([...direct, ...routed, ...shared])].filter((f) => fs.existsSync(f));

describe('every served function parses under Node', () => {
    it('finds the handlers it is meant to check', () => {
        expect(files).toContain('api/ai.js');
        expect(files).toContain('api/router.js');
        expect(files).toContain('wf-api-guard.mjs');
        expect(files.length).toBeGreaterThan(40);
    });
    for (const f of files) {
        it(f, () => {
            const r = spawnSync(process.execPath, ['--check', path.resolve(f)], { encoding: 'utf8' });
            expect(r.stderr || '', f).toBe('');
            expect(r.status, f).toBe(0);
        });
    }
});
