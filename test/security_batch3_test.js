// Small hardening from the security review: a receipt photo is not sent to a third party unless the person switched it on,
// a shared token is compared in constant time, and the two vulnerable transitive packages are pinned past their fixes.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(f, 'utf8');

describe('cloud OCR is opt-in', () => {
    const html = read('index.html');
    it('the OCR.space helper returns before any network call unless wf_cloud_ocr is "1"', () => {
        const fn = html.slice(html.indexOf('async function _tryOCRSpace'), html.indexOf('async function _tryOCRSpace') + 400);
        expect(fn).toMatch(/if \(!_cloudOcrAllowed\(\)\) return null;/);
        expect(html).toMatch(/localStorage\.getItem\('wf_cloud_ocr'\) === '1'/);
    });
    it('the scan only shows the cloud-OCR step when it is switched on', () => {
        expect(html).toMatch(/if \(isExpense && _cloudOcrAllowed\(\)\) \{\s*_showScanOverlay\('Reading with cloud OCR…'/);
    });
});

describe('api/verify.js token check', () => {
    it('compares WF_VERIFY_TOKEN with secretEquals, not !==', () => {
        const src = read('api/verify.js');
        expect(src).toMatch(/secretEquals\(String\(req\.headers\['x-wf-token'\] \|\| ''\), process\.env\.WF_VERIFY_TOKEN\)/);
        expect(src).not.toMatch(/x-wf-token'\] !== process\.env\.WF_VERIFY_TOKEN/);
    });
});

describe('no known-vulnerable transitive packages', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    const ver = (name) => (lock.packages[`node_modules/${name}`] || {}).version;
    const gt = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; } return false; };
    it('node-forge is past 1.4.2 and fast-xml-parser past 5.11.2', () => {
        expect(pkg.overrides['node-forge']).toBeTruthy();
        expect(pkg.overrides['fast-xml-parser']).toBeTruthy();
        expect(gt(ver('node-forge'), '1.4.2')).toBe(true);
        expect(gt(ver('fast-xml-parser'), '5.11.2')).toBe(true);
    });
});
