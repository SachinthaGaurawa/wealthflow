import { proxyFirebaseHelper } from '../../_shared/firebase-auth-proxy.js';

export function onRequest({ request }) {
    return proxyFirebaseHelper(request, '/__/firebase/');
}
