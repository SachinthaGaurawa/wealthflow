/* =============================================================================
 * test/debt_demolisher_icons_test.js
 * -----------------------------------------------------------------------------
 * The Debt Demolisher screen, migrated from emoji to icons.
 *
 * Every glyph on this screen sat in a template literal written into innerHTML,
 * so `${_ic('name')}` composes directly — no new sink parameter, unlike the
 * scanner's overlay. What it needed instead was care about WHICH icon, because
 * this screen's glyphs were not decoration:
 *
 *   the mountain and the snowman are the two debt-payoff STRATEGIES.
 *
 * Avalanche pays the highest interest rate first; snowball pays the smallest
 * balance first. They appear side by side, three times each, and a migration
 * that gave both the same mark would pass an emoji count while destroying the
 * one distinction the screen exists to draw. Removing an icon is not an emoji
 * violation, so only naming them catches it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ICONS = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');

function fn(name) {
    const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let depth = 0;
    for (let j = HTML.indexOf('{', at); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    return '';
}

const BODY = fn('renderDebtDemolisher');

describe('the Debt Demolisher screen', () => {
    it('was found, and is reachable from the router', () => {
        expect(BODY, 'renderDebtDemolisher is gone — every test here would pass vacuously').toBeTruthy();
        expect(BODY.length).toBeGreaterThan(5000);
        /* Wired to a page, not orphaned. This repository's most common defect
         * is a facility built and connected to nothing. */
        expect(HTML, 'the screen is no longer routed').toContain('debtdemo: renderDebtDemolisher');
    });

    it('keeps the two payoff strategies visually distinct', () => {
        /* The assertion this file exists for. Both names, both icons, and the
         * two icons must differ from each other. */
        const avalanche = [...BODY.matchAll(/_ic\('([a-zA-Z]+)'\)\}?\s*Avalanche/g)].map((m) => m[1]);
        const snowball = [...BODY.matchAll(/_ic\('([a-zA-Z]+)'\)\}?\s*Snowball/g)].map((m) => m[1]);

        expect(avalanche.length, 'the Avalanche headings lost their icons').toBeGreaterThanOrEqual(3);
        expect(snowball.length, 'the Snowball headings lost their icons').toBeGreaterThanOrEqual(3);

        expect(new Set(avalanche).size, `Avalanche is inconsistent: ${avalanche.join(' ')}`).toBe(1);
        expect(new Set(snowball).size, `Snowball is inconsistent: ${snowball.join(' ')}`).toBe(1);
        expect(avalanche[0], 'both strategies were given the SAME icon — the screen no longer distinguishes them')
            .not.toBe(snowball[0]);
    });

    it('names an icon for each thing on the screen, and each one exists', () => {
        const named = [...new Set([...BODY.matchAll(/_ic\('([a-zA-Z][a-zA-Z0-9]*)'\)/g)].map((m) => m[1]))];
        expect(named.length, 'the screen names too few icons to have been migrated').toBeGreaterThanOrEqual(8);
        const missing = named.filter((n) => !ICONS.includes(`${n}:`));
        expect(missing, `icons not in wealthflow-icons.js: ${missing.join(', ')}`).toEqual([]);
    });

    it('gives each distinct concept its own mark rather than one generic one', () => {
        /* Named individually, because a spot check on two of them is how a
         * migration that collapsed ten glyphs into one icon survives review. */
        for (const [text, icon] of [
            ['Interactive Payoff Simulator', 'settings'],
            ['Your Accelerated Payoff Plan', 'target'],
            ['Your Personalized Payoff Plan', 'target'],
            ['Accelerated Payoff', 'trendUp'],
            ['Active Debt Account', 'bank'],
            ['AI Debt Strategist', 'bot'],
            ['Generate Deep AI Strategy', 'sparkles'],
            ['How to Use Debt Demolisher', 'info'],
            ['Recommendation:', 'thumbsUp'],
            ['TARGET', 'target'],
        ]) {
            /* Some of these labels are substrings of others — "Accelerated
             * Payoff" also occurs inside "Your Accelerated Payoff Plan", and
             * the two carry DIFFERENT icons on purpose. So: find every line
             * carrying the label, and require one of them to pair it with this
             * icon, rather than trusting the first match. */
            const lines = BODY.split('\n').filter((l) => l.includes(text));
            expect(lines.length, `the "${text}" label is gone`).toBeGreaterThan(0);
            const paired = lines.filter((l) => l.includes(`_ic('${icon}')`));
            expect(paired.length, `"${text}" is never paired with the ${icon} icon`).toBeGreaterThan(0);
        }
    });

    it('keeps the debt-free empty state, with an icon rather than a glyph', () => {
        const line = BODY.split('\n').find((l) => l.includes("'Debt Free!'"));
        expect(line, 'the empty state is gone').toBeTruthy();
        expect(line, 'emptyState takes its icon as an argument, so _ic() is called, not interpolated')
            .toContain("emptyState(_ic('trophy')");
    });

    it('carries no emoji', () => {
        const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
        const found = BODY.match(EMOJI) || [];
        expect(found, `emoji left on the screen: ${found.join(' ')}`).toEqual([]);
    });

    it('is not overridden by a sibling file', () => {
        /* Checked BEFORE the migration this time, not after. Two functions on
         * the scanner screen were replaced at load by wealthflow-ai-v4.js, and
         * cleaning the host copies changed the emoji count and nothing a user
         * could see. */
        const siblings = fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f));
        for (const f of siblings) {
            expect(fs.readFileSync(path.join(ROOT, f), 'utf8'),
                `${f} replaces renderDebtDemolisher — migrate the replacement instead`)
                .not.toMatch(/window\.renderDebtDemolisher\s*=/);
        }
    });
});
