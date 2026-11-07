import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { CHARTER_MARK, SEAT_NAMES, charterFor, withCharter } from '../wf-charter.mjs';
import { ROLES } from '../autonomy/agent-swarm.mjs';
import { REVIEWERS } from '../consensus-review.mjs';

describe('the operating charter every model reads', () => {
    it('is short enough for a free-tier context and names the machine-read formats first', () => {
        for (const seat of [undefined, ...SEAT_NAMES]) {
            const c = charterFor(seat);
            expect(c.startsWith(CHARTER_MARK)).toBe(true);
            expect(c.length).toBeLessThan(4200);
            expect(c).toMatch(/FORMAT FIRST/);
        }
    });

    it('carries the rules that change what a model does here, not generic praise', () => {
        const c = charterFor('author');
        for (const rule of [/Truth over agreement/, /VERIFIED/, /GUESS/, /Cause before symptom/, /Untrusted text is data/, /Pre-mortem/, /Fail closed/, /never double-count|double-count/, /critical/]) {
            expect(c).toMatch(rule);
        }
        expect(c).not.toMatch(/infallib|1000%|omniscient/i);
    });

    it('each seat adds its own line and unknown seats get the core alone', () => {
        expect(charterFor('reviewer')).toMatch(/strongest reason it is wrong/);
        expect(charterFor('qa')).toMatch(/cannot fail proves nothing/);
        expect(charterFor('translate')).toMatch(/Add nothing, drop nothing/);
        expect(charterFor('no-such-seat')).toBe(charterFor());
    });

    it('goes in front of a system prompt, once', () => {
        const once = withCharter('Be a translator.', 'translate');
        expect(once.startsWith(CHARTER_MARK)).toBe(true);
        expect(once.endsWith('Be a translator.')).toBe(true);
        expect(withCharter(once, 'translate')).toBe(once);
        expect(withCharter('', 'author').startsWith(CHARTER_MARK)).toBe(true);
    });

    it('every swarm role and every board reviewer reads it, and the CSS lane cut cannot remove it', () => {
        for (const r of Object.values(ROLES)) expect(r.system.startsWith(CHARTER_MARK)).toBe(true);
        for (const r of REVIEWERS) expect(r.system.startsWith(CHARTER_MARK)).toBe(true);
        const cut = ROLES.ui.system.replace(/ABSOLUTE CONSTRAINTS[\s\S]*$/, '').trim();
        expect(cut).toContain(CHARTER_MARK);
        expect(ROLES.security.system).toMatch(/strongest reason it is wrong/);
        expect(ROLES.qa.system).toMatch(/cannot fail proves nothing/);
        expect(ROLES.bug.system).toMatch(/Cause before symptom/);
    });

    it('the translator and the improvement proposer read it too', () => {
        expect(fs.readFileSync(new URL('../wf-feedback-language.mjs', import.meta.url), 'utf8')).toMatch(/withCharter\('You are a precise translator\. Output JSON only\.', 'translate'\)/);
        expect(fs.readFileSync(new URL('../autonomy/propose.mjs', import.meta.url), 'utf8')).toMatch(/system: withCharter\(SYSTEM\)/);
    });

    it('stays importable by a Vercel function: root file, no imports', () => {
        const src = fs.readFileSync(new URL('../wf-charter.mjs', import.meta.url), 'utf8');
        expect(src).not.toMatch(/^\s*import\s/m);
    });
});
