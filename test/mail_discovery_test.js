/* =============================================================================
 * test/mail_discovery_test.js — the banks that could never appear
 * -----------------------------------------------------------------------------
 * THE OWNER'S LOUDEST COMPLAINT, AND IT WAS NOT A PARSER BUG.
 *
 * "I have over 10 bank accounts, but the system is only fetching from 3 or 4."
 *
 * Once one sender is approved, the scan asks Gmail about THAT sender and nobody
 * else. For routine scanning that is exactly right — an unapproved sender is
 * never asked for, so no quota is spent, no attachment downloaded, no receipt
 * put on a screen. But it also means the mailbox is never asked about anyone
 * NEW. The three banks the owner happened to see got approved; the other seven
 * could not appear on the screen that offers senders to approve, because
 * nothing would ever ask about them again.
 *
 * A discovery run widens the QUESTION for one scan. It widens nothing that gets
 * stored: mail from an unapproved sender is still refused before an attachment
 * is fetched, and the run's only lasting effect is that the sender is listed
 * for the owner to decide about. Those two halves — wider question, unchanged
 * answer — are what these tests pin, because a discovery mode that also stored
 * would re-import the exact bills and receipts the sweep just cleared.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { windowFor } from '../gmail-scan.mjs';
import { STATEMENT_TERMS } from '../wealthflow-backfill.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const NOW = Date.parse('2026-08-28T10:00:00Z');

/* ═══════════════════════════════════════════════════════════════════════════
 * THE QUESTION THAT GETS ASKED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what a discovery window asks Gmail for', () => {
    const base = { months: 6, index: 0, now: NOW };

    it('THE TRAP: a routine scan with an approved sender asks about nobody else', () => {
        /* Not a bug — the reason receipts stopped arriving. It is also why a
         * bank the owner has not approved can never be seen, which is what
         * discovery exists for. */
        const q = windowFor({ ...base, senders: ['from:hnb.lk'] }).query;
        expect(q).toContain('from:hnb.lk');
        for (const t of STATEMENT_TERMS) expect(q).not.toContain(`"${t}"`);
    });

    it('a discovery scan asks a DIFFERENT question, not a wider version of the same one', () => {
        /* CHANGED DELIBERATELY, AND THIS TEST USED TO ASSERT THE OPPOSITE.
         *
         * It pinned `filename:pdf` and the statement vocabulary as still being
         * present in a discovery run, on the reasoning that discovery widens
         * WHO is asked about rather than how much of the mailbox is read. That
         * reasoning was wrong about what those two clauses do:
         *
         *   filename:pdf   a bank sending a password-protected ZIP, an .htm
         *                  attachment, or a PDF whose filename carries no
         *                  extension is not in the answer at all
         *   the vocabulary a subject reading "Monthly Account Summary" matches
         *                  none of the six phrases
         *
         * Neither is ranked low. Both are ABSENT, and the screen reports the
         * silence as "nothing found" — which is exactly the complaint that
         * produced this change: banks that could never appear, for a reason
         * nothing displayed. The narrowing moved to
         * wealthflow-sender-discovery.js, where it is done on evidence that can
         * be shown to the owner. */
        const q = windowFor({ ...base, senders: ['from:hnb.lk'], discover: true }).query;
        expect(q).toContain('has:attachment');
        expect(q).toContain('after:');
        expect(q).toContain('before:');
        expect(q).not.toContain('filename:pdf');
        expect(q).not.toContain('"statement"');
        /* Personal mailboxes are excluded in the query, using the same list
         * that already decides a sender is a person rather than an institution.
         * There is no second definition of that anywhere. */
        expect(q).toContain('-from:gmail.com');
    });

    it('the vocabulary carries no bill and no invoice, even in discovery', () => {
        /* Those two words were the direct cause of a screen full of utility
         * bills, and a discovery mode is exactly where they would come back. */
        const q = windowFor({ ...base, senders: ['from:hnb.lk'], discover: true }).query.toLowerCase();
        expect(q).not.toContain('"bill"');
        expect(q).not.toContain('"invoice"');
    });

    it('the default is unchanged for every existing caller', () => {
        const withList = windowFor({ ...base, senders: ['from:hnb.lk'] }).query;
        const explicit = windowFor({ ...base, senders: ['from:hnb.lk'], discover: null }).query;
        expect(explicit).toBe(withList);
        /* And with nobody approved it still discovers, because that is the only
         * way to find out what to approve. */
        expect(windowFor({ ...base, senders: [] }).query).toContain('"statement"');
    });

    it('a bad index or clock is still refused, discovery or not', () => {
        expect(windowFor({ months: 6, index: null, now: NOW, discover: true })).toBe(null);
        expect(windowFor({ months: 6, index: 0, now: 0, discover: true })).toBe(null);
        expect(windowFor({ months: 6, index: -1, now: NOW, discover: true })).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ANSWER THAT COMES BACK — the handler, run
 * ═══════════════════════════════════════════════════════════════════════════*/

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';
const TOKEN = '1//0g' + 'A'.repeat(40);
let calls;

function message(id, from, subject = 'Your monthly statement') {
    const domain = /@([^>]+)>?$/.exec(from)[1].replace(/>$/, '');
    return {
        id,
        internalDate: String(NOW - 86400000),
        payload: {
            headers: [
                { name: 'From', value: from },
                { name: 'Subject', value: subject },
                { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${domain}` },
            ],
            parts: [{ filename: 'statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a-' + id, size: 2048 } }],
        },
    };
}

function stubGmail(byId) {
    return async (url) => {
        const u = String(url);
        calls.push(u);
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
        throw new Error(`unexpected call: ${u}`);
    };
}

beforeEach(async () => {
    fake.reset();
    calls = [];
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    fake.setVerifier(async (t) => {
        if (t !== 'good-token') throw new Error('invalid token');
        return { email: OWNER, email_verified: true, uid: 'u1' };
    });
    globalThis.fetch = async (i) => { throw new Error(`network blocked in tests: ${String(i)}`); };
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

async function scan(body, byId) {
    const { default: handler } = await import('../gmail-scan.js');
    const seen = { status: null, body: undefined };
    const res = {
        statusCode: 200,
        setHeader() { return res; },
        end(o) { seen.status = res.statusCode; try { seen.body = JSON.parse(o); } catch (_) { seen.body = o; } return res; },
    };
    await handler(
        { method: 'POST', url: '/api/gmail-scan', headers: { authorization: 'Bearer good-token' }, body },
        res,
        { env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' }, fetchImpl: stubGmail(byId) },
    );
    return seen;
}

/** One approved bank, and the sender list stored the way the endpoint writes it. */
function connectWithApproved() {
    fake.docs.set(`wf-mail/${KEY}`, {
        refresh_token: TOKEN,
        email: OWNER,
        senders: [{ id: 'hnb.lk', kind: 'domain', domain: 'hnb.lk', name: 'HNB', status: 'approved', source: 'manual', addedMs: 1 }],
    });
}

const sendersOf = () => (fake.docs.get(`wf-mail/${KEY}`) || {}).senders || [];
const itemKeys = () => [...fake.docs.keys()].filter((k) => k.startsWith(`wf-mail/${KEY}/items/`));

describe('a discovery run lists the unknown bank without importing it', () => {
    const byId = {
        m1: message('m1', 'HNB Statements <no-reply@hnb.lk>'),
        m2: message('m2', 'Sampath e-Statements <estatement@sampath.lk>'),
    };

    it('THE FIX: the eleventh bank finally reaches the screen that approves senders', async () => {
        connectWithApproved();
        const seen = await scan({ months: 6, index: 0, now: NOW, discover: true }, byId);
        expect(seen.status).toBe(200);
        const list = sendersOf();
        const found = list.find((e) => e.id === 'sampath.lk');
        expect(found, 'the unapproved bank was not recorded — it can never be approved').toBeTruthy();
        expect(found.status).toBe('new');
        expect(seen.body.discovered).toBeGreaterThan(0);
    });

    it('AND NOTHING AT ALL IS STORED OR DOWNLOADED', async () => {
        /* STRONGER THAN IT USED TO BE, AND THIS TEST USED TO ASSERT LESS.
         *
         * It checked that the UNAPPROVED sender's attachment was not fetched,
         * while the approved one was imported by the same run. A discovery run
         * now reads `format=metadata` — from, subject, date, and no body — so
         * it cannot reach an attachment for anybody, approved or not. The old
         * rule was a policy decision taken per message; this is a property of
         * what was requested from Gmail.
         *
         * The cost is real and is stated rather than hidden: pressing "find my
         * banks" no longer imports anything. Importing is what the ordinary
         * scan does, and it does it with the sender list this run just filled
         * in. */
        connectWithApproved();
        await scan({ months: 6, index: 0, now: NOW, discover: true }, byId);
        expect(itemKeys().length).toBe(0);
        expect(calls.some((u) => /\/attachments\//.test(u)),
            'a discovery run downloaded an attachment').toBe(false);
        expect(calls.some((u) => /format=full/.test(u)),
            'a discovery run asked for a message body').toBe(false);
        expect(calls.some((u) => /format=metadata/.test(u)),
            'a discovery run should read headers only').toBe(true);
    });

    it('and it still sees BOTH senders, which is the point of reading headers', async () => {
        connectWithApproved();
        await scan({ months: 6, index: 0, now: NOW, discover: true }, byId);
        const ids = sendersOf().map((e) => e.id);
        expect(ids).toContain('hnb.lk');
        expect(ids).toContain('sampath.lk');
    });

    it('a routine scan does not even ask about the unknown bank', async () => {
        connectWithApproved();
        await scan({ months: 6, index: 0, now: NOW }, byId);
        const listed = calls.find((u) => u.includes('/messages?'));
        expect(decodeURIComponent(listed)).toContain('from:hnb.lk');
        expect(decodeURIComponent(listed)).not.toContain('"statement"');
    });

    it('a sender already blocked stays blocked — discovery does not undo a decision', async () => {
        fake.docs.set(`wf-mail/${KEY}`, {
            refresh_token: TOKEN,
            email: OWNER,
            senders: [
                { id: 'hnb.lk', kind: 'domain', domain: 'hnb.lk', name: 'HNB', status: 'approved', source: 'manual', addedMs: 1 },
                { id: 'sampath.lk', kind: 'domain', domain: 'sampath.lk', name: 'Sampath', status: 'blocked', source: 'manual', addedMs: 1 },
            ],
        });
        await scan({ months: 6, index: 0, now: NOW, discover: true }, byId);
        expect(sendersOf().find((e) => e.id === 'sampath.lk').status).toBe('blocked');
        /* Nothing is stored by a discovery run at all now — see the test above.
         * A blocked sender staying blocked is still the assertion that matters:
         * a run that went looking must never undo a decision. */
        expect(itemKeys().length).toBe(0);
    });

    it('the caller can widen the question and nothing else', async () => {
        /* Anything else accepted from the request would be a caller-shaped
         * query against a credential that can read a whole mailbox. */
        connectWithApproved();
        await scan({ months: 6, index: 0, now: NOW, discover: true, q: 'from:anyone.example', query: 'x' }, byId);
        const listed = decodeURIComponent(calls.find((u) => u.includes('/messages?')));
        expect(listed).not.toContain('anyone.example');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SOMETHING CALLS IT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the owner can reach it', () => {
    function fn(name) {
        const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
        const m = decl.exec(HTML);
        if (!m) return '';
        const after = HTML.slice(m.index + m[0].length);
        const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
        return next < 0 ? HTML.slice(m.index) : HTML.slice(m.index, m.index + m[0].length + next);
    }

    it('there is a button on the senders screen, and it is wired', () => {
        /* This repository's most repeated defect is a facility built and wired
         * to nobody. The endpoint accepts a discovery flag; without this line
         * nothing would ever send one. */
        const render = fn('renderSenderList');
        expect(render).toContain('_sl_find');
        expect(render).toMatch(/#_sl_find[\s\S]{0,200}runSenderDiscovery\(\)/);
    });

    it('it sends the flag the endpoint reads', () => {
        expect(fn('runSenderDiscovery')).toContain('discover: true');
    });

    it('IT DOES NOT CLOBBER THE HISTORICAL SCAN’S POSITION', () => {
        /* That cursor is a position in a long job the owner can resume.
         * Writing this six-month walk over it would send that job back to
         * whichever month this one reached. */
        const body = fn('runSenderDiscovery');
        expect(body).not.toContain('_saveScanCursor');
        expect(body).toContain('startCursor');
    });

    it('it is bounded — this is somebody’s Gmail quota', () => {
        const body = fn('runSenderDiscovery');
        expect(body).toContain('DISCOVERY_MAX_CALLS');
        expect(HTML).toMatch(/const DISCOVERY_MAX_CALLS = \d+;/);
        expect(HTML).toMatch(/const DISCOVERY_MONTHS = \d+;/);
    });

    it('it re-reads the list from the server instead of patching it', () => {
        expect(fn('runSenderDiscovery')).toContain('_sendersLoad()');
    });

    it('it says what it will not do, on the screen', () => {
        expect(fn('renderSenderList')).toContain('refused before it is even downloaded');
    });
});
