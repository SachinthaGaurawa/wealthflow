// =============================================================================
// test/responsive_table_test.js — guardrail for the table-overflow fix.
//
// The global `table` rule used to carry `min-width: 600px`. Because `body` has
// `overflow-x: hidden`, any table that was NOT inside a scrollable `.tbl-wrap`
// (modal summaries, AI advisor tables, amortization schedules, …) was silently
// clipped at the screen edge on narrow devices — columns and words cut off.
//
// The fix scopes the 600px floor to `.tbl-wrap` (which scrolls sideways) and
// lets every other table shrink to fit. This test pins that split so the
// overflow cannot silently come back.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

// The bare `table {` rule (not `.tbl-wrap table {`, not `table.amort {`).
function globalTableRule() {
    const m = html.match(/\n\s*table\s*\{([^}]*)\}/);
    return m ? m[1] : '';
}

function scopedTableRule() {
    const m = html.match(/\.tbl-wrap\s+table\s*\{([^}]*)\}/);
    return m ? m[1] : '';
}

describe('responsive: table minimum width is scoped to the scroll wrapper', () => {
    it('lets the global table rule shrink to fit its container', () => {
        const body = globalTableRule();
        expect(body, 'global table rule not found').not.toBe('');
        expect(body).toContain('min-width: 0');
        expect(body).not.toContain('min-width: 600px');
    });

    it('gives only .tbl-wrap tables the 600px sideways-scroll floor', () => {
        const body = scopedTableRule();
        expect(body, '.tbl-wrap table rule not found').not.toBe('');
        expect(body).toContain('min-width: 600px');
    });
});
