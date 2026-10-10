import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('browser identity assets', () => {
    it('gives both the app and customer portal a real same-origin favicon', () => {
        for (const file of ['index.html', 'tenant.html']) {
            const { document } = parseHTML(read(file));
            const icon = document.querySelector('link[rel="icon"]');
            expect(icon, `${file} has no favicon`).toBeTruthy();
            expect(icon.getAttribute('href'), `${file} disables or externalises its favicon`)
                .toMatch(/^\/favicon\.ico(?:\?|$)/);
            expect(document.querySelector('link[rel="apple-touch-icon"]'), `${file} has no touch icon`).toBeTruthy();
        }
    });

    it('routes favicon requests to an image before the app-shell catch-all', () => {
        const config = JSON.parse(read('vercel.json'));
        const iconAt = config.rewrites.findIndex((r) => r.source === '/favicon.ico');
        const catchAllAt = config.rewrites.findIndex((r) => r.source === '/(.*)');
        expect(iconAt).toBeGreaterThanOrEqual(0);
        expect(iconAt).toBeLessThan(catchAllAt);
        expect(config.rewrites[iconAt].destination).toMatch(/^https:\/\/.+\.ico$/);
    });
});

describe('subscription form', () => {
    it('offers a real One-Time billing-cycle value', () => {
        const { document } = parseHTML(read('index.html'));
        const options = [...document.querySelectorAll('#sub_cycle option')]
            .map((o) => ({ value: o.getAttribute('value'), label: o.textContent.trim() }));
        expect(options).toContainEqual({ value: 'once', label: 'One-Time' });
    });

    it('captures the exact due date and completion lifecycle for a one-time payment', () => {
        const index = read('index.html');
        const { document } = parseHTML(index);
        expect(document.querySelector('#sub_due_date')).toBeTruthy();
        expect(index).toContain('syncSubscriptionCycleFields');
        expect(index).toContain('toggleOneTimePayment');
        expect(index).toContain('completed:');
        expect(index).toContain('paidStatementKey: oneTime && wasPaid && existing');
        expect(document.querySelector('#sub_paid')).toBeTruthy();
        expect(index).toContain('s.reopened = !done');
        expect(index).toContain("return cycle === 'monthly';");
    });

    it('keeps AI bill auto-fill aligned with the one-time due-date UI', () => {
        const ai = read('wealthflow-ai-v4.js');
        expect(ai).toContain("$('sub_due_date')");
        expect(ai).toContain('syncSubscriptionCycleFields');
        expect(ai).toContain('matchedSub.dueDay');
    });
});
