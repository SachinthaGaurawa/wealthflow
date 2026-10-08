import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const scriptMatch = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .find((match) => match[1].includes('var _WF_REDIRECTING'));

function boot(url) {
    expect(scriptMatch, 'the canonical redirect must run before the application').toBeTruthy();
    const parsed = new URL(url);
    const replaced = [];
    const location = {
        hostname: parsed.hostname,
        pathname: parsed.pathname,
        search: parsed.search,
        hash: parsed.hash,
        replace(value) { replaced.push(value); },
    };
    const window = { location };
    vm.runInNewContext(scriptMatch[1], { window, console: { log() {}, warn() {} }, URL });
    return { window, replaced };
}

describe('the pre-boot canonical-host guard', () => {
    it.each([
        ['https://sachinthagaurawa.github.io/wealthflow/', 'https://www.wealthflow.lk/'],
        [
            'https://sachinthagaurawa.github.io/wealthflow/t/Token_123?lang=si#balance',
            'https://www.wealthflow.lk/t/Token_123?lang=si#balance',
        ],
        [
            'https://wealthflow-personal.vercel.app/?s=Eight888#top',
            'https://www.wealthflow.lk/?s=Eight888#top',
        ],
        [
            'https://wealthflow-peach.vercel.app/api/statement-view?id=Eight888',
            'https://www.wealthflow.lk/api/statement-view?id=Eight888',
        ],
    ])('moves %s directly to the official equivalent', (before, after) => {
        const { window, replaced } = boot(before);
        expect(window.WF_PUBLIC_ORIGIN).toBe('https://www.wealthflow.lk');
        expect(replaced).toEqual([after]);
    });

    it('does nothing on the official host and builds all public URLs there', () => {
        const { window, replaced } = boot('https://www.wealthflow.lk/dashboard?month=2026-10');
        expect(replaced).toEqual([]);
        expect(window._wfPublicUrl('/?s=Eight888')).toBe('https://www.wealthflow.lk/?s=Eight888');
        expect(window._wfCanonicalizePublicUrl(
            'https://wealthflow-personal.vercel.app/t/Token_123?lang=si#balance',
        )).toBe('https://www.wealthflow.lk/t/Token_123?lang=si#balance');
        expect(window._wfCanonicalizePublicUrl('https://example.com/t/Token_123'))
            .toBe('https://example.com/t/Token_123');
    });

    it('keeps local and preview API calls relative, while GitHub Pages targets the official API', () => {
        expect(boot('http://localhost:3000/').window._wfApiUrl('/api/ai')).toBe('/api/ai');
        expect(boot('https://preview-123.vercel.app/').window._wfApiUrl('/api/ai')).toBe('/api/ai');
        expect(boot('https://sachinthagaurawa.github.io/wealthflow/').window._wfApiUrl('/api/ai'))
            .toBe('https://www.wealthflow.lk/api/ai');
    });
});

describe('browser and provider public-link consumers', () => {
    it('uses the official origin for externally opened or sent URLs', () => {
        for (const fragment of [
            "window._wfPublicUrl('/?drivelink=1')",
            "window._wfPublicUrl('/?driveauth=1')",
            "window._wfPublicUrl('/?recovery=1')",
            "const _WF_APP_URL = window.WF_PUBLIC_ORIGIN",
            "const proxyBase = window.WF_PUBLIC_ORIGIN",
            "window._wfPublicUrl('/api/statement-store?id='",
        ]) expect(HTML, fragment).toContain(fragment);
    });

    it('has no obsolete origin outside the explicit pre-boot migration allow-list', () => {
        const withoutGuard = HTML.replace(scriptMatch[0], '');
        expect(withoutGuard).not.toContain('wealthflow-personal.vercel.app');
        expect(withoutGuard).not.toContain('wealthflow-peach.vercel.app');

        for (const file of [
            'wealthflow-ai-v4.js',
            'wealthflow-route.js',
            'wealthflow-vision-ocr.js',
            'api/ai.js',
            'api/vision-scan.js',
            '.github/workflows/merchant-sync.yml',
        ]) {
            const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
            expect(source, file).not.toContain('https://wealthflow-personal.vercel.app');
            expect(source, file).not.toContain('https://wealthflow-peach.vercel.app');
        }
    });

    it('attributes OpenRouter requests to the official website', () => {
        for (const file of ['api/ai.js', 'api/vision-scan.js']) {
            const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
            expect(source, file).toContain("'HTTP-Referer': OFFICIAL_ORIGIN");
        }
    });
});
