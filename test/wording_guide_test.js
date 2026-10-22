// =============================================================================
// The wording guide (docs/wording-guide.md), kept from drifting back.
// -----------------------------------------------------------------------------
// The wording audit replaced marketing names, slang and internal terms in the
// owner app with one calm, professional voice. This test scans the shipped
// sources for the phrases the audit removed, so a later edit cannot quietly
// bring one back. Comments are ignored: a comment may name the old wording to
// explain why it went.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

/** Source text with comment-only lines and trailing line comments removed. */
function visibleSource(file) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return raw
        .split('\n')
        .map((line) => {
            const t = line.trim();
            if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return '';
            return line.replace(/\s\/\/\s.*$/, '');
        })
        .join('\n');
}

const APP_FILES = ['index.html', ...fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.(js|mjs)$/.test(f))];

/** Phrases the audit removed, with the reason a reader would want. */
const BANNED = [
    [/Infinity (Engine|Cloud)/, 'brand fluff: the product is "WealthFlow"'],
    [/Passcode-free/i, 'the feature is "PIN-free entry"; the lock is a PIN'],
    [/Core System Reset|Core Data Wiped/, 'say what happens: "Erase all data"'],
    [/Format Database|Wipe System Data|Authenticate &\s*Wipe/, 'say what happens: "Erase data"'],
    [/Restore Data Protocol|Restore Vault/, 'say what it does: "Restore data"'],
    [/Dynamic Soundscapes|luxury (UI|vibration|PDF)/i, 'marketing language, not a description'],
    [/Keep pushing|Feel that buzz|paste it to me/i, 'casual or developer-facing copy in a user message'],
    [/Please fill required fields|Fill required fields/, 'a form error names the missing fields: "Add the loan name, bank and amount."'],
    [/TARGET ACHIEVED|Congratulations!|Amazing!/, 'celebration shouting; say what happened, calmly'],
    [/MONTHLY INSTALLMENT/, 'no capitals for emphasis; spell it "instalment"'],
];

const SOURCES = APP_FILES.map((file) => [file, visibleSource(file)]);

describe('wording guide: phrases the audit removed stay removed', () => {
    for (const [pattern, why] of BANNED) {
        it(`no shipped source contains ${pattern} (${why})`, () => {
            const hits = SOURCES.filter(([, text]) => pattern.test(text)).map(([file]) => file);
            expect(hits, why).toEqual([]);
        });
    }
});
