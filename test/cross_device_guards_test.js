// =============================================================================
// Same account, every device, one committed state: the guards that keep another account's books and a silent upload out of it.
// -----------------------------------------------------------------------------
// Owner, 2026-10-23: changes on one device must reach every device on the same Google account, and nothing may quietly revert. These tests pin the
// pieces that are not about speed: who owns the books on a device, what happens to an upload that never answers, how the live listener comes back,
// and that the database rules let only the owner read or write the account's data. The behaviour itself is proven in test/e2e/convergence.mjs
// and test/e2e/live-sync.mjs (real browsers, several devices, one cloud document).
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');

/** Source of a top-level function in index.html (8-space indent). */
const fnBody = (name) => {
    const a = HTML.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(a, `${name} is gone from index.html`).toBeGreaterThan(-1);
    const next = HTML.slice(a + 10).search(/\n {8}(?:async )?function |\n {8}\/\* [A-Z]/);
    return HTML.slice(a, next < 0 ? a + 6000 : a + 10 + next);
};

describe('the books on a device belong to one account', () => {
    const guard = fnBody('_wfAccountSwitched');

    it('records the account that signed in, and does nothing else the first time', () => {
        expect(guard).toMatch(/localStorage\.getItem\('wf_account_uid'\)/);
        expect(guard).toMatch(/if \(!prev\) _persistRaw\('wf_account_uid', uid\)/);
    });

    it('removes the previous account\'s books, stamps, queue and dirty flag when another account signs in', () => {
        expect(guard).toMatch(/\^wf2_/);                    // wf2_<every collection>, _kut, _kuf, _tomb, pendingCloudDeletes, isDirty
        expect(guard).toMatch(/ai_/);
        expect(guard).toMatch(/_persistRaw\('wf_account_uid', uid\);\s*return true/);
    });

    it('keeps the device\'s own identity, so removing the books does not create a new device', () => {
        expect(guard).not.toMatch(/device_id|device_token/);
    });

    it('runs before anything of the new account is wired: before the account document reference exists', () => {
        const at = HTML.indexOf('_wfAccountSwitched(user.uid)');
        const ref = HTML.indexOf("userDocRef = db.collection('users').doc(user.uid)", at);
        expect(at).toBeGreaterThan(-1);
        expect(ref).toBeGreaterThan(at);
        expect(HTML.slice(at, ref)).toMatch(/window\.location\.reload\(\); return;/);
    });

    it('signing out still clears everything, which also forgets the recorded account', () => {
        expect(fnBody('signOutGoogle')).toMatch(/_wfClearLocal\(\)/);
        const clear = fnBody('_wfClearLocal');
        expect(clear).toMatch(/localStorage\.clear\(\)/);
        // ...except what this device learned about its own connection: the mode and the offline-cache choice outlive a sign-out
        for (const k of ['wf_fs_transport', 'wf_fs_persist', 'wf_fs_repaired_at']) expect(clear).toContain(k);
    });
});

describe('an upload that never answers becomes an ordinary failure', () => {
    const sync = fnBody('syncToCloud');

    it('races the transaction against a deadline that fails with a network-kind code', () => {
        expect(sync).toMatch(/Promise\.race\(\[_push, new Promise/);
        expect(sync).toMatch(/code: 'deadline-exceeded'/);
        expect(sync).toMatch(/window\._wfPushDeadlineMs \|\| 30000/);
    });

    it('clears the timer when the push settles either way', () => {
        expect(sync).toMatch(/_push\.then\(\(\) => clearTimeout\(_deadline\), \(\) => clearTimeout\(_deadline\)\)/);
    });

    it('the failure path keeps the data dirty so it is retried', () => {
        expect(sync).toMatch(/Stay dirty/);
        expect(sync).toMatch(/_wfSyncFailed/);
    });
});

describe('the database rules: only the owner reaches the account\'s data', () => {
    /** The text of one `match` block, by its path line. */
    const block = (matchLine) => {
        const a = RULES.indexOf(matchLine);
        expect(a, `${matchLine} is gone from firestore.rules`).toBeGreaterThan(-1);
        let depth = 0, i = RULES.indexOf('{', a + matchLine.length - 1);
        const start = i;
        for (; i < RULES.length; i++) {
            if (RULES[i] === '{') depth++;
            else if (RULES[i] === '}') { depth--; if (!depth) break; }
        }
        return RULES.slice(start, i + 1);
    };
    const allowLines = (text) => text.split('\n').map((l) => l.trim()).filter((l) => /^allow /.test(l) || /^&&/.test(l));

    it('users/{uid} and everything under it is readable and writable only by that user', () => {
        const root = block('match /users/{uid} {');
        expect(root).toMatch(/allow read, write: if isOwner\(uid\)/);
        const sub = block('match /users/{uid}/{collection}/{document=**} {');
        expect(sub).toMatch(/allow read: if isOwner\(uid\)/);
        expect(sub).toMatch(/allow write: if isOwner\(uid\)/);
        expect(sub).not.toMatch(/if true|signedIn\(\)/);
    });

    it('the server-owned collections cannot be written from a browser', () => {
        const sub = block('match /users/{uid}/{collection}/{document=**} {');
        for (const c of ['smsLog', 'statementLedger', 'statementReview', 'statementLayouts', 'statementRegistry']) expect(sub).toContain(`'${c}'`);
    });

    it('the sync probe collection is not on that list, so the connection check can write it as the owner', () => {
        expect(block('match /users/{uid}/{collection}/{document=**} {')).not.toContain('syncProbe');
    });

    it('the AI memory is owner-only', () => {
        const ai = block('match /userAI/{uid}/{document=**} {');
        expect(ai).toMatch(/allow read, write: if isOwner\(uid\)/);
    });

    it('isOwner compares the signed-in uid with the path\'s uid, never a client-supplied field', () => {
        expect(RULES).toMatch(/function isOwner\(uid\) \{\s*return request\.auth != null && request\.auth\.uid == uid;/);
        for (const line of allowLines(block('match /users/{uid} {'))) expect(line).not.toMatch(/request\.resource\.data/);
    });

    it('the sealed server-only branches stay sealed', () => {
        for (const m of ['match /wf-inbox/', 'match /wf-mail/', 'match /wf-sms/']) {
            const a = RULES.indexOf(m);
            expect(a, m).toBeGreaterThan(-1);
            expect(RULES.slice(a, a + 400)).toMatch(/allow read, write: if false/);
        }
    });
});
