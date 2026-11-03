/* The self-healing locators: a renamed control is found another way and reported; nothing is ever made to pass.
 *
 * These run a REAL Chromium against small fixture pages. If no Chromium can be started the browser tests are skipped (and say so);
 * the pure ones always run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium } from 'playwright';
import { healer, strategiesOf } from './e2e/heal.mjs';

let browser = null;
beforeAll(async () => {
    try { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'], ...(process.env.WF_CHROME ? { executablePath: process.env.WF_CHROME } : {}) }); } catch (_) { browser = null; }
}, 60000);
afterAll(async () => { if (browser) await browser.close(); });

const PAGE = (body) => `<!doctype html><html><body>${body}</body></html>`;
async function fixture(body) {
    const page = await browser.newPage();
    await page.setContent(PAGE(body));
    const logs = [];
    return { page, logs, h: healer(page, { log: (m) => logs.push(m), strict: false }) };
}

describe('strategiesOf', () => {
    const fake = { locator: () => 'L', getByTestId: () => 'T', getByRole: () => 'R', getByLabel: () => 'B', getByText: () => 'X' };
    it('orders them css, testid, role, label, text; the first is the primary', () => {
        expect(strategiesOf(fake, { text: /a/, css: '#a', role: 'button', name: /go/i }).map((s) => s.kind)).toEqual(['css', 'role', 'text']);
        expect(strategiesOf(fake, { testid: 'x', label: 'y' }).map((s) => s.kind)).toEqual(['testid', 'label']);
    });
    it('has nothing to find with when the spec is empty', () => {
        expect(strategiesOf(fake, {})).toEqual([]);
        expect(strategiesOf(fake, undefined)).toEqual([]);
    });
});

describe('healer in a real browser', () => {
    const need = (ctx) => { if (!browser) ctx.skip(); };

    it('the primary selector present: found at once, nothing healed, nothing logged', async (ctx) => {
        need(ctx);
        const { page, logs, h } = await fixture('<button id="pill">Update available</button>');
        const el = await h.find('pill', { css: '#pill', text: /Update available/ });
        expect(await el.evaluate((e) => e.id)).toBe('pill');
        expect(h.report()).toEqual([]);
        expect(logs).toEqual([]);
        await page.close();
    }, 30000);

    it('a renamed id: found by its text, logged, and the stable selector is suggested', async (ctx) => {
        need(ctx);
        const { page, logs, h } = await fixture('<button id="updateBadge">Update available — 9.0.0</button><button id="other">Settings</button>');
        const el = await h.find('update pill', { css: '#wfUpdatePill', text: /Update available/ }, { timeout: 4000, graceMs: 300 });
        expect(await el.evaluate((e) => e.id)).toBe('updateBadge');
        const [rec] = h.report();
        expect(rec).toMatchObject({ label: 'update pill', primary: { kind: 'css', value: '#wfUpdatePill' }, healedBy: { kind: 'text' }, suggest: '#updateBadge' });
        expect(logs.join('\n')).toMatch(/\[heal\] "update pill": css #wfUpdatePill found nothing; found it by text .*→ use #updateBadge/);
        await page.close();
    }, 30000);

    it('clicking through a heal presses the right control', async (ctx) => {
        need(ctx);
        const { page, h } = await fixture('<button id="renamed" onclick="document.body.dataset.pressed=\'yes\'">Update now</button><button onclick="document.body.dataset.pressed=\'wrong\'">Later</button>');
        await h.click('update now', { css: '#wfUpdateNow', role: 'button', name: /update now/i }, { timeout: 4000, graceMs: 200 });
        expect(await page.evaluate(() => document.body.dataset.pressed)).toBe('yes');
        await page.close();
    }, 30000);

    it('a control that is only LATE is not healed onto something else', async (ctx) => {
        need(ctx);
        const { page, h } = await fixture('<p>Update available soon</p>');
        setTimeout(() => page.evaluate(() => { const b = document.createElement('button'); b.id = 'pill'; b.textContent = 'Update available'; document.body.appendChild(b); }).catch(() => {}), 600);
        const el = await h.find('pill', { css: '#pill', text: /Update available/ }, { timeout: 5000, graceMs: 1500 });
        expect(await el.evaluate((e) => e.id)).toBe('pill');
        expect(h.report()).toEqual([]);
        await page.close();
    }, 30000);

    it('two candidates is ambiguous: refused, and it says so, rather than picking one', async (ctx) => {
        need(ctx);
        const { page, h } = await fixture('<button onclick="document.body.dataset.pressed=1">Update now</button><button onclick="document.body.dataset.pressed=2">Update now</button>');
        await expect(h.click('update now', { css: '#gone', text: /Update now/ }, { timeout: 1200, graceMs: 100 })).rejects.toThrow(/text .*Update now.* → 2 visible \(ambiguous, refused\)/);
        expect(await page.evaluate(() => document.body.dataset.pressed || null)).toBe(null);
        expect(h.report()).toEqual([]);
        await page.close();
    }, 30000);

    it('a hidden match does not count: a person could not use it', async (ctx) => {
        need(ctx);
        const { page, h } = await fixture('<button style="display:none">Update available</button>');
        await expect(h.find('pill', { css: '#pill', text: /Update available/ }, { timeout: 1000, graceMs: 100 })).rejects.toThrow(/could not find "pill"/);
        await page.close();
    }, 30000);

    it('NOTHING matches: it throws and lists every way it looked (an absent control is a failing check)', async (ctx) => {
        need(ctx);
        const { page, h } = await fixture('<p>Nothing to see</p>');
        const err = await h.find('update pill', { css: '#wfUpdatePill', role: 'button', name: /update/i, text: /Update available/ }, { timeout: 1000, graceMs: 100 }).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toMatch(/could not find "update pill" in 1000 ms/);
        for (const kind of ['css #wfUpdatePill', 'role button', 'text']) expect(err.message).toContain(kind);
        expect(err.message).toMatch(/failing check, not something to work around/);
        expect(h.report()).toEqual([]);
        await page.close();
    }, 30000);

    it('a check can veto a healed match', async (ctx) => {
        need(ctx);
        const { page, h } = await fixture('<button>Update available</button>');
        const veto = async () => false;
        await expect(h.find('pill', { css: '#pill', text: /Update available/ }, { timeout: 800, graceMs: 100, check: veto })).rejects.toThrow(/refused by the check/);
        expect(h.report()).toEqual([]);
        await page.close();
    }, 30000);

    it('strict mode turns a heal into a failure, for the day the maintainer wants to see every one', async (ctx) => {
        need(ctx);
        const page = await browser.newPage();
        await page.setContent(PAGE('<button id="renamed">Update available</button>'));
        const h = healer(page, { log: () => {}, strict: true });
        await expect(h.find('pill', { css: '#pill', text: /Update available/ }, { timeout: 1500, graceMs: 100 })).rejects.toThrow(/heal \(strict\)/);
        await page.close();
    }, 30000);

    it('summary names the selector to change, or says none was needed', async (ctx) => {
        need(ctx);
        const a = await fixture('<button id="pill">x</button>');
        a.h.summary();
        expect(a.logs).toEqual(['[heal] 0 selectors needed healing']);
        await a.page.close();
        const b = await fixture('<button id="renamed">Update available</button>');
        await b.h.find('pill', { css: '#pill', text: /Update available/ }, { timeout: 1500, graceMs: 100 });
        b.logs.length = 0;
        b.h.summary();
        expect(b.logs.join('\n')).toMatch(/1 selector\(s\) were healed[\s\S]*"pill": css #pill {2}→ {2}#renamed/);
        await b.page.close();
    }, 30000);
});
