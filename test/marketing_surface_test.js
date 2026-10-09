import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'marketing.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'marketing.css'), 'utf8');

describe('official marketing surface', () => {
    it('makes the official identity and secure app action immediately discoverable', () => {
        const { document } = parseHTML(html);
        expect(document.querySelector('link[rel="canonical"]').getAttribute('href')).toBe('https://www.wealthflow.lk/');
        expect(document.querySelector('header img').getAttribute('src')).toBe('/assets/brand/wealthflow-wordmark.svg');
        expect([...document.querySelectorAll('a[href="/app"]')].length).toBeGreaterThanOrEqual(2);
        expect(document.querySelector('a[href="mailto:info@wealthflow.lk"]')).not.toBeNull();
    });

    it('uses product language instead of decorative kickers or section-number furniture', () => {
        const { document } = parseHTML(html);
        expect(document.querySelector('.mk-kicker')).toBeNull();
        expect(document.querySelectorAll('.mk-grid article > b')).toHaveLength(0);
        expect(document.querySelector('h1').textContent).toContain('Every financial signal');
    });

    it('supports keyboard focus, reduced motion and reduced transparency', () => {
        expect(css).toMatch(/:focus-visible/);
        expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        expect(css).toMatch(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/);
    });
});
