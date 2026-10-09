import { describe, expect, it } from 'vitest';
import { firebaseStubSource } from './e2e/firebase-stub.mjs';

function loadStub() {
    const window = {};
    new Function('window', firebaseStubSource())(window);
    return window.firebase;
}

describe('the browser audit Firestore stub matches the transaction contract used by the app', () => {
    it('lets a document reference run a transaction through its owning Firestore instance', async () => {
        const firebase = loadStub();
        const db = firebase.firestore();
        const ref = db.collection('users').doc('audit-user');
        expect(ref.firestore).toBe(db);
        let ran = false;
        await ref.firestore.runTransaction(async (tx) => {
            ran = true;
            const snap = await tx.get(ref);
            expect(snap.exists).toBe(false);
        });
        expect(ran).toBe(true);
    });
});
