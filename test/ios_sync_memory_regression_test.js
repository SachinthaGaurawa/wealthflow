import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const icons = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');
const intake = fs.readFileSync(path.join(ROOT, 'wealthflow-mail-intake.js'), 'utf8');

describe('iOS statement-sync peak-memory guardrails', () => {
    it('boot lists metadata and never requests attachment payloads', () => {
        expect(html).toContain("?items=1&metadata=1&limit=200");
    });

    it('counts retained teachable text against the mobile statement budget', () => {
        expect(html).toContain('_ready.length + _teach.length >= _MAIL_READY_STATEMENT_BUDGET');
    });

    it('coalesces mail-card redraws through the scroll-idle gate', () => {
        expect(html).toContain("_wfAfterScrollIdle('mail-sync-paint'");
        expect(html).toContain('_mailSyncIdleCommit = true');
    });

    it('closed modal overlays leave the compositor tree', () => {
        const modalCss = html.slice(html.indexOf('.mo {'), html.indexOf('.md {'));
        expect(modalCss).toMatch(/\.mo\s*\{[\s\S]*display:\s*none/);
        expect(modalCss).toMatch(/\.mo\.open\s*\{[\s\S]*display:\s*flex/);
        expect(modalCss).toMatch(/wf-ios-stable[\s\S]*backdrop-filter:\s*none\s*!important/);
    });

    it('dynamic icon work is scoped to added nodes, not the two-megabyte document', () => {
        expect(icons).not.toContain('hydrate(document); break;');
        expect(icons).not.toContain('replaceIn(document.body); }, 120');
        expect(icons).toContain('hydrate(added[j])');
        expect(icons).toContain('schedule(added[j])');
    });

    it('PDFs are only prefix-sniffed instead of fully decoded as text', () => {
        expect(intake).toContain('bytes.subarray(0, 512)');
        expect(intake).not.toContain("if (typeof bytes !== 'string') source = new TextDecoder().decode(bytes);");
    });
});
