/* =============================================================================
 * test/scan_window_test.js — the month range that was only ever a suggestion
 * -----------------------------------------------------------------------------
 * THE COMPLAINT: "I chose a month range for the historical scan and it fetched
 * everything anyway."
 *
 * The query was never the bug. Every window planWindows() builds carries
 * `after:` and `before:`, and the tests in mail_discovery_test.js pin that. The
 * bug is that NOTHING ON THIS SIDE HAD EVER CHECKED. The window was a request
 * sent to Gmail and then forgotten, so anything Gmail chose to return was
 * imported — and Gmail has two good reasons to return more than was asked for:
 *
 *   • `after:`/`before:` are DAY-granular and evaluated in the account's own
 *     timezone, while these bounds are UTC month edges. In Asia/Colombo that is
 *     a five-and-a-half hour disagreement at both ends of every window.
 *
 *   • a pageToken belongs to the search that minted it. A cursor carried across
 *     a depth change pages through a different month with nothing to notice.
 *
 * `internalDate` is the message's own receipt time, in milliseconds, from
 * Google. Comparing it to the window is what turns the range from something the
 * scan asks for into something that holds. These tests run the real handler
 * over a stub mailbox and assert on what was STORED, not on the URL that was
 * built — a test that only reads the query would have passed throughout the
 * entire life of this bug.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { windowFor } from '../gmail-scan.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';
const TOKEN = '1//0g' + 'A'.repeat(40);

/* Late August 2026, so window 0 is 2026-08-01 .. 2026-09-01 (UTC). */
const NOW = Date.parse('2026-08-28T10:00:00Z');
const AUG = Date.parse('2026-08-14T06:00:00Z');   // inside
const JUL = Date.parse('2026-07-30T23:30:00Z');   // one day before the window
const SEP = Date.parse('2026-09-01T00:30:00Z');   // half an hour after it

/** A message that would be imported on every count except its date. */
function message(id, landedMs) {
    const m = {
        id,
        payload: {
            headers: [
                { name: 'From', value: 'HNB Statements <no-reply@hnb.lk>' },
                { name: 'Subject', value: 'Your monthly e-Statement' },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@hnb.lk' },
            ],
            parts: [{
                filename: 'statement.pdf',
                mimeType: 'application/pdf',
                body: { attachmentId: 'a-' + id, size: 2048 },
            }],
        },
    };
    if (landedMs !== null) m.internalDate = String(landedMs);
    return m;
}

function stubGmail(byId, seenUrls) {
    return async (url) => {
        const u = String(url);
        seenUrls.push(u);
        if (u.includes('oauth2.googleapis.com/token')) {
            return { ok: true, status: 200, async json() { return { access_token: 'ya29.access' }; } };
        }
        if (u.includes('/messages?')) {
            return { ok: true, status: 200, async json() { return { messages: Object.keys(byId).map((id) => ({ id })) }; } };
        }
        if (/\/attachments\//.test(u)) {
            return { ok: true, status: 200, async json() { return { data: 'JVBERi0xLjQK' + 'QQ'.repeat(40) }; } };
        }
        const one = /\/messages\/([^/?]+)\?/.exec(u);
        if (one) {
            const m = byId[decodeURIComponent(one[1])];
            if (!m) return { ok: false, status: 404, async json() { return {}; } };
            return { ok: true, status: 200, async json() { return m; } };
        }
        throw new Error('unexpected call: ' + u);
    };
}

beforeEach(async () => {
    fake.reset();
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    fake.setVerifier(async (t) => {
        if (t !== 'good-token') throw new Error('invalid token');
        return { email: OWNER, email_verified: true, uid: 'u1' };
    });
    fake.docs.set('wf-mail/' + KEY, {
        refresh_token: TOKEN,
        email: OWNER,
        senders: [{ id: 'no-reply@hnb.lk', kind: 'address', domain: 'hnb.lk', name: 'HNB', status: 'approved', source: 'manual', addedMs: 1 }],
    });
    globalThis.fetch = async (i) => { throw new Error('network blocked in tests: ' + String(i)); };
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

async function scan(byId, body = {}) {
    const urls = [];
    const { default: handler } = await import('../gmail-scan.js');
    const seen = { status: null, body: undefined, urls };
    const res = {
        statusCode: 200,
        setHeader() { return res; },
        end(o) { seen.status = res.statusCode; try { seen.body = JSON.parse(o); } catch (_) { seen.body = o; } return res; },
    };
    await handler(
        { method: 'POST', url: '/api/gmail-scan', headers: { authorization: 'Bearer good-token' }, body: { months: 6, index: 0, now: NOW, ...body } },
        res,
        { env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' }, fetchImpl: stubGmail(byId, urls) },
    );
    return seen;
}

const itemKeys = () => [...fake.docs.keys()].filter((k) => k.startsWith('wf-mail/' + KEY + '/items/'));
const sendersOf = () => (fake.docs.get('wf-mail/' + KEY) || {}).senders || [];

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BOUNDS THEMSELVES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the window a scan is given', () => {
    it('carries real millisecond bounds, not just a Gmail query string', () => {
        const w = windowFor({ months: 6, index: 0, now: NOW, senders: ['from:hnb.lk'] });
        expect(w).toBeTruthy();
        expect(w.after).toBe(Date.UTC(2026, 7, 1));
        expect(w.before).toBe(Date.UTC(2026, 8, 1));
        /* Half-open, so the same instant cannot land in two windows. */
        expect(windowFor({ months: 6, index: 1, now: NOW, senders: ['from:hnb.lk'] }).before).toBe(w.after);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE FIX — the bound is enforced against what came back
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a scan imports the month it was asked for and no other', () => {
    it('THE BUG: mail from outside the chosen month is not stored', async () => {
        const seen = await scan({
            inside: message('inside', AUG),
            early: message('early', JUL),
            late: message('late', SEP),
        });
        expect(seen.status).toBe(200);
        const keys = itemKeys();
        expect(keys.some((k) => k.includes('inside')), 'the message in the chosen month was dropped').toBe(true);
        expect(keys.some((k) => k.includes('early')), 'July mail was imported into an August window').toBe(false);
        expect(keys.some((k) => k.includes('late')), 'September mail was imported into an August window').toBe(false);
        expect(seen.body.statements).toBe(1);
    });

    it('and it is not downloaded either — the refusal happens before the attachment', async () => {
        const seen = await scan({ early: message('early', JUL) });
        expect(seen.status).toBe(200);
        expect(seen.urls.some((u) => /\/attachments\//.test(u)),
            'an out-of-window attachment was fetched, spending quota on mail that is then thrown away').toBe(false);
    });

    it('an out-of-window message is not counted as a sighting either', async () => {
        /* A sender whose only mail in this window fell outside it has not been
         * seen in this window. Recording it would report recurrence that the
         * scan did not actually observe. */
        await scan({ early: message('early', JUL) });
        const hnb = sendersOf().find((e) => e.id === 'no-reply@hnb.lk');
        expect(hnb.months || []).not.toContain('2026-08');
    });

    it('SILENTLY — a message from another month is not a problem to report', async () => {
        /* It is not an error, not a skipped statement, and not something the
         * owner needs told. Putting it in `skipped` would fill the report with
         * noise on every single window and bury the refusals that matter. */
        const seen = await scan({ inside: message('inside', AUG), early: message('early', JUL) });
        const texts = (seen.body.skipped || []).map((s) => s.reason);
        expect(texts).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT MUST NOT DO — a filter that loses real statements is worse
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the enforcement is strict about dates it has, lenient about dates it does not', () => {
    it('a message with no internalDate is still imported', async () => {
        /* Google always sends one, but "always" is how a scan loses a
         * statement. An absent date is not evidence of being out of range, so
         * it is judged on the sender and the attachment like any other. */
        const seen = await scan({ nodate: message('nodate', null) });
        expect(seen.status).toBe(200);
        expect(itemKeys().some((k) => k.includes('nodate'))).toBe(true);
    });

    it('a malformed internalDate is treated as absent, not as out of range', async () => {
        const byId = { junk: message('junk', AUG) };
        byId.junk.internalDate = 'not-a-number';
        expect((await scan(byId)).status).toBe(200);
        expect(itemKeys().some((k) => k.includes('junk'))).toBe(true);
    });

    it('the boundaries themselves: the first millisecond is in, the last is out', async () => {
        /* Ids that are not prefixes of one another. The first draft used
         * `last` and `lastms`, and `includes('last')` matched both — the test
         * reported a bug in code that was correct. */
        const seen = await scan({
            opening: message('opening', Date.UTC(2026, 7, 1)),
            closing: message('closing', Date.UTC(2026, 8, 1) - 1),
            nextmonth: message('nextmonth', Date.UTC(2026, 8, 1)),
        });
        expect(seen.status).toBe(200);
        const keys = itemKeys();
        expect(keys.some((k) => k.includes('opening')), 'the window\'s first millisecond was excluded').toBe(true);
        expect(keys.some((k) => k.includes('closing')), 'the window\'s last millisecond was excluded').toBe(true);
        expect(keys.some((k) => k.includes('nextmonth')), 'the upper bound must be exclusive or a message lands in two windows').toBe(false);
    });
});
