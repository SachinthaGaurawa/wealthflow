/* =============================================================================
 * test/taxonomy_unity_test.js — one category list, or a red suite
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * PR #125 made wealthflow-merchants.js the single source of the category list and
 * derived its validator from it, so the two could not drift. It then fixed two
 * other copies that already had. I described that as done. It was three of seven.
 *
 * The four that were missed, and what each one cost:
 *
 *   test/merchant-expand.cjs   Hardcoded 20 categories. This is the file the
 *                              NIGHTLY SYNC runs, so `Cash Advance` — added for a
 *                              user's own uncategorised credit-card advance — was
 *                              blocked from the merchant table twice over: the
 *                              prompt tells the model the allowed values, and
 *                              validEntry() drops anything outside them, silently
 *                              (`held++`, no log naming the category).
 *
 *   merchants.json             taxonomy.categories, regenerated from the file
 *                              above, so it inherited the same gap and shipped it
 *                              to every device. 914 merchants, version 106, and
 *                              not one of them could ever be a cash advance.
 *
 *   index.html handleAIScan    An eight-name vocabulary of its own: Food &
 *                              Groceries, Medical, Entertainment, Clothing and
 *                              four more. Four matched nothing in the dropdown, so
 *                              a scanned receipt silently kept the default while
 *                              the same shop from a statement classified properly.
 *                              Thirteen real categories were unreachable by scan.
 *
 *   wealthflow-route.js        A parallel regex table used for ROUTING. Not the
 *                              same job, so it is not unified — but its category
 *                              outputs must still be names this app has, which is
 *                              asserted below rather than assumed.
 *
 * A category vocabulary that disagrees with itself is not a tidiness problem. Every
 * model downstream — the merchant learner, the ML verifier, recurring detection —
 * trains on whichever name the door of entry happened to use.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const require_ = createRequire(import.meta.url);

/** The canonical list, parsed the same way every consumer parses it. */
function canonical() {
    const m = read('wealthflow-merchants.js').match(/var CATEGORIES = \[([\s\S]*?)\];/);
    expect(m, 'CATEGORIES is gone from wealthflow-merchants.js — every derived list '
        + 'below now has no source').toBeTruthy();
    const list = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(list.length).toBeGreaterThan(10);
    return list;
}
const sorted = (a) => [...a].sort().join('|');

/* A mention inside a COMMENT is not a reference. wealthflow-self-heal.js was
 * deleted from the app and survived the orphan check below for a release,
 * because index.html still carried an HTML comment saying it had been removed —
 * the filename was present, so the file looked referenced.
 *
 * Defined ONCE, here, and used by both the orphan check and its self-check. The
 * first version had the self-check build its own copy, so mutating the real one
 * changed nothing and the mutation survived. */
const stripComments = (src) => src
    .replace(/<!--[\s\S]*?-->/g, '')       // HTML comments
    .replace(/\/\*[\s\S]*?\*\//g, '')      // JS block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // JS line comments, sparing https://

describe('every category list in the repository is the same list', () => {
    const CANON = canonical();

    it('the canonical list still carries the category this was found through', () => {
        expect(CANON, 'Cash Advance is gone — the user-reported case that exposed all of '
            + 'this has no category again').toContain('Cash Advance');
    });

    it('wealthflow-merchants.js derives its own validator rather than repeating itself', () => {
        const src = read('wealthflow-merchants.js');
        expect(src, 'VALID_CATS is hardcoded again instead of being built from CATEGORIES')
            .toMatch(/VALID_CATS\[CATEGORIES\[/);
    });

    it('the nightly merchant sync gates on the canonical list', () => {
        const mod = require_(path.join(ROOT, 'test/merchant-expand.cjs'));
        expect(sorted(Object.keys(mod.VALID_CATS)), 'the sync job\'s category gate has drifted from '
            + 'wealthflow-merchants.js. It runs every night and silently HOLDS anything outside its '
            + 'list, so a category it does not know can never gain a merchant')
            .toBe(sorted(CANON));
    });

    it('the sync refuses to run on a guessed list rather than falling back', () => {
        const src = read('test/merchant-expand.cjs');
        expect(src, 'the derivation has a silent fallback — a stale gate that reports success is '
            + 'exactly what this replaces').toMatch(/throw new Error\('merchant-expand: cannot find CATEGORIES/);
    });

    it('merchants.json ships the same taxonomy it is gated by', () => {
        const j = JSON.parse(read('merchants.json'));
        expect(sorted(j.taxonomy.categories), 'merchants.json is trusted by every device and its '
            + 'taxonomy no longer matches the app').toBe(sorted(CANON));
    });

    it('api/verify.js agrees', () => {
        const m = read('api/verify.js').match(/CATEGORIES\s*=\s*\[([\s\S]*?)\]/);
        expect(m, 'CATEGORIES is gone from api/verify.js').toBeTruthy();
        const list = m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
        expect(sorted(list)).toBe(sorted(CANON));
    });

    it('the review panel reads the canonical list at runtime', () => {
        expect(read('wealthflow-verify-panel.js'), 'the review modal has its own copy again')
            .toMatch(/WFMerchants\.CATEGORIES|CATS_FALLBACK/);
    });
});

describe('the receipt scanner speaks the same vocabulary as the statement importer', () => {
    const CANON = canonical();
    const HTML = read('index.html');

    it('the scan prompt is built from the canonical list, not written out', () => {
        expect(HTML, 'the scanner has a hardcoded category vocabulary again')
            .toMatch(/"category": best fit from: \$\{_scanCategoryList\(\)\}/);
        expect(HTML, 'the old eight-name list is back')
            .not.toMatch(/best fit from: Food & Groceries/);
    });

    it('_scanCategoryList takes the app\'s own categories', () => {
        const at = HTML.indexOf('function _scanCategoryList()');
        expect(at, '_scanCategoryList is gone — retarget this test').toBeGreaterThan(-1);
        const body = HTML.slice(at, at + 900);
        expect(body).toMatch(/window\.WFMerchants && window\.WFMerchants\.CATEGORIES/);
        expect(body, 'a missing merchant module now degrades silently to a shorter vocabulary — '
            + 'the exact failure shape this file documents').toMatch(/console\.error/);
    });

    it('a scanned receipt is refined through the same table a statement uses', () => {
        const at = HTML.indexOf('function _refineScanCategory(');
        expect(at, 'the scan result no longer reaches WFMerchants, so a photographed receipt and '
            + 'an imported statement can disagree about the same shop again').toBeGreaterThan(-1);
        expect(HTML.slice(at, at + 700)).toMatch(/WFMerchants\.refine/);
        const pop = HTML.indexOf('function _populateExpenseFromScan(');
        expect(pop).toBeGreaterThan(-1);
        const body = HTML.slice(pop, pop + 1200);
        expect(body, 'the refine step is not wired into the populate path')
            .toMatch(/_refineScanCategory\(result\.vendor, result\.category\)/);
    });

    it('none of the retired names survive anywhere in the scan path', () => {
        // Food & Groceries / Medical / Entertainment / Clothing are not categories
        // this app has. Any of them reappearing means a fifth vocabulary is back.
        const scanRegion = HTML.slice(HTML.indexOf('async function handleAIScan('),
            HTML.indexOf('function _populateExpenseFromScan('));
        ['Food & Groceries', 'Medical', 'Entertainment', 'Clothing'].forEach((bad) => {
            expect(scanRegion, `"${bad}" is back in the scan path and is not an app category`)
                .not.toContain(bad);
        });
        expect(CANON).toContain('Groceries');
        expect(CANON).toContain('Health');
    });
});

describe('the routing table stays inside the vocabulary', () => {
    it('every category wealthflow-route.js can emit is a real one', () => {
        const CANON = canonical();
        const src = read('wealthflow-route.js');
        // The routing table's rows look like  ['Groceries', /regex/],
        const emitted = [...src.matchAll(/\[\s*'([A-Z][A-Za-z/ ]+)',\s*\//g)].map((m) => m[1]);
        expect(emitted.length, 'the routing table shape changed — retarget this test')
            .toBeGreaterThan(3);
        // Three of the table's names are routing concepts the app has no category
        // for. They are aliased on the way out rather than renamed in the table, so
        // the check is on what expenseCategory() can RETURN, not what the table says.
        const aliasM = src.match(/var ROUTE_CAT_ALIAS = \{([^}]*)\}/);
        expect(aliasM, 'the alias map is gone — expenseCategory() can emit names the rest of the '
            + 'app does not have again').toBeTruthy();
        const alias = Object.fromEntries(aliasM[1].split(',').map((pair) => {
            const [k, v] = pair.split(':').map((x) => x.trim().replace(/^'|'$/g, ''));
            return [k, v];
        }).filter(([k]) => k));
        Object.values(alias).forEach((target) => {
            expect(CANON, `the alias map points at "${target}", which is not a category`).toContain(target);
        });
        const strays = [...new Set(emitted)].map((c) => alias[c] || c).filter((c) => !CANON.includes(c));
        expect(strays, 'the router emits a category the rest of the app does not have, so a routed '
            + 'transaction lands under a name nothing else recognises').toEqual([]);
    });

    it('expenseCategory actually APPLIES the alias, not just declares it', () => {
        // The check above proves the map exists and points somewhere valid. It does
        // NOT prove the function consults it: deleting the one line in
        // expenseCategory that reads the map left the suite green, because the test
        // applied the alias itself. So load the real module and call it.
        const CANON = canonical();
        const sandbox = { console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no network in tests')) };
        sandbox.window = sandbox;
        sandbox.globalThis = sandbox;
        sandbox.location = { hostname: 'localhost' };
        new Function('window', 'globalThis', 'self', 'location', 'console', 'fetch', 'setTimeout', 'clearTimeout',
            read('wealthflow-route.js'))(
            sandbox, sandbox, sandbox, sandbox.location, console, sandbox.fetch, setTimeout, clearTimeout);

        const R = sandbox.WFRoute;
        expect(R && typeof R.expenseCategory, 'wealthflow-route.js no longer exposes '
            + 'WFRoute.expenseCategory — retarget this test').toBe('function');

        const cases = {
            'NETFLIX.COM AMSTERDAM': 'Streaming',
            'WEDDING GIFT SHOP COLOMBO': 'Shopping',
            'OUTWARD CEFT TRF TO 12345': 'Other',
        };
        Object.entries(cases).forEach(([desc, want]) => {
            const got = R.expenseCategory(desc);
            expect(got, `"${desc}" routed to "${got}" — the alias is declared but not applied, so `
                + 'this name reaches the ledger and nothing else recognises it').toBe(want);
        });

        // And nothing the router can produce is outside the vocabulary, for any input.
        const probes = ['NETFLIX', 'WEDDING GIFT', 'OUTWARD CEFT', 'KEELLS SUPER', 'CEYPETCO FUEL',
            'ASIRI HOSPITAL', 'PVR CINEMA', 'BOWLING ALLEY', 'NLB LOTTERY', 'SLT BROADBAND'];
        const produced = [...new Set(probes.map((d) => R.expenseCategory(d)))];
        expect(produced.filter((c) => !CANON.includes(c)),
            'the router produced a name that is not an app category').toEqual([]);
    });
});

describe('modules that ship are modules that run', () => {
    const HTML = read('index.html');
    const onDisk = fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f)).sort();
    const loaded = [...HTML.matchAll(/<script[^>]*src="(wealthflow-[^"]+\.js)"/g)].map((m) => m[1]);

    it('the reference check ignores comments — checked against known-bad input', () => {
        // An allowlist-style filter cannot be tested on a clean tree: with no
        // orphan present, removing the comment-stripping changes nothing and the
        // suite stays green. A mutation did exactly that. So the stripper is run
        // against input that IS bad.
        const onlyInHtmlComment = '<!-- the old wealthflow-ghost.js was REMOVED -->\n<div></div>';
        const onlyInBlockComment = '/* wealthflow-ghost.js is gone */\nvar x = 1;';
        const onlyInLineComment = '// wealthflow-ghost.js was deleted\nvar y = 2;';
        const realReference = '<script src="wealthflow-ghost.js"></script>';
        expect(stripComments(onlyInHtmlComment).includes('wealthflow-ghost.js'),
            'a filename mentioned only in an HTML comment still counts as a reference — this is '
            + 'exactly how wealthflow-self-heal.js survived deletion for a release')
            .toBe(false);
        expect(stripComments(onlyInBlockComment).includes('wealthflow-ghost.js')).toBe(false);
        expect(stripComments(onlyInLineComment).includes('wealthflow-ghost.js')).toBe(false);
        expect(stripComments(realReference).includes('wealthflow-ghost.js'),
            'a real script tag was stripped as if it were a comment').toBe(true);
        // and a URL is not a line comment
        expect(stripComments('var u = "https://example.com/wealthflow-ghost.js";')
            .includes('wealthflow-ghost.js'), 'https:// was mistaken for a line comment').toBe(true);
    });

    it('nothing ships that nothing references', () => {
        // wealthflow-ai-v3.js (60 KB) and wealthflow-autopilot.js (16 KB) were
        // referenced by no file in the repository — not index.html, not another
        // module, not a test — while counting against the performance budget.
        const orphans = onDisk.filter((f) => {
            if (loaded.includes(f)) return false;
            const referrers = fs.readdirSync(ROOT)
                .filter((o) => /\.(js|mjs|cjs|html|json)$/.test(o) && o !== f)
                .filter((o) => { try { return stripComments(read(o)).includes(f); } catch { return false; } });
            const inTests = fs.existsSync(path.join(ROOT, 'test'))
                && fs.readdirSync(path.join(ROOT, 'test'))
                    .some((t) => { try { return read('test/' + t).includes(f); } catch { return false; } });
            return referrers.length === 0 && !inTests;
        });
        expect(orphans, 'a module ships and is budgeted but nothing anywhere references it')
            .toEqual([]);
    });

    it('the intelligence layer is loaded, because loaded modules depend on it', () => {
        expect(loaded, 'wealthflow-intelligence.js is unloaded again. Two modules that ARE loaded '
            + 'guard on globals only it defines, so password-locked PDF statements stop being '
            + 'auto-unlocked and semantic allocation to a goal or loan stops happening — both in '
            + 'silence, because the guards are typeof checks').toContain('wealthflow-intelligence.js');
    });

    it('it loads after the module that consumes it', () => {
        const i = loaded.indexOf('wealthflow-intelligence.js');
        const a = loaded.indexOf('wealthflow-autonomous.js');
        expect(a, 'wealthflow-autonomous.js is no longer loaded — retarget this test').toBeGreaterThan(-1);
        expect(i, 'the intelligence layer loads before its consumer').toBeGreaterThan(a);
    });

    it('the globals its consumers guard on are the ones it exports', () => {
        const intel = read('wealthflow-intelligence.js');
        const consumers = {
            'wealthflow-ai-v4.js': 'wfVaultPdfPasswords',
            'wealthflow-autonomous.js': 'wfTrySemanticAllocate',
        };
        Object.entries(consumers).forEach(([file, global_]) => {
            expect(read(file), `${file} no longer consumes ${global_} — retarget this test`)
                .toContain(global_);
            expect(intel, `${global_} is consumed by ${file} but no longer exported by the `
                + 'intelligence layer, so the guard there is permanently false again')
                .toMatch(new RegExp('window\\.' + global_ + '\\s*='));
        });
    });

    it('the vault keeps its ciphertext out of the synced document', () => {
        const intel = read('wealthflow-intelligence.js');
        // It holds card last-4, NIC and DOB. localStorage only: appData is what
        // syncToCloud uploads, so a vault key there would put them in Firestore.
        expect(intel).toMatch(/localStorage\.setItem\('wf_vault_enc'/);
        expect(intel, 'the vault now writes through DB/appData, which is the object syncToCloud '
            + 'uploads — NIC and date of birth would reach the cloud')
            .not.toMatch(/DB\(\)?\.set\(\s*['"]?(wf_)?vault/i);
        expect(intel, 'the vault is no longer encrypting at rest').toMatch(/AES-GCM/);
    });
});
