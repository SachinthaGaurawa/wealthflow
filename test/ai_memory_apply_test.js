// =============================================================================
// wealthflow-ai-memory.js — learned category propagation to suggested_fields
// =============================================================================
// `applyToBrain()` carried two dead guards — `if ('cat' in f || true)` and
// `if ('category' in f || true)` — whose `|| true` made the `in` checks always
// true. This test loads the browser IIFE hermetically and pins the intended,
// unambiguous behaviour: a confidently-learned category is written to BOTH the
// `cat` and `category` fields of the routed suggested_fields.
// =============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

let wfMemory;

beforeAll(() => {
    const win = { console };
    const src = fs.readFileSync(path.join(process.cwd(), 'wealthflow-ai-memory.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function('window', src)(win);
    wfMemory = win.wfMemory;
});

describe('wfMemory.applyToBrain() — learned category propagation', () => {
    it('writes the learned category to both cat and category on suggested_fields', async () => {
        await wfMemory.learn('KEELLS SUPER', {
            category: 'Food & Groceries',
            module: 'expenses',
            source: 'user',
        });

        const brain = {
            ok: true,
            resolved_merchant: { name: 'KEELLS SUPER', confidence: 0.5 },
            routed: { module: 'expenses', suggested_fields: { desc: 'KEELLS SUPER' }, confidence: 0.5 },
        };

        await wfMemory.applyToBrain(brain);

        expect(brain.routed.suggested_fields.cat).toBe('Food & Groceries');
        expect(brain.routed.suggested_fields.category).toBe('Food & Groceries');
        expect(brain._memory.matched).toBe(true);
        expect(brain._memory.userConfirmed).toBe(true);
    });

    it('does not touch a brain that is not ok', async () => {
        const brain = { ok: false, routed: { suggested_fields: {} } };
        await wfMemory.applyToBrain(brain);
        expect(brain.routed.suggested_fields.cat).toBeUndefined();
    });
});
