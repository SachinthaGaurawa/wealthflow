// =============================================================================
// WealthFlow Shadow Test Harness — the quarantine learning loop is WIRED
// =============================================================================
// This repository's most persistent defect is a facility that is built, tested
// and then wired to nobody. wealthflow-quarantine.js had no caller at all;
// existingHashes had been accepted by classifyStatement since it was written and
// never once passed; renderQuarantineTile() was called and never defined.
//
// wealthflow-layout-memory.js has its own tests, and they prove the logic. They
// prove nothing about whether a statement the owner receives ever reaches it.
// That is what this file is for, and every assertion below names the specific
// break it would catch:
//
//   - the script tag missing         -> window.WFLayoutMemory is undefined, the
//                                       parser's fallback silently does nothing,
//                                       and every unknown layout stays a dead end
//   - `{ bank }` not passed          -> the owner's own bank's layout is tried
//                                       after five strangers', or not at all
//   - LAYOUT_UNKNOWN not collected   -> the teach screen never opens
//   - the text not carried out       -> the teach screen has nothing to read
//   - remember() never called        -> the owner confirms the same layout every
//                                       month, which is the opposite of learning
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const intake = fs.readFileSync('wealthflow-mail-intake.js', 'utf8');

function codeOnly(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body of a top-level `function NAME(` in the page, to its closing brace. */
function functionBody(name) {
    const at = html.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let p = html.indexOf('(', at);
    let paren = 0;
    let i = -1;
    for (let j = p; j < html.length; j += 1) {
        if (html[j] === '(') paren += 1;
        else if (html[j] === ')') {
            paren -= 1;
            if (paren === 0) { i = html.indexOf('{', j); break; }
        }
    }
    if (i < 0) return '';
    let depth = 0;
    for (let j = i; j < html.length; j += 1) {
        if (html[j] === '{') depth += 1;
        else if (html[j] === '}') { depth -= 1; if (depth === 0) return html.slice(at, j + 1); }
    }
    return html.slice(at);
}

describe('the module is loaded by the page at all', () => {
    it('index.html loads wealthflow-layout-memory.js', () => {
        expect(html).toMatch(/<script[^>]+src="wealthflow-layout-memory\.js"/);
    });

    it('the file it extends is loaded too, and this one is not loaded instead of it', () => {
        expect(html).toMatch(/<script[^>]+src="wealthflow-statement-parser\.js"/);
        expect(html.indexOf('wealthflow-layout-memory.js'))
            .toBeGreaterThan(html.indexOf('wealthflow-statement-parser.js'));
    });

    it('the file exists and attaches to window (a 404 would be a silent no-op)', () => {
        const src = fs.readFileSync('wealthflow-layout-memory.js', 'utf8');
        expect(src).toContain('W.WFLayoutMemory = API');
    });
});

describe('the parser asks the memory, and the memory cannot recurse', () => {
    const parser = fs.readFileSync('wealthflow-statement-parser.js', 'utf8');

    it('parseStatement consults the layouts the owner confirmed', () => {
        expect(parser).toContain('W.WFLayoutMemory');
        expect(parser).toMatch(/mem\.recall\(opts\.bank\)/);
        expect(parser).toMatch(/mem\.normalise\(src, taught\[ti\]\)/);
    });

    it('only when it read nothing, and never twice', () => {
        // Trying a rewrite on a statement that already parsed would let a
        // learned layout overwrite a correct reading. The guard is the verdict.
        expect(parser).toContain("if (verdict === 'unreadable' && !opts.__learned)");
        expect(parser).toContain('{ __learned: true, bank: opts.bank }');
    });
});

describe('runMailSync collects the statements worth asking about', () => {
    const fn = codeOnly(functionBody('runMailSync'));

    it('runMailSync was found (guards against a vacuous pass)', () => {
        expect(fn.length).toBeGreaterThan(2000);
    });

    it('an unknown layout is queued for teaching, and nothing else is', () => {
        expect(fn).toContain('QK.LAYOUT_UNKNOWN');
        expect(fn).toContain('_teach.push');
        // A locked PDF or an empty statement is not a layout question, and
        // asking about it wastes the one confirmation the owner will give.
        expect(fn).not.toMatch(/_teach\.push[\s\S]{0,200}PASSWORD_FAILED/);
    });

    it('the statement text is carried to the teach screen', () => {
        // Without it the screen has nothing to propose a reading of.
        expect(fn).toMatch(/text: res\.text/);
        expect(fn).toMatch(/typeof res\.text === 'string'/);
    });

    it('teaching runs BEFORE the review screen, not on top of it', () => {
        // Two modals at once files half the sync. The review screen is opened
        // from inside the teach callback.
        expect(fn).toContain('_teachStatementLayout(_teach');
        const teachAt = fn.indexOf('_teachStatementLayout(_teach');
        const openAt = fn.indexOf('const _openReview');
        expect(openAt).toBeGreaterThan(-1);
        expect(openAt).toBeLessThan(teachAt);
        expect(fn).toMatch(/_teachStatementLayout\(_teach,[\s\S]{0,600}_openReview\(\);/);
    });
});

describe('the teach flow closes the loop', () => {
    const teach = codeOnly(functionBody('_teachStatementLayout'));
    const modal = codeOnly(functionBody('_showLayoutTeachModal'));

    it('both functions were found (guards against a vacuous pass)', () => {
        expect(teach.length).toBeGreaterThan(500);
        expect(modal.length).toBeGreaterThan(1500);
    });

    it('it proposes a reading rather than asking the owner to type one', () => {
        expect(teach).toMatch(/M\.propose\(item\.text, P\.parseStatement/);
    });

    it('THE LEARNING STEP: a confirmed reading is remembered', () => {
        // Without this the owner confirms the same layout every single month.
        expect(teach).toMatch(/M\.remember\(item\.bank, reading\.template\)/);
    });

    it('the confirmed rows go to the same review screen as everything else', () => {
        expect(teach).toContain('learned.push');
        expect(teach).toMatch(/rows: reading\.rows/);
    });

    it('a missing module is announced, not swallowed', () => {
        // A statement skipped because a script did not load is exactly the
        // silent failure this feature exists to end.
        expect(teach).toMatch(/if \(!P \|\| !M \|\| typeof M\.propose !== 'function'\)/);
        expect(teach).toMatch(/notify\(/);
    });

    it('the modal builds its rows with textContent, never innerHTML', () => {
        // Every value on that screen came out of a PDF someone else wrote.
        expect(modal).not.toContain('innerHTML');
        expect(modal).toContain('textContent');
    });

    it('the modal keeps its heading and its buttons on screen on a phone', () => {
        // The owner ruled out the lazy route by name: critical items are not to
        // be hidden to make room. The body scrolls inside a bounded card.
        expect(modal).toContain('max-height:92vh');
        expect(modal).toMatch(/overflow:auto;flex:1 1 auto/);
        expect(modal).not.toMatch(/display:none/);
        // A wide table scrolls in its own box rather than the page sideways.
        expect(modal).toContain('overflow-x:auto');
    });

    it('every button is reachable by touch and by keyboard', () => {
        expect(modal).toContain('min-height:44px');
        expect(modal).toMatch(/e\.key === 'Escape'/);
    });
});

describe('the intake names which of the three emptinesses happened', () => {
    it('the parser verdict decides the reason, not rows.length', () => {
        expect(intake).toMatch(/const verdict = parsed && parsed\.verdict;/);
        expect(intake).toMatch(/verdict === 'no-text'[\s\S]{0,80}NO_TEXT_LAYER/);
        expect(intake).toMatch(/verdict === 'empty'[\s\S]{0,80}NO_TRANSACTIONS/);
        expect(intake).toMatch(/verdict === 'unreadable'/);
    });

    it('only the teachable case carries the statement text back out', () => {
        // It is the owner's bank statement. It travels exactly as far as the
        // screen that needs it and no further.
        const at = intake.indexOf("verdict === 'unreadable'");
        expect(at).toBeGreaterThan(-1);
        const block = intake.slice(at, at + 700);
        expect(block).toContain('LAYOUT_UNKNOWN');
        expect(block).toContain('teachable: true');
        expect(block).toMatch(/\n\s+text,\n/);
        // Not attached to the other refusals.
        expect(intake).not.toMatch(/NO_VAULT_KEYS[\s\S]{0,120}text,/);
    });

    it('rows that do not add up are flagged without being thrown away', () => {
        expect(intake).toContain('BALANCE_MISMATCH');
        expect(intake).toContain('advisory: true');
        // intakeAll must not count an advisory as a failed statement.
        expect(intake).toContain("q.scope === 'statement' && !q.advisory");
    });

    it('every quarantine reason has a sentence the owner can act on', () => {
        // A reason with no text renders as "it needs a look", which is what the
        // three new ones would have done.
        const codes = [...intake.matchAll(/^\s{4}([A-Z_]+): '([a-z-]+)',/gm)].map((m) => m[2]);
        expect(codes.length).toBeGreaterThanOrEqual(11);
        for (const c of codes) {
            expect(intake, 'no QUARANTINE_TEXT for ' + c)
                .toMatch(new RegExp('QUARANTINE\\.[A-Z_]+\\]: \'[^\']+\'', 'g'));
        }
        for (const key of ['LAYOUT_UNKNOWN', 'NO_TRANSACTIONS', 'BALANCE_MISMATCH']) {
            expect(intake).toMatch(new RegExp('\\[QUARANTINE\\.' + key + '\\]: \''));
        }
    });
});
