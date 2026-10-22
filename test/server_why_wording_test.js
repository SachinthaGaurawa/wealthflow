// =============================================================================
// _wfServerWhy: the server writes some answers for a log ("sender list
// unreadable"); the screen must show a sentence a person can act on.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function _wfServerWhy');
const end = html.indexOf('window._wfServerWhy');
const why = new Function(`${html.slice(start, end)}; return _wfServerWhy;`)();
const FALLBACK = 'The change could not be completed. Please try again.';

describe('_wfServerWhy', () => {
    it('is found in the page source', () => {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
    });

    it('uses the fallback when the server said nothing', () => {
        for (const empty of ['', '   ', null, undefined]) expect(why(empty, FALLBACK)).toBe(FALLBACK);
    });

    it('passes a finished sentence through untouched', () => {
        expect(why('The statement could not be removed.', FALLBACK)).toBe('The statement could not be removed.');
    });

    it.each([
        ['no mailbox is connected yet', /^No mailbox is connected yet\. Connect Gmail first\.$/],
        ['Gmail did not answer in time', /^Google did not answer in time\./],
        ['no such sender', /^That sender is no longer in the list\.$/],
        ['could not disconnect', /^Gmail could not be disconnected\./],
        ['could not save the sender list', /^The change could not be saved\./],
        ['sender list unreadable', /^WealthFlow could not reach the server just now\./],
        ['state unreadable', /^WealthFlow could not reach the server just now\./],
    ])('turns the log line %j into a sentence', (raw, expected) => {
        const out = why(raw, FALLBACK);
        expect(out).toMatch(expected);
        expect(out).toMatch(/^[A-Z].*[.?]$/);
    });

    it('keeps a long, instructive message and finishes it properly', () => {
        const raw = 'that does not look like a refresh token. It should be the refresh_token value alone, not an access token';
        const out = why(raw, FALLBACK);
        expect(out.startsWith('That does not look like a refresh token.')).toBe(true);
        expect(out.endsWith('.')).toBe(true);
    });

    it('never shows a bare machine code', () => {
        for (const code of ['delete_incomplete', 'inbox_not_configured', 'missing refresh_token']) {
            expect(why(code, FALLBACK)).toBe(FALLBACK);
        }
    });
});
