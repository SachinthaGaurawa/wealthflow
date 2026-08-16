/* =============================================================================
 * test/release_brain_auth_test.js — /api/release-brain was an open write
 * endpoint, and the brain could declare a mandatory update on its own
 * -----------------------------------------------------------------------------
 * TWO DEFECTS, ONE FILE.
 *
 * 1. NO AUTHENTICATION AT ALL
 *
 * api/router.js routes 'release-brain' with no guard. Anyone on the internet
 * who knew the URL could make the endpoint:
 *
 *     · read every document in the `feedback` collection
 *     · overwrite system/feedbackPriority  (the in-app priority board)
 *     · overwrite system/pendingRelease    (the owner's approval queue)
 *     · DELETE feedback older than 14 days, up to 5,000 documents per call,
 *       via archiveOldFeedback
 *
 * The delete is the sharp edge. The rest are overwrites of derived state; that
 * one destroys user-submitted data on an attacker's schedule.
 *
 * 2. THE BRAIN ANNOUNCED MANDATORY UPDATES BY ITSELF
 *
 * Whenever any critical cluster existed, the brain wrote `mandatory` straight
 * into system/manifest — the document every client reads to decide whether to
 * show "Required security update". A machine could therefore alarm the entire
 * user base with no human in the loop, inside a system whose stated premise is
 * that a human approves what ships.
 *
 * It did exactly that on v7.69.24. release.cjs derived, from the real diff,
 * "1 internal change — nothing user-facing". The brain marked the SAME version
 * a mandatory security release, because three critical clusters existed in the
 * feedback. Both statements were about one version and only one could be true:
 * the urgency was real, and the release it was pinned to did not address it.
 *
 * The urgency now lives only in system/pendingRelease behind
 * `approval: { required: true, approved: false }`, and approve-release.js is
 * the only writer that may promote it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { authorize, localRequest, isLocalInvocation } from '../release-brain.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* Every source assertion below runs against comment-stripped code. The fixed
 * sources quote the deleted lines in their own comments — `_send`'s comment
 * contains the literal `obj.ok ? 200 : 200` it replaced — so scanning raw text
 * would flag the file that documents the fix and pass the file that silently
 * still has the bug. This trap has now caught three guards in this repo. */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');

const req = (auth) => (auth === undefined ? { headers: {} } : { headers: { authorization: auth } });
const OWNER = 'owner-uid-abc123';
const SECRET = 'cron-secret-value-do-not-log';

// ── 1. authentication ────────────────────────────────────────────────────────

describe('an anonymous caller is refused', () => {
    const env = { CRON_SECRET: SECRET, RELEASE_ADMIN_UID: OWNER };

    it('rejects a request with no Authorization header', async () => {
        const r = await authorize(req(), { env });
        expect(r.ok, 'the endpoint is open again').toBe(false);
        expect(r.status).toBe(401);
    });

    it('rejects a wrong bearer token', async () => {
        const r = await authorize(req('Bearer not-the-secret'), { env });
        expect(r.ok).toBe(false);
        expect(r.status).toBe(401);
    });

    it('rejects a near-miss on the secret', async () => {
        for (const t of [SECRET.slice(0, -1), SECRET + 'x', SECRET.toUpperCase(), ' ' + SECRET]) {
            // The last one is trimmed by bearerOf, so it SHOULD pass — assert
            // the others fail and handle that case separately below.
            if (t.trim() === SECRET) continue;
            expect((await authorize(req('Bearer ' + t), { env })).ok, `accepted "${t}"`).toBe(false);
        }
    });

    it('rejects other auth schemes', async () => {
        for (const h of ['Basic ' + SECRET, SECRET, 'Token ' + SECRET, 'Bearer', 'Bearer ']) {
            expect((await authorize(req(h), { env })).ok, `accepted "${h}"`).toBe(false);
        }
    });

    it('never echoes the secret in the refusal', async () => {
        const r = await authorize(req('Bearer wrong'), { env });
        expect(JSON.stringify(r)).not.toContain(SECRET);
        expect(JSON.stringify(r)).not.toContain(OWNER);
    });
});

describe('the two legitimate credentials are accepted', () => {
    const env = { CRON_SECRET: SECRET, RELEASE_ADMIN_UID: OWNER };

    it('accepts the cron secret — this is how Vercel Cron calls it', async () => {
        const r = await authorize(req('Bearer ' + SECRET), { env });
        expect(r.ok).toBe(true);
        expect(r.via).toBe('cron');
    });

    it('is case-insensitive on the scheme and tolerant of extra whitespace', async () => {
        expect((await authorize(req('bearer ' + SECRET), { env })).ok).toBe(true);
        expect((await authorize(req('Bearer   ' + SECRET + '  '), { env })).ok).toBe(true);
    });

    it('accepts the owner ID token', async () => {
        const r = await authorize(req('Bearer id-token'), {
            env, verifyIdToken: async () => ({ uid: OWNER }),
        });
        expect(r.ok).toBe(true);
        expect(r.via).toBe('owner');
    });

    it('refuses a VALID token belonging to someone else', async () => {
        // Authenticated is not authorised. The board ping fires for any
        // signed-in user, so this is the common case, not an exotic one.
        const r = await authorize(req('Bearer id-token'), {
            env, verifyIdToken: async () => ({ uid: 'some-other-user' }),
        });
        expect(r.ok).toBe(false);
        expect(r.status).toBe(403);
    });

    it('refuses when token verification throws', async () => {
        const r = await authorize(req('Bearer id-token'), {
            env, verifyIdToken: async () => { throw new Error('expired'); },
        });
        expect(r.ok).toBe(false);
        expect(r.status).toBe(401);
    });
});

describe('an unconfigured guard refuses everything', () => {
    /* The failure mode that matters most. A guard that lets traffic through
     * when it has nothing to check against is not a guard, and this repository
     * has already shipped that shape more than once. */
    it('refuses even a plausible token when no credential is configured', async () => {
        for (const env of [{}, { CRON_SECRET: '' }, { RELEASE_ADMIN_UID: '   ' }]) {
            const r = await authorize(req('Bearer anything'), { env });
            expect(r.ok, `fails OPEN with env ${JSON.stringify(env)}`).toBe(false);
            expect(r.status).toBe(503);
            expect(r.reason).toMatch(/no credentials configured/);
        }
    });

    it('works with only ONE of the two configured', async () => {
        expect((await authorize(req('Bearer ' + SECRET), { env: { CRON_SECRET: SECRET } })).ok).toBe(true);
        const ownerOnly = await authorize(req('Bearer tok'), {
            env: { RELEASE_ADMIN_UID: OWNER }, verifyIdToken: async () => ({ uid: OWNER }),
        });
        expect(ownerOnly.ok).toBe(true);
    });
});

describe('the CLI is not blocked, and HTTP cannot impersonate it', () => {
    it('lets the in-process CLI through', async () => {
        const r = await authorize(localRequest(), { env: {} });
        expect(r.ok).toBe(true);
        expect(r.via).toBe('local');
    });

    it('cannot be forged from anything an HTTP caller controls', async () => {
        // The marker is a module-private Symbol. A body, a query string and a
        // header are all strings — none of them can produce it.
        const forgeries = [
            { headers: {}, _localInvocation: true },
            { headers: {}, local: true, trusted: true },
            { headers: { 'x-local-invocation': 'true' } },
            { query: { local: '1' }, headers: {} },
            { headers: {}, [Symbol('release-brain.local')]: true },   // same description, different Symbol
            JSON.parse('{"headers":{},"__proto__":{"localInvocation":true}}'),
        ];
        for (const f of forgeries) {
            expect(isLocalInvocation(f), `forged: ${JSON.stringify(f)}`).toBe(false);
            expect((await authorize(f, { env: { CRON_SECRET: SECRET } })).ok).toBe(false);
        }
    });
});

describe('the guard runs before any Firestore work', () => {
    const SRC = stripComments(read('release-brain.js'));

    it('authorizes before the feedback read, the writes, and the archive pass', () => {
        const authAt = SRC.indexOf('const auth = await authorize(req');
        expect(authAt, 'the handler no longer calls authorize').toBeGreaterThan(-1);
        for (const marker of [
            "collection('feedback')",
            "doc('feedbackPriority')",
            "doc('pendingRelease')",
            'archiveOldFeedback(db, admin)',
        ]) {
            const at = SRC.indexOf(marker, authAt);
            expect(at, `${marker} not found after the guard`).toBeGreaterThan(authAt);
        }
    });

    it('returns a real HTTP status instead of 200-for-everything', () => {
        // _send used to be `res.status(obj.ok ? 200 : 200)` — both branches 200,
        // so a refusal was indistinguishable from a success to any client.
        expect(SRC).not.toMatch(/obj\.ok \? 200 : 200/);
        expect(SRC).toMatch(/_send\(res, out, auth\.status \|\| 401\)/);
    });
});

describe('the comment stripper cannot make these assertions vacuous', () => {
    it('leaves the executable code intact', () => {
        const code = stripComments(read('release-brain.js'));
        expect(code).toMatch(/export async function authorize/);
        expect(code).toMatch(/export default async function handler/);
        expect(code.length).toBeGreaterThan(4000);
    });

    it('actually removes the documentation that would fool the scan', () => {
        const raw = read('release-brain.js');
        expect(raw, 'the _send comment no longer quotes the old code').toMatch(/obj\.ok \? 200 : 200/);
        expect(stripComments(raw), 'the stripper missed it').not.toMatch(/obj\.ok \? 200 : 200/);
    });
});

// ── 2. the brain no longer announces ─────────────────────────────────────────

describe('the brain proposes urgency; it does not declare it', () => {
    const CODE = stripComments(read('release-brain.js'));

    it('never appends to manifest.mandatory', () => {
        // The single line that alarmed every user without a human.
        expect(CODE, 'the brain is writing mandatory again')
            .not.toMatch(/man\.mandatory\s*=\s*\[[^\]]*nextVersion/);
        expect(CODE).not.toMatch(/mandatory[^\n]*arrayUnion/i);
    });

    it('only ever PRUNES the mandatory list', () => {
        const line = CODE.split('\n').find((l) => /man\.mandatory\s*=/.test(l));
        expect(line, 'nothing assigns man.mandatory any more — did the bookkeeping go?').toBeTruthy();
        expect(line.trim()).toBe('man.mandatory = pruneMandatory(man.mandatory, deployed);');
    });

    it('sets manifest.latest to what is DEPLOYED, never to a speculative bump', () => {
        // `man.latest = nextVersion` advertised a version that, on the Vercel
        // cron path where nothing ships, would never exist.
        expect(CODE).not.toMatch(/man\.latest\s*=\s*nextVersion/);
        expect(CODE).toMatch(/man\.latest\s*=\s*resolveCurrentVersion\(deployed, null\)/);
    });

    it('writes nothing at all when the deployed version is unknown', () => {
        // Guessing is what produced the 7.13.1 incident.
        expect(CODE).toMatch(/if \(!deployed\)/);
        expect(CODE).toMatch(/manifest not updated: the deployed version could not be read/);
    });

    it('still records the urgency it found, so the run stays legible', () => {
        expect(CODE).toMatch(/out\.urgencyProposed = nextVersion/);
    });

    it('still writes the proposal behind the approval gate', () => {
        expect(CODE).toMatch(/doc\('pendingRelease'\)/);
        expect(CODE).toMatch(/approval: \{ required: true, approved: false \}/);
    });
});

describe('approve-release remains the only writer that may announce', () => {
    const SRC = read('approve-release.js');

    it('is the one that sets mandatory', () => {
        expect(SRC).toMatch(/man\.mandatory = Array\.from\(new Set\(\[\.\.\.\(man\.mandatory \|\| \[\]\), version\]\)\)/);
    });

    it('still requires the owner before doing so', () => {
        expect(SRC).toMatch(/verifyIdToken/);
        expect(SRC).toMatch(/RELEASE_ADMIN_UID/);
        expect(SRC).toMatch(/not authorised to approve releases/);
    });
});

describe('the in-app caller sends a credential', () => {
    const SRC = stripComments(read('wealthflow-feedback-ai.js'));

    it('attaches an ID token to the rerank ping', () => {
        // Without this the board's escalation ping silently 401s forever —
        // exactly the class of silent failure this whole audit is about.
        expect(SRC).toMatch(/getIdToken\(\)/);
        expect(SRC).toMatch(/Authorization: 'Bearer ' \+ tok/);
    });

    it('no longer fires the ping unauthenticated', () => {
        expect(SRC).not.toMatch(/fetch\('\/api\/release-brain\?mode=rerank', \{ cache: 'no-store', keepalive: true \}\)/);
    });

    it('catches its own rejection rather than leaving one unhandled', () => {
        const at = SRC.indexOf("'/api/release-brain?mode=rerank'");
        expect(at).toBeGreaterThan(-1);
        expect(SRC.slice(at, at + 400)).toMatch(/\.catch\(/);
    });
});
