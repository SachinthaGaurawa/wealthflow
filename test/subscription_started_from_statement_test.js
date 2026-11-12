import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'wealthflow-subscriptions.js'), 'utf8');
const HTML = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const load = () => { const window = { console: { log() {} } }; new Function('window', SRC)(window); return window.WFSubs; };

describe('an entry a statement started', () => {
    it('is told apart from one the owner typed', () => {
        const S = load();
        expect(S.startedFromStatement({ autoCreated: true, source: 'statement' })).toBe(true);
        expect(S.startedFromStatement({ autoCreated: true })).toBe(true);
        expect(S.startedFromStatement({ name: 'Typed by hand' })).toBe(false);
        expect(S.startedFromStatement(null)).toBe(false);
    });
    it('removes the entry and forgets every merchant that pointed at it', () => {
        const S = load();
        const subs = [{ id: 'a', autoCreated: true }, { id: 'b' }];
        const map = { k1: 'a', k2: 'a', k3: 'b' };
        const r = S.removeEntry(subs, map, 'a');
        expect(r.subscriptions.map(s => s.id)).toEqual(['b']);
        expect(r.map).toEqual({ k3: 'b' });
        expect(r.forgot).toBe(2);
        expect(r.removed.id).toBe('a');
    });
    it('leaves everything alone when the id is unknown', () => {
        const S = load();
        const r = S.removeEntry([{ id: 'b' }], { k: 'b' }, 'zzz');
        expect(r.subscriptions).toHaveLength(1);
        expect(r.map).toEqual({ k: 'b' });
        expect(r.removed).toBeNull();
    });
    it('the card shows the marker with Rename and Remove, and delete clears the map', () => {
        expect(HTML).toContain('Started from your statement');
        expect(HTML).toContain('WFSubs.startedFromStatement');
        expect(HTML).toContain('WFSubs.removeEntry');
    });
});
