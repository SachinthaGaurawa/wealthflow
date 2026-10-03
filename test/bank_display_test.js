import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { INSTITUTIONS, PICKER, displayBank, canonicalBank, institutionFor } from '../wealthflow-institutions.js';
import { nameFromDomain } from '../wealthflow-mail-ingest.mjs';
import { bankIdentity } from '../statement-coverage.mjs';

/* =============================================================================
 * A BANK IS WRITTEN BY ITS OWN NAME — AND ONLY WHERE IT IS READ.
 * The email sync labels a statement from the sender's mail domain ("dfccbank.com" -> "Dfccbank"). That label is a key — the books, the card walk and the registry group by it — so it is
 * never rewritten; but the review screen printed it as the bank's name: "AI extracted 21 transactions — Dfccbank". displayBank() is the one place that turns a label into the name,
 * strictly (never a substring, never a different bank), and these tests hold both halves: every bank reads right, and nothing that is stored can drift because of it.
 * ===========================================================================*/

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const shownAs = (inst) => inst.mailName || inst.name;   // NTB has two picker entries; a label that names neither product is the issuer

describe('displayBank: every bank the app lists is written by its own name, however its label was made', () => {
    for (const inst of INSTITUTIONS) {
        it(`${inst.name}`, () => {
            /* what the picker stores, exactly: a name that already carries its product keeps it */
            expect(displayBank(inst.name)).toBe(inst.name);
            const forms = new Set();
            for (const t of inst.tokens) {
                forms.add(t); forms.add(t.toUpperCase()); forms.add(`${t.replace(/ /g, '')}`);
                if (!/bank$/.test(t)) { forms.add(`${t} bank`); forms.add(`${t}bank`); }                  // "Dfcc Bank", "Dfccbank" (a token that already ends in bank is not suffixed twice)
                forms.add(t.charAt(0).toUpperCase() + t.slice(1).replace(/ /g, ''));                  // "Dfcc", "Nationstrust"
            }
            forms.add(inst.name.toUpperCase()); forms.add(inst.name.toLowerCase());
            if (inst.mailName) forms.add(inst.mailName);
            for (const d of inst.domains) forms.add(nameFromDomain(d));                                   // what the mail sync writes for a verified domain
            for (const label of forms) {
                /* an exact picker name of a product keeps its product; everything else is the institution's one name */
                const want = INSTITUTIONS.find((i) => i.name.toLowerCase() === label.toLowerCase()) ? INSTITUTIONS.find((i) => i.name.toLowerCase() === label.toLowerCase()).name : shownAs(inst);
                expect(displayBank(label), JSON.stringify(label)).toBe(want);
            }
        });
    }

    it('the label the email sync writes for a domain it does not list ("dfccbank.com") is the bank\'s name', () => {
        expect(nameFromDomain('dfccbank.com')).toBe('Dfccbank');
        expect(displayBank(nameFromDomain('dfccbank.com'))).toBe('DFCC Bank');
        expect(displayBank(nameFromDomain('hnb.lk'))).toBe('Hatton National Bank (HNB)');
        expect(displayBank(nameFromDomain('sampathbank.lk'))).toBe('Sampath Bank');
        expect(displayBank(nameFromDomain('commercialbank.lk'))).toBe('Commercial Bank');
        expect(displayBank(nameFromDomain('nationstrust.com'))).toBe('Nations Trust Bank (NTB)');
        expect(displayBank(nameFromDomain('boc.lk'))).toBe('Bank of Ceylon (BOC)');
        expect(displayBank(nameFromDomain('seylan.lk'))).toBe('Seylan Bank');
        expect(displayBank(nameFromDomain('unionb.com'))).toBe('Unionb');                                    // not a name the app knows: left as written
    });

    it('the names it prints are the names the picker already uses, so a screen and the list never disagree', () => {
        const allowed = new Set([...PICKER, ...INSTITUTIONS.filter((i) => i.mailName).map((i) => i.mailName)]);
        for (const inst of INSTITUTIONS) for (const t of inst.tokens) expect(allowed.has(displayBank(t)), t).toBe(true);
    });

    it('is idempotent and total', () => {
        for (const x of ['Dfccbank', 'DFCC Bank', 'Hnb', 'Nationstrust', 'Cargills Bank', 'Pan', '', '  ']) expect(displayBank(displayBank(x))).toBe(displayBank(x));
        for (const bad of [undefined, null, 0, 12, {}, [], NaN, false]) expect(() => displayBank(bad)).not.toThrow();
        expect(displayBank(undefined)).toBe('');
        expect(displayBank(null)).toBe('');
    });
});

describe('displayBank never names the wrong bank', () => {
    it('a bank that is only CLOSE to a listed one is left exactly as it was written', () => {
        for (const label of ['Pan', 'Union', 'National Bank', 'Bank', 'Ceylon', 'Commercial', 'Asia Bank', 'Sampath Bank PLC', 'Pan Asia Banking Corp', 'Cargills Bank', 'ABC Bank', 'Hatton', 'DFCC Finance', 'Nations Trust Finance']) {
            const out = displayBank(label);
            /* "Union" and "Commercial" ARE one bank's own short names; the rest are not any bank's */
            if (['Union', 'Commercial'].includes(label)) continue;
            expect(out, label).toBe(label);
        }
    });
    it('a label that is already another institution\'s exact name is never rewritten into a neighbour', () => {
        for (const a of INSTITUTIONS) for (const b of INSTITUTIONS) if (a !== b && a.name !== b.name) expect(displayBank(a.name)).not.toBe(shownAs(b));
    });
    it('AMEX folds the way the rest of the app folds it', () => {
        for (const x of ['Amex', 'AMEX', 'American Express', 'Americanexpress', 'American Express (AMEX)']) expect(displayBank(x), x).toBe('American Express (AMEX)');
        expect(displayBank('Nations Trust Bank (NTB) — AMEX')).toBe('Nations Trust Bank (NTB) — AMEX');
    });
});

describe('what is STORED does not change', () => {
    it('the registry lock treats the label and its display name as one bank — so nothing about the lock moves', () => {
        for (const label of ['Dfccbank', 'Hnb', 'Sampathbank', 'Commercialbank', 'Nationstrust', 'Seylanbank', 'Peoplesbank', 'Unionbank', 'Panasia']) {
            expect(bankIdentity(label).id, label).toBe(bankIdentity(displayBank(label)).id);
        }
    });
    it('displayBank is used only where a bank is READ — never by the code that writes a label or builds a key', () => {
        for (const f of ['statement-ledger.mjs', 'cc-fifo.mjs', 'statement-coverage.mjs', 'statement-registry.mjs', 'wealthflow-bank-detect.js', 'wealthflow-mail-ingest.mjs', 'wealthflow-accounts.js', 'wealthflow-card-registry.js']) {
            if (fs.existsSync(path.join(ROOT, f))) expect(read(f), f).not.toMatch(/displayBank/);
        }
        /* canonicalBank (what the ledger writes, what the card walk keys on) is unchanged: it folds American Express and nothing else */
        expect(canonicalBank('Dfccbank')).toBe('Dfccbank');
        expect(canonicalBank('Amex')).toBe('American Express (AMEX)');
        expect(institutionFor('Dfccbank')).toBeNull();
    });
    it('the screens that read a bank print its name, through the one helper; the keys they filter and group by are the stored ones', () => {
        const html = read('index.html');
        expect(html).toMatch(/function _bankShown\(n\)[^\n]*displayBank/);
        /* the card filter chip: label by name, filter by key */
        expect(html).toMatch(/banks\.map\(b => chip\(b, _wfEsc\(_bankShown\(b\)\)\)\)/);
        expect(html).toMatch(/setCCOTBankFilter\('\$\{_wfJsAttr\(String\(key\)\)\}'\)/);
        expect(html).toMatch(/_wfEsc\(_bankShown\(it\.bank\) \|\| 'Statement'\)/);
        expect(html).toMatch(/wf-cover-chip">' \+ _wfEsc\(_bankShown\(b\)\)/);
        expect(html).toMatch(/_wfEsc\(_bankShown\(p\.bank\) \|\| '—'\)/);
        expect(html).toMatch(/<b>\$\{_wfEsc\(_bankShown\(w\.bank\) \|\| 'Card'\)\}<\/b>/);
        /* the walk and the filter still key on the stored label */
        expect(html).toMatch(/function _ccKey\(r\) \{ return String\(_canonBank\(r && r\.bank\)/);
        expect(html).toMatch(/charges\.filter\(c => _canonBank\(c\.bank\) === _ccotBankFilter\)/);
        expect(read('wealthflow-statement-cloud.js')).toMatch(/shownBank\(entry\.bank\)/);
        expect(read('wealthflow-notifications.js')).toMatch(/esc\(shownBank\(x\.bank\)\)/);
    });
    it('the review screen records the stored label: the title is printed by name, the record is filed by label', () => {
        const html = read('index.html');
        expect(html).toMatch(/bank: _sourceRow\._bank \|\| bank \|\| ''/);
        expect(html).toMatch(/_wfEsc\(_bankShown\(bank\) \|\| 'Bank Statement'\)/);
    });
});
