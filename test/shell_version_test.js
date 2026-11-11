/* test/shell_version_test.js — the live-release check reads the app the way a browser does.
 *
 * Auto Release #257 and #258 went red although production served the new version: the check read
 * `WF_APP_VERSION` out of the /app HTML only, and since the strict CSP (#583) that line lives in an
 * inline-script FILE the page loads. The same blind spot made "Pipeline liveness" claim the shell was
 * unreadable. Both now go through autonomy/shell-version.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { shellText, shellVersion, inlineScriptPaths } from '../autonomy/shell-version.mjs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const PAGE = '<!doctype html><script src="/wealthflow-inline-index-0-ab12cd34.js"></script><script src="/wealthflow-inline-index-1-ef56ab78.js"></script><script src="/other.js"></script>';
const files = {
    'https://x.test/app?_=1': PAGE,
    'https://x.test/wealthflow-inline-index-0-ab12cd34.js': 'var a = 1;',
    'https://x.test/wealthflow-inline-index-1-ef56ab78.js': "var WF_APP_VERSION = '7.69.81'; window.WF_APP_VERSION = WF_APP_VERSION;",
};
const get = async (u) => files[u] ?? null;

describe('the shell version is found where the build put it', () => {
    it('lists only the page\'s own inline-script files, in order', () => {
        expect(inlineScriptPaths(PAGE)).toEqual(['/wealthflow-inline-index-0-ab12cd34.js', '/wealthflow-inline-index-1-ef56ab78.js']);
        expect(inlineScriptPaths('<script>var x</script>')).toEqual([]);
        expect(inlineScriptPaths(null)).toEqual([]);
    });
    it('reads the version from an inline-script file the page loads', async () => {
        expect(shellVersion(await shellText('https://x.test/', get, '?_=1'))).toBe('7.69.81');
    });
    it('still reads a page that carries the line itself (a build with WF_INLINE_SCRIPTS=keep)', async () => {
        const one = async (u) => (u.includes('/app') ? "<script>var WF_APP_VERSION = '7.1.2';</script>" : null);
        expect(shellVersion(await shellText('https://x.test', one, '?_=1'))).toBe('7.1.2');
    });
    it('says nothing when the page cannot be read, or has no version, instead of guessing', async () => {
        expect(await shellText('https://x.test', async () => null, '')).toBe('');
        expect(shellVersion('')).toBeNull();
        expect(shellVersion(await shellText('https://x.test', async (u) => (u.includes('/app') ? PAGE : 'nothing here'), '?_=1'))).toBeNull();
    });
    it('survives one inline file that fails to load', async () => {
        const partial = async (u) => (u.endsWith('ef56ab78.js') ? null : files[u] ?? null);
        expect(shellVersion(await shellText('https://x.test', partial, '?_=1'))).toBeNull();
    });
});

describe('every live-release check uses it', () => {
    it('the Auto Release "is it LIVE" step no longer greps the page HTML for the version', () => {
        const wf = read('.github/workflows/auto-release.yml');
        const step = wf.slice(wf.indexOf('- name: Confirm the new version is LIVE in production'));
        expect(step).toContain('node autonomy/shell-version.mjs');
        expect(step.slice(0, step.indexOf('# THE BROWSER CANARY'))).not.toMatch(/grep -o "WF_APP_VERSION/);
    });
    it('the pipeline-liveness probe reads the shell through the same helper', () => {
        const flow = read('autonomy/release-flow.mjs');
        expect(flow).toMatch(/import \{ shellText, shellVersion \} from '\.\/shell-version\.mjs'/);
        const live = flow.slice(flow.indexOf('export async function deployedFacts'), flow.indexOf('export function markdown'));
        expect(live).not.toMatch(/WF_APP_VERSION/);       // (the local-source read above it is a different thing)
    });
    it('the helper reads what the real build produces: the shipped page names a file that holds the version', async () => {
        // the built tree is made by `node build.mjs --write`; the source page keeps the line inline,
        // so here the source file stands in for the file the build extracts.
        const src = read('index.html');
        expect(shellVersion(src)).toMatch(/^\d+\.\d+\.\d+$/);
        expect(readdirSync(new URL('../', import.meta.url)).includes('wf-inline-extract.mjs')).toBe(true);
    });
});
