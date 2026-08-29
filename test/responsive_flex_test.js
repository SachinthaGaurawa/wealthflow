// =============================================================================
// test/responsive_flex_test.js — guardrail for the flex-overflow fixes.
//
// A flex row that pairs a flexible title/text block with `white-space: nowrap`
// buttons cannot shrink: the buttons hold their full width, the text block is
// crushed to a couple of characters per line, and the last button is pushed
// past the screen edge (then clipped by `body { overflow-x: hidden }`). The
// three fixes below pin the invariants that stop that from returning:
//
//   1. header rows must wrap,
//   2. the title/text block must be allowed to shrink (`min-width: 0`),
//   3. long unbroken strings must break instead of forcing the row wide.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

function rule(selector) {
    // Escapes the selector for a literal regex, then finds its first `{ … }`.
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = html.match(new RegExp(esc + '\\s*\\{([^}]*)\\}'));
    return m ? m[1] : '';
}

describe('responsive: header/text rows wrap instead of crushing', () => {
    it('.card-hdr-row wraps so action buttons drop to their own line', () => {
        expect(rule('.card-hdr-row')).toContain('flex-wrap: wrap');
    });

    it('.card-hdr-row .card-hdr-main is allowed to shrink', () => {
        expect(rule('.card-hdr-row > .card-hdr-main')).toContain('min-width: 0');
    });

    it('.md-hdr wraps so modal titles are not squeezed by action buttons', () => {
        expect(rule('.md-hdr')).toContain('flex-wrap: wrap');
    });

    it('.md-title can shrink and break long unbroken names', () => {
        const body = rule('.md-title');
        expect(body).toContain('min-width: 0');
        expect(body).toContain('overflow-wrap');
    });

    it('.setting-row wraps so labels are not crushed by controls', () => {
        expect(rule('.setting-row')).toContain('flex-wrap: wrap');
    });

    it('.setting-info is allowed to shrink below its longest word', () => {
        expect(rule('.setting-info')).toContain('min-width: 0');
    });
});
