/* Nothing in the owner's elite-expert prompt may be dropped silently again (#564 squeezed 26 parts to nine rules).
 * This reads the ORIGINAL (docs/elite-expert-mode.original.md, saved verbatim) and fails if any part of it has no section in
 * wf-charter-sections.mjs, no row in docs/update-charter.md, or if a section is only a copy of its heading. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { SECTIONS, SECTION_BY_ID } from '../wf-charter-sections.mjs';

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const original = read('docs/elite-expert-mode.original.md');
const heads = [...original.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
const numbered = heads.map((h) => /^(\d+)\. (.+)$/.exec(h)).filter(Boolean).map((m) => ({ n: Number(m[1]), title: m[2] }));

describe('every part of the original prompt has a section', () => {
    it('the original has the core mission, sections 1 to 24 and the task', () => {
        expect(heads[0]).toBe('CORE MISSION');
        expect(numbered.map((x) => x.n)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
        expect(heads[heads.length - 1]).toBe('USER TASK');
        expect(original).toMatch(/### OPTIONAL TASK PARAMETERS/);
    });

    it('each numbered section has the same number and (case aside) the same title', () => {
        for (const o of numbered) {
            const s = SECTIONS.find((x) => x.n === o.n);
            expect(s, `section ${o.n}`).toBeTruthy();
            expect(s.title.toLowerCase()).toBe(o.title.toLowerCase());
        }
        expect(SECTION_BY_ID.mission.n).toBe(0);
        expect(SECTION_BY_ID.task.n).toBe(25);
        expect(SECTIONS.map((s) => s.n)).toEqual(Array.from({ length: 26 }, (_, i) => i));
        expect(new Set(SECTIONS.map((s) => s.id)).size).toBe(26);
    });

    it('every section is real text in two sizes, written for this repository', () => {
        for (const s of SECTIONS) {
            expect(s.std.length, `${s.id} std`).toBeGreaterThan(150);
            expect(s.full.length, `${s.id} full`).toBeGreaterThan(s.std.length + 200);
            expect(s.std.length, `${s.id} std stays short`).toBeLessThan(700);
        }
        const all = SECTIONS.map((s) => s.full).join('\n');
        // each section is tied to something that exists here, not pasted general advice
        for (const word of [/service worker/i, /sabotage check/i, /canary/i, /guarded/i, /ledger/i, /free-tier|free tier/i, /rupees/i, /board/i, /restore point/i, /public/i]) expect(all).toMatch(word);
    });

    it('the key instructions of the original survive in them', () => {
        const all = SECTIONS.map((s) => s.full).join('\n');
        for (const phrase of [
            /Truth over agreement|truth over agreement/, /Never promise infallibility/, /Verified fact|VERIFIED FACT/i, /HIGH:|HIGH confidence|HIGH, MODERATE/,
            /Baseline|BASELINE/, /Disruptive|DISRUPTIVE/, /second order|SECOND ORDER/i, /pre-mortem/i, /prompt injection/i,
            /Check 1|1 Task alignment/, /12 Final consistency/, /Never manufacture certainty/, /Do not confuse/, /critical 1%/,
            /Three|three models/i, /Desired outcome/, /Evaluation criteria/,
        ]) expect(all, String(phrase)).toMatch(phrase);
    });
});

describe('the human page maps every part to the code that applies it', () => {
    const doc = read('docs/update-charter.md');
    it('has a row for every part, 0 to 25', () => {
        for (const s of SECTIONS) {
            expect(doc, `docs/update-charter.md row for part ${s.n}`).toMatch(new RegExp(`\\|\\s*${s.n}\\s*\\|`));
        }
    });
    it('names where the original is kept and what is not done', () => {
        expect(doc).toMatch(/docs\/elite-expert-mode\.original\.md/);
        expect(doc).toMatch(/What this does not do/i);
    });
    it('every file it points at exists', () => {
        const files = [...new Set([...doc.matchAll(/`((?:autonomy|test|docs|\.github\/workflows)\/[\w./-]+|wf-[\w-]+\.mjs|consensus-review\.mjs|autonomous-fix-agent\.js)`/g)].map((m) => m[1]))];
        expect(files.length).toBeGreaterThan(10);
        for (const f of files) expect(fs.existsSync(new URL(`../${f}`, import.meta.url)), f).toBe(true);
    });
});
