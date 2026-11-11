/* autonomy/shell-version.mjs — what version does the LIVE app shell say it is?
 *
 * Since the strict CSP (#583) the app page carries no inline script: its code is in
 * `/wealthflow-inline-index-<n>-<hash>.js` files the page loads. `WF_APP_VERSION` lives in one of
 * those files, so a probe that greps only the page HTML finds nothing and calls a healthy release
 * "not live" (Auto Release #257/#258 failed for exactly this reason). This reads the page AND the
 * inline files it loads, as a browser would.
 *
 *   node autonomy/shell-version.mjs https://www.wealthflow.lk/app   -> prints 7.69.81 (or nothing)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION_RE = /WF_APP_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/;
const INLINE_SRC_RE = /<script[^>]*\ssrc="(\/wealthflow-inline-index-[A-Za-z0-9-]+\.js)"/g;

/** The inline-script files an app page loads, in page order. */
export function inlineScriptPaths(html) {
    return [...String(html || '').matchAll(INLINE_SRC_RE)].map((m) => m[1]);
}

/** Page text plus the text of its inline script files. `get(url)` returns text or null. */
export async function shellText(base, get, query = '') {
    const b = String(base).replace(/\/+$/, '');
    const page = await get(`${b}/app${query}`);
    if (!page) return '';
    const parts = await Promise.all(inlineScriptPaths(page).map((p) => get(`${b}${p}`)));
    return [page, ...parts.filter(Boolean)].join('\n');
}

export function shellVersion(text) {
    const m = VERSION_RE.exec(String(text || ''));
    return m ? m[1] : null;
}

async function getText(url, ms = 20_000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
        const r = await fetch(url, { signal: ctl.signal, headers: { 'cache-control': 'no-cache' } });
        return r.ok ? await r.text() : null;
    } catch { return null; } finally { clearTimeout(t); }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const url = new URL(process.argv[2] || 'https://www.wealthflow.lk/app');
    const text = await shellText(url.origin, getText, url.search || `?_=${Date.now()}`);
    const v = shellVersion(text);
    if (v) process.stdout.write(v);
}
