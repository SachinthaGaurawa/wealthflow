import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function functionSource(name) {
    const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) throw new Error(`${name} was not found`);
    let i = HTML.indexOf('(', at);
    let depth = 0;
    for (; i < HTML.length; i += 1) {
        if (HTML[i] === '(') depth += 1;
        else if (HTML[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    depth = 0;
    for (let j = HTML.indexOf('{', i); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    throw new Error(`${name} did not close`);
}

function toggleNode(setting, on = false) {
    const classes = new Set(['toggle', ...(on ? ['on'] : [])]);
    const attrs = {};
    return {
        dataset: { setting },
        classList: {
            contains: (name) => classes.has(name),
            toggle: (name, force) => {
                const next = force === undefined ? !classes.has(name) : !!force;
                if (next) classes.add(name); else classes.delete(name);
                return next;
            },
        },
        setAttribute: (name, value) => { attrs[name] = String(value); },
        getAttribute: (name) => attrs[name],
    };
}

function runtime(initial = {}, { activePage = 'settings' } = {}) {
    const settings = { ...initial };
    const first = toggleNode('notifications', !!settings.notifications);
    const duplicate = toggleNode('notifications', !!settings.notifications);
    const dependent = {
        dataset: { settingDependent: 'notifications' },
        hidden: !settings.notifications,
        attrs: {},
        setAttribute(name, value) { this.attrs[name] = String(value); },
        getAttribute(name) { return this.attrs[name]; },
    };
    let renders = 0;
    let writes = 0;
    let dashboardRenders = 0;
    const pageRenders = [];
    const nodes = [first, duplicate];
    const document = {
        body: { classList: { toggle() {} } },
        documentElement: { scrollTop: 0 },
        getElementById: () => null,
        querySelector: (selector) => selector === '.page.active' ? { id: `page-${activePage}` } : null,
        querySelectorAll: (selector) => {
            if (selector === '[data-setting="notifications"]') return nodes;
            if (selector === '[data-setting-dependent="notifications"]') return [dependent];
            return [];
        },
    };
    const DB = {
        getObj: () => settings,
        set: (_key, value) => { Object.assign(settings, value); writes += 1; },
    };
    const window = { event: null, scrollY: 0, scrollTo() {} };
    const toggleSetting = new Function(
        'DB', 'window', 'document', 'renderSettings', 'triggerHaptic',
        '_applyDisplaySettings', 'renderDash', 'renderPage', 'notify',
        `${functionSource('toggleSetting')}; return toggleSetting;`,
    )(
        DB, window, document, () => { renders += 1; }, () => {},
        () => {}, () => { dashboardRenders += 1; }, (page) => { pageRenders.push(page); }, () => {},
    );
    return {
        toggleSetting, settings, first, duplicate, dependent,
        counts: () => ({ renders, writes, dashboardRenders, pageRenders }),
    };
}

describe('settings switches use their live control state', () => {
    it('a repeated click reverses the prior click even when the rendered boolean argument is stale', () => {
        const r = runtime({ notifications: false });
        r.toggleSetting('notifications', true, r.first);
        expect(r.settings.notifications).toBe(true);
        r.toggleSetting('notifications', true, r.first);
        expect(r.settings.notifications).toBe(false);
    });

    it('updates every visible control for the same setting without rebuilding the page', () => {
        const r = runtime({ notifications: false });
        r.toggleSetting('notifications', true, r.first);
        expect(r.first.classList.contains('on')).toBe(true);
        expect(r.duplicate.classList.contains('on')).toBe(true);
        expect(r.first.getAttribute('aria-checked')).toBe('true');
        expect(r.duplicate.getAttribute('aria-checked')).toBe('true');
        expect(r.counts()).toEqual({ renders: 0, writes: 1, dashboardRenders: 0, pageRenders: [] });
    });

    it('enables and disables dependent controls in place', () => {
        const r = runtime({ notifications: false });
        r.toggleSetting('notifications', true, r.first);
        expect(r.dependent.hidden).toBe(false);
        expect(r.dependent.getAttribute('aria-hidden')).toBe('false');
        r.toggleSetting('notifications', true, r.first);
        expect(r.dependent.hidden).toBe(true);
        expect(r.dependent.getAttribute('aria-hidden')).toBe('true');
    });

    it('does not rebuild a hidden dashboard while the owner is using Settings', () => {
        const r = runtime({ compactMode: false }, { activePage: 'settings' });
        const control = toggleNode('compactMode', false);
        r.toggleSetting('compactMode', true, control);
        expect(r.counts().dashboardRenders).toBe(0);
        expect(r.counts().pageRenders).toEqual([]);
    });

    it('refreshes only the currently visible financial page after a display preference changes', () => {
        const r = runtime({ compactMode: false }, { activePage: 'dashboard' });
        const control = toggleNode('compactMode', false);
        r.toggleSetting('compactMode', true, control);
        expect(r.counts().dashboardRenders).toBe(0);
        expect(r.counts().pageRenders).toEqual(['dashboard']);
    });
});

describe('the switch knob is a real positioned visual, not generated text', () => {
    it('defines the pseudo-element as absolute and empty without a browser binary', () => {
        const block = (HTML.match(/\.toggle::after\s*\{([^}]*)\}/) || [])[1] || '';
        expect(block).toMatch(/position\s*:\s*absolute\s*;/);
        expect(block).toMatch(/content\s*:\s*(['"])\1\s*;/);
        expect(block).not.toMatch(/content\s*:\s*['"]absolute['"]/);
    });
});
