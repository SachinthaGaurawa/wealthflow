/* The CC Instalments rows on a phone (#635, round 3). The owner's real phone showed a row as its name and three icons, a second card cut in half at the
   screen edge, and a detail sheet that said "paid 0 of 15" over a schedule whose first month read "paid". These pin the three fixes. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../wf-ui.css', import.meta.url), 'utf8');

describe('CC Instalments rows say what matters and can be opened', () => {
    const body = html.slice(html.indexOf('function renderCCI()'), html.indexOf('// ==================== CC ONE-TIME'));
    it('each row carries the monthly figure, months paid, status and a Details button', () => {
        expect(body).toContain('class="wf-cci-sum"');
        expect(body).toContain('a month');
        expect(body).toContain('${prog.paid} of ${prog.total} paid');
        expect(body).toContain('class="wf-cci-open"');
        expect(body).toContain('WFCCInstalmentDetail.open(');
    });
    it('the card tabs fit a phone two to a row instead of a strip cut at the edge', () => {
        const m = css.slice(css.indexOf('@media (max-width: 640px) {\n    /* A phone shows every card at once'));
        expect(m).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
        expect(m).toMatch(/overflow-x:\s*visible/);
    });
});

describe('the sheet counts paid months the way the table does', () => {
    let saved;
    beforeAll(() => { saved = globalThis.cciProgress; });
    afterAll(() => { globalThis.cciProgress = saved; });
    it('uses the page cciProgress, and the schedule marks exactly that many months paid', async () => {
        globalThis.cciProgress = () => ({ paid: 3, total: 12, pct: 25 });
        const src = fs.readFileSync(new URL('../wealthflow-cc-instalment-detail.js', import.meta.url), 'utf8');
        // load the module against a fake root that exposes cciProgress
        const root = { cciProgress: globalThis.cciProgress };
        new Function('root', 'document', src.replace(/\}\)\(typeof window[^\n]*\n/, '})(root);\n').replace(/\/\* TEST RECIPE[\s\S]*$/, ''))(root, undefined);
        const out = root.WFCCInstalmentDetail.compute({ id: 'a', product: 'TV', total: 120000, monthly: 10000, duration: 12, date: '2026-10-23', rate: 0 }, new Date('2026-11-21T00:00:00'));
        expect(out.lines.find((l) => l.label === 'Paid so far').value).toBe('LKR 30,000.00 (3/12)');
        expect(out.schedule.filter((s) => s.state === 'paid').length).toBe(3);
        expect(out.schedule[3].state).toBe('due');
    });
});
