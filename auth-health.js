/*  auth-health.js  →  GET /api/auth-health
 *  ---------------------------------------------------------------------------
 *  "Why can't I sign in with Google?" answered by the server, in one request.
 *
 *  WHY THIS EXISTS
 *  Sign-in with Google fails in a place nobody can see. The popup opens on
 *  wealthflow-6dffb.firebaseapp.com, Firebase's own page asks Google for a sign-in
 *  address, and when that step fails the popup simply closes. The browser gets an
 *  error code, the app used to put it in a toast that sits UNDER the sign-in
 *  screen, and the owner saw a blank window and nothing else. Every cause looks
 *  the same from the outside: a domain missing from Firebase's list, the Google
 *  provider switched off, the OAuth client behind it deleted, a redirect address
 *  the client does not list, the hosting page itself gone.
 *
 *  This endpoint asks each of those questions directly, from the server (which is
 *  not subject to the browser's CORS rules and can POST to Google's identity API),
 *  and answers with a plain list of what is wrong and what to change.
 *
 *  WHAT IT READS (all public, none of it is the owner's data)
 *    · Firebase's authorized-domains list for the project (GET, by the web API key,
 *      which is already in every page of the app).
 *    · The sign-in handler and iframe pages on the Firebase auth domain.
 *    · The sign-in address Firebase builds for Google (createAuthUri). That address
 *      names the OAuth client the Google provider is really using.
 *    · Google's own OAuth page for that client and for the app's Drive/Gmail
 *      client, to see whether Google still knows it ("The OAuth client was
 *      deleted", "redirect_uri_mismatch", or a normal sign-in page). Nothing is
 *      signed in and no account is touched: the request is the first hop of any
 *      sign-in, and Google answers it before a person is asked for anything.
 *
 *  WHAT IT NEVER DOES
 *    · It holds no secret, reads no Firestore, writes nothing. The OAuth client id
 *      is public (it is in every Google sign-in address); the client SECRET is
 *      reported only as set/not set.
 *    · It is GET/HEAD only and cached for 30 s, so repeated calls do not fan out.
 *
 *  RESPONSE  200 always (a diagnostic is not an outage):
 *    { ok, signInOk, time, hosts, firebase:{…}, oauth:{…}, problems:[{code,severity,scope,title,fix}] }
 *    ok is false when any problem is severity "critical"; signInOk only looks at
 *    the problems that stop Google sign-in itself (scope "signin"), so a deleted
 *    Drive client does not make the sign-in screen cry wolf.
 * ---------------------------------------------------------------------------
 */

import { fetchWithTimeout, fetchWithBodyDeadline } from './fetch-timeout.mjs';
import { DEFAULT_CLIENT_ID as DRIVE_DEFAULT_CLIENT_ID } from './drive-auth.js';

// Public web config of the Firebase project (the values of the firebaseConfig literal in
// index.html; test/auth_health_test.js asserts they stay equal). The web apiKey is
// deliberately NOT written here: it is a public identifier, but a credential-shaped
// literal in a server file would need an exception in the CI secret scan. It is read
// from FIREBASE_API_KEY (as statement-view.js does) or, failing that, from the page
// the app actually serves, which is also the truth about what a browser sends.
export const FIREBASE = Object.freeze({
    authDomain: 'wealthflow-6dffb.firebaseapp.com',
    projectId: 'wealthflow-6dffb'
});

// Hosts the app is served from; the request's own host is added to this list.
export const APP_HOSTS = Object.freeze(['www.wealthflow.lk', 'wealthflow.lk']);

const PROBE_MS = 4000;
const CACHE_MS = 30_000;
const UA = 'Mozilla/5.0 (compatible; WealthFlowAuthHealth/1.0)';

/* ---------------------------------------------------------------- pure helpers */

/** Firebase's own rule (handler.js): a host is authorized when it equals an entry
 *  of the list, or is a subdomain of one. */
export function isAuthorizedDomain(host, list) {
    const h = String(host || '').toLowerCase().trim();
    if (!h) return false;
    return (Array.isArray(list) ? list : []).some((d) => {
        const dom = String(d || '').toLowerCase().trim();
        return !!dom && (h === dom || h.endsWith('.' + dom));
    });
}

/** Hosts worth testing: the fixed production hosts plus whatever host asked.
 *  Anything that does not look like a hostname is dropped (the header is caller
 *  controlled). */
export function hostsToCheck(req) {
    const out = [];
    const add = (v) => {
        const h = String(v || '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
        if (/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) && !out.includes(h)) out.push(h);
    };
    APP_HOSTS.forEach(add);
    const hd = (req && req.headers) || {};
    add(hd['x-forwarded-host']);
    add(hd.host);
    return out;
}

/** The web apiKey inside the page's `const firebaseConfig = { … }` literal. */
export function apiKeyFromPage(html) {
    const m = String(html || '').match(/firebaseConfig\s*=\s*\{[^}]*?apiKey\s*:\s*["']([^"']+)["']/);
    return m ? m[1] : '';
}

/** Read the `authError` blob Google puts on its error page address. It is a
 *  base64url protobuf whose field 1 is a short code ("deleted_client") and field 2
 *  a sentence. Returns null when there is none or it cannot be read. */
export function decodeAuthError(location) {
    let blob = '';
    try { blob = new URL(String(location || ''), 'https://accounts.google.com').searchParams.get('authError') || ''; } catch (_) { return null; }
    if (!blob) return null;
    let buf;
    try { buf = Buffer.from(blob.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch (_) { return null; }
    const out = {};
    let i = 0;
    const varint = () => { let v = 0, s = 0; while (i < buf.length) { const b = buf[i++]; v += (b & 0x7f) * 2 ** s; if (!(b & 0x80)) return v; s += 7; } return v; };
    while (i < buf.length) {
        const tag = buf[i++];
        const field = tag >> 3, wire = tag & 7;
        if (wire === 2) {
            const len = varint();
            const str = buf.subarray(i, i + len).toString('utf8');
            i += len;
            if (field === 1) out.code = str;
            else if (field === 2) out.description = str;
        } else if (wire === 0) {
            varint();
        } else {
            break;
        }
    }
    return out.code ? out : null;
}

/** What Google's authorization endpoint said about a client. `status`/`location`
 *  are the first response (not followed). */
export function classifyOAuthResponse(status, location) {
    const loc = String(location || '');
    if (/\/signin\/oauth\/error/.test(loc)) {
        const e = decodeAuthError(loc) || {};
        const code = e.code || 'unknown_error';
        const state = code === 'deleted_client' ? 'deleted'
            : code === 'invalid_client' ? 'invalid'
            : code === 'redirect_uri_mismatch' ? 'redirect-mismatch'
            : 'error';
        return { state, code, description: e.description || '' };
    }
    if ((status >= 300 && status < 400 && loc) || status === 200) return { state: 'ok' };
    return { state: 'unknown', status: status || 0 };
}

/** The client id Google names in a sign-in address. */
export function clientIdFromAuthUri(authUri) {
    try { return new URL(String(authUri || '')).searchParams.get('client_id') || ''; } catch (_) { return ''; }
}

/** Identity Toolkit error text ("OPERATION_NOT_ALLOWED : …") → its code. */
export function toolkitErrorCode(message) {
    const m = String(message || '').match(/^[A-Z][A-Z0-9_]+/);
    return m ? m[0] : '';
}

/** Turn the raw findings into the list the owner acts on. Pure: no network. */
export function buildProblems(r) {
    const p = [];
    const handlerUri = `https://${FIREBASE.authDomain}/__/auth/handler`;
    // scope "signin": stops Google sign-in itself. scope "drive": only the Drive/Gmail
    // token client is affected; people can still sign in.
    const push = (code, severity, title, fix, scope = 'signin') => p.push({ code, severity, scope, title, fix });

    if (r.firebase.domains.error) {
        if (r.firebase.apiKeyFound !== false) push('domains-unreadable', 'warning',
            'Could not read the list of authorized domains from Firebase.',
            'Firebase console → Authentication → Settings → Authorized domains: check that www.wealthflow.lk (or wealthflow.lk) is listed.');
    } else {
        for (const h of r.firebase.domains.hosts) {
            if (!h.authorized) {
                push('domain-not-authorized', 'critical',
                    `${h.host} is not an authorized domain of the Firebase project, so Google sign-in is refused on it.`,
                    `Firebase console → Authentication → Settings → Authorized domains → Add domain → ${h.host}.`);
            }
        }
    }

    for (const k of ['handler', 'iframe']) {
        const c = r.firebase[k];
        if (c && c.status !== 200) {
            push(`auth-${k}-down`, 'critical',
                `The sign-in ${k} page on ${FIREBASE.authDomain} answered ${c.status || 'nothing'} instead of 200.`,
                `Firebase console → Hosting: the default site ${FIREBASE.authDomain} must be active (it serves /__/auth/*). An App Hosting backend or a custom Hosting release must not replace it.`);
        }
    }

    const prov = r.firebase.googleProvider;
    if (prov.error) {
        const code = prov.errorCode;
        if (code === 'NO_API_KEY') {
            push('api-key-unknown', 'warning',
                'The diagnostic could not find the Firebase web apiKey, so it could not ask Firebase anything.',
                'Set FIREBASE_API_KEY in Vercel (the same public value as apiKey in the firebaseConfig of index.html), or check that https://www.wealthflow.lk/ loads.');
        } else if (code === 'OPERATION_NOT_ALLOWED') {
            push('provider-disabled', 'critical',
                'The Google sign-in provider is switched off in Firebase.',
                'Firebase console → Authentication → Sign-in method → Google → Enable → Save.');
        } else if (code === 'CONFIGURATION_NOT_FOUND' || code === 'INVALID_PROVIDER_ID') {
            push('provider-not-configured', 'critical',
                'Firebase has no usable Google provider configuration.',
                'Firebase console → Authentication → Sign-in method → Google → set the support email, Enable, Save. If it was just re-enabled, wait a minute and retry.');
        } else if (/App ?Check/i.test(prov.error)) {
            push('app-check-enforced', 'critical',
                `Firebase App Check is enforced for Authentication, but the app sends no App Check token (Firebase says: ${prov.error}). Firebase therefore stops every Google sign-in before it reaches Google.`,
                'Firebase console → Build → App Check → APIs tab → Authentication → Unenforce (or Monitor) → Confirm. Enforce it again only after the app registers App Check (reCAPTCHA Enterprise) and ships the token.');
        } else if (/API_KEY|API key|referer|blocked/i.test(prov.error)) {
            push('api-key-refused', 'critical',
                `Google refused the web API key: ${prov.error}`,
                'Google Cloud console → APIs & Services → Credentials → the Browser key used by Firebase → Application restrictions must allow www.wealthflow.lk and wealthflow-6dffb.firebaseapp.com; API restrictions must include Identity Toolkit API.');
        } else {
            push('provider-error', 'critical',
                `Firebase could not start a Google sign-in: ${prov.error}`,
                'Firebase console → Authentication → Sign-in method → Google: open it, check it is enabled and its web client is valid, Save.');
        }
    }

    const pc = r.oauth.provider;
    if (pc && (pc.state === 'deleted' || pc.state === 'invalid')) {
        push('provider-client-deleted', 'critical',
            `The OAuth client behind Google sign-in (${pc.clientId}) ${pc.state === 'deleted' ? 'was deleted' : 'does not exist'} in Google Cloud. Google rejects every sign-in that uses it.`,
            'Google Cloud console (project wealthflow-6dffb) → APIs & Services → Credentials → "Restore deleted credentials" (a deleted client can be restored for 30 days). If it cannot be restored: Firebase console → Authentication → Sign-in method → Google → turn it off, Save, turn it on again, Save (Firebase creates a new client).');
    } else if (pc && pc.state === 'redirect-mismatch') {
        push('provider-redirect-mismatch', 'critical',
            `The OAuth client behind Google sign-in (${pc.clientId}) does not list ${handlerUri} as an authorized redirect URI.`,
            `Google Cloud console → APIs & Services → Credentials → that client → Authorized redirect URIs → add ${handlerUri} → Save.`);
    } else if (pc && (pc.state === 'error' || pc.state === 'unknown')) {
        push('provider-client-error', 'warning',
            `Google answered the provider client ${pc.clientId} with ${pc.code || 'status ' + pc.status}${pc.description ? ' (' + pc.description + ')' : ''}.`,
            'Google Cloud console → APIs & Services → OAuth consent screen / Credentials: check the client and the consent screen status.');
    }

    for (const c of r.oauth.serverClients) {
        if (c.state === 'deleted' || c.state === 'invalid') {
            push('server-client-deleted', 'critical',
                `The OAuth client ${c.clientId} (${c.uses.join(', ')}) ${c.state === 'deleted' ? 'was deleted' : 'does not exist'} in Google Cloud. ${c.uses.join(' and ')} cannot get tokens.`,
                'Google Cloud console → APIs & Services → Credentials → "Restore deleted credentials" (30 days). If it cannot be restored, create a new Web application client, then set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Vercel and reconnect Gmail in the app; the Drive client id in the page must be updated too.',
                'drive');
        }
    }
    return p;
}

/* ---------------------------------------------------------------- network */

async function getJson(url, init) {
    // the deadline keeps running while the body is read: a quiet upstream must not hold the endpoint
    const r = await fetchWithBodyDeadline(url, init, PROBE_MS);
    let body = null;
    try { body = await r.json(); } catch (_) { /* not JSON */ }
    return { status: r.status, body };
}

let knownKey = '';
/** The web apiKey: FIREBASE_API_KEY, else the page's own firebaseConfig (remembered for the life of the instance). */
async function resolveApiKey() {
    const env = String(process.env.FIREBASE_API_KEY || '').trim();
    if (env) return env;
    if (knownKey) return knownKey;
    try {
        const r = await fetchWithBodyDeadline(`https://${APP_HOSTS[0]}/`, { method: 'GET', headers: { 'user-agent': UA } }, 8000);
        if (r.status === 200) knownKey = apiKeyFromPage(await r.text());
    } catch (_) { /* reported as api-key-unknown */ }
    return knownKey;
}

async function pageStatus(url) {
    try {
        const r = await fetchWithTimeout(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA } }, PROBE_MS);
        return { status: r.status };
    } catch (e) {
        return { status: 0, error: String((e && e.message) || e).slice(0, 120) };
    }
}

async function probeOAuthClient(clientId, redirectUri, { responseType = 'code', scope = 'openid email' } = {}) {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: responseType, scope
    }).toString();
    try {
        const r = await fetchWithTimeout(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': UA } }, PROBE_MS);
        return { clientId, ...classifyOAuthResponse(r.status, r.headers.get('location')) };
    } catch (e) {
        return { clientId, state: 'unknown', status: 0, error: String((e && e.message) || e).slice(0, 120) };
    }
}

async function readAuthorizedDomains(apiKey) {
    try {
        const { status, body } = await getJson(
            `https://identitytoolkit.googleapis.com/v1/projects?key=${encodeURIComponent(apiKey)}`,
            { method: 'GET', headers: { 'user-agent': UA } });
        if (status === 200 && body && Array.isArray(body.authorizedDomains)) return { list: body.authorizedDomains };
        const msg = body && body.error && body.error.message;
        return { error: String(msg || `status ${status}`).slice(0, 200) };
    } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 200) };
    }
}

async function readGoogleProvider(apiKey) {
    try {
        const { status, body } = await getJson(
            `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${encodeURIComponent(apiKey)}`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'user-agent': UA },
                body: JSON.stringify({ providerId: 'google.com', continueUri: `https://${FIREBASE.authDomain}/__/auth/handler` })
            });
        const authUri = body && body.authUri;
        if (status === 200 && authUri) return { ok: true, clientId: clientIdFromAuthUri(authUri) };
        const msg = String((body && body.error && body.error.message) || `status ${status}`).slice(0, 200);
        return { ok: false, error: msg, errorCode: toolkitErrorCode(msg) };
    } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 200);
        return { ok: false, error: msg, errorCode: '' };
    }
}

async function collect(req) {
    const hosts = hostsToCheck(req);
    const handlerUri = `https://${FIREBASE.authDomain}/__/auth/handler`;
    const envClient = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();

    // Clients the server or the page use for Drive and Gmail tokens.
    const serverClients = new Map();
    const use = (id, label) => { if (!id) return; (serverClients.get(id) || serverClients.set(id, []).get(id)).push(label); };
    use(DRIVE_DEFAULT_CLIENT_ID, 'Google Drive (page)');
    use(envClient || DRIVE_DEFAULT_CLIENT_ID, envClient ? 'Gmail / Drive server' : 'Gmail / Drive server (default)');

    const apiKey = await resolveApiKey();
    const NOKEY = { error: 'the web apiKey could not be found (FIREBASE_API_KEY is unset and the page could not be read)' };
    const [domains, handler, iframe, provider, ...clientProbes] = await Promise.all([
        apiKey ? readAuthorizedDomains(apiKey) : NOKEY,
        pageStatus(handlerUri),
        pageStatus(`https://${FIREBASE.authDomain}/__/auth/iframe`),
        apiKey ? readGoogleProvider(apiKey) : { ok: false, error: NOKEY.error, errorCode: 'NO_API_KEY' },
        ...[...serverClients.keys()].map((id) =>
            probeOAuthClient(id, `https://${hosts[0] || APP_HOSTS[0]}/`, { responseType: 'token', scope: 'https://www.googleapis.com/auth/drive.file' }))
    ]);

    // The provider's own client can only be probed once createAuthUri has named it.
    let providerProbe = null;
    if (provider.ok && provider.clientId) providerProbe = { ...(await probeOAuthClient(provider.clientId, handlerUri)) };

    // A redirect mismatch is only a fault for the provider (it signs in through the
    // handler address). For the Drive/Gmail clients it just means the probe's own
    // address is not listed, which says the client exists.
    const serverList = [...serverClients.entries()].map(([id, uses], i) => {
        const pr = clientProbes[i];
        const state = pr.state === 'redirect-mismatch' ? 'ok' : pr.state;
        return { clientId: id, uses, state, code: pr.code, status: pr.status };
    });

    return {
        hosts,
        firebase: {
            authDomain: FIREBASE.authDomain,
            apiKeyFound: !!apiKey,
            domains: domains.error
                ? { error: domains.error, hosts: [] }
                : { list: domains.list, hosts: hosts.map((h) => ({ host: h, authorized: isAuthorizedDomain(h, domains.list) })) },
            handler,
            iframe,
            googleProvider: provider.ok
                ? { ok: true, clientId: provider.clientId }
                : { ok: false, error: provider.error, errorCode: provider.errorCode }
        },
        oauth: {
            provider: providerProbe,
            serverClients: serverList,
            serverClientSecretSet: !!String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
            serverClientFromEnv: !!envClient
        }
    };
}

let cache = { at: 0, body: null };

export default async function handler(req, res) {
    const method = (req && req.method) || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
        try { res.setHeader('Allow', 'GET, HEAD'); } catch (_) {}
        return res.status(405).json({ ok: false, error: 'method not allowed' });
    }
    try {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
    } catch (_) {}

    const now = Date.now();
    if (cache.body && now - cache.at < CACHE_MS) {
        return res.status(200).json({ ...cache.body, cached: true });
    }
    let body;
    try {
        const report = await collect(req);
        const problems = buildProblems(report);
        body = {
            ok: !problems.some((x) => x.severity === 'critical'),
            signInOk: !problems.some((x) => x.severity === 'critical' && x.scope === 'signin'),
            time: new Date(now).toISOString(),
            ...report,
            problems
        };
    } catch (e) {
        body = { ok: false, signInOk: null, time: new Date(now).toISOString(), error: String((e && e.message) || e).slice(0, 200), problems: [] };
    }
    // One structured line so the daily check can read it from the runtime log.
    try { console.log(JSON.stringify({ evt: 'auth-health', ok: body.ok, signInOk: body.signInOk, problems: (body.problems || []).map((x) => x.code) })); } catch (_) {}
    cache = { at: now, body };
    return res.status(200).json(body);
}
