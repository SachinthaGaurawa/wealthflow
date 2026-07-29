// =============================================================================
// Proving test for issue #3 — numbered lists with 3+ digits
// =============================================================================
// Autonomously authored by Agent 4 (QA, via groq). The assertions are the
// agent's own and are genuinely good: they cover 1/2/3-digit list numbers, a
// negative case, and multiple lists in one string.
//
// The loader was corrected by hand: the generated version depended on `jsdom`
// (not a dependency here) and assigned a LOCAL `window` variable, so the browser
// IIFE `wealthflow-format.js` — which attaches to a global `window` — threw
// `ReferenceError` on import. This repo's browser modules run in node by setting
// `globalThis.window` first, then evaluating the source. (The QA agent is being
// hardened separately to emit this pattern itself.)
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let WFFmt;

beforeAll(() => {
    // Load the browser IIFE hermetically: evaluate the source with `window`
    // injected as a function parameter, so the module's bare `window` reference
    // resolves through closure. This needs no DOM, no dependency, and — crucially
    // — never touches globalThis, so it cannot pollute other test files.
    const win = {};
    const src = fs.readFileSync(path.join(process.cwd(), 'wealthflow-format.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', src)(win);
    WFFmt = win.WFFmt;
});

describe('wealthflow-format.js — numbered lists (issue #3)', () => {
    it('renders a numbered list with a 3-digit number (the reported bug)', () => {
        const result = WFFmt.render('100. hundred');
        expect(result).toContain('<div class="ai-numbered"><span class="ai-num">100</span> <span>hundred</span></div>');
    });

    it('still renders a 1-digit numbered list', () => {
        const result = WFFmt.render('1. one');
        expect(result).toContain('<div class="ai-numbered"><span class="ai-num">1</span> <span>one</span></div>');
    });

    it('still renders a 2-digit numbered list', () => {
        const result = WFFmt.render('10. ten');
        expect(result).toContain('<div class="ai-numbered"><span class="ai-num">10</span> <span>ten</span></div>');
    });

    it('does not turn ordinary prose into a numbered list', () => {
        expect(WFFmt.render('not a list')).not.toContain('ai-numbered');
    });

    it('renders a mix of 1-, 2- and 3-digit list items in one string', () => {
        const result = WFFmt.render('1. one\n2. two\n100. hundred');
        expect(result).toContain('<span class="ai-num">1</span> <span>one</span>');
        expect(result).toContain('<span class="ai-num">2</span> <span>two</span>');
        expect(result).toContain('<span class="ai-num">100</span> <span>hundred</span>');
    });
});
