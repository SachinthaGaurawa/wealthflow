import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs, { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { textPdf } from './helpers/embedded-statements.js';
import { createFirestore } from './helpers/fake-firestore.js';
import { readStatement } from '../statement-reader.mjs';
import { runStatementSync, deterministicDecision, unfileStatement, healChequeTwins } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';
import { incomeIn } from '../wealthflow-reactive.js';
import { loadParser } from './statement-fixtures.mjs';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import Cheques, { readCheque, matchTracked, settleCheque, incomeCounted, normNo, sameNo, sameBank, partyFrom } from '../wealthflow-cheques.js';

/* THE CHEQUE TRACKER READS A BANK STATEMENT THE WAY A PERSON DOES.
 * "CHEQUE DEPOSIT 285943" says it is a cheque, that money came IN, and which cheque. It used to be lost three ways: the statement parser deleted the number (it looks like a reference), the page
 * guessed the direction from loose words and ignored the bank's own debit/credit flag, and the email worker did not read cheques at all. wealthflow-cheques.js is now the one reader, and this file
 * reads real-looking rows through all of it: the reader, the page's router, the worker's decision, and the worker end to end against ground truth (each cheque counted once, nothing lost). */
const read = (file) => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const html = read('index.html');
const parser = loadParser(fs);

/* ---- the rows: [narration, direction, amount, what a person reads from it] ------------------------------------------------------------------------------------------------------------ */
const IN = 'received', OUT = 'issued';
const CLEAR = { cheque: true, event: 'clear' };
const RETURN = { cheque: true, event: 'return' };
const CORPUS = [
    // Commercial Bank
    ['CHEQUE DEPOSIT 285943', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHQ DEP 285943', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHQ DEP 285943 COLOMBO 07', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['INWARD CLEARING CHQ 000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['INWARD CLG CHQ NO 000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['OUTWARD CLEARING CHQ 285943', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['OUTWARD CLG CHQ RTN 285943', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    ['CLG CHQ 000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['Inward Cheque 000123 HNB', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['CHEQUE REALISATION 285943', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['Cheque Realised 285943 Sampath', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    // Sampath
    ['CHQ NO 100234 CLEARING', 'debit', 18000, { ...CLEAR, type: OUT, no: '100234' }],
    ['CHEQUE PAID 100234', 'debit', 18000, { ...CLEAR, type: OUT, no: '100234' }],
    ['CHQ DEPOSIT-LOCAL 345678', 'credit', 90000, { ...CLEAR, type: IN, no: '345678' }],
    ['RETURNED CHEQUE 345678 INSUFFICIENT FUNDS', 'debit', 90000, { ...RETURN, type: IN, no: '345678' }],
    ['Chq Returned - Refer to Drawer 345678', 'debit', 90000, { ...RETURN, type: IN, no: '345678' }],
    // HNB
    ['CHEQUE DEP/ 123456 NUGEGODA', 'credit', 42000, { ...CLEAR, type: IN, no: '123456' }],
    ['CHQ 000321 PAID', 'debit', 42000, { ...CLEAR, type: OUT, no: '000321' }],
    ['CHQ RETURN 123456', 'debit', 42000, { ...RETURN, type: IN, no: '123456' }],
    ['CHQ RTN 285943', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    ['DEPOSIT CHEQUE RETURNED 285943', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    ['CHEQUE DISHONOURED 285943', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    // Bank of Ceylon
    ['CHEQUE DEPOSIT - CITY OFFICE 654321', 'credit', 75000, { ...CLEAR, type: IN, no: '654321' }],
    ['CHEQUE NO:654321 PAID', 'debit', 75000, { ...CLEAR, type: OUT, no: '654321' }],
    ['Cheque Deposit - Cheque No: 070283', 'credit', 75000, { ...CLEAR, type: IN, no: '070283' }],
    ['Transfer Cheque Deposit Cheque No: 070283', 'credit', 75000, { ...CLEAR, type: IN, no: '070283' }],
    // People's Bank
    ['CHQ.DEPOSIT 777888', 'credit', 31000, { ...CLEAR, type: IN, no: '777888' }],
    ['CHQ.NO.777888 DR', 'debit', 31000, { ...CLEAR, type: OUT, no: '777888' }],
    ['CHQ NO.000456 DEPOSIT', 'credit', 31000, { ...CLEAR, type: IN, no: '000456' }],
    // NSB
    ['CHEQUE WITHDRAWAL 010101', 'debit', 15000, { ...CLEAR, type: OUT, no: '010101' }],
    ['CHEQUE CLEARING 010101', 'debit', 15000, { ...CLEAR, type: OUT, no: '010101' }],
    // NDB
    ['CHEQUE PAYMENT - 880011', 'debit', 64000, { ...CLEAR, type: OUT, no: '880011' }],
    ['PAYMENT BY CHEQUE 000123', 'debit', 64000, { ...CLEAR, type: OUT, no: '000123' }],
    ['OUTWARD CHEQUE RETURN 880011', 'credit', 64000, { ...RETURN, type: OUT, no: '880011' }],
    // Seylan / NTB / DFCC / Pan Asia / Union / Cargills
    ['CHQ DEP 5566778', 'credit', 12500, { ...CLEAR, type: IN, no: '5566778' }],
    ['CHEQUE #112233', 'debit', 12500, { ...CLEAR, type: OUT, no: '112233' }],
    ['CHQ#123456', 'debit', 12500, { ...CLEAR, type: OUT, no: '123456' }],
    ['CHQ 445566 CLEARING', 'debit', 12500, { ...CLEAR, type: OUT, no: '445566' }],
    ['CHEQUE DEPOSIT 998877 - BORELLA', 'credit', 12500, { ...CLEAR, type: IN, no: '998877' }],
    ['CHQ DEPOSIT NO 335577', 'credit', 12500, { ...CLEAR, type: IN, no: '335577' }],
    ['CHQ DEPOSIT COMM BANK 123456', 'credit', 12500, { ...CLEAR, type: IN, no: '123456' }],
    // number written every way
    ['CHEQUE 000123 PAID', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['CHEQUE-000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['Chq/000123/Landlord', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['CHQ123456', 'debit', 25000, { ...CLEAR, type: OUT, no: '123456' }],
    ['CHEQUE123456', 'debit', 25000, { ...CLEAR, type: OUT, no: '123456' }],
    ['CHQNO123456 PAID', 'debit', 25000, { ...CLEAR, type: OUT, no: '123456' }],
    ['Cheque No 000123 Presented', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['CHQ 285943 DEP BR 045', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHQ DEP BR 045 285943', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['Cheque Deposit (Colombo Fort) Chq No 285943', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE DEPOSIT   RAJ TRADERS 285943', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE DEPOSIT A/C 0012345678 CHQ 285943', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE DEPOSIT 285943 REF 8801234567', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE DEPOSIT 15/03/2026 285943', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE DEPOSIT 25,000.00 285943', 'credit', 25000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE DEPOSIT 100000', 'credit', 100000, { ...CLEAR, type: IN, no: '' }],                     // the amount echoed, not a number
    ['CHEQUE NO 100000 DEPOSIT', 'credit', 100000, { ...CLEAR, type: IN, no: '100000' }],           // said to be the number: it is
    ['CHEQUE DEPOSIT 000285943', 'credit', 50000, { ...CLEAR, type: IN, no: '000285943' }],         // padded with zeros by the bank
    ['CHEQUE 000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['PDC 000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['CHEQUE 285943 CREDIT', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHEQUE CR 285943', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['CHQ DR 000123', 'debit', 25000, { ...CLEAR, type: OUT, no: '000123' }],
    ['REMITTANCE CHQ 285943 CREDITED', 'credit', 50000, { ...CLEAR, type: IN, no: '285943' }],
    ['SELF CHEQUE 000777', 'debit', 20000, { ...CLEAR, type: OUT, no: '000777' }],
    ['CASH CHEQUE 000777', 'debit', 20000, { ...CLEAR, type: OUT, no: '000777' }],
    ['CHECK NO 1234', 'debit', 20000, { ...CLEAR, type: OUT, no: '1234' }],
    ['CHK 1234 PAID', 'debit', 20000, { ...CLEAR, type: OUT, no: '1234' }],
    ['CQ 123456 PAID', 'debit', 20000, { ...CLEAR, type: OUT, no: '123456' }],
    // a cheque whose number the statement does not print — still a cheque, still the right way round
    ['LOCAL CHEQUE DEPOSIT', 'credit', 33000, { ...CLEAR, type: IN, no: '' }],
    ['Cheque Withdrawal Self', 'debit', 33000, { ...CLEAR, type: OUT, no: '' }],
    ['CHEQUE CLEARING', 'debit', 33000, { ...CLEAR, type: OUT, no: '' }],
    // the bank sent it back
    ['CHEQUE RETURNED 285943 INSUFFICIENT FUNDS', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    ['CHQ DEP 285943 RTN', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    ['CHQ RETURNED UNPAID 285943', 'debit', 50000, { ...RETURN, type: IN, no: '285943' }],
    ['CHEQUE 000123 RETURNED - PAYMENT STOPPED', 'credit', 25000, { ...RETURN, type: OUT, no: '000123' }],
];

/* ---- things that look like cheques and are not ------------------------------------------------------------------------------------------------------------------------------------- */
const FEES = [
    'Cheque Book Fee', 'CHEQUE BOOK ISSUE CHARGES', 'CHQ BOOK CHARGES', 'CHQ RETURN CHARGES', 'CHQ RTN CHG', 'Cheque Return Charges - 285943', 'RETURNED CHEQUE FEE', 'CHEQUE DISHONOUR CHARGES',
    'Cheque stop payment charges', 'STOP PAYMENT CHQ 000123 FEE', 'CHQ LEAF CHARGES', 'Stamp duty on cheque book', 'CHEQUE PROCESSING FEE', 'CHEQUE COLLECTION COMMISSION', 'CHQ CLEARING FEE',
    'Cheque Confirmation Fee', 'SPECIAL CLEARING CHARGES CHQ 285943',
];
const NOT_CHEQUES = [
    'CHEQUERS RESTAURANT COLOMBO', 'Check In Hotel Kandy', 'Bank Transfer to Mr Cheque Perera', 'KEELLS SUPER COLOMBO', 'SALARY CREDIT 7654321098', 'POS Transaction - CHECKERS 1234567', 'CEFT Transfer 100000',
    'ATM WITHDRAWAL 50000', 'CHECKOUT.COM 4567', 'Cashier Check Hotel',
];

const asRow = (description, direction, amount) => ({ description, direction, amount });

describe('the reader: a statement row says what it is', () => {
    it.each(CORPUS.map((c) => [c[0], c[1], c[2], c[3]]))('%s (%s)', (description, direction, amount, want) => {
        const r = readCheque(asRow(description, direction, amount));
        expect(r.isCheque, 'is a cheque').toBe(true);
        expect(r.fee).toBe(false);
        expect(r.type, 'which way the money went').toBe(want.type);
        expect(r.event).toBe(want.event);
        expect(normNo(r.no), 'the number').toBe(want.no);
    });

    it.each(FEES)('a bank charge about a cheque is a charge, not a cheque moving: %s', (description) => {
        for (const direction of ['debit', 'credit', '']) {
            const r = readCheque(asRow(description, direction, 100));
            expect(r.isCheque).toBe(false);
            expect(r.fee).toBe(true);
        }
    });

    it.each(NOT_CHEQUES)('%s is not a cheque', (description) => {
        expect(readCheque(asRow(description, 'debit', 5000)).isCheque).toBe(false);
        expect(readCheque(asRow(description, 'credit', 5000)).isCheque).toBe(false);
    });

    it('the bank\'s own debit/credit flag decides which way the money went; the wording is only a fallback', () => {
        // "OUTWARD CLEARING" reads as an issued cheque to anyone who skims it — the money came IN, so it is a received one
        expect(readCheque(asRow('OUTWARD CLEARING CHQ 285943', 'credit', 50000)).type).toBe(IN);
        // wording says "paid", the flag says the money came in: the flag wins and the row is marked for a look
        const odd = readCheque(asRow('CHQ PAID 000123', 'credit', 25000));
        expect(odd.type).toBe(IN);
        expect(odd.conflict).toBe(true);
        expect(odd.needsReview).toBe(true);
        // no flag at all (an SMS, a pasted line): the words decide, with a lower confidence
        expect(readCheque({ description: 'CHEQUE DEPOSIT 285943', amount: 50000 })).toMatchObject({ isCheque: true, type: IN, confidence: 'medium' });
        expect(readCheque({ description: 'CHQ PAID 000123', amount: 25000 })).toMatchObject({ isCheque: true, type: OUT, confidence: 'medium' });
        // nothing says which way: still a cheque, never guessed
        expect(readCheque({ description: 'CHEQUE 000123', amount: 25000 })).toMatchObject({ isCheque: true, type: '', needsReview: true });
        // the extractor's own prefix and a signed amount are flags too
        expect(readCheque({ description: '[credit] CHEQUE 285943', amount: 50000 }).type).toBe(IN);
        expect(readCheque({ description: 'CHEQUE 285943', signedAmount: -50000 }).type).toBe(OUT);
    });

    it('a number is never an amount, a date, an account, a branch or a reference', () => {
        expect(readCheque(asRow('CHEQUE DEPOSIT 25,000.00 15/03/2026', 'credit', 25000)).no).toBe('');
        expect(readCheque(asRow('CHQ DEP BR 045', 'credit', 25000)).no).toBe('');
        expect(readCheque(asRow('CHQ DEP A/C 0012345678', 'credit', 25000)).no).toBe('');
        expect(readCheque(asRow('CHEQUE DEPOSIT REF 8801234', 'credit', 25000)).no).toBe('');
        expect(readCheque(asRow('CHEQUE DEPOSIT 20260315', 'credit', 25000)).no).toBe('');
        expect(readCheque(asRow('CHEQUE DEPOSIT 285943 CEFT 998877', 'credit', 25000)).no).toBe('285943');
        // the same digits as the amount are the amount, unless the narration says they are the number
        expect(readCheque(asRow('CHEQUE 50000 DEPOSIT', 'credit', 50000)).no).toBe('');
        expect(readCheque(asRow('CHEQUE NO 100000 DEPOSIT', 'credit', 100000)).no).toBe('100000');
    });

    it('titles and shop names do not make a cheque', () => {
        expect(readCheque(asRow('Mr Cheque Perera', 'debit', 100)).isCheque).toBe(false);
        expect(readCheque(asRow('CHEQUERS', 'debit', 100)).isCheque).toBe(false);
        expect(readCheque(asRow('Check In Hotel', 'debit', 100)).isCheque).toBe(false);
        expect(readCheque(asRow('CHECK 123456 PAID', 'debit', 100)).isCheque).toBe(true);        // "check" with a number beside it is the US spelling
        expect(readCheque({}).isCheque).toBe(false);
        expect(readCheque(null).isCheque).toBe(false);
        expect(readCheque(asRow('', 'debit', 100)).isCheque).toBe(false);
    });

    it('leading zeros are the same cheque; a lone zero or a single digit is no number at all', () => {
        expect(sameNo('000123', '123')).toBe(true);
        expect(sameNo('0123', '00123')).toBe(true);
        expect(sameNo('123', '124')).toBe(false);
        expect(sameNo('', '')).toBe(false);
        expect(sameNo('0', '000')).toBe(false);
        expect(sameNo('7', '07')).toBe(false);
        expect(sameNo('CHQ-000123', '123')).toBe(true);
    });

    it('the other party\'s name is taken from what is left, for the Cheque tab', () => {
        expect(partyFrom('CHEQUE DEPOSIT RAJ TRADERS 285943')).toBe('Raj Traders');
        expect(partyFrom('CHQ DEP 285943')).toBe('');
        expect(partyFrom('Chq/000123/Landlord')).toBe('Landlord');
    });

    it('bank names compare the way people write them', () => {
        expect(sameBank('Sampath Bank PLC', 'Sampath')).toBe(true);
        expect(sameBank('Commercial Bank of Ceylon', 'Commercial Bank')).toBe(true);
        expect(sameBank('HNB', 'Hatton National Bank')).toBe(true);           // the app's own list of banks says so
        expect(sameBank('Hnb', 'Hatton National Bank (HNB)')).toBe(true);
        expect(sameBank('Dfccbank', 'DFCC Bank')).toBe(true);
        expect(sameBank('HNB', 'Sampath Bank')).toBe(false);
        expect(sameBank('Sampath', 'BOC')).toBe(false);
        expect(sameBank('', 'BOC')).toBeNull();
    });
});

/* ---- the page's router and the worker's decision agree with the reader ---------------------------------------------------------------------------------------------------------------- */
describe('every door reads the same rows the same way', () => {
    let page;
    beforeAll(() => {
        const sandbox = { console: { log() {}, warn() {}, error() {}, info() {} }, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('no network in tests')) };
        sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
        sandbox.location = { hostname: 'localhost' };
        sandbox.document = { readyState: 'complete', addEventListener() {} };
        sandbox.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
        sandbox.WFCheques = Cheques;                                                 // the module script index.html loads before the router
        for (const file of ['wealthflow-merchants.js', 'wealthflow-route.js']) {
            new Function('window', 'globalThis', 'self', 'location', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'document', 'localStorage', read(file))(
                sandbox, sandbox, sandbox, sandbox.location, sandbox.console, sandbox.fetch, setTimeout, clearTimeout, sandbox.document, sandbox.localStorage);
        }
        page = sandbox;
    });
    const route = (description, direction, amount) => page.WFRoute.routeTransaction({ description, amount, direction }, 'bank_account');
    const worker = (description, direction, amount) => deterministicDecision({ narration: description, description, direction, amount, date: '2026-03-12', directionSource: 'balance', needsReview: false }, { statementType: 'bank_account', bank: 'HNB' });

    it.each(CORPUS.map((c) => [c[0], c[1], c[2], c[3]]))('page and worker: %s (%s)', (description, direction, amount, want) => {
        const routed = route(description, direction, amount);
        expect(routed.tab, 'the page files it on the Cheque tab').toBe('cheque');
        expect(routed.chequeType).toBe(want.type);
        expect(routed.chequeNo).toBe(want.no);
        expect(routed.chequeEvent).toBe(want.event);
        const decided = worker(description, direction, amount);
        expect(decided.cheque, 'the worker settles it as a cheque').toBe(true);
        expect(decided.verified).toBe(true);
        expect(decided.module).toBe(direction === 'credit' ? 'incomeRecv' : 'expenses');
    });

    it.each(FEES)('page and worker: %s is a bank charge, not a cheque', (description) => {
        expect(route(description, 'debit', 150).tab).not.toBe('cheque');
        expect(worker(description, 'debit', 150).cheque).toBeUndefined();
    });

    it.each(NOT_CHEQUES)('page and worker: %s is not a cheque', (description) => {
        expect(route(description, 'debit', 5000).tab).not.toBe('cheque');
        expect(worker(description, 'debit', 5000).cheque).toBeUndefined();
    });

    it('a credit-card statement is never read as cheques', () => {
        const decided = deterministicDecision({ narration: 'CHEQUE PAYMENT 000123', description: 'CHEQUE PAYMENT 000123', direction: 'credit', amount: 5000, date: '2026-03-12', directionSource: 'balance' }, { statementType: 'credit_card', bank: 'HNB' });
        expect(decided.cheque).toBeUndefined();
    });
});

/* ---- the statement parser keeps the number --------------------------------------------------------------------------------------------------------------------------------------------- */
describe('the statement parser keeps the cheque number in the narration', () => {
    const statement = (lines) => ['HATTON NATIONAL BANK PLC', 'Statement Period: 01/03/2026 - 31/03/2026', 'Account Number: 074020012388', 'Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance', '01/03/2026 Opening Balance 500,000.00', ...lines].join('\n');
    it.each([
        ['CHEQUE DEPOSIT 285943', '12/03/2026 12/03/2026 CHEQUE DEPOSIT 285943 50,000.00 550,000.00', '285943'],
        ['CHQ000123', '12/03/2026 12/03/2026 CHQ000123 25,000.00 475,000.00', '000123'],
        ['Cheque No 100234 Paid', '12/03/2026 12/03/2026 Cheque No 100234 Paid 18,000.00 482,000.00', '100234'],
    ])('%s', (_name, line, no) => {
        const parsed = parser.parseStatement(statement([line]));
        const rows = parsed.rows || parsed.transactions || [];
        expect(rows.length).toBeGreaterThan(0);
        const text = String(rows[0].narration || rows[0].description || '');
        expect(readCheque({ description: text, direction: rows[0].direction, amount: rows[0].amount })).toMatchObject({ isCheque: true, no });
    });
});

/* ---- properties: any number, any wording, any bank ------------------------------------------------------------------------------------------------------------------------------------- */
describe('properties', () => {
    const TEMPLATES = [
        ['CHEQUE DEPOSIT {n}', 'credit'], ['CHQ DEP {n}', 'credit'], ['CHQ DEP {n} COLOMBO 07', 'credit'], ['Cheque Deposit - Cheque No: {n}', 'credit'], ['CHQ DEPOSIT-LOCAL {n}', 'credit'], ['CHEQUE DEP/ {n} NUGEGODA', 'credit'],
        ['CHQ.DEPOSIT {n}', 'credit'], ['CHQ DEP BR 045 {n}', 'credit'], ['CHEQUE {n} CREDIT', 'credit'], ['REMITTANCE CHQ {n} CREDITED', 'credit'], ['OUTWARD CLEARING CHQ {n}', 'credit'],
        ['CHQ NO {n} CLEARING', 'debit'], ['CHEQUE PAID {n}', 'debit'], ['CHQ {n} PAID', 'debit'], ['CHEQUE NO:{n} PAID', 'debit'], ['CHQ#{n}', 'debit'], ['CHEQUE #{n}', 'debit'], ['INWARD CLEARING CHQ {n}', 'debit'],
        ['PAYMENT BY CHEQUE {n}', 'debit'], ['CHQ{n}', 'debit'], ['Chq/{n}/Landlord', 'debit'], ['CLG CHQ {n}', 'debit'], ['CHEQUE WITHDRAWAL {n}', 'debit'],
    ];
    const number = fc.integer({ min: 100000, max: 999999 }).map(String);
    it('the number a narration carries is the number read, with or without zeros in front', () => {
        fc.assert(fc.property(fc.constantFrom(...TEMPLATES), number, fc.constantFrom('', '0', '00'), fc.integer({ min: 1, max: 900 }).map((n) => n * 100 + 17), ([template, direction], n, zeros, amount) => {
            const r = readCheque(asRow(template.replace('{n}', zeros + n), direction, amount));
            expect(r.isCheque).toBe(true);
            expect(sameNo(r.no, n)).toBe(true);
            expect(r.type).toBe(direction === 'credit' ? IN : OUT);
        }), { numRuns: runs(300) });
    });
    it('a return is a return and its number is the cheque\'s, in whichever words the bank returns it', () => {
        const words = ['CHQ RTN {n}', 'RETURNED CHEQUE {n}', 'CHEQUE {n} RETURNED', 'CHQ RETURN {n} INSUFFICIENT FUNDS', 'CHEQUE DISHONOURED {n}', 'DEPOSIT CHEQUE RETURNED {n}'];
        fc.assert(fc.property(fc.constantFrom(...words), number, (template, n) => {
            const r = readCheque(asRow(template.replace('{n}', n), 'debit', 12345));
            expect(r).toMatchObject({ isCheque: true, event: 'return', type: IN });
            expect(sameNo(r.no, n)).toBe(true);
        }), { numRuns: runs(200) });
    });
    it('a fee about a cheque is never a cheque, whatever number it quotes', () => {
        const words = ['CHEQUE RETURN CHARGES {n}', 'CHQ BOOK CHARGES {n}', 'STOP PAYMENT CHQ {n} FEE', 'CHEQUE PROCESSING FEE {n}', 'RETURNED CHEQUE FEE {n}'];
        fc.assert(fc.property(fc.constantFrom(...words), number, fc.constantFrom('debit', 'credit'), (template, n, direction) => {
            const r = readCheque(asRow(template.replace('{n}', n), direction, 150));
            expect(r.isCheque).toBe(false);
            expect(r.fee).toBe(true);
        }), { numRuns: runs(150) });
    });
    it('reading never throws and never says "cheque" without a cheque word, whatever the text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 120 }), fc.constantFrom('debit', 'credit', ''), fc.double({ min: -1e9, max: 1e9, noNaN: true }), (text, direction, amount) => {
            const r = readCheque({ description: text, direction, amount });
            if (r.isCheque) expect(/ch(?:e|q|k)|pdc|cq/i.test(text)).toBe(true);
            return true;
        }), { numRuns: runs(500) });
    });
    it('settling a row twice never changes the tracker the second time', () => {
        fc.assert(fc.property(fc.constantFrom(...TEMPLATES), number, fc.constantFrom('0', ''), fc.boolean(), ([template, direction], n, zeros, tracked) => {
            const description = template.replace('{n}', zeros + n);
            const row = { description, direction, amount: 31000, date: '2026-03-12', bank: 'HNB' };
            const type = direction === 'credit' ? IN : OUT;
            const list = tracked ? [{ id: 'T', no: n, party: 'P', bank: 'HNB', type, amount: 31000, issue: '2026-03-01', release: '2026-03-10', status: 'pending' }] : [];
            const a = settleCheque(row, list, { id: 'N1', source: { statementKey: 'k', statementRow: 1 } });
            if (a.action === 'create') list.push(a.record); else if (a.patch) Object.assign(list[0], a.patch);
            const b = settleCheque(row, list, { id: 'N2', source: { statementKey: 'k', statementRow: 1 } });
            expect(['already']).toContain(b.action);
            expect(list).toHaveLength(1);
        }), { numRuns: runs(300) });
    });
});

/* ---- which tracked cheque a row settles ------------------------------------------------------------------------------------------------------------------------------------------------ */
const chq = (extra = {}) => ({ id: 'C1', no: '285943', party: 'Raj Traders', bank: 'Sampath', type: IN, amount: 50000, issue: '2026-03-05', release: '2026-03-10', status: 'pending', notes: '', ...extra });
const ROW = { date: '2026-03-12', amount: 50000, bank: 'Commercial Bank' };
const deposit = (extra = {}) => ({ description: 'CHEQUE DEPOSIT 285943', direction: 'credit', amount: 50000, date: '2026-03-12', bank: 'Commercial Bank', ...extra });
const returnRow = (extra = {}) => ({ description: 'CHQ RTN 285943', direction: 'debit', amount: 50000, date: '2026-03-20', bank: 'Commercial Bank', ...extra });

describe('which tracked cheque a row settles', () => {
    const find = (description, direction, cheques, row = ROW) => matchTracked(readCheque(asRow(description, direction, row.amount)), row, cheques);

    it('by NUMBER first — leading zeros do not matter, and the amount can differ', () => {
        const hit = find('CHEQUE DEPOSIT 000285943', 'credit', [chq()]);
        expect(hit).toMatchObject({ status: 'matched', by: 'number', amountDiffers: false });
        expect(hit.cheque.id).toBe('C1');
        const off = find('CHEQUE DEPOSIT 285943', 'credit', [chq({ amount: 48000 })]);
        expect(off).toMatchObject({ status: 'matched', by: 'number', amountDiffers: true });
    });

    it('a received cheque is never settled by an issued row, nor an issued one by a received row', () => {
        expect(find('CHEQUE DEPOSIT 285943', 'credit', [chq({ type: OUT })]).status).toBe('none');
        expect(find('CHQ PAID 285943', 'debit', [chq({ type: IN })]).status).toBe('none');
    });

    it('amount and days settle a cheque logged without its number, only when exactly one fits', () => {
        const noNumber = chq({ no: '' });
        expect(find('CHEQUE DEPOSIT', 'credit', [noNumber])).toMatchObject({ status: 'matched', by: 'amount-date' });
        expect(find('CHEQUE DEPOSIT', 'credit', [noNumber, chq({ id: 'C2', no: '', party: 'Other', bank: 'BOC' })])).toMatchObject({ status: 'ambiguous' });
        // two fit, but only one is at this bank: that is the one
        expect(find('CHEQUE DEPOSIT', 'credit', [chq({ no: '', bank: 'Commercial Bank' }), chq({ id: 'C2', no: '', party: 'Other', bank: 'BOC' })])).toMatchObject({ status: 'matched', cheque: expect.objectContaining({ id: 'C1' }) });
        // a month and a half away is a different cheque
        expect(find('CHEQUE DEPOSIT', 'credit', [chq({ no: '', release: '2026-01-10', issue: '2026-01-05' })]).status).toBe('none');
        // a row that prints a number is never matched to a numbered cheque with another number by amount alone
        expect(find('CHEQUE DEPOSIT 285943', 'credit', [chq({ no: '999111' })]).status).toBe('none');
    });

    it('the same cheque keyed twice is one cheque; two different cheques are never guessed between', () => {
        const twice = find('CHEQUE DEPOSIT 285943', 'credit', [chq(), chq({ id: 'C1b' })]);
        expect(twice).toMatchObject({ status: 'matched', cheque: expect.objectContaining({ id: 'C1' }) });
        const differ = find('CHEQUE DEPOSIT 285943', 'credit', [chq({ bank: 'Commercial Bank' }), chq({ id: 'C2', bank: 'BOC', amount: 50000 })]);
        expect(differ.status).toBe('matched');                                         // the bank tells them apart
        const unsure = find('CHEQUE DEPOSIT 285943', 'credit', [chq({ bank: 'HNB' }), chq({ id: 'C2', bank: 'BOC', party: 'Silva' })]);
        expect(unsure.status).toBe('ambiguous');
        expect(unsure.candidates.map((c) => c.id).sort()).toEqual(['C1', 'C2']);
    });

    it('a cheque closed long ago is not this row\'s cheque: cheque books reuse numbers', () => {
        const old = chq({ status: 'cleared', clearedDate: '2025-06-01', release: '2025-05-28', issue: '2025-05-20' });
        expect(find('CHEQUE DEPOSIT 285943', 'credit', [old]).status).toBe('none');
        // …but the same cheque cleared this month is the same cheque (a statement read again)
        expect(find('CHEQUE DEPOSIT 285943', 'credit', [chq({ status: 'cleared', clearedDate: '2026-03-12' })])).toMatchObject({ status: 'matched', already: true });
    });

    it('the very statement row, filed before, is recognised whatever else changed', () => {
        const filed = chq({ status: 'cleared', clearedDate: '2026-03-12', statementKey: 'k1', statementRow: 4 });
        const hit = matchTracked(readCheque(asRow('CHEQUE DEPOSIT 285943', 'credit', 50000)), { ...ROW, key: 'k1', rowNo: 4 }, [filed]);
        expect(hit).toMatchObject({ status: 'matched', by: 'row', already: true });
        // another row of the same statement is another event
        const other = matchTracked(readCheque(asRow('CHEQUE DEPOSIT 285943', 'credit', 50000)), { ...ROW, key: 'k1', rowNo: 9, date: '2026-04-30' }, [filed]);
        expect(other.already).toBe(false);
    });

    it('a returned cheque: the one that was cleared is the one that bounces', () => {
        const cleared = chq({ status: 'cleared', clearedDate: '2026-03-12' });
        expect(find('CHQ RTN 285943', 'debit', [cleared], { ...ROW, date: '2026-03-20' })).toMatchObject({ status: 'matched', by: 'number', already: false });
        const bounced = chq({ status: 'bounced', bouncedDate: '2026-03-20' });
        expect(find('CHQ RTN 285943', 'debit', [bounced], { ...ROW, date: '2026-03-20' })).toMatchObject({ status: 'matched', already: true });
    });

    it('number-less rows: two identical rows on one day are two cheques; the Nth is a copy only if N are already there', () => {
        const row = { date: '2026-03-12', amount: 33000, bank: 'HNB', nth: 2 };
        const read1 = readCheque(asRow('LOCAL CHEQUE DEPOSIT', 'credit', 33000));
        const one = [chq({ no: '', amount: 33000, status: 'cleared', clearedDate: '2026-03-12', source: 'statement', statementKey: 'other', statementRow: 1 })];
        expect(matchTracked(read1, { ...row, nth: 1, key: 'mine' }, one)).toMatchObject({ status: 'matched', already: true });
        expect(matchTracked(read1, { ...row, nth: 2, key: 'mine' }, one).status).toBe('none');
        // what this very statement wrote is not a copy of its own next row
        expect(matchTracked(read1, { ...row, nth: 1, key: 'other' }, one).status).toBe('none');
    });
});

/* ---- the decision ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
describe('the page finds the typed entry exactly as the worker does', () => {
    it('typedTwin and manualTwin agree over generated payments and entries', async () => {
        const { manualTwin } = await import('../statement-links.mjs');
        const { typedTwin } = Cheques;
        const days = ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-14', '2026-03-16', '2026-02-27'];
        const text = fc.constantFrom('Rent - Landlord', 'Cheque 000123', 'Keells', 'Salary advance', 'Landlord rent', 'electricity bill', 'CHQ 000123 PAID', 'payment', 'Dialog top up');
        const entry = fc.record({
            id: fc.string({ minLength: 1, maxLength: 4 }), desc: text, amount: fc.constantFrom(25000, 24000, 25000.004, 1500), date: fc.constantFrom(...days, ''),
            month: fc.constantFrom('2026-03', '2026-02'), recurring: fc.boolean(), source: fc.constantFrom(undefined, 'sms', 'statement'), statementTwin: fc.constantFrom(undefined, { sourcePath: 'x' }),
            statementKey: fc.constantFrom(undefined, 'k'), uploadClaim: fc.constantFrom(undefined, 'u'),
        }, { requiredKeys: ['id', 'desc', 'amount'] });
        fc.assert(fc.property(fc.array(entry, { maxLength: 4 }), fc.constantFrom(...days), fc.constantFrom('CHQ 000123 PAID', 'RENT LANDLORD CHQ 000123', 'CHEQUE 000123'), fc.boolean(), (records, date, description, strict) => {
            const row = { amount: 25000, date, description, direction: 'debit' };
            const a = manualTwin(records, row, { strict }), b = typedTwin(records, row, { strict });
            expect(b ? b.r : null).toBe(a ? a.r : null);
            if (a) expect(b.gap).toBe(a.gap);
        }), { numRuns: runs(300) });
    });
});

describe('the same cheque number in two bank accounts', () => {
    const issued = (extra) => ({ id: 'H1', no: '000123', party: 'Landlord', type: OUT, amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending', bank: 'Hatton National Bank', ...extra });
    const row = (extra) => ({ description: 'CHQ 000123 PAID', direction: 'debit', amount: 25000, date: '2026-03-12', ...extra });
    it('a Sampath statement clears the Sampath cheque, never the HNB one that happens to have the exact amount', () => {
        const list = [issued(), issued({ id: 'S1', bank: 'Sampath Bank', amount: 24500 })];
        const out = settleCheque(row({ bank: 'Sampath Bank' }), list, {});
        expect(out.action).toBe('clear');
        expect(out.cheque.id).toBe('S1');
        expect(out.patch.amount).toBe(25000);
    });
    it('a Sampath statement does not touch an HNB cheque at all: it is a cheque of its own', () => {
        const out = settleCheque(row({ bank: 'Sampath Bank' }), [issued()], {});
        expect(out.action).toBe('create');
        expect(out.record).toMatchObject({ no: '000123', bank: 'Sampath Bank', status: 'cleared' });
        expect(out.review.join(' ')).toContain('also tracked at Hatton National Bank');
    });
    it('a cheque with no bank written on it still matches (the owner did not say)', () => {
        const out = settleCheque(row({ bank: 'Sampath Bank' }), [issued({ bank: '' })], {});
        expect(out.action).toBe('clear');
    });
    it('the bank that agrees is preferred over one that is unknown, whatever the amounts', () => {
        const list = [issued({ id: 'U1', bank: '' }), issued({ id: 'S1', bank: 'Sampath Bank', amount: 24500 })];
        const out = settleCheque(row({ bank: 'Sampath Bank' }), list, {});
        expect(out.cheque.id).toBe('S1');
    });
    it('a received cheque is drawn on someone else\'s bank: the statement bank is not compared', () => {
        const out = settleCheque({ description: 'CHEQUE DEPOSIT 285943', direction: 'credit', amount: 50000, date: '2026-03-12', bank: 'Sampath Bank' }, [chq({ id: 'R1', bank: 'Commercial Bank' })], {});
        expect(out.action).toBe('clear');
        expect(out.cheque.id).toBe('R1');
    });
});

describe('the decision for one row', () => {
    const opts = (extra = {}) => ({ id: 'new1', now: '2026-03-12T10:00:00.000Z', source: { statementKey: 'k1', statementRow: 3, bank: 'Commercial Bank' }, note: 'Imported', ...extra });

    it('a deposit credit that matches a pending received cheque clears it and files the income', () => {
        const out = settleCheque(deposit(), [chq()], opts());
        expect(out).toMatchObject({ action: 'clear', filesIncome: true, filesExpense: false });
        expect(out.patch).toMatchObject({ status: 'cleared', clearedDate: '2026-03-12', prevStatus: 'pending', statementKey: 'k1', statementRow: 3 });
        expect(out.patch.notes).toContain('Cleared on the bank statement 2026-03-12');
    });

    it('a cheque nobody tracked is recorded from the statement, with its number and the other party', () => {
        const out = settleCheque(deposit({ description: 'CHEQUE DEPOSIT RAJ TRADERS 285943' }), [], opts());
        expect(out).toMatchObject({ action: 'create', filesIncome: true });
        expect(out.record).toMatchObject({ id: 'new1', no: '285943', party: 'Raj Traders', type: IN, amount: 50000, status: 'cleared', clearedDate: '2026-03-12', source: 'statement', statementKey: 'k1', statementRow: 3 });
        const issued = settleCheque({ description: 'CHQ PAID 000123', direction: 'debit', amount: 25000, date: '2026-03-14' }, [], opts());
        expect(issued).toMatchObject({ action: 'create', filesIncome: false, filesExpense: false });
        expect(issued.record).toMatchObject({ no: '000123', type: OUT, status: 'cleared' });
    });

    it('a cheque the statement prints no number for is recorded without one — never a made-up number', () => {
        const out = settleCheque(deposit({ description: 'LOCAL CHEQUE DEPOSIT' }), [], opts());
        expect(out.record.no).toBe('');
        expect(out.record.party).toBe('Cheque on statement');
    });

    it('a returned deposit bounces the received cheque and the debit is the owner\'s expense', () => {
        const out = settleCheque(returnRow(), [chq({ status: 'cleared', clearedDate: '2026-03-12' })], opts());
        expect(out).toMatchObject({ action: 'bounce', filesIncome: false, filesExpense: true });
        expect(out.patch).toMatchObject({ status: 'bounced', bouncedDate: '2026-03-20', prevStatus: 'cleared' });
    });

    it('a returned ISSUED cheque (the credit that brings the money back) bounces it and is not income', () => {
        const out = settleCheque({ description: 'OUTWARD CHEQUE RETURN 880011', direction: 'credit', amount: 64000, date: '2026-03-22' }, [chq({ id: 'I1', no: '880011', type: OUT, amount: 64000, status: 'cleared', clearedDate: '2026-03-15' })], opts());
        expect(out).toMatchObject({ action: 'bounce', filesIncome: false, filesExpense: false });
    });

    it('the statement\'s amount is the money that moved: it replaces a different typed amount, and the old one is kept in the note', () => {
        const out = settleCheque(deposit(), [chq({ amount: 48000 })], opts());
        expect(out.action).toBe('clear');
        expect(out.patch).toMatchObject({ amount: 50000, prevAmount: 48000 });
        expect(out.patch.notes).toContain('amount on file was 48000');
        expect(out.review.join(' ')).toContain('differs');
    });

    it('an unnumbered tracked cheque is given the number the statement printed', () => {
        const out = settleCheque(deposit(), [chq({ no: '' })], opts());
        expect(out.action).toBe('clear');
        expect(out.patch.no).toBe('285943');
    });

    it('several fit: nothing is changed and the row is written as its own record with a note', () => {
        const out = settleCheque(deposit({ description: 'CHEQUE DEPOSIT' }), [chq({ no: '' }), chq({ id: 'C2', no: '', bank: 'BOC', party: 'Silva' })], opts());
        expect(out.ambiguous).toBe(true);
        expect(out.action).toBe('create');
        expect(out.review.join(' ')).toContain('more than one tracked cheque fits');
    });

    it('a cheque with a doubtful direction is never filed blind', () => {
        const out = settleCheque({ description: 'CHEQUE 000123', amount: 25000, date: '2026-03-14' }, [], opts());
        expect(out.action).toBe('none');
        expect(out.review.length).toBe(1);
    });

    it('a fee about a cheque, and a row that is no cheque, are left to the usual routing', () => {
        expect(settleCheque({ description: 'CHEQUE BOOK FEE', direction: 'debit', amount: 150, date: '2026-03-14' }, [chq()], opts())).toMatchObject({ action: 'none', fee: true });
        expect(settleCheque({ description: 'KEELLS', direction: 'debit', amount: 150, date: '2026-03-14' }, [chq()], opts())).toMatchObject({ action: 'none', isCheque: false });
    });

    it('a row the owner sent to the Cheque tab by hand is a plain clearing, the way the bank\'s flag says the money went', () => {
        const out = settleCheque({ description: 'Raj Traders Kandy', direction: 'credit', amount: 50000, date: '2026-03-12' }, [], opts({ force: true }));
        expect(out).toMatchObject({ action: 'create', filesIncome: true });
        expect(out.record.type).toBe(IN);
    });

    it('reading the same row again changes nothing (apply the patch, settle again: already)', () => {
        const list = [chq()];
        const first = settleCheque(deposit(), list, opts());
        Object.assign(list[0], first.patch);
        const again = settleCheque(deposit(), list, opts());
        expect(again.action).toBe('already');
        // …by a different door: the same cheque, the same day, no statement key at all
        const elsewhere = settleCheque(deposit(), list, opts({ source: {} }));
        expect(elsewhere.action).toBe('already');
        // a created record is found again too
        const made = settleCheque(deposit({ description: 'CHEQUE DEPOSIT 777555' }), [], opts());
        expect(settleCheque(deposit({ description: 'CHEQUE DEPOSIT 777555' }), [made.record], opts()).action).toBe('already');
    });

    it('deposited, returned, deposited again: three events on one cheque, each recorded once', () => {
        const list = [chq()];
        const a = settleCheque(deposit(), list, opts()); Object.assign(list[0], a.patch);
        expect(list[0].status).toBe('cleared');
        const b = settleCheque(returnRow(), list, opts({ source: { statementKey: 'k2', statementRow: 1 } })); Object.assign(list[0], b.patch);
        expect(list[0]).toMatchObject({ status: 'bounced', bouncedDate: '2026-03-20' });
        const c = settleCheque(deposit({ date: '2026-03-27' }), list, opts({ source: { statementKey: 'k3', statementRow: 1 } }));
        expect(c.action).toBe('clear');
        Object.assign(list[0], c.patch);
        expect(list[0]).toMatchObject({ status: 'cleared', clearedDate: '2026-03-27' });
        expect(list).toHaveLength(1);
    });
});

describe('an income the owner already typed in is not counted twice', () => {
    const cheque = chq();
    const row = deposit();
    it('same amount within a week and it names the cheque (number or payer)', () => {
        expect(incomeCounted(row, cheque, [{ id: 'I1', name: 'Raj Traders cheque', amount: 50000, date: '2026-03-10' }])).toMatchObject({ id: 'I1' });
        expect(incomeCounted(row, cheque, [{ id: 'I2', name: 'Rent', notes: 'cheque 285943', amount: 50000, date: '2026-03-11' }])).toMatchObject({ id: 'I2' });
    });
    it('another amount, another week, a statement-filed row, or an unrelated name is not it', () => {
        expect(incomeCounted(row, cheque, [{ id: 'I1', name: 'Raj Traders cheque', amount: 49000, date: '2026-03-10' }])).toBeNull();
        expect(incomeCounted(row, cheque, [{ id: 'I1', name: 'Raj Traders cheque', amount: 50000, date: '2026-02-01' }])).toBeNull();
        expect(incomeCounted(row, cheque, [{ id: 'I1', name: 'Raj Traders cheque', amount: 50000, date: '2026-03-10', source: 'statement' }])).toBeNull();
        expect(incomeCounted(row, cheque, [{ id: 'I1', name: 'Consulting', amount: 50000, date: '2026-03-10' }])).toBeNull();
        expect(incomeCounted(row, cheque, [])).toBeNull();
    });
});

/* ---- the worker, end to end -------------------------------------------------------------------------------------------------------------------------------------------------------------- */
const src = (n) => { const s = html.indexOf(`function ${n}(`); const from = html.slice(s - 6, s) === 'async ' ? s - 6 : s; return html.slice(from, html.indexOf('\n        }', s) + 10); };
function monthly(user, year = 2026, month = 2) {
    const store = { loans: [], expenses: [], incomeRecv: [], ccinstall: [], cconetime: [], subscriptions: [], cheques: [], ...user };
    const ctx = vm.createContext({ DB: { get: (k) => store[k] || [] }, p2: (n) => String(n).padStart(2, '0'), window: { WFReactive: { incomeIn } }, Date });
    for (const n of ['_loanMethod', '_loanInstallmentMonths', '_scheduledPaymentFor', '_loanBalanceBeforeMonth', 'loanEndDate', 'getLoanMonthlyForDate', '_wfLinkedLoanMonths', 'getCCIMonthlyForDate', '_wfFindLoanDebit', '_wfMonthIsFuture', 'getMonthlyData']) vm.runInContext(src(n), ctx);
    return ctx.getMonthlyData(year, month);
}
const STATEMENT = (rows) => `
HATTON NATIONAL BANK PLC
Statement Period: 01/03/2026 - 31/03/2026
Account Number: 074020012388
Date Value Date Narration Withdrawal (Dr) Deposit (Cr) Balance
01/03/2026 Opening Balance 500,000.00
${rows}
`;
const line = (day, text, dr, cr, bal) => `${day}/03/2026 ${day}/03/2026 ${text} ${dr || ''} ${cr || ''} ${bal}`.replace(/\s+/g, ' ');
const OWNER = { uid: 'u', email: 'owner@example.com' };
const MAIL = 'wf-mail/owner_example_com', SOURCE = `${MAIL}/items/item0`;
function world(user) {
    return createFirestore({
        [MAIL]: { uid: 'u', email: OWNER.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved', name: 'HNB', domain: 'hnb.lk' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], ccinstall: [], loans: [], subscriptions: [], cheques: [], ...user },
        [SOURCE]: { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-04-02T05:00:00Z') },
    });
}
async function drain(w, rows) {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        await runStatementSync({ action: 'drain', db: w.db, owner: OWNER, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [{ password: 'p', bank: 'HNB' }], settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment: async () => ({ bytes: textPdf(STATEMENT(rows).trim().split('\n')), filename: 'statement.pdf', contentSha256: 'x' }) });
    } finally { spy.mockRestore(); }
}
async function file(user, rows) { const w = world(user); await drain(w, rows); return { user: w.data.get('users/u'), item: w.data.get(SOURCE), data: w.data, w }; }
const ledger = (data) => [...data.keys()].filter((k) => k.startsWith('users/u/statementLedger/')).map((k) => data.get(k));

describe('the email worker files cheque rows into the Cheque Tracker, and counts each once', () => {
    it('a deposit of a tracked received cheque: the cheque is cleared, the credit is income once, nothing else is added', async () => {
        const { user, item } = await file({ cheques: [chq({ id: 'R1', no: '285943', release: '2026-03-10', issue: '2026-03-05' })] }, line('12', 'CHEQUE DEPOSIT 285943', '', '50,000.00', '550,000.00'));
        expect(item.status).toBe('filed');
        expect(user.cheques).toHaveLength(1);
        expect(user.cheques[0]).toMatchObject({ id: 'R1', status: 'cleared', clearedDate: '2026-03-12' });
        expect(user.incomeRecv).toHaveLength(1);
        expect(user.incomeRecv[0]).toMatchObject({ amount: 50000 });
        expect(user.expenses).toHaveLength(0);
        expect(monthly(user).totalExp).toBe(0);
    });

    it('a cheque the owner issued, paid: the cheque carries the money — no second expense; the month shows it once', async () => {
        const { user } = await file({ cheques: [{ id: 'I1', no: '000123', party: 'Landlord', type: OUT, amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending' }] }, line('12', 'CHQ 000123 PAID', '25,000.00', '', '475,000.00'));
        expect(user.expenses).toHaveLength(0);
        expect(user.cheques[0]).toMatchObject({ status: 'cleared', clearedDate: '2026-03-12' });
        expect(monthly(user).totalExp).toBe(25000);
    });

    it('a cheque nobody tracked: recorded from the statement with its number; paid-out ones count once in the month', async () => {
        const { user } = await file({}, [line('12', 'CHQ 000123 PAID', '25,000.00', '', '475,000.00'), line('14', 'CHEQUE DEPOSIT RAJ TRADERS 285943', '', '50,000.00', '525,000.00')].join('\n'));
        expect(user.cheques).toHaveLength(2);
        expect(user.cheques.find((c) => c.type === OUT)).toMatchObject({ no: '000123', amount: 25000, status: 'cleared', source: 'statement', clearedDate: '2026-03-12' });
        expect(user.cheques.find((c) => c.type === IN)).toMatchObject({ no: '285943', amount: 50000, status: 'cleared', source: 'statement', party: 'Raj Traders' });
        expect(user.expenses).toHaveLength(0);
        expect(user.incomeRecv).toHaveLength(1);
        expect(monthly(user).totalExp).toBe(25000);
    });

    it('a deposited cheque that comes back: the received cheque is bounced and the debit is the owner\'s expense', async () => {
        const { user } = await file({ cheques: [chq({ id: 'R1', status: 'cleared', clearedDate: '2026-03-12' })], incomeRecv: [{ id: 'I0', name: 'Raj Traders', amount: 50000, date: '2026-03-12', month: '2026-03' }] }, line('20', 'CHQ RTN 285943', '50,000.00', '', '450,000.00'));
        expect(user.cheques).toHaveLength(1);
        expect(user.cheques[0]).toMatchObject({ id: 'R1', status: 'bounced', bouncedDate: '2026-03-20' });
        expect(user.expenses).toHaveLength(1);
        expect(user.expenses[0]).toMatchObject({ amount: 50000 });
        expect(monthly(user).totalExp).toBe(50000);
    });

    it('a cheque the owner issued that is returned: marked bounced, and the credit that brings the money back is not income', async () => {
        const { user } = await file({ cheques: [{ id: 'I1', no: '880011', party: 'Supplier', type: OUT, amount: 64000, issue: '2026-03-01', release: '2026-03-01', status: 'cleared', clearedDate: '2026-03-15' }] }, line('22', 'OUTWARD CHEQUE RETURN 880011', '', '64,000.00', '564,000.00'));
        expect(user.cheques[0]).toMatchObject({ id: 'I1', status: 'bounced', bouncedDate: '2026-03-22' });
        expect(user.incomeRecv).toHaveLength(0);
        expect(monthly(user).totalExp).toBe(0);                     // a bounced cheque is not money paid out
    });

    it('a cheque book fee is the bank charge it is, not a cheque; a restaurant called Chequers is spending', async () => {
        const { user } = await file({ cheques: [chq({ id: 'R1', no: '285943' })] }, [line('05', 'CHEQUE BOOK ISSUE CHARGES', '150.00', '', '499,850.00'), line('06', 'CHEQUERS RESTAURANT COLOMBO', '4,200.00', '', '495,650.00')].join('\n'));
        expect(user.cheques).toHaveLength(1);
        expect(user.cheques[0].status).toBe('pending');
        expect(user.expenses.map((e) => e.amount).sort((a, b) => a - b)).toEqual([150, 4200]);
    });

    it('the same statement read twice changes nothing the second time', async () => {
        const w = world({ cheques: [chq({ id: 'R1', no: '285943' })] });
        const rows = [line('12', 'CHEQUE DEPOSIT 285943', '', '50,000.00', '550,000.00'), line('14', 'CHQ 000123 PAID', '25,000.00', '', '525,000.00'), line('15', 'LOCAL CHEQUE DEPOSIT', '', '33,000.00', '558,000.00')].join('\n');
        await drain(w, rows);
        const once = structuredClone(w.data.get('users/u'));
        expect(once.cheques).toHaveLength(3);
        // the statement mail arrives again (a re-forward): a fresh queue item for the same rows
        w.data.set(SOURCE, { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm1', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-04-03T05:00:00Z') });
        await drain(w, rows);
        const twice = w.data.get('users/u');
        expect(twice.cheques).toHaveLength(3);
        expect(twice.incomeRecv.length).toBe(once.incomeRecv.length);
        expect(twice.expenses.length).toBe(once.expenses.length);
        expect(monthly(twice).totalExp).toBe(monthly(once).totalExp);
    });

    it('two identical number-less cheques on one day are two cheques', async () => {
        const { user } = await file({}, [line('12', 'LOCAL CHEQUE DEPOSIT', '', '33,000.00', '533,000.00'), line('12', 'LOCAL CHEQUE DEPOSIT', '', '33,000.00', '566,000.00')].join('\n'));
        expect(user.cheques).toHaveLength(2);
        expect(user.incomeRecv).toHaveLength(2);
    });

    it('unfiling the statement puts the Cheque Tracker back as it was', async () => {
        const w = world({ cheques: [chq({ id: 'R1', no: '285943', amount: 48000 })] });
        const before = structuredClone(w.data.get('users/u').cheques);
        await drain(w, [line('12', 'CHEQUE DEPOSIT 285943', '', '50,000.00', '550,000.00'), line('14', 'CHQ 000123 PAID', '25,000.00', '', '525,000.00')].join('\n'));
        const filed = w.data.get('users/u');
        expect(filed.cheques).toHaveLength(2);
        expect(filed.cheques.find((c) => c.id === 'R1')).toMatchObject({ status: 'cleared', amount: 50000, prevAmount: 48000 });
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(SOURCE) });
        const back = w.data.get('users/u');
        expect(back.cheques).toHaveLength(1);
        expect(back.cheques[0]).toMatchObject({ id: 'R1', status: 'pending', amount: 48000 });
        expect(back.cheques[0].statementKey).toBeUndefined();
        expect(back.cheques[0].clearedDate).toBeUndefined();
        expect(back.incomeRecv).toHaveLength(0);
        expect(before[0]).toMatchObject({ status: 'pending', amount: 48000 });
    });

    /* a cheque a statement ADDED, then settled by a later statement: unfiling the later one must not take the cheque (nor the earlier statement's record of it) away */
    const OTHER = 'wf-mail/owner_example_com/items/itemA';
    const built = (rowA, rowB, bank = 'HNB') => {
        const created = settleCheque(rowA, [], { id: 'C1', now: '2026-03-14T00:00:00.000Z', source: { statementKey: OTHER, statementRow: 3, bank } });
        const tracked = [{ ...created.record, countedBy: undefined }];
        const settled = settleCheque(rowB, tracked, { id: 'X', now: '2026-03-25T00:00:00.000Z', source: { statementKey: SOURCE, statementRow: 1, bank } });
        Object.assign(tracked[0], settled.patch);
        return tracked;
    };
    it('a cheque statement A added and statement B returned: unfiling B puts it back as A left it, it does not delete it', async () => {
        const tracked = built({ description: 'CHEQUE DEPOSIT 285943', direction: 'credit', amount: 50000, date: '2026-03-12' }, { description: 'CHQ RTN 285943', direction: 'debit', amount: 50000, date: '2026-03-20' });
        expect(tracked[0]).toMatchObject({ source: 'statement', status: 'bounced', statementKey: SOURCE });
        const w = world({ cheques: tracked });
        w.data.set(SOURCE, { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm1', status: 'filed', hasReview: false, filed: true, cursor: 0, receivedMs: Date.parse('2026-04-03T05:00:00Z') });
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(SOURCE) });
        const back = w.data.get('users/u').cheques;
        expect(back).toHaveLength(1);
        expect(back[0]).toMatchObject({ no: '285943', status: 'cleared', clearedDate: '2026-03-12', statementKey: OTHER, statementRow: 3 });
        expect(back[0].bouncedDate).toBeUndefined();
    });

    it('a cheque the owner tracked as cleared and a statement returned: unfiling it brings back the day it cleared', async () => {
        const mine = chq({ id: 'R1', status: 'cleared', clearedDate: '2026-03-12' });
        const w = world({ cheques: [mine] });
        await drain(w, line('20', 'CHQ RTN 285943', '50,000.00', '', '450,000.00'));
        const once = w.data.get('users/u').cheques[0];
        expect(once).toMatchObject({ status: 'bounced', bouncedDate: '2026-03-20' });
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(SOURCE) });
        const back = w.data.get('users/u').cheques[0];
        expect(back).toMatchObject({ id: 'R1', status: 'cleared', clearedDate: '2026-03-12' });
        expect(back.bouncedDate).toBeUndefined();
        expect(back.statementKey).toBeUndefined();
    });

    it('a cheque one statement cleared and then returned goes back to the state before that statement', async () => {
        const w = world({ cheques: [chq({ id: 'R1' })] });
        await drain(w, [line('12', 'CHEQUE DEPOSIT 285943', '', '50,000.00', '550,000.00'), line('20', 'CHQ RTN 285943', '50,000.00', '', '500,000.00')].join('\n'));
        expect(w.data.get('users/u').cheques[0]).toMatchObject({ status: 'bounced' });
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(SOURCE) });
        const back = w.data.get('users/u').cheques[0];
        expect(back).toMatchObject({ id: 'R1', status: 'pending' });
        expect(back.clearedDate).toBeUndefined();
        expect(back.bouncedDate).toBeUndefined();
    });

    it('a ledger line is written for every cheque row so the statement\'s totals add up', async () => {
        const { data } = await file({}, [line('12', 'CHQ 000123 PAID', '25,000.00', '', '475,000.00'), line('14', 'CHEQUE DEPOSIT RAJ TRADERS 285943', '', '50,000.00', '525,000.00')].join('\n'));
        const entries = ledger(data);
        expect(entries).toHaveLength(2);
        expect(entries.every((e) => e.module === 'cheque' || e.module === 'incomeRecv')).toBe(true);
    });
});

/* ---- a payment the owner ALSO typed in (or pasted from an SMS) is still one payment --------------------------------------------------------------------------------------------------- */
describe('a cheque the bank paid and an expense the owner typed for it count once', () => {
    const typed = (extra = {}) => ({ id: 'T1', desc: 'Rent - Landlord', amount: 25000, date: '2026-03-12', month: '2026-03', cat: 'Rent', ...extra });
    const issued = (extra = {}) => ({ id: 'I1', no: '000123', party: 'Landlord', type: OUT, amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending', ...extra });
    const paid = line('12', 'CHQ 000123 PAID', '25,000.00', '', '475,000.00');

    it('typed first, the cheque untracked: the statement adds the cheque for the record and the expense counts the money', async () => {
        const { user } = await file({ expenses: [typed()] }, paid);
        expect(user.expenses).toHaveLength(1);
        expect(user.cheques).toHaveLength(1);
        expect(user.cheques[0]).toMatchObject({ no: '000123', type: OUT, status: 'cleared', source: 'statement', countedBy: 'T1' });
        expect(user.expenses[0].statementTwin).toBeTruthy();
        expect(monthly(user).totalExp).toBe(25000);                  // not 50,000
    });

    it('typed first, the cheque tracked: the cheque clears, the expense counts the money', async () => {
        const { user } = await file({ expenses: [typed()], cheques: [issued()] }, paid);
        expect(user.cheques[0]).toMatchObject({ id: 'I1', status: 'cleared', countedBy: 'T1' });
        expect(monthly(user).totalExp).toBe(25000);
    });

    it('an expense pasted from the bank\'s SMS is the same thing', async () => {
        const sms = typed({ id: 'S1', desc: 'Cheque 000123 debited', source: 'sms' });
        const { user } = await file({ expenses: [sms], cheques: [issued()] }, paid);
        expect(user.cheques[0]).toMatchObject({ status: 'cleared', countedBy: 'S1' });
        expect(monthly(user).totalExp).toBe(25000);
    });

    it('a different amount or day is another payment: both count', async () => {
        const { user } = await file({ expenses: [typed({ amount: 24000 })], cheques: [issued()] }, paid);
        expect(user.cheques[0].countedBy).toBeUndefined();
        expect(monthly(user).totalExp).toBe(49000);
        const far = await file({ expenses: [typed({ date: '2026-03-02' })] }, paid);
        expect(far.user.cheques[0].countedBy).toBeUndefined();
        expect(monthly(far.user).totalExp).toBe(50000);
    });

    it('two typed expenses that fit equally are never guessed between', async () => {
        const { user } = await file({ expenses: [typed(), typed({ id: 'T2' })] }, paid);
        expect(user.cheques[0].countedBy).toBeUndefined();
    });

    it('the cheque the typed entry stands behind comes back: the credit offsets that entry, so the month does not count a payment that did not happen', async () => {
        const sheet = [paid, line('20', 'CHQ 000123 RETURNED', '', '25,000.00', '500,000.00')].join('\n');
        const { user } = await file({ expenses: [typed()], cheques: [issued()] }, sheet);
        expect(user.cheques[0]).toMatchObject({ id: 'I1', status: 'bounced', bouncedDate: '2026-03-20' });
        expect(user.expenses).toHaveLength(1);                                   // the owner's entry is never touched
        expect(user.incomeRecv).toHaveLength(1);
        expect(user.incomeRecv[0]).toMatchObject({ amount: 25000, date: '2026-03-20' });
        const month = monthly(user);
        const credited = user.incomeRecv.reduce((sum, row) => sum + row.amount, 0);
        expect(month.totalExp - credited).toBe(0);                               // paid out 25,000, got 25,000 back
    });

    it('an issued cheque that carried the money itself and comes back: the credit is not income (nothing else counts the payment)', async () => {
        const { user } = await file({ cheques: [issued()] }, [paid, line('20', 'CHQ 000123 RETURNED', '', '25,000.00', '500,000.00')].join('\n'));
        expect(user.cheques[0]).toMatchObject({ status: 'bounced' });
        expect(user.incomeRecv).toHaveLength(0);
        expect(monthly(user).totalExp).toBe(0);
    });

    it('the typed entry is deleted later: the cheque carries the money again', async () => {
        const { user } = await file({ expenses: [typed()], cheques: [issued()] }, paid);
        expect(monthly({ ...user, expenses: [] }).totalExp).toBe(25000);
        expect(monthly(user).totalExp).toBe(25000);
    });

    it('typed AFTER the statement filed the cheque: the periodic pass links them and the month counts the payment once', async () => {
        const { user, w } = await file({ cheques: [issued()] }, paid);
        expect(monthly(user).totalExp).toBe(25000);
        // the owner now types the payment in
        w.data.set('users/u', { ...user, expenses: [typed({ id: 'T9' })] });
        expect(monthly(w.data.get('users/u')).totalExp).toBe(50000);
        const first = await healChequeTwins({ db: w.db, uid: 'u', log: () => {} });
        expect(first.merged).toBe(1);
        const healed = w.data.get('users/u');
        expect(healed.cheques[0]).toMatchObject({ status: 'cleared', countedBy: 'T9', no: '000123' });
        expect(healed.expenses[0].id).toBe('T9');
        expect(healed.expenses[0].statementTwin).toBeTruthy();
        expect(monthly(healed).totalExp).toBe(25000);
        expect((await healChequeTwins({ db: w.db, uid: 'u', log: () => {} })).merged).toBe(0);      // again: nothing more
    });

    it('the statement is unfiled and read again: the typed entry is linked afresh and the payment still counts once', async () => {
        const w = world({ expenses: [typed()], cheques: [issued()] });
        await drain(w, paid);
        const first = w.data.get('users/u');
        expect(first.cheques[0]).toMatchObject({ status: 'cleared', countedBy: 'T1' });
        expect(first.expenses[0].statementTwin).toBeTruthy();
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(SOURCE) });
        const back = w.data.get('users/u');
        expect(back.cheques[0]).toMatchObject({ id: 'I1', status: 'pending' });
        expect(back.cheques[0].countedBy).toBeUndefined();
        expect(back.expenses[0].statementTwin).toBeUndefined();     // the typed entry stands for no row of a statement that is gone
        w.data.set(SOURCE, { uid: 'u', bank: 'HNB', filename: 'statement.pdf', from: 'statements@hnb.lk', messageId: 'm1', status: 'pending', hasReview: false, filed: false, cursor: 0, receivedMs: Date.parse('2026-04-03T05:00:00Z') });
        await drain(w, paid);
        const again = w.data.get('users/u');
        expect(again.cheques[0]).toMatchObject({ status: 'cleared', countedBy: 'T1' });
        expect(again.expenses).toHaveLength(1);
        expect(monthly(again).totalExp).toBe(25000);                // not 50,000
    });

    it('the cheque was untracked and the statement is unfiled: the typed entry is freed as well', async () => {
        const w = world({ expenses: [typed()] });
        await drain(w, paid);
        expect(w.data.get('users/u').expenses[0].statementTwin).toBeTruthy();
        await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(SOURCE) });
        const back = w.data.get('users/u');
        expect(back.cheques).toHaveLength(0);
        expect(back.expenses).toHaveLength(1);
        expect(back.expenses[0].statementTwin).toBeUndefined();
        expect(monthly(back).totalExp).toBe(25000);
    });

    it('a cheque the owner marked cleared by hand (no statement) is never linked by guess', async () => {
        const w = world({ cheques: [issued({ status: 'cleared', clearedDate: '2026-03-12' })], expenses: [typed()] });
        expect((await healChequeTwins({ db: w.db, uid: 'u', log: () => {} })).merged).toBe(0);
    });

    it('a received cheque is never linked to an expense', async () => {
        const w = world({ cheques: [chq({ status: 'cleared', clearedDate: '2026-03-12', statementKey: 'k', statementRow: 1 })], expenses: [typed({ amount: 50000 })] });
        expect((await healChequeTwins({ db: w.db, uid: 'u', log: () => {} })).merged).toBe(0);
    });
});

/* ---- the manual upload, run for real ------------------------------------------------------------------------------------------------------------------------------------------------- */
/* The page files an uploaded statement inside one very long function, so the cheque branch is cut out of index.html itself and run here with the page's own helpers stubbed; what it does to the
 * Cheque Tracker, Income and Expenses is what the owner sees. The batch log (Undo) is the real wealthflow-batches.js. */
describe('the manual upload files cheque rows the same way', () => {
    const start = html.indexOf("} else if (dest === 'cheque') {");
    const end = html.indexOf("} else {\n                        skipped++; // skip", start);
    const BRANCH = html.slice(start + "} else if (dest === 'cheque') {".length, end);
    const BATCHES = read('wealthflow-batches.js');
    const nz = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

    function upload(user, rows, { bank = 'Hatton National Bank', key = 'stmt-1', claim = 'claim-1' } = {}) {
        const state = structuredClone({ cheques: [], incomeRecv: [], expenses: [], importBatches: [], ...user });
        const DB = { get: (k) => state[k], set: (k, v) => { state[k] = structuredClone(v); } };
        const win = { DB, console: { log() {}, info() {}, warn() {}, error() {} }, WFCheques: Cheques };
        const quiet = vi.spyOn(console, 'log').mockImplementation(() => {});
        try { new Function('window', BATCHES)(win); } finally { quiet.mockRestore(); }
        let n = 0;
        const uid = () => 'new' + (++n);
        const chequeArr = state.cheques.slice(), incRecvArr = state.incomeRecv.slice(), expArr = state.expenses.slice();
        const before = new Map([[incRecvArr, incRecvArr.slice()], [expArr, expArr.slice()]]);
        let curNth = 1;
        const dupIn = (list, d, a, name, amtKey, src) => {
            src = src || {};
            const held = (before.get(list) || list).filter((r) => r.date === d && Math.abs(((r[amtKey] != null ? r[amtKey] : r.amount) || 0) - a) < 0.01 && nz(r.desc || r.name) === nz(name) &&
                !(src.statementKey && r.statementKey && src.statementKey !== r.statementKey)).length;
            return held >= curNth;
        };
        const run = new Function('window', '_bankShown', 'uid', 'incRecvArr', 'expArr', 'chequeArr', '_noteFor', '_dupIn', 'rows', 'bank', 'WFBatch', 'getCur', 'setCur', `
            let dup = 0, chq = 0, chqNew = 0, chqCleared = 0, chqBounced = 0, inc = 0, exp = 0, _chequesDirty = false, _expLinked = false; const chqReview = [];
            const _batch = WFBatch.begin('stmt', 'statement');
            rows.forEach((t, i) => {
                setCur(t._nth || 1);
                const date = t.date, desc = t.description, amount = t.amount, month = date.slice(0, 7), past = true;
                const _source = { statementKey: t._statementKey, statementRow: t._statementRow, bank: bank, card_last4: '', ref: '', uploadClaim: t._claim };
                (function () { ${BRANCH} })();
            });
            WFBatch.commit(_batch);
            return { dup, chq, chqNew, chqCleared, chqBounced, inc, exp, dirty: _chequesDirty, review: chqReview, batch: _batch };
        `);
        const counts = {};
        const seen = new Map();
        const prepared = rows.map((r, i) => { const k = r.date + '|' + r.amount + '|' + nz(r.description); seen.set(k, (seen.get(k) || 0) + 1); return { ...r, _nth: seen.get(k), _statementKey: key, _statementRow: i + 1, _claim: claim }; });
        const out = run(win, (b) => b, uid, incRecvArr, expArr, chequeArr, () => '', dupIn, prepared, bank, win.WFBatch, () => curNth, (v) => { curNth = v; });
        state.cheques = chequeArr; state.incomeRecv = incRecvArr; state.expenses = expArr;
        return { state, out, undo: () => win.WFBatch.undo(out.batch.id), win, DB };
    }
    const r = (description, direction, amount, date) => ({ description, direction, amount, date });

    it('a deposit of a tracked cheque clears it, adds the income once, and does not add the cheque again', () => {
        const { state, out } = upload({ cheques: [chq({ id: 'R1' })] }, [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12')]);
        expect(state.cheques).toHaveLength(1);
        expect(state.cheques[0]).toMatchObject({ id: 'R1', status: 'cleared', clearedDate: '2026-03-12' });
        expect(state.incomeRecv).toHaveLength(1);
        expect(state.incomeRecv[0]).toMatchObject({ amount: 50000, source: 'statement' });
        expect(state.expenses).toHaveLength(0);
        expect(out).toMatchObject({ chq: 1, chqCleared: 1, inc: 1, dup: 0 });
    });

    it('a cheque paid out clears the issued cheque and adds no expense; the month counts it once', () => {
        const issued = { id: 'I1', no: '000123', party: 'Landlord', type: OUT, amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending' };
        const { state } = upload({ cheques: [issued] }, [r('CHQ 000123 PAID', 'debit', 25000, '2026-03-12')]);
        expect(state.cheques[0]).toMatchObject({ status: 'cleared', clearedDate: '2026-03-12' });
        expect(state.expenses).toHaveLength(0);
        expect(monthly({ cheques: state.cheques }).totalExp).toBe(25000);
    });

    it('a returned deposit bounces the cheque and costs the owner the debit', () => {
        const { state, out } = upload({ cheques: [chq({ id: 'R1', status: 'cleared', clearedDate: '2026-03-12' })] }, [r('CHQ RTN 285943', 'debit', 50000, '2026-03-20')]);
        expect(state.cheques[0]).toMatchObject({ status: 'bounced', bouncedDate: '2026-03-20' });
        expect(state.expenses).toHaveLength(1);
        expect(state.expenses[0]).toMatchObject({ amount: 50000, cat: 'Banking' });
        expect(out.chqBounced).toBe(1);
    });

    it('a cheque not in the tracker is added with its number, cleared; a deposit also becomes income', () => {
        const { state } = upload({}, [r('CHEQUE DEPOSIT RAJ TRADERS 285943', 'credit', 50000, '2026-03-12'), r('CHQ 000123 PAID', 'debit', 25000, '2026-03-14')]);
        expect(state.cheques.map((c) => [c.no, c.type, c.status]).sort()).toEqual([['000123', OUT, 'cleared'], ['285943', IN, 'cleared']]);
        expect(state.incomeRecv).toHaveLength(1);
        expect(state.expenses).toHaveLength(0);
    });

    it('uploading the same statement twice changes nothing the second time', () => {
        const rows = [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12'), r('CHQ 000123 PAID', 'debit', 25000, '2026-03-14'), r('LOCAL CHEQUE DEPOSIT', 'credit', 33000, '2026-03-15')];
        const first = upload({ cheques: [chq({ id: 'R1' })] }, rows);
        const second = upload(first.state, rows, { claim: 'claim-2' });
        expect(second.state.cheques).toHaveLength(first.state.cheques.length);
        expect(second.state.incomeRecv).toHaveLength(first.state.incomeRecv.length);
        expect(second.state.expenses).toHaveLength(first.state.expenses.length);
        expect(second.out.dup).toBe(3);
    });

    it('two identical number-less cheques on one day are two cheques, not one', () => {
        const { state } = upload({}, [r('LOCAL CHEQUE DEPOSIT', 'credit', 33000, '2026-03-12'), r('LOCAL CHEQUE DEPOSIT', 'credit', 33000, '2026-03-12')]);
        expect(state.cheques).toHaveLength(2);
        expect(state.incomeRecv).toHaveLength(2);
    });

    it('an income the owner typed in for that cheque is not counted a second time', () => {
        const typed = { id: 'T1', name: 'Raj Traders cheque', amount: 50000, date: '2026-03-10', month: '2026-03', type: 'Other' };
        const { state, out } = upload({ cheques: [chq({ id: 'R1' })], incomeRecv: [typed] }, [r('CHEQUE DEPOSIT RAJ TRADERS 285943', 'credit', 50000, '2026-03-12')]);
        expect(state.incomeRecv).toHaveLength(1);
        expect(state.cheques[0].status).toBe('cleared');
        expect(out.review.join(' ')).toContain('already in Income');
    });

    it('a fee about a cheque is not in this branch (it is routed as the bank charge it is)', () => {
        const { state } = upload({ cheques: [chq({ id: 'R1' })] }, [r('CHEQUE BOOK ISSUE CHARGES', 'debit', 150, '2026-03-05')]);
        // the branch is only reached for rows routed to the Cheque tab; if one arrives anyway (the owner moved it there by hand) it is a plain clearing and never changes the pending cheque
        expect(state.cheques.find((c) => c.id === 'R1').status).toBe('pending');
    });

    it('Undo puts every cheque, income and expense of the upload back', () => {
        const before = { cheques: [chq({ id: 'R1' }), chq({ id: 'R2', no: '777000', amount: 12000, party: 'Silva' })], incomeRecv: [], expenses: [] };
        const up = upload(before, [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12'), r('CHQ RTN 777000', 'debit', 12000, '2026-03-20'), r('CHQ 000123 PAID', 'debit', 25000, '2026-03-14')]);
        expect(up.state.cheques.length).toBeGreaterThan(2);
        const undone = up.undo();
        expect(undone).not.toBeNull();
        expect(up.DB.get('cheques').map((c) => c.id).sort()).toEqual(['R1', 'R2']);
        expect(up.DB.get('cheques').find((c) => c.id === 'R1')).toMatchObject({ status: 'pending' });
        expect(up.DB.get('cheques').find((c) => c.id === 'R1').statementKey).toBeUndefined();
        expect(up.DB.get('cheques').find((c) => c.id === 'R2')).toMatchObject({ status: 'pending' });
    });

    it('Undo leaves a cheque the owner edited after the upload, even when its status is unchanged', () => {
        const up = upload({ cheques: [chq({ id: 'R1' }), chq({ id: 'R2', no: '777000', amount: 12000, party: 'Silva' })] }, [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12'), r('CHEQUE DEPOSIT 777000', 'credit', 12000, '2026-03-12')]);
        expect(up.DB.get('cheques').map((c) => c.status)).toEqual(['cleared', 'cleared']);
        // the owner corrects the payer of R1 and the amount of R2 afterwards; both stay cleared
        up.DB.set('cheques', up.DB.get('cheques').map((c) => (c.id === 'R1' ? { ...c, party: 'Raj Traders (Pvt) Ltd' } : c.id === 'R2' ? { ...c, notes: 'banked at Galle branch' } : c)));
        up.undo();
        const after = up.DB.get('cheques');
        expect(after.find((c) => c.id === 'R1')).toMatchObject({ status: 'cleared', party: 'Raj Traders (Pvt) Ltd' });
        expect(after.find((c) => c.id === 'R2')).toMatchObject({ status: 'cleared', notes: 'banked at Galle branch' });
    });

    it('Undo still restores a cheque that only gained the system\'s own stamps', () => {
        const up = upload({ cheques: [chq({ id: 'R1' })] }, [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12')]);
        up.DB.set('cheques', up.DB.get('cheques').map((c) => ({ ...c, countedBy: 'T1', _ut: 123 })));
        up.undo();
        expect(up.DB.get('cheques').find((c) => c.id === 'R1')).toMatchObject({ status: 'pending' });
    });

    describe('a payment the owner also typed into Expenses is still one payment', () => {
        const typed = (extra = {}) => ({ id: 'T1', desc: 'Rent - Landlord', amount: 25000, date: '2026-03-12', month: '2026-03', cat: 'Rent', ...extra });
        const issued = (extra = {}) => ({ id: 'I1', no: '000123', party: 'Landlord', type: OUT, amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending', ...extra });
        const paid = [r('CHQ 000123 PAID', 'debit', 25000, '2026-03-12')];

        it('the tracked cheque is cleared and linked to the typed entry; the month counts the payment once; Undo frees both', () => {
            const up = upload({ cheques: [issued()], expenses: [typed()] }, paid);
            expect(up.state.cheques[0]).toMatchObject({ id: 'I1', status: 'cleared', countedBy: 'T1' });
            expect(up.state.expenses).toHaveLength(1);
            expect(up.state.expenses[0].statementTwin).toMatchObject({ date: '2026-03-12', cents: 2500000 });
            expect(monthly(up.state).totalExp).toBe(25000);                       // not 50,000
            up.undo();
            expect(up.DB.get('cheques')[0]).toMatchObject({ id: 'I1', status: 'pending' });
            expect(up.DB.get('cheques')[0].countedBy).toBeUndefined();
            expect(up.DB.get('expenses')).toHaveLength(1);
            expect(up.DB.get('expenses')[0].statementTwin).toBeUndefined();
        });

        it('a cheque nobody tracked is added for the record and linked the same way', () => {
            const up = upload({ expenses: [typed()] }, paid);
            expect(up.state.cheques).toHaveLength(1);
            expect(up.state.cheques[0]).toMatchObject({ no: '000123', status: 'cleared', source: 'statement', countedBy: 'T1' });
            expect(monthly(up.state).totalExp).toBe(25000);
            up.undo();
            expect(up.DB.get('cheques')).toHaveLength(0);
            expect(up.DB.get('expenses')[0].statementTwin).toBeUndefined();
        });

        it('a different amount or a different week is another payment: nothing is linked', () => {
            const a = upload({ cheques: [issued()], expenses: [typed({ amount: 24000 })] }, paid);
            expect(a.state.cheques[0].countedBy).toBeUndefined();
            expect(monthly(a.state).totalExp).toBe(49000);
            const b = upload({ cheques: [issued()], expenses: [typed({ date: '2026-03-02' })] }, paid);
            expect(b.state.cheques[0].countedBy).toBeUndefined();
        });

        it('two typed entries that fit equally are never guessed between, and a received cheque is never linked', () => {
            const two = upload({ cheques: [issued()], expenses: [typed(), typed({ id: 'T2' })] }, paid);
            expect(two.state.cheques[0].countedBy).toBeUndefined();
            const received = upload({ cheques: [chq({ id: 'R1' })], expenses: [typed({ amount: 50000 })] }, [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12')]);
            expect(received.state.cheques[0].countedBy).toBeUndefined();
            expect(received.state.expenses[0].statementTwin).toBeUndefined();
        });

        it('the cheque comes back in a later upload: the credit is filed as income and offsets the typed entry', () => {
            const first = upload({ cheques: [issued()], expenses: [typed()] }, paid);
            const back = upload(first.state, [r('CHQ 000123 RETURNED', 'credit', 25000, '2026-03-20')], { key: 'stmt-2', claim: 'claim-2' });
            expect(back.state.cheques[0]).toMatchObject({ status: 'bounced' });
            expect(back.state.expenses).toHaveLength(1);
            expect(back.state.incomeRecv).toHaveLength(1);
            expect(back.state.incomeRecv[0]).toMatchObject({ amount: 25000 });
        });

        it('uploaded twice, the payment is still counted once and the entry stands for one row', () => {
            const first = upload({ cheques: [issued()], expenses: [typed()] }, paid);
            const second = upload(first.state, paid, { claim: 'claim-2' });
            expect(second.state.cheques).toHaveLength(1);
            expect(second.state.expenses).toHaveLength(1);
            expect(monthly(second.state).totalExp).toBe(25000);
        });

        it('the page and the email worker pick the same typed entry for the same payment', async () => {
            const w = await file({ cheques: [issued()], expenses: [typed()] }, line('12', 'CHQ 000123 PAID', '25,000.00', '', '475,000.00'));
            const up = upload({ cheques: [issued()], expenses: [typed()] }, paid);
            expect(up.state.cheques[0].countedBy).toBe(w.user.cheques[0].countedBy);
            expect(Object.keys(up.state.expenses[0].statementTwin).sort()).toEqual(Object.keys(w.user.expenses[0].statementTwin).sort());
        });
    });

    it('one statement through both doors: the Cheque Tracker holds each cheque once, whichever came first', async () => {
        const rows = [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12'), r('CHQ 000123 PAID', 'debit', 25000, '2026-03-14'), r('LOCAL CHEQUE DEPOSIT', 'credit', 33000, '2026-03-15'), r('CHQ RTN 285943', 'debit', 50000, '2026-03-20')];
        const sheet = [line('12', 'CHEQUE DEPOSIT 285943', '', '50,000.00', '550,000.00'), line('14', 'CHQ 000123 PAID', '25,000.00', '', '525,000.00'), line('15', 'LOCAL CHEQUE DEPOSIT', '', '33,000.00', '558,000.00'), line('20', 'CHQ RTN 285943', '50,000.00', '', '508,000.00')].join('\n');
        const alone = (await file({}, sheet)).user.cheques.length;
        const pageFirst = upload({}, rows).state;
        const afterPage = (await file({ cheques: pageFirst.cheques, incomeRecv: pageFirst.incomeRecv, expenses: pageFirst.expenses }, sheet)).user;
        expect(afterPage.cheques).toHaveLength(alone);
        const workerFirst = (await file({}, sheet)).user;
        const afterWorker = upload({ cheques: workerFirst.cheques, incomeRecv: workerFirst.incomeRecv, expenses: workerFirst.expenses }, rows, { key: 'stmt-2', claim: 'claim-2' }).state;
        expect(afterWorker.cheques).toHaveLength(alone);
        const shape = (u) => u.cheques.map((c) => `${c.no || '-'}|${c.type}|${c.status}|${c.amount}`).sort();
        expect(shape(afterPage)).toEqual(shape(workerFirst));
        expect(shape(afterWorker)).toEqual(shape(workerFirst));
    });

    it('the page and the worker file the same rows to the same result', async () => {
        const rows = [r('CHEQUE DEPOSIT 285943', 'credit', 50000, '2026-03-12'), r('CHQ 000123 PAID', 'debit', 25000, '2026-03-14'), r('LOCAL CHEQUE DEPOSIT', 'credit', 33000, '2026-03-15'), r('CHQ RTN 285943', 'debit', 50000, '2026-03-20')];
        const tracked = () => [chq({ id: 'R1' }), { id: 'I1', no: '000123', party: 'Landlord', type: OUT, amount: 25000, issue: '2026-03-10', release: '2026-03-10', status: 'pending' }];
        const page = upload({ cheques: tracked() }, rows).state;
        const sheet = [line('12', 'CHEQUE DEPOSIT 285943', '', '50,000.00', '550,000.00'), line('14', 'CHQ 000123 PAID', '25,000.00', '', '525,000.00'), line('15', 'LOCAL CHEQUE DEPOSIT', '', '33,000.00', '558,000.00'), line('20', 'CHQ RTN 285943', '50,000.00', '', '508,000.00')].join('\n');
        const { user: worker } = await file({ cheques: tracked() }, sheet);
        const shape = (u) => ({
            cheques: u.cheques.map((c) => `${c.no || '-'}|${c.type}|${c.status}|${c.amount}`).sort(),
            income: u.incomeRecv.map((i) => i.amount).sort((a, b) => a - b),
            expenses: u.expenses.map((e) => e.amount).sort((a, b) => a - b),
        });
        expect(shape(page)).toEqual(shape(worker));
        expect(monthly(page).totalExp).toBe(monthly(worker).totalExp);
    });
});

/* ---- the page ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
describe('the page', () => {
    it('loads the cheque reader before anything that asks it', () => {
        const cheques = html.indexOf('src="wealthflow-cheques.js"');
        expect(cheques).toBeGreaterThan(0);
        expect(html.slice(cheques - 30, cheques)).toContain('type="module"');
        // the router reads window.WFCheques lazily, but the filing step does at once: the module tag comes first in the document
        const route = html.indexOf('src="wealthflow-route.js"');
        expect(route).toBeGreaterThan(0);
        expect(html.slice(html.indexOf('</script>', cheques)).includes('wealthflow-route.js')).toBe(true);
    });
    it('the router has no cheque rules of its own any more — it asks the one reader', () => {
        const router = read('wealthflow-route.js');
        expect(router).toContain('WFCheques');
        expect(router).not.toMatch(/RE_CHEQUE\b/);
    });
    it('the page file step settles a cheque row through the same decision the worker uses', () => {
        expect(html).toContain('settleCheque(');
        expect(html).toContain("dest === 'cheque'");
        const worker = read('statement-ledger.mjs');
        expect(worker).toContain('settleCheque');
    });
    it('cheques can be undone with the rest of an upload', () => {
        const batches = read('wealthflow-batches.js');
        expect(batches).toContain('recordCheque');
        expect(batches).toContain('_undoCheques');
    });
    it('the module is also exposed on window for the page', () => {
        expect(Object.keys(Cheques).sort()).toEqual(['incomeCounted', 'matchTracked', 'normNo', 'partyFrom', 'readCheque', 'sameBank', 'sameNo', 'settleCheque', 'stampTwin', 'typedTwin']);
    });
});
