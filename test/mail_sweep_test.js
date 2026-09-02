/* =============================================================================
 * test/mail_sweep_test.js — clearing what the keyword search left behind
 * -----------------------------------------------------------------------------
 * THE DEFECT, FOR THE THIRD TIME IN THIS PIPELINE: a change that fixed future
 * writes and was presented as a repair of what is on the screen.
 *
 * The sender list stopped bills and receipts being FETCHED. It removed none of
 * the ones already stored, and it could not even label them: the manifest's
 * `known` flag is written when a statement arrives, so
 *
 *   - every document collected before the list existed has NO flag at all, and
 *     an absent flag reads as known — so a receipt drew, and was opened,
 *     parsed and offered for filing, exactly like a confirmed bank's statement;
 *   - blocking a sender today changed nothing about the mail it already sent.
 *
 * So the verdict is recomputed on every listing, against the list as it stands,
 * and the card can offer to clear what the owner has not approved.
 *
 * WHAT THESE TESTS PIN, AND WHY THEY RUN THE CODE
 *
 * The endpoint half is EXECUTED against the in-memory Admin SDK, with the
 * network hard-blocked. The device half is EXECUTED too — the real functions,
 * lifted out of index.html — because the dangerous behaviour here is not what
 * the source says but which keys actually reach a delete request. This deletes
 * someone's documents; a source-shaped test would not have caught a sweep that
 * quietly included the statements it was meant to leave alone.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 1 — THE ENDPOINT, RUN
 * ═══════════════════════════════════════════════════════════════════════════*/

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';
const ITEMS = `wf-mail/${KEY}/items`;

beforeEach(async () => {
    fake.reset();
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    fake.setVerifier(async (t) => {
        if (t !== 'good-token') throw new Error('invalid token');
        return { email: OWNER, email_verified: true, uid: 'uid-1' };
    });
    globalThis.fetch = async (input, init) => {
        throw new Error(`network blocked in tests: ${String((init && init.method) || 'GET')} ${String(input)}`);
    };
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

function mkRes() {
    const seen = { status: null, body: undefined, ended: false };
    const res = {
        statusCode: 200,
        setHeader() { return res; },
        end(o) {
            seen.status = res.statusCode;
            try { seen.body = o === undefined ? undefined : JSON.parse(o); } catch (_) { seen.body = o; }
            seen.ended = true;
            return res;
        },
    };
    return { res, seen };
}

async function call({ method = 'GET', token = 'good-token', body, url = '/api/gmail-link' } = {}) {
    const { default: handler } = await import('../gmail-link.js');
    const { res, seen } = mkRes();
    await handler({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
    return seen;
}

/** Put a statement in the store, the way gmail-hook.js would have. */
function store(id, manifest) {
    fake.docs.set(`${ITEMS}/${id}`, { filename: id + '.pdf', parts: 0, d: 'x', ...manifest });
}

/** Add a sender through the real endpoint, so the stored shape is the real one. */
const addSender = (value, status) =>
    call({ method: 'POST', url: '/api/gmail-link?senders=1', body: { action: 'add', value, status } });

const list = () => call({ method: 'GET', url: '/api/gmail-link?items=1' });
const byId = (body, id) => (body.items || []).find((i) => i.id === id);

describe('the listing decides against the list as it is NOW', () => {
    it('an approved sender’s statement comes back approved', async () => {
        await addSender('statements@hnb.lk', 'approved');
        store('a1', { bank: 'HNB', from: 'HNB <statements@hnb.lk>' });
        const seen = await list();
        expect(seen.status).toBe(200);
        expect(seen.body.decided).toBe(true);
        expect(byId(seen.body, 'a1').sender.verdict).toBe('approved');
    });

    it('A SENDER BLOCKED AFTER THE FACT is blocked now, though the manifest says known', async () => {
        /* The regression this closes: the flag was written when the statement
         * arrived, so a block could never reach the mail already stored. */
        store('b1', { bank: 'Utility', from: 'billing@utility.example', known: true });
        await addSender('hnb.lk', 'approved');
        await addSender('utility.example', 'blocked');
        const seen = await list();
        expect(byId(seen.body, 'b1').sender.verdict).toBe('blocked');
    });

    it('A DOCUMENT STORED BEFORE THE FLAG EXISTED is judged by its sender, not by its silence', async () => {
        /* The owner's actual complaint. No `known` field at all — written by a
         * keyword search months before any list existed — and it used to draw
         * exactly like a confirmed bank's statement. */
        await addSender('hnb.lk', 'approved');
        store('c1', { bank: 'Shop', from: 'receipts@shop.example' });
        const seen = await list();
        expect(byId(seen.body, 'c1').sender.verdict).toBe('new');
    });

    it('NO SENDER RECORDED IS NOT AN ANSWER OF "STRANGER"', async () => {
        /* Documents older still carry no From either. Reading absence as
         * refusal would offer a real bank's statement up for deletion. */
        await addSender('hnb.lk', 'approved');
        store('d1', { bank: 'HNB' });
        const seen = await list();
        expect(byId(seen.body, 'd1').sender.verdict).toBe('unrecorded');
    });

    it('with nobody approved yet, the verdicts are declared meaningless', async () => {
        /* Every sender is equally undecided, the scanner is still guessing by
         * keyword, and calling a statement "not on your list" would blame the
         * owner for a list they have not been asked to make. */
        store('e1', { bank: 'Shop', from: 'receipts@shop.example' });
        const seen = await list();
        expect(seen.body.decided).toBe(false);
        expect(seen.body.approvedCount).toBe(0);
    });

    it('a blocked-only list is still not "decided" — nothing has been approved', async () => {
        await addSender('shop.example', 'blocked');
        store('f1', { bank: 'Shop', from: 'receipts@shop.example' });
        const seen = await list();
        expect(seen.body.decided).toBe(false);
    });

    it('the address is reported, never the display name the sender chose', async () => {
        await addSender('hnb.lk', 'approved');
        store('g1', { bank: 'HNB', from: '"Your Bank <security@evil.example>" <statements@hnb.lk>' });
        const s = byId((await list()).body, 'g1').sender;
        expect(s.address).toBe('statements@hnb.lk');
    });

    it('deciding writes NOTHING — the manifest is read, never rewritten', async () => {
        await addSender('hnb.lk', 'approved');
        store('h1', { bank: 'Shop', from: 'receipts@shop.example' });
        const before = { ...fake.docs.get(`${ITEMS}/h1`) };
        fake.ops.length = 0;
        await list();
        expect(fake.ops.filter((o) => o.op === 'set' || o.op === 'delete')).toEqual([]);
        expect(fake.docs.get(`${ITEMS}/h1`)).toEqual(before);
    });

    it('an unreadable sender list is not an empty one', async () => {
        /* It must leave `decided` false — the answer that makes the device fall
         * back to the stored flag and offer nothing for removal. A read that
         * failed must never present itself as "none of these are yours". */
        await addSender('hnb.lk', 'approved');
        store('i1', { bank: 'Shop', from: 'receipts@shop.example' });
        fake.setFailOn((p, op) => (p === `wf-mail/${KEY}` && op === 'get' ? new Error('unreachable') : null));
        const seen = await list();
        expect(seen.status).toBe(200);
        expect(seen.body.decided).toBe(false);
    });

    it('a filed statement stays out of the listing whatever its sender says', async () => {
        await addSender('hnb.lk', 'approved');
        store('j1', { bank: 'Shop', from: 'receipts@shop.example', filed: true });
        const seen = await list();
        expect(byId(seen.body, 'j1')).toBeUndefined();
        expect(seen.body.filed).toBe(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 2 — THE DEVICE, RUN
 * ═══════════════════════════════════════════════════════════════════════════*/

/** Source of a top-level block, by brace matching from a literal start marker. */
function blockAt(marker) {
    const start = HTML.indexOf(marker);
    expect(start, `"${marker}" is gone from index.html — retarget this test`).toBeGreaterThan(-1);
    let i = HTML.indexOf('{', start), depth = 0, q = null, j = i;
    for (; j < HTML.length; j++) {
        const c = HTML[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && HTML[j + 1] === '/') { j = HTML.indexOf('\n', j); continue; }
        if (c === '/' && HTML[j + 1] === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    expect(depth, `could not brace-match "${marker}"`).toBe(0);
    return HTML.slice(start, j + 1);
}

function constAt(re, what) {
    const m = HTML.match(re);
    expect(m, `${what} is gone from index.html — retarget this test`).toBeTruthy();
    return m[0];
}

/**
 * The real sweep, in one scope, over a fake endpoint.
 *
 * Nothing about the decision is stubbed: _mailVerdict, _mailKnownNow,
 * _mailSweepable and _mailSweepUnapproved are the shipped source. What is
 * replaced is only the browser around them — the confirmation, the toast and
 * the HTTP call — and each of those is recorded so the test can assert on the
 * ORDER as well as the content.
 */
function loadSweep(state) {
    const calls = [];
    const notes = [];
    const asked = [];
    let confirmCb = null;
    const src = [
        blockAt('function _mailFromLabel(from)'),
        constAt(/const _MAIL_VERDICTS = \[[^\]]*\];/, '_MAIL_VERDICTS'),
        blockAt('function _mailVerdict(d, decided)'),
        blockAt('function _mailKnownNow(d, decided)'),
        blockAt('function _mailSweepable()'),
        blockAt('function _mailSweepGroups(list)'),
        constAt(/const MAIL_DELETE_CHUNK = \d+;/, 'MAIL_DELETE_CHUNK'),
        blockAt('async function _mailSweepUnapproved()'),
    ].join('\n');
    const api = new Function(
        '_mailSyncState', 'showConfirm', 'notify', '_gmailLink', 'runMailSync',
        src + '; return { _mailVerdict, _mailKnownNow, _mailSweepable, _mailSweepGroups,'
        + ' _mailSweepUnapproved, MAIL_DELETE_CHUNK };',
    )(
        state,
        (icon, title, detail, cls, label, cb) => { asked.push({ icon, title, detail, cls, label }); confirmCb = cb; },
        (msg, kind) => notes.push({ msg, kind }),
        async (method, body, query) => {
            calls.push({ method, body, query });
            const keys = (body && body.keys) || [];
            return { status: 200, body: { ok: true, deleted: keys.length, failed: [] } };
        },
        () => { calls.push({ method: 'RERUN' }); },
    );
    return { api, calls, notes, asked, confirm: () => confirmCb && confirmCb() };
}

/** One listed row, as runMailSync builds it. */
const row = (key, verdict, from) => ({ key, verdict, from, bank: 'Someone', stage: 'waiting' });

describe('what the device does with the verdict', () => {
    it('an approved sender is known; blocked and unlisted are not', () => {
        const { api } = loadSweep({ decided: true, items: [] });
        const of = (v) => api._mailKnownNow({ manifest: {}, sender: { verdict: v } }, true);
        expect(of('approved')).toBe(true);
        expect(of('blocked')).toBe(false);
        expect(of('new')).toBe(false);
    });

    it('A LEGACY DOCUMENT IS NOT ACCUSED BY ITS SILENCE', () => {
        /* No stored flag, no sender recorded, a full list. If this ever
         * answers false, every statement stored before the flag existed turns
         * into "not on your sender list" on upgrade — and stops being read. */
        const { api } = loadSweep({ decided: true, items: [] });
        expect(api._mailKnownNow({ manifest: { bank: 'HNB' }, sender: { verdict: 'unrecorded' } }, true)).toBe(true);
    });

    it('the stored flag still decides when the list cannot', () => {
        const { api } = loadSweep({ decided: false, items: [] });
        expect(api._mailKnownNow({ manifest: { known: false }, sender: { verdict: 'approved' } }, false)).toBe(false);
        expect(api._mailKnownNow({ manifest: { known: true }, sender: { verdict: 'new' } }, false)).toBe(true);
    });

    it('a verdict the server did not send is no verdict at all', () => {
        const { api } = loadSweep({ decided: true, items: [] });
        expect(api._mailVerdict({ manifest: {} }, true)).toBe('');
        expect(api._mailVerdict({ manifest: {}, sender: { verdict: 'nonsense' } }, true)).toBe('');
    });
});

describe('the sweep removes what the owner refused, and nothing else', () => {
    const mixed = () => ({
        decided: true,
        stage: 'idle',
        items: [
            row('k-app', 'approved', 'statements@hnb.lk'),
            row('k-blk', 'blocked', 'billing@utility.example'),
            row('k-new', 'new', 'receipts@shop.example'),
            row('k-old', '', ''),                 // stored before the From header was kept
        ],
    });

    it('only the blocked and the unapproved are offered', () => {
        const { api } = loadSweep(mixed());
        expect(api._mailSweepable().map((i) => i.key)).toEqual(['k-blk', 'k-new']);
    });

    it('NOTHING is offered while the owner has approved nobody', () => {
        const s = mixed(); s.decided = false;
        const { api } = loadSweep(s);
        expect(api._mailSweepable()).toEqual([]);
    });

    it('IT ASKS BEFORE IT DELETES', async () => {
        const { api, calls, asked, confirm } = loadSweep(mixed());
        await api._mailSweepUnapproved();
        expect(calls).toEqual([]);                       // nothing has happened yet
        expect(asked.length).toBe(1);
        expect(asked[0].cls).toBe('btn-danger');
        expect(asked[0].title).toContain('2');
        await confirm();
        expect(calls.filter((c) => c.method === 'POST').length).toBe(1);
    });

    it('the confirmation names the senders and the counts', async () => {
        const s = mixed();
        s.items.push(row('k-new2', 'new', 'receipts@shop.example'));
        const { api, asked } = loadSweep(s);
        await api._mailSweepUnapproved();
        expect(asked[0].detail).toContain('receipts@shop.example (2)');
        expect(asked[0].detail).toContain('billing@utility.example (1)');
        /* And says the way back, because it is true: the mail is still in
         * Gmail, and approving the sender re-fetches it. */
        expect(asked[0].detail).toMatch(/Gmail/);
    });

    it('the request names its keys — it never asks the server to match a rule', async () => {
        const { api, calls, confirm } = loadSweep(mixed());
        await api._mailSweepUnapproved();
        await confirm();
        const post = calls.find((c) => c.method === 'POST');
        expect(post.query).toBe('?items=1');
        expect(post.body.action).toBe('delete');
        expect(post.body.keys).toEqual(['k-blk', 'k-new']);
        /* A pattern, a verdict or a sender name in the request body is a
         * delete-by-rule evaluated server-side. One bad rule ends someone's
         * statement history. */
        expect(Object.keys(post.body).sort()).toEqual(['action', 'keys']);
    });

    it('THE APPROVED AND THE UNATTRIBUTED ARE NEVER IN THE REQUEST', async () => {
        const { api, calls, confirm } = loadSweep(mixed());
        await api._mailSweepUnapproved();
        await confirm();
        const sent = calls.filter((c) => c.method === 'POST').flatMap((c) => c.body.keys);
        expect(sent).not.toContain('k-app');
        expect(sent).not.toContain('k-old');
    });

    it('a long sweep is chunked, and every key is sent exactly once', async () => {
        const many = { decided: true, items: [] };
        for (let i = 0; i < 450; i += 1) many.items.push(row('m' + i, 'new', 'receipts@shop.example'));
        const { api, calls, confirm } = loadSweep(many);
        await api._mailSweepUnapproved();
        await confirm();
        const posts = calls.filter((c) => c.method === 'POST');
        expect(posts.length).toBe(3);
        for (const p of posts) expect(p.body.keys.length).toBeLessThanOrEqual(api.MAIL_DELETE_CHUNK);
        const sent = posts.flatMap((p) => p.body.keys);
        expect(sent.length).toBe(450);
        expect(new Set(sent).size).toBe(450);
    });

    it('the chunk fits inside the server’s own ceiling', () => {
        const src = fs.readFileSync(path.join(ROOT, 'gmail-link.js'), 'utf8');
        const cap = Number(/ITEMS_DELETE_MAX = (\d+)/.exec(src)[1]);
        const { api } = loadSweep({ decided: true, items: [] });
        /* A chunk larger than the cap would have its tail silently dropped —
         * the rows would come back on the next refresh and the button would
         * look broken. */
        expect(api.MAIL_DELETE_CHUNK).toBeLessThanOrEqual(cap);
    });

    it('the list is re-read afterwards, so the card cannot show what is gone', async () => {
        const { api, calls, confirm } = loadSweep(mixed());
        await api._mailSweepUnapproved();
        await confirm();
        expect(calls[calls.length - 1].method).toBe('RERUN');
    });

    it('nothing to sweep asks nothing and sends nothing', async () => {
        const { api, calls, asked } = loadSweep({ decided: true, items: [row('k-app', 'approved', 'a@hnb.lk')] });
        await api._mailSweepUnapproved();
        expect(asked).toEqual([]);
        expect(calls).toEqual([]);
    });
});

describe('a sweep that did not work says so', () => {
    function loadFailing(answer) {
        const calls = [];
        const notes = [];
        let cb = null;
        const src = [
            blockAt('function _mailFromLabel(from)'),
            constAt(/const _MAIL_VERDICTS = \[[^\]]*\];/, '_MAIL_VERDICTS'),
            blockAt('function _mailVerdict(d, decided)'),
            blockAt('function _mailKnownNow(d, decided)'),
            blockAt('function _mailSweepable()'),
            blockAt('function _mailSweepGroups(list)'),
            constAt(/const MAIL_DELETE_CHUNK = \d+;/, 'MAIL_DELETE_CHUNK'),
            blockAt('async function _mailSweepUnapproved()'),
        ].join('\n');
        const api = new Function(
            '_mailSyncState', 'showConfirm', 'notify', '_gmailLink', 'runMailSync',
            src + '; return { _mailSweepUnapproved };',
        )(
            { decided: true, items: [row('k1', 'new', 'a@shop.example'), row('k2', 'blocked', 'b@shop.example')] },
            (icon, title, detail, cls, label, fn) => { cb = fn; },
            (msg, kind) => notes.push({ msg, kind }),
            async (method, body) => { calls.push(body); return answer(body); },
            () => {},
        );
        return { api, calls, notes, confirm: () => cb && cb() };
    }

    it('a refusal from the server is reported, not swallowed as success', async () => {
        const h = loadFailing(() => ({ status: 503, body: { ok: false, error: 'store unreachable' } }));
        await h.api._mailSweepUnapproved();
        await h.confirm();
        expect(h.notes.some((n) => n.kind === 'error')).toBe(true);
        expect(h.notes.some((n) => /^Removed \d/.test(n.msg))).toBe(false);
    });

    it('a throw is counted, not lost', async () => {
        const h = loadFailing(() => { throw new Error('offline'); });
        await h.api._mailSweepUnapproved();
        await h.confirm();
        expect(h.notes.some((n) => n.kind === 'error')).toBe(true);
    });

    it('a partial removal reports both numbers', async () => {
        const h = loadFailing((body) => ({ status: 200, body: { ok: true, deleted: 1, failed: [body.keys[1]] } }));
        await h.api._mailSweepUnapproved();
        await h.confirm();
        const said = h.notes.map((n) => n.msg).join(' ');
        expect(said).toContain('Removed 1');
        expect(said).toContain('1 could not be removed');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 3 — THE CARD SAYS WHAT IT IS DOING
 * ═══════════════════════════════════════════════════════════════════════════*/

describe('the card', () => {
    const card = blockAt('function renderMailSync()');

    it('offers the sweep only when there is something to sweep', () => {
        expect(card).toContain('const sweep = _mailSweepable();');
        expect(card).toMatch(/const sweepStrip = sweep\.length \?/);
        expect(card).toContain('${sweepStrip}');
    });

    it('the button is wired to the sweep, not left as decoration', () => {
        /* The repeated defect in this repository is a facility built and wired
         * to nobody. The strip is markup until this line exists. */
        expect(card).toMatch(/#_ms_sweep[\s\S]{0,200}_mailSweepUnapproved\(\)/);
    });

    it('a blocked sender is named as blocked, not as merely unlisted', () => {
        expect(card).toContain('you blocked this sender.');
    });

    it('a blocked sender is not offered an Add button', () => {
        /* "Add sender" on a row the owner explicitly refused is an invitation
         * to undo their own decision by mistake. */
        expect(card).toMatch(/it\.verdict !== 'blocked' \? `<button[^`]*data-msadd/);
    });

    it('nothing is hidden from the owner: the unapproved rows still draw', () => {
        /* The lazy version of this feature filters the list. Then the store
         * holds documents the owner cannot see, and "Nothing waiting" is a
         * lie about a store that is full. */
        expect(card).not.toMatch(/items\.filter\([^)]*verdict/);
    });
});

describe('the sync loop', () => {
    const loop = blockAt('async function runMailSync()');

    it('reads the live verdict rather than the flag frozen at arrival', () => {
        expect(loop).toContain('known: _mailKnownNow(d, _mailSyncState.decided)');
        expect(loop).toContain('verdict: _mailVerdict(d, _mailSyncState.decided)');
        /* And the old direct read is gone — two answers to "is this known" is
         * how the card and the loop end up disagreeing. */
        expect(loop).not.toContain('known: !(d.manifest && d.manifest.known === false)');
    });

    it('the decision flag is taken from the server before the rows are built', () => {
        const flag = loop.indexOf('_mailSyncState.decided = r.body.decided === true');
        const rows = loop.indexOf('_mailSyncState.items = docs.map');
        expect(flag).toBeGreaterThan(-1);
        expect(rows).toBeGreaterThan(flag);
    });

    it('an unapproved statement is still not opened', () => {
        /* "Held for review" has to mean the statement is not processed. */
        expect(loop).toContain("set(i, { stage: 'held', reason: 'waiting for you to add this sender' });");
    });
});
