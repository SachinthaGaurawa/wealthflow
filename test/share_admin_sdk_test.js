/* =============================================================================
 * test/share_admin_sdk_test.js — only the server may mint a share document
 * -----------------------------------------------------------------------------
 * WHAT THIS CLOSES
 *
 * firestore.rules had to leave `create` open on the collections that serve
 * shared statements:
 *
 *     match /s/{shortId}             { allow create: if true; … }
 *     match /shared_statements/{id}  { allow create: if true; … }
 *
 * Two things needed that. statement-store.js wrote over the Firestore REST API
 * with only the public Web apiKey, which rules see as unauthenticated; and
 * index.html had a client-side fallback that wrote `s/` straight from the
 * browser. So anyone at all could POST a document into the collection the app
 * serves statements out of, with the document id as the only access control.
 *
 * Both are gone. Writes go through the Admin SDK (admin-db.mjs), whose service
 * account BYPASSES rules — the same mechanism release-brain.js uses to write
 * system/* while that collection is `allow write: if false`.
 *
 * AND IT FIXES REVOCATION. `allow delete: if false` was already deployed, so the
 * REST delete was refused: revoking a share could not work at all, and the
 * endpoint could only answer its honest 502 while the document stayed public.
 * The Admin SDK is not subject to rules, so delete works WITHOUT reopening it to
 * anyone holding a link.
 *
 * The rules assertions land here, with the migration that makes them true — a
 * guard should go green on arrival, not be committed ahead of its fix.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RULES = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
let blocked;

beforeEach(async () => {
    fake.reset();
    blocked = [];
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    globalThis.fetch = async (input, init) => {
        blocked.push(`${String((init && init.method) || 'GET').toUpperCase()} ${String(input)}`);
        throw new Error('network blocked in tests');
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

function mkRes() {
    const seen = { status: null, body: undefined, ended: false };
    const res = {
        status(c) { seen.status = c; return res; },
        json(o) { seen.body = o; seen.ended = true; return res; },
        send(o) { seen.body = o; seen.ended = true; return res; },
        end(o) { if (o !== undefined) seen.body = o; seen.ended = true; return res; },
        setHeader() { return res; }, getHeader() { return undefined; },
        get headersSent() { return seen.ended; },
        get writableEnded() { return seen.ended; },
    };
    return { res, seen };
}

async function call(req) {
    const { default: handler } = await import('../statement-store.js');
    const { res, seen } = mkRes();
    await handler({ headers: {}, query: {}, body: undefined, ...req }, res);
    return seen;
}

/** The body of one top-level match block in firestore.rules. */
function ruleFor(coll) {
    const m = RULES.match(new RegExp(`match\\s+/${coll}/\\{\\w+\\}[^\\n]*\\{([^}]*)\\}`));
    expect(m, `firestore.rules does not scope /${coll}`).toBeTruthy();
    return m[1];
}

describe('the share collections no longer accept writes from the internet', () => {
    for (const coll of ['s', 'shared_statements']) {
        it(`/${coll} seals create`, () => {
            expect(ruleFor(coll), `/${coll} still lets anyone mint a share document`)
                .not.toMatch(/allow[^:\n]*\bcreate\b[^:\n]*:\s*if\s+true/i);
            expect(ruleFor(coll), `/${coll} no longer denies create`)
                .toMatch(/allow[^:\n]*\bcreate\b[^:\n]*:\s*if\s+false/i);
        });

        it(`/${coll} still serves the link and still counts a view`, () => {
            // Sealing writes must not break reading a share or the view counter,
            // which statement-view.js still bumps over unauthenticated REST.
            expect(ruleFor(coll)).toMatch(/allow[^:\n]*\bget\b[^:\n]*:\s*if\s+true/i);
            expect(ruleFor(coll)).toMatch(/allow\s+update:\s*if\s+onlyChanges\(/);
        });

        it(`/${coll} keeps delete denied — revocation runs on the Admin SDK`, () => {
            expect(ruleFor(coll), `/${coll} opened delete, letting anyone holding a link `
                + "destroy someone else's shared statement")
                .not.toMatch(/allow[^:\n]*\bdelete\b[^:\n]*:\s*if\s+true/i);
        });
    }

    it('the browser no longer writes a share document anywhere', () => {
        const code = HTML.replace(/\/\*[\s\S]*?\*\//g, ' ')
            .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
        for (const coll of ['s', 'shared_statements', 'links', 'shared_stmts']) {
            expect(code, `index.html writes /${coll} from the client again, which forces `
                + 'create back open for the whole internet')
                .not.toMatch(new RegExp(`collection\\('${coll}'\\)[^;]*\\.(set|add|update)\\(`));
        }
    });
});

describe('statement-store writes and deletes through the Admin SDK', () => {
    const SRC = fs.readFileSync(path.join(ROOT, 'statement-store.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

    it('the scan is reading real code (guards a vacuous pass)', () => {
        expect(SRC.length).toBeGreaterThan(3000);
        expect(SRC).toMatch(/req\.method === 'DELETE'/);
    });

    it('uses no Firestore REST endpoint and no public Web apiKey', () => {
        expect(SRC, 'statement-store is back on the REST API, which rules see as '
            + 'unauthenticated — create would have to be reopened').not.toMatch(/firestore\.googleapis\.com/);
        expect(SRC, 'statement-store uses the public Web apiKey again').not.toMatch(/FIREBASE_API_KEY/);
        expect(SRC).toMatch(/from '\.\/admin-db\.mjs'/);
    });

    it('stores a statement, and ONLY through the injected Admin SDK', async () => {
        const r = await call({ method: 'POST', body: { html: '<p>hello</p>', name: 'Loan' } });
        expect(r.status).toBe(200);
        expect(r.body.via).toBe('firestore');
        expect(blocked, 'a write went out over the network').toEqual([]);

        const written = [...fake.docs.keys()];
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/^s\/[A-Za-z0-9]{8}$/);
        // Plain values, not REST {stringValue:…} wrappers, and a NUMERIC timestamp
        // so statement-view.js — still on REST — keeps reading integerValue.
        const doc = fake.docs.get(written[0]);
        expect(typeof doc.h).toBe('string');
        expect(typeof doc.t).toBe('number');
        expect(typeof doc.x).toBe('number');
        expect(doc.kind).toBe('html');
    });

    it('refuses to overwrite an existing id rather than clobbering a stranger\'s share', async () => {
        // create() is not an upsert. An id collision must be loud: ids come from a
        // CSPRNG, so one means something is wrong.
        fake.setFailOn((path, op) => (op === 'create'
            ? Object.assign(new Error('ALREADY_EXISTS'), { code: 6 }) : null));
        const r = await call({ method: 'POST', body: { html: '<p>x</p>', name: 'Dup' } });
        expect(r.status).toBe(502);
        expect(r.body.error).toBe('all_hosts_failed');
    });

    it('revokes a share — the thing sealed rules used to make impossible', async () => {
        fake.docs.set('s/revokeme', { kind: 'html', h: '<p>x</p>' });
        const r = await call({ method: 'DELETE', query: { id: 'revokeme' } });
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
        expect(fake.docs.has('s/revokeme'), 'the document survived a reported success').toBe(false);
        expect(blocked, 'the delete went out over the network').toEqual([]);
    });

    it('reports 503-shaped failure, not success, when no service account is configured', async () => {
        const { _setAdminModule } = await import('../admin-db.mjs');
        _setAdminModule(null);
        const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
        delete process.env.FIREBASE_SERVICE_ACCOUNT;
        try {
            const r = await call({ method: 'DELETE', query: { id: 'anything1' } });
            expect(r.status, 'a delete with no credential reported success').toBe(502);
            expect(r.body.success).toBe(false);
            expect(String(JSON.stringify(r.body))).toMatch(/FIREBASE_SERVICE_ACCOUNT/);
        } finally {
            process.env.FIREBASE_SERVICE_ACCOUNT = saved;
            _setAdminModule(fake.admin);
        }
    });
});

describe('the test seam cannot become a production code path', () => {
    it('no shipped file calls _setAdminModule', () => {
        const shipped = fs.readdirSync(ROOT)
            .filter((f) => /\.(js|mjs|cjs)$/.test(f))
            .concat(['api/router.js']);
        const offenders = shipped.filter((f) => {
            const p = path.join(ROOT, f);
            if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) return false;
            const src = fs.readFileSync(p, 'utf8');
            return src.includes('_setAdminModule(') && f !== 'admin-db.mjs';
        });
        expect(offenders, `these shipped files call the test-only Admin seam: ${offenders.join(', ')}`)
            .toEqual([]);
    });

    it('index.html does not reach it either', () => {
        expect(HTML).not.toMatch(/_setAdminModule/);
    });
});
