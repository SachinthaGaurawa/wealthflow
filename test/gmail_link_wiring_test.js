/* =============================================================================
 * test/gmail_link_wiring_test.js
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS PINS WAS SHIPPED, AND I SHIPPED IT.
 *
 * The Statement Sync card asked whether a mailbox was connected by querying
 * wf-mail directly from the browser. firestore.rules closes with
 *
 *     match /{document=**} { allow read, write: if false; }
 *
 * and had no wf-mail entry, so that branch was sealed to every client — for
 * READS as much as writes. Every call was denied, caught by a try/catch, and
 * reported as "not connected". The card would have said that with a mailbox
 * perfectly connected, because it could never see the answer. The sync loop had
 * the same problem: it read the items subcollection the same way, so it could
 * never have fetched a statement either.
 *
 * Nothing threw where anyone would see it. The card looked truthful and was
 * structurally incapable of telling the truth.
 *
 * So this file asserts the page does not reach Firestore for wf-mail at all.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const endpoint = fs.readFileSync(path.join(ROOT, 'gmail-link.js'), 'utf8');
const router = fs.readFileSync(path.join(ROOT, 'api/router.js'), 'utf8');

function fn(name) {
    const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
    const m = decl.exec(html);
    if (!m) return '';
    const after = html.slice(m.index + m[0].length);
    const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
    return next < 0 ? html.slice(m.index) : html.slice(m.index, m.index + m[0].length + next);
}
const code = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the page never queries the sealed branch', () => {
    it('THE DEFECT: the connected check no longer reads Firestore', () => {
        const f = code(fn('_mailConnected'));
        expect(f, '_mailConnected not found').toBeTruthy();
        expect(f, 'still querying a branch no client may read')
            .not.toMatch(/firestore\(\)|collection\(/);
        expect(f).toContain("_gmailLink('GET')");
    });

    it('and neither does the sync loop', () => {
        const f = code(fn('runMailSync'));
        expect(f, 'the items subcollection is queried from the page again')
            .not.toMatch(/firestore\(\)\s*\n?\s*\.collection\(MAIL_ROOT\)|collection\('items'\)/);
        expect(f).toContain("_gmailLink('GET', null, '?items=1')");
    });

    it('sends the query in the URL, not as the HTTP method', () => {
        /* Written first as `_gmailLink('GET&items=1')`, which would have become
         * fetch(url, { method: 'GET&items=1' }) — not a method, and the request
         * would never have been made. */
        const helper = code(fn('_gmailLink'));
        expect(helper).toContain("fetch('/api/gmail-link' + (query || '')");
        expect(helper).toContain('method,');
    });

    it('authenticates with a Firebase ID token', () => {
        // Identity is the whole boundary once the Admin SDK bypasses rules.
        expect(fn('_gmailLink')).toContain('currentUser.getIdToken()');
        expect(fn('_gmailLink')).toContain("'Authorization': 'Bearer ' + token");
    });
});

describe('the sealed branch is sealed on purpose', () => {
    it('wf-mail is written out in the rules, not merely covered by default-deny', () => {
        /* It was already sealed by the catch-all. Writing it makes the sealing a
         * decision rather than an accident, so opening it later is deliberate. */
        expect(rules).toContain('match /wf-mail/{userKey}/{document=**}');
        const at = rules.indexOf('match /wf-mail/{userKey}/{document=**}');
        expect(rules.slice(at, at + 120)).toContain('allow read, write: if false;');
    });

    it('the default-deny is still there behind it', () => {
        expect(rules).toContain('match /{document=**}');
    });
});

describe('the endpoint is reachable and does what the page needs', () => {
    it('is routed', () => {
        expect(router).toContain("'gmail-link': () => import('../gmail-link.js')");
    });

    it('serves status, items, save and disconnect', () => {
        expect(endpoint).toContain("['GET', 'POST', 'DELETE'].includes(method)");
        expect(endpoint).toContain('items=1');
        expect(endpoint).toContain('linkRecord(who.email, token)');
    });

    it('derives the document from the verified identity, never the request', () => {
        /* THE BOUNDARY. The Admin SDK bypasses rules, so whatever document this
         * addresses is the one that gets read or written. */
        expect(endpoint).toContain('db.collection(MAIL_ROOT).doc(who.userKey)');
        expect(code(endpoint), 'the document key came from the request body')
            .not.toMatch(/doc\((?:body|req)\./);
    });

    it('never sends the token back, in any response', () => {
        const c = code(endpoint);
        expect(c).toContain('statusOf(');
        expect(c, 'a response reads the token field directly')
            .not.toMatch(/refresh_token:\s*(?:snap|doc|d)\./);
    });

    it('keeps historyId when disconnecting', () => {
        /* Deleting it would make the next connection re-import the entire
         * mailbox: to gmail-hook.js it means "already seen up to here". */
        const del = endpoint.slice(endpoint.indexOf("method === 'DELETE'"), endpoint.indexOf('const body = await readBody'));
        expect(del).toContain('refresh_token: admin.firestore.FieldValue.delete()');
        expect(del, 'the whole document is being deleted').not.toMatch(/ref\.delete\(\)/);
    });
});

describe('the card can say which piece is missing', () => {
    it('reports the unset variables rather than only "not connected"', () => {
        /* BOTH response paths. The status read and the save both return it, and
         * a mutation blanking only one survived a single toContain — the string
         * appears twice, so one surviving occurrence satisfied the assertion
         * while half the endpoint had stopped reporting. */
        const occurrences = (endpoint.match(/missing: missingConfig\(process\.env\)/g) || []).length;
        expect(occurrences, 'a response path stopped reporting the missing config').toBe(2);
        expect(fn('renderMailSync')).toContain('_mailStatus.missing');
    });

    it('offers a way in', () => {
        expect(html).toContain('openGmailLink()');
        expect(fn('openGmailLink')).toContain("_gmailLink('POST', { refresh_token:");
    });

    it('does not claim it can obtain the token itself', () => {
        /* Getting one needs a Google Cloud project, an OAuth client and a
         * consent flow. A "Connect" button that opened nothing would be the
         * same species of dishonesty as a pipeline described as live. */
        const f = fn('openGmailLink');
        expect(f).toContain('Paste the <b>refresh token</b>');
    });

    it('never puts the token into markup', () => {
        const f = fn('openGmailLink');
        expect(f, 'the token was interpolated into a value attribute')
            .not.toMatch(/value="\$\{[^}]*(?:tok|refresh)/i);
        expect(code(f)).not.toMatch(/console\.(log|warn|error)/);
    });
});
