import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'autonomy', 'agent-swarm.mjs'), 'utf8');

describe('autonomous security review availability gate', () => {
    it('blocks when the independent security reviewer is unavailable', () => {
        expect(SRC).toContain("stage: 'security_unavailable'");
        expect(SRC).toContain("verdict: 'FAIL'");
        expect(SRC).not.toContain("no independent reviewer available — deferring to CI gates");
    });

    it('does not reuse the author or security reviewer for QA', () => {
        expect(SRC).toContain('exclude: [authored.provider, reviewed.provider]');
    });
});
