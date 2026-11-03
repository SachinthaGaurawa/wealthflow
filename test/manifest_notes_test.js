/* test/manifest_notes_test.js — an announced note that is raw JSON gets replaced, nothing else does */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { repairManifestNotes, looksSerialised } = require('../autonomy/manifest-notes.cjs');

const structured = { headline: "What's New", date: '2026-11-03', sections: [{ title: 'What changed for you', items: ['One real change (#494)'] }] };
const bad = '{"date":"2026-11-03","type":"security","headline":"Urgent security update","sections":[]}';

describe('repairManifestNotes', () => {
    it('replaces a serialised-JSON announcement with what version.json says for the same version', () => {
        const r = repairManifestNotes({ '7.69.35': 'Plain text.', '7.69.36': bad }, { '7.69.36': structured });
        expect(r.notes['7.69.36']).toEqual(structured);
        expect(r.repaired).toEqual(['7.69.36']);
        expect(r.notes['7.69.35']).toBe('Plain text.');
    });
    it('never overwrites a readable note, including a human-written one that differs from version.json', () => {
        const r = repairManifestNotes({ '7.69.36': 'Hand-written announcement.' }, { '7.69.36': structured });
        expect(r.notes['7.69.36']).toBe('Hand-written announcement.');
        expect(r.repaired).toEqual([]);
    });
    it('does not replace a bad note with something that is also unusable', () => {
        expect(repairManifestNotes({ '7.69.36': bad }, { '7.69.36': bad }).repaired).toEqual([]);
        expect(repairManifestNotes({ '7.69.36': bad }, {}).repaired).toEqual([]);
        expect(repairManifestNotes({ '7.69.36': bad }, { '7.69.36': { sections: [] } }).repaired).toEqual([]);
    });
    it('only looks at the newest versions and returns a copy', () => {
        const manifest = { '7.1.0': bad, '7.69.36': bad };
        const r = repairManifestNotes(manifest, { '7.1.0': 'Old.', '7.69.36': 'New.' }, { keep: 1 });
        expect(r.notes['7.1.0']).toBe(bad);
        expect(r.notes['7.69.36']).toBe('New.');
        expect(manifest['7.69.36']).toBe(bad);
    });
    it('tolerates missing input', () => {
        expect(repairManifestNotes(null, null)).toEqual({ notes: {}, repaired: [] });
        expect(repairManifestNotes(undefined, { '1.0.0': 'x' }).repaired).toEqual([]);
    });
    it('looksSerialised recognises objects and arrays only', () => {
        expect(looksSerialised(' {"a":1}')).toBe(true);
        expect(looksSerialised('[1]')).toBe(true);
        expect(looksSerialised('Fixed {braces} later')).toBe(false);
        expect(looksSerialised(structured)).toBe(false);
    });
});

// The post-update screen must say how many changes a release really had and let the
// owner read every one of them (a fixed cap of 8 made a 77-change release look tiny).
import fs from 'node:fs';
import path from 'node:path';
describe('post-update screen counts every change', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'wealthflow-update-system.js'), 'utf8');
    const start = src.indexOf('function _maybeShowPostUpdate');
    const body = src.slice(start, src.indexOf('function _closePost'));
    it('shows a count and opens the full list instead of silently cutting at 8', () => {
        expect(body).not.toMatch(/slice\(0,\s*8\)/);
        expect(body).toMatch(/See all ' \+ total \+ ' changes/);
        expect(body).toMatch(/wfUpdate\.whatsNew/);
    });
    it('keeps the single primary button the app tests rely on', () => {
        expect(body).toMatch(/Return to Dashboard/);
    });
});
