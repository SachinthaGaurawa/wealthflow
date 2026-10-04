/* =============================================================================
 * test/merchant_name_test.js — the email worker and the manual upload isolate a merchant the same way
 * -----------------------------------------------------------------------------
 * The manual upload isolates the merchant from a narration with WFMerchants.isolate (a classic script); the email worker's history key had its own, weaker cleaning ("POPEYES- -COLOMBO" and
 * "POPEYES- -KANDY" were two merchants, so what the owner decided about one never reached the other). statement-merchant-name.mjs is the page's isolation as a module the worker can import. The two must give the
 * same answer for any line, so this reads both with a few hundred generated ones.
 * ===========================================================================*/
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isolateMerchant, CITIES } from '../statement-merchant-name.mjs';
import { merchantNameFor } from '../statement-sync.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

let page;
beforeAll(() => {
    const sandbox = { console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no network in tests')) };
    sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
    sandbox.location = { hostname: 'localhost' };
    sandbox.document = { readyState: 'complete', addEventListener() {} };
    sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    new Function('window', 'globalThis', 'self', 'location', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'document', 'localStorage', read('wealthflow-merchants.js'))(
        sandbox, sandbox, sandbox, sandbox.location, sandbox.console, sandbox.fetch, setTimeout, clearTimeout, sandbox.document, sandbox.localStorage);
    page = sandbox.WFMerchants;
});

const NAMES = ['KEELLS SUPER', 'CARGILLS FOOD CITY', 'ARPICO SUPERCENTRE', 'POPEYES', 'KFC', 'PIZZA HUT', 'UBER EATS', 'DIALOG AXIATA', 'CEYPETCO FILLING STATION', 'HEMAS PHARMACY', 'NETFLIX', 'DARAZ', 'ZXQ TRADERS', 'N K PERERA & SONS', 'AMZN MKTP', 'BLUE BOTTLE COFFEE'];
const WRAPS = [
    (s) => s, (s) => s.toLowerCase(), (s) => ` ${s}  `, (s) => `POS ${s} COLOMBO 03 LK`, (s) => `ECOM TXN ${s}`, (s) => `VISA DEBIT 4532******1234 ${s}`, (s) => `${s} 4029357733 SG`,
    (s) => `PAYPAL *${s}`, (s) => `CARD PURCHASE ${s} REF 884422`, (s) => `POS 4829 ${s} LK`, (s) => `${s}/COLOMBO`, (s) => `${s} 4829 LK`, (s) => `SQ *${s}`, (s) => `PAYME-VISA*${s}`,
    (s) => `${s.replace(/ /g, '*')} 0077`, (s) => `${s.replace(/ /g, '-')} KANDY`, (s) => `TXN REF: AB12CD34 ${s}`, (s) => `${s}-3921-COLOMBO`, (s) => `Pos Transaction ${s} Nugegoda`,
    (s) => `Outward Ceft Transfer ${s}`, (s) => `IB Bill Payment ${s}`, (s) => `${s} PVT LTD`,
];

describe('the merchant a narration names', () => {
    const lines = NAMES.flatMap((name) => WRAPS.map((wrap) => wrap(name)));
    it(`is the same in the module and in the page, for ${lines.length} generated lines`, () => {
        const differ = lines.filter((line) => isolateMerchant(line) !== page.isolate(line)).map((line) => `${JSON.stringify(line)}: module ${JSON.stringify(isolateMerchant(line))}, page ${JSON.stringify(page.isolate(line))}`);
        expect(differ.slice(0, 10)).toEqual([]);
        expect(lines.length).toBeGreaterThan(300);
    });
    it('knows the same towns as the page', () => {
        const source = read('wealthflow-merchants.js');
        const listed = /var CITIES = \/\\b\(([^)]+)\)\\b\/g;/.exec(source);
        expect(listed, 'the page\'s town list moved: retarget this test').not.toBeNull();
        expect(CITIES).toEqual(listed[1].split('|'));
    });
    it('the worker\'s key strips the outlet, the terminal, the gateway and the bank\'s own words, and keeps the merchant', () => {
        for (const wrap of WRAPS.slice(0, 20)) expect(merchantNameFor({ narration: wrap('POPEYES') }), wrap('POPEYES')).toBe('POPEYES');
    });
    it('says nothing for a line that names only a gateway, a town and a number', () => {
        expect(isolateMerchant('PAYME-VISA*COLOMBO')).toBe('');
        expect(isolateMerchant('4829 COLOMBO 03 LK')).toBe('');
    });
});
