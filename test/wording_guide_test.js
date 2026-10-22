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

const APP_FILES = [
    'index.html', 'sw.js', 'manifest.json', 'statement-store.js',
    ...fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.(js|mjs)$/.test(f)),
];

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
    [/Debt Demolisher/, 'the screen is the Debt Payoff Planner'],
    [/Triple-Engine/, 'brand fluff and a provider list that goes out of date'],
    [/AI Vision —|TF\.js Image Enhancement|Tesseract OCR Engine/, 'say what the scan does, not which library does it'],
    [/best-friend advisor|or just chat/, 'the advisor greets calmly and says what it does'],
    [/WealthFlow Elite|WEALTHFLOW ELITE|Elite (Report|Statement|Private|Financial)|Financial Vault|WealthFlow Intelligence Engine/, 'the product is "WealthFlow"; a report is a "statement"'],
    [/WealthFlow Infinity/, 'brand fluff: the product is "WealthFlow"'],
    [/Raw JSON Vault|Raw Data JSON|Generating Smart Link|Privacy Guaranteed/, 'say what the file or link is, and promise only what is true'],
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

describe('wording guide: toasts', () => {
    /** First string literal of every notify / _notify / toast call. */
    const TOAST = /\b(?:notify|_notify|toast)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
    const toasts = [];
    for (const [file, text] of SOURCES) {
        for (const line of text.split('\n')) {
            for (const m of line.matchAll(TOAST)) toasts.push([file, m[2].replace(/\$\{[^}]*\}/g, '')]);
        }
    }

    it('finds the toasts it is meant to check', () => {
        expect(toasts.length).toBeGreaterThan(300);
    });

    it('no toast shouts with an exclamation mark', () => {
        expect(toasts.filter(([, t]) => t.includes('!')).map(([f, t]) => `${f}: ${t}`)).toEqual([]);
    });

    it('no toast carries its own icon, the toast already draws one', () => {
        expect(toasts.filter(([, t]) => /@[A-Za-z0-9]+@/.test(t)).map(([f, t]) => `${f}: ${t}`)).toEqual([]);
    });

    it('no toast uses a contraction', () => {
        const contraction = /\b(?:can't|won't|don't|doesn't|didn't|couldn't|isn't|aren't|wasn't|haven't|hasn't|wouldn't|shouldn't|I'm|you're|you've|it's|let's|we're|I'll|you'll)\b/i;
        expect(toasts.filter(([, t]) => contraction.test(t.replace(/\\'/g, "'"))).map(([f, t]) => `${f}: ${t}`)).toEqual([]);
    });
});
