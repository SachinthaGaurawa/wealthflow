export const OFFICIAL_ORIGIN = 'https://www.wealthflow.lk';
export const OFFICIAL_EMAIL = 'info@wealthflow.lk';

const LEGACY_VERCEL_HOSTS = new Set([
    'wealthflow-personal.vercel.app',
    'wealthflow-peach.vercel.app',
]);
const GITHUB_PAGES_HOST = 'sachinthagaurawa.github.io';
const GITHUB_PAGES_PREFIX = '/wealthflow';

const stringOf = (value) => String(value == null ? '' : value);

/** Return a safe public HTTPS origin, falling back to the official site. */
export function publicOrigin(env = process.env) {
    const raw = stringOf(env && env.WEALTHFLOW_PUBLIC_ORIGIN).trim();
    try {
        const url = new URL(raw);
        if (url.protocol === 'https:'
            && !url.username
            && !url.password
            && !url.search
            && !url.hash
            && (url.pathname === '/' || url.pathname === '')) {
            return url.origin;
        }
    } catch (_) { /* the official origin is the safe default */ }
    return OFFICIAL_ORIGIN;
}

/** Build an absolute public URL without making ordinary API fetches absolute. */
export function publicUrl(path = '/', env = process.env) {
    const value = stringOf(path).trim();
    const relative = value.startsWith('/') || value.startsWith('?') || value.startsWith('#')
        ? value
        : `/${value}`;
    return new URL(relative, `${publicOrigin(env)}/`).href;
}

/**
 * Upgrade a link issued by a former WealthFlow host. Unknown hosts and unsafe
 * credential-bearing URLs remain byte-for-byte unchanged.
 */
export function canonicalizeLegacyUrl(value) {
    const original = stringOf(value);
    let url;
    try { url = new URL(original); } catch (_) { return original; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return original;

    if (LEGACY_VERCEL_HOSTS.has(url.hostname)) {
        return `${OFFICIAL_ORIGIN}${url.pathname}${url.search}${url.hash}`;
    }

    if (url.hostname === GITHUB_PAGES_HOST
        && (url.pathname === GITHUB_PAGES_PREFIX || url.pathname.startsWith(`${GITHUB_PAGES_PREFIX}/`))) {
        const path = url.pathname.slice(GITHUB_PAGES_PREFIX.length) || '/';
        return `${OFFICIAL_ORIGIN}${path.startsWith('/') ? path : `/${path}`}${url.search}${url.hash}`;
    }

    return original;
}

export default {
    OFFICIAL_ORIGIN,
    OFFICIAL_EMAIL,
    publicOrigin,
    publicUrl,
    canonicalizeLegacyUrl,
};
