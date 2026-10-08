import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');

function run404(url) {
    const html = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
    const source = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
    const parsed = new URL(url);
    const replaced = [];
    const location = {
        hostname: parsed.hostname,
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
        replace(value) { replaced.push(value); },
    };
    vm.runInNewContext(source, { window: { location } });
    return { html, replaced };
}

describe('GitHub Pages custom 404 migration', () => {
    it('preserves a nested path, query and hash while removing only /wealthflow', () => {
        expect(run404('https://sachinthagaurawa.github.io/wealthflow/t/AbCdEfGhIjKlMnOp?lang=si#balance').replaced)
            .toEqual(['https://www.wealthflow.lk/t/AbCdEfGhIjKlMnOp?lang=si#balance']);
    });

    it('never turns an unrelated GitHub Pages project into a WealthFlow URL', () => {
        expect(run404('https://sachinthagaurawa.github.io/another-project/?x=1').replaced).toEqual([]);
    });

    it('provides an official-domain fallback for browsers without JavaScript', () => {
        expect(run404('https://sachinthagaurawa.github.io/wealthflow/missing').html)
            .toContain('https://www.wealthflow.lk');
    });
});
