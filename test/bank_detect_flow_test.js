import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFirestore } from './helpers/fake-firestore.js';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import { _setAdminModule } from '../admin-db.mjs';
import handler from '../statement-guard.js';
import { bankHistory } from '../statement-bank-evidence.mjs';
import { detect } from '../wealthflow-bank-detect.js';

/* =============================================================================
 * THE BANK, WITHOUT ASKING — the parts around the detector: what the mailbox knows (statement-bank-evidence.mjs, POST /api/statement-guard `identify`),
 * and the upload flow that used to open a fifteen-button picker (wealthflow-ai-v4.js, index.html).
 * ===========================================================================*/

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const sha = (text) => createHash('sha256').update(text).digest('hex');
const MAIL = 'wf-mail/owner_example_com';
const owner = { uid: 'u', email: 'owner@example.com' };

const filed = (id, extra = {}) => [`${MAIL}/items/${id}`, { uid: 'u', bank: 'Nations Trust Bank (NTB)', filed: true, status: 'filed', filename: 'eStatement_376657XXXXX0276_2026JUL.html', last4: '0276', contentSha256: sha(id), ...extra }];

describe('what the mailbox knows about the bank (statement-bank-evidence.mjs)', () => {
    const seed = (rows, mail = { uid: 'u', senders: [{ id: 'estatements@nationstrust.com', kind: 'address', status: 'approved', name: 'Nations Trust Bank (NTB)', domain: 'nationstrust.com' }] }) => createFirestore({ [MAIL]: mail, ...Object.fromEntries(rows) });
    const ask = (fs, extra = {}) => bankHistory({ mailRef: fs.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', ...extra });

    it('the same file, filed by the email sync, names its bank', async () => {
        const fs = seed([filed('a')]);
        expect((await ask(fs, { sha: sha('a') })).sha).toEqual({ bank: 'Nations Trust Bank (NTB)' });
        expect((await ask(fs, { sha: sha('other') })).sha).toBeNull();
    });
    it('a card tail names the banks the sync filed it under, with counts', async () => {
        const fs = seed([filed('a'), filed('b'), filed('c'), filed('d', { bank: 'Seylan Bank', last4: '0276' }), filed('e', { last4: '9999' })]);
        expect((await ask(fs, { tails: ['0276'] })).last4).toEqual({ '0276': { 'Nations Trust Bank (NTB)': 3, 'Seylan Bank': 1 } });
    });
    it('a statement that was not filed does not count: a refused mail names no bank of the owner\'s', async () => {
        const fs = seed([filed('a', { filed: false, status: 'refused' })]);
        expect((await ask(fs, { tails: ['0276'] })).last4).toEqual({});
    });
    it('the file-name series: every month of "eStatement_…_2026JUL.html" is one product', async () => {
        const fs = seed([filed('a', { filename: 'eStatement_376657XXXXX0276_2026JUN.html' }), filed('b', { filename: 'eStatement_376657XXXXX0276_2026JUL.html' }), filed('c', { filename: 'unrelated.pdf', bank: 'Seylan Bank' })]);
        const r = await ask(fs, { filename: 'eStatement_376657XXXXX0276_2026AUG.html' });
        expect(r.series).toEqual({ bank: 'Nations Trust Bank (NTB)', count: 2 });
        expect((await ask(fs, { filename: 'statement.pdf' })).series).toBeNull();          // a stem too short to be a series
    });
    it('the banks the owner approved a sender of', async () => {
        expect((await ask(seed([]))).approved).toEqual(['Nations Trust Bank (NTB)']);
    });
    it('only this owner\'s mail counts', async () => {
        const fs = seed([filed('a', { uid: 'someone-else' })]);
        const r = await ask(fs, { sha: sha('a'), tails: ['0276'] });
        expect(r.sha).toBeNull();
        expect(r.last4).toEqual({});
    });
    it('every failure is "no evidence" and never a thrown error', async () => {
        const broken = { get: async () => { throw new Error('down'); }, collection: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('down'); } }) }), limit: () => ({ get: async () => { throw new Error('down'); } }), get: async () => { throw new Error('down'); } }) };
        await expect(bankHistory({ mailRef: broken, uid: 'u', sha: sha('a'), tails: ['0276'], filename: 'eStatement_376657XXXXX0276_2026AUG.html' })).resolves.toEqual({ approved: [], sha: null, last4: {}, series: null });
    });
    it('returns bank labels and counts only — no amount, row, file name or hash leaves it', async () => {
        const fs = seed([filed('a', { amount: 1234.5, rows: [{ description: 'SECRET MERCHANT' }] })]);
        const text = JSON.stringify(await ask(fs, { sha: sha('a'), tails: ['0276'], filename: 'eStatement_376657XXXXX0276_2026AUG.html' }));
        expect(text).not.toMatch(/SECRET|1234|contentSha256|eStatement|filename/);
    });
    it('the answer feeds the detector: a page that prints no bank is named by the mailbox, under the label the sync writes', async () => {
        const fs = seed([filed('a'), filed('b'), filed('c')]);
        const history = await ask(fs, { sha: sha('x'), tails: ['0276'], filename: 'eStatement_376657XXXXX0276_2026AUG.html' });
        const r = detect({ text: 'Credit Card Statement\nCard No: ************0276\nCredit Limit 350,000', history });
        expect(r).toMatchObject({ ok: true, lockName: 'Nations Trust Bank (NTB)' });
    });
});

describe('POST /api/statement-guard  { action: "identify" }', () => {
    const fake = makeFakeAdmin(); let fs, saved;
    const call = async (body, headers = { authorization: 'Bearer ok' }, method = 'POST') => {
        let out; const res = { statusCode: 200, setHeader() {}, end(t) { out = { status: this.statusCode, body: JSON.parse(t) }; } };
        await handler({ method, body, headers }, res); return out;
    };
    beforeEach(() => {
        saved = process.env.FIREBASE_SERVICE_ACCOUNT; process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;
        fake.reset(); fake.setVerifier(async () => ({ uid: 'u', email: owner.email, email_verified: true }));
        fs = createFirestore({ [MAIL]: { uid: 'u' }, ...Object.fromEntries([filed('a'), filed('b'), filed('c')]) }); fake.admin.firestore = () => fs.db; _setAdminModule(fake.admin);
    });
    afterEach(() => { _setAdminModule(null); if (saved === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = saved; });

    it('needs a signed-in owner', async () => {
        expect((await call({ action: 'identify' }, {})).status).toBe(401);
        expect((await call({ action: 'identify' }, undefined, 'GET')).status).toBe(405);
    });
    it('answers from the owner\'s own mailbox', async () => {
        const r = await call({ action: 'identify', sha256: sha('a'), tails: ['0276'], filename: 'eStatement_376657XXXXX0276_2026AUG.html' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, sha: { bank: 'Nations Trust Bank (NTB)' }, last4: { '0276': { 'Nations Trust Bank (NTB)': 3 } }, series: { bank: 'Nations Trust Bank (NTB)', count: 3 } });
    });
    it('takes nothing but a hash, four-digit tails and a file name, and bounds them', async () => {
        const r = await call({ action: 'identify', sha256: 'not-a-hash', tails: ['0276', '12', 'abcd', '9999', '1111', '2222', { x: 1 }], filename: 'x'.repeat(5000) });
        expect(r.status).toBe(200);
        expect(r.body.sha).toBeNull();
        expect(Object.keys(r.body.last4)).toEqual(['0276']);
    });
    it('reads and writes nothing in the registry', async () => {
        const before = JSON.stringify([...fs.data.entries()]);
        await call({ action: 'identify', sha256: sha('a'), tails: ['0276'], filename: 'eStatement_376657XXXXX0276_2026AUG.html' });
        expect(JSON.stringify([...fs.data.entries()])).toBe(before);
    });
    it('a mailbox the owner has not connected is an empty answer, not an error', async () => {
        fs = createFirestore({}); fake.admin.firestore = () => fs.db;
        expect((await call({ action: 'identify', sha256: sha('a'), tails: ['0276'] })).body).toEqual({ ok: true, approved: [], sha: null, last4: {}, series: null });
    });
    it('the other actions are untouched', async () => {
        expect((await call({ action: 'nope' })).status).toBe(400);
        expect((await call({ action: 'check', sha256: sha('zzz') })).body).toMatchObject({ ok: true, duplicate: false });
    });
});

describe('the upload flow no longer asks which bank', () => {
    const html = read('index.html'), v4 = read('wealthflow-ai-v4.js');

    it('the "Which credit card / bank?" picker is gone from the page, and nothing calls it', () => {
        expect(html).not.toMatch(/function _ccotPickBankAsync/);
        expect(html).not.toMatch(/_wf_bank_pick/);
        expect(html).not.toMatch(/Which credit card \/ bank\?/);
        expect(html).not.toMatch(/please confirm the issuing bank/);
        expect(v4).not.toMatch(/_ccotPickBankAsync\s*\(/);
        expect(v4).not.toMatch(/bank picker failed/);
    });
    it('the detector is a deferred module the page loads once, after the institutions registry it reads', () => {
        const tag = '<script type="module" src="wealthflow-bank-detect.js"></script>';
        expect(html.split(tag)).toHaveLength(2);
        expect(html.indexOf('wealthflow-institutions.js"></script>')).toBeLessThan(html.indexOf(tag));
    });
    it('every read path resolves the bank AFTER the statement is open, and a cancelled upload is never a rejected pick', () => {
        expect(v4).toMatch(/_wfResolveBank\(\{ file: file, sha: _wfSha, text: _hres && _hres\.text \}\)/);                  // HTML e-statement
        expect(v4).toMatch(/_wfResolveBank\(\{ file: file, sha: _wfSha, text: _res\.text, meta: _res\.meta \}\)/);          // text PDF
        expect(v4).toMatch(/_wfResolveBank\(\{ file: file, sha: _wfSha, text: _ocrText, ai: _aiBank \}\)/);                // scanned page
        expect(v4).not.toMatch(/if \(!ccotBank\) \{ inputEl\.value = ''; return; \}/);
    });
    it('the registry is given the ISSUER label (the one the email sync writes), and nothing when the bank is not identified', () => {
        const guarded = v4.match(/_wfGuardParsed\(_parsed[H]?, \{[^}]*\}/g) || [];
        expect(guarded).toHaveLength(2);
        for (const call of guarded) expect(call).toMatch(/bank: _wfBank && _wfBank\.ok \? _wfBank\.lockName : ''/);
    });
    it('records carry the detected label, or none — never the placeholder "Bank Statement"', () => {
        expect(v4).not.toMatch(/ccotBank \|\| 'Bank Statement'/);
        expect(v4).toMatch(/_showCCReviewModal\(_parsedH, ccotBank\)/);
        expect(v4).toMatch(/_showCCReviewModal\(_parsed, ccotBank\)/);
    });
    it('the AI is asked to read the bank off the page, and told not to guess it', () => {
        expect(v4).toMatch(/"bank_name":""/);
        expect(v4).toMatch(/NEVER take it from a transaction row/);
        expect(v4).toMatch(/do NOT guess/);
    });
    it('the review says what it found, or that it did not, instead of asking', () => {
        expect(html).toMatch(/Bank:<\/b> <span id="_ccr_bankName">\$\{_wfEsc\(w\.name\)\}<\/span> <span style="opacity:\.8">— \$\{w\.manual \? 'set by you' : 'found automatically/);
        expect(html).toMatch(/Bank not identified/);
        expect(html).toMatch(/_wfEsc\(bank \|\| 'Bank Statement'\)/);
    });
    it('the PDF reader hands its properties (title, author, subject) to the detector', () => {
        const unlock = read('wealthflow-pdf-unlock.js');
        expect(unlock).toMatch(/_metaOf/);
        expect(unlock).toMatch(/meta/);
    });
    it('the cloud client exposes identify next to the guard\'s other calls, bounded to a few seconds', () => {
        const cloud = read('wealthflow-statement-cloud.js');
        expect(cloud).toMatch(/guard: \{[^}]*identify: guardIdentify/);
        expect(cloud).toMatch(/setTimeout\(\(\)=>done\(null\),8000\)/);
    });
});
