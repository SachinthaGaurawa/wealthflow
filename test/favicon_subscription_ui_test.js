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
});
