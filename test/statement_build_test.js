import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build, rewriteImportsOnly, survivorsInImports } from '../build.mjs';

it('hashes repository-owned reader assets and reads a statement from the actual built tree', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wealthflow-statement-build-'));
    try {
        const files = await fs.readdir(process.cwd());
        for (const name of files.filter(name => /\.(?:js|mjs|json)$/.test(name) || ['index.html', '.vercelignore'].includes(name))) await fs.copyFile(name, path.join(root, name));
        await fs.symlink(path.join(process.cwd(), 'node_modules'), path.join(root, 'node_modules'), 'dir');
        await build({ root, write: true, log() {} });
        const reader = await import(pathToFileURL(path.join(root, 'statement-reader.mjs')).href);
        const html = '<html><body><p>Bank account statement</p><p>Opening balance 100.00</p><p>2026-09-01 SHOP 10.00 DR 90.00</p><p>Closing balance 90.00</p></body></html>';
        const result = await reader.readStatement({ bytes: Buffer.from(html), filename: 'statement.html', passwords: [] });
        expect(result.parsed.rows).toHaveLength(1);
        expect(result.parsed.rows[0].amount).toBe(10);
        expect(await fs.readFile(path.join(root, 'statement-reader.mjs'), 'utf8')).toMatch(/new URL\('\.\/wealthflow-statement-parser-[a-f0-9]{8}\.js'/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 20000);
it('detects asset URL references while leaving unrelated strings intact', () => {
    const map = new Map([['wealthflow-reader.js', 'wealthflow-reader-abcd1234.js']]);
    const text = "new URL('./wealthflow-reader.js', import.meta.url)";
    expect(rewriteImportsOnly(text, map)).toContain('wealthflow-reader-abcd1234.js');
    expect(survivorsInImports(text, [...map.keys()])).toEqual(['wealthflow-reader.js']);
    expect(rewriteImportsOnly("const prose = 'wealthflow-reader.js'", map)).toBe("const prose = 'wealthflow-reader.js'");
});
