import { describe, expect, it } from 'vitest';
import { formKind } from '../statement-document-kind.mjs';

describe('a document that names itself a form', () => {
    it('by its file name', () => {
        expect(formKind({ filename: 'Mandate.pdf' })).toEqual({ form: 'mandate', where: 'file' });
        expect(formKind({ filename: 'Application_Form.PDF' })).toEqual({ form: 'application form', where: 'file' });
        expect(formKind({ filename: 'Terms-and-Conditions.pdf' })).toMatchObject({ where: 'file' });
    });
    it('by its title (the first lines)', () => {
        expect(formKind({ filename: 'scan0001.pdf', text: 'NATIONS TRUST BANK\n\nDIRECT DEBIT MANDATE\nAuthority to debit' })).toEqual({ form: 'mandate', where: 'title' });
        expect(formKind({ text: '\n\nConsent Form\nI agree' })).toEqual({ form: 'consent form', where: 'title' });
    });
    it('never when either place says statement', () => {
        expect(formKind({ filename: 'Mandate-statement.pdf' })).toBeNull();
        expect(formKind({ filename: 'e-statementPDF.pdf', text: 'Credit Card Statement\nTerms and Conditions apply' })).toBeNull();
        expect(formKind({ text: 'Standing Instruction\nAccount statement for March' })).toBeNull();
    });
    it('never for a form word beyond the title block, or for nothing at all', () => {
        const text = Array.from({ length: 14 }, (_, i) => `line ${i}`).join('\n') + '\nTerms and Conditions';
        expect(formKind({ text })).toBeNull();
        expect(formKind({})).toBeNull();
        expect(formKind({ filename: 'statement.pdf', text: 'Opening balance 0.00' })).toBeNull();
    });
    it('a statement file named like a mandate by a word inside another word is not one', () => {
        expect(formKind({ filename: 'mandatetory-notes-2026.pdf' })).toBeNull();
    });
});
