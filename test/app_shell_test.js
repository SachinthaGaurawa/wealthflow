import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'wealthflow-shell.css'), 'utf8');
const dashboardCss = fs.readFileSync(path.join(ROOT, 'wealthflow-dashboard.css'), 'utf8');

describe('secure application shell', () => {
    it('supports compact navigation, visible focus and user motion preferences', () => {
        expect(css).toMatch(/\.wf-mobile-nav\s*\{/);
        expect(css).toMatch(/:focus-visible/);
        expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
        expect(css).toMatch(/@media\s*\(prefers-reduced-transparency:\s*reduce\)/);
        expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    });

    it('contains complete dashboard states instead of an unstyled injected island', () => {
        for (const selector of [
            '.wf-dash-experience',
            '.wf-dash-overview',
            '.wf-dash-attention',
            '.wf-dash-chart-card',
            '.wf-dash-empty',
            '.wf-dash-error',
            '.wf-dash-skeleton',
        ]) expect(dashboardCss, selector).toContain(selector);
    });
});
