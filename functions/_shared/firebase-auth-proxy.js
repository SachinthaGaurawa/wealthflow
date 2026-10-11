const FIREBASE_HELPER_ORIGIN = 'https://wealthflow-6dffb.firebaseapp.com';

export async function proxyFirebaseHelper(request, namespace) {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith(namespace)) {
        return new Response('Not found', { status: 404 });
    }
    const upstream = new URL(incoming.pathname + incoming.search, FIREBASE_HELPER_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete('host');
    const upstreamRequest = new Request(upstream, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
    });
    const response = await fetch(upstreamRequest, { cf: { cacheEverything: false, cacheTtl: 0 } });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Cache-Control', 'private, no-store, max-age=0, must-revalidate');
    responseHeaders.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
}
