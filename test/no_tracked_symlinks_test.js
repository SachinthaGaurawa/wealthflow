/** A symlink committed to the repository points at a path that exists on one machine only. #409 committed
 * `node_modules -> /home/user/wealthflow/node_modules`, so the GitHub Pages (Jekyll) build failed with
 * "No such file or directory - /github/workspace/node_modules" and every later commit on main showed a red X.
 * Nothing in this repository needs a symlink, so none may be tracked. */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

describe('no symlink is committed', () => {
    it('git tracks no mode-120000 entry', () => {
        const rows = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
        const links = rows.filter((r) => r.startsWith('120000 ')).map((r) => r.split('\t')[1]);
        expect(links, `tracked symlinks break the Pages build: ${links.join(', ')}`).toEqual([]);
    });
    it('.gitignore ignores node_modules even when it is a symlink (no trailing slash)', () => {
        const lines = fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
        expect(lines).toContain('node_modules');
    });
});
