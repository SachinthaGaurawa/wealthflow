import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('the three public surfaces stay isolated', () => {
    it('routes the official home, secure app and tenant workspace to separate documents', () => {
        const routes = JSON.parse(read('vercel.json')).rewrites;
        expect(routes).toContainEqual({ source: '/', destination: '/marketing.html' });
        expect(routes).toContainEqual({ source: '/app', destination: '/index.html' });
        expect(routes).toContainEqual({ source: '/t/([A-Za-z0-9_-]{16})', destination: '/tenant.html' });
    });

    it('gives the app an official canonical route and a semantic mobile navigation landmark', () => {
        const app = read('index.html');
        expect(app).toContain('<link rel="canonical" href="https://www.wealthflow.lk/app">');
        expect(app).toContain('id="wfMobileNav"');
        expect(app).toContain('aria-label="Primary"');
        expect(app).toContain('wealthflow-dashboard-ui.js');
    });

    it('loads only the assets each lightweight public surface owns', () => {
        const marketing = read('marketing.html');
        const tenant = read('tenant.html');
        expect(marketing).toContain('marketing.css');
        expect(marketing).not.toContain('wealthflow-dashboard-ui.js');
        expect(tenant).toContain('tenant-page.css');
        expect(tenant).not.toContain('wealthflow-dashboard-ui.js');
        expect(tenant).toContain('/assets/brand/wealthflow-wordmark.svg');
    });
});
