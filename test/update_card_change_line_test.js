/* #625: the waiting-update card says in one line what the update changes, from THAT version's own release note. */
import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const POLICY = loadBrowserModule('wealthflow-update-policy.js').window.WF_UPDATE_POLICY;
const json = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });

async function cardFor(notes, latest = '99.0.0') {
    const manifest = { latest, notes };
    const fetchImpl = async (url) => {
        if (String(url).includes('/api/version')) return json({ sha: 'abc123def456' });
        if (String(url).includes('version.json')) return json(manifest);
        return { ok: false, status: 404 };
    };
    const m = loadBrowserModule('wealthflow-update-system.js', {
        html: '<div id="wfUpdateCard"></div><nav><span id="nb-settings" style="display:none"></span></nav><div id="page-dashboard"><h1>Home</h1></div>',
        fetchImpl, globals: { WF_UPDATE_POLICY: POLICY, WFWhen: { today: () => '2026-11-19' }, wfVersionManifest: manifest },
    });
    await m.window.wfUpdate._loadManifest();
    m.window.wfUpdate.refresh();
    const card = m.document.getElementById('wfUpdateCard');
    expect(card.textContent).toContain('Update now');
    return card;
}

describe('update card: one line saying what changed', () => {
    it('shows the first sentence of that version\'s own note', async () => {
        const card = await cardFor({ '99.0.0': 'Cheques now settle from the statement. A second sentence that must not appear.' });
        expect(card.textContent).toContain('Cheques now settle from the statement.');
        expect(card.textContent).not.toContain('second sentence');
    });

    it('cuts a long note to one short line on whole characters, Sinhala included', async () => {
        const long = 'සිංහල '.repeat(80);
        const card = await cardFor({ '99.0.0': long });
        const line = [...card.querySelectorAll('div')].find((d) => d.textContent.startsWith('සිංහල') && d.children.length === 0);
        expect(line).toBeTruthy();
        expect(Array.from(line.textContent).length).toBeLessThanOrEqual(140);
        expect(line.textContent.endsWith('…')).toBe(true);
        expect(line.textContent).not.toMatch(/[�]/);
    });

    it('draws nothing extra when the version has no note (no other release\'s note is borrowed)', async () => {
        const withNote = await cardFor({ '99.0.0': 'Plain change.' });
        const without = await cardFor({ '98.0.0': 'An older release.' });
        expect(withNote.textContent).toContain('Plain change.');
        expect(without.textContent).not.toContain('An older release.');
        expect(without.textContent).toContain('Update now');
    });

    it('escapes the text: markup in a note is shown as words, never run', async () => {
        const card = await cardFor({ '99.0.0': '<img src=x onerror=alert(1)> Fixed.' });
        expect(card.querySelector('img')).toBeNull();
        expect(card.textContent).toContain('<img');
    });
});
