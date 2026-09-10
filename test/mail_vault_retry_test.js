/* =============================================================================
 * test/mail_vault_retry_test.js — the statement that arrived and stayed shut
 * -----------------------------------------------------------------------------
 * Sri Lankan banks lock statement PDFs, and the vault holding those passwords
 * is itself locked until the owner enters their PIN. So there is a state where
 * everything worked — the watch fired, the statement was fetched, stored,
 * assembled — and the owner still has nothing, because no key was tried.
 *
 * The card said "held" with a sentence, threw the REASON CODE away, and offered
 * nothing to do about it. "None of your saved keys opened it" and "the layout
 * yielded no rows" then looked like the same dead end, though one of them is
 * fixed by one tap.
 *
 * The iteration itself was never the problem and is not changed here: unlock()
 * tries every candidate the vault offers, and candidatesFor() offers every
 * password when the bank is unknown — both are pinned in mail_intake_test.js
 * and vault_test.js. What this file pins is the part that was missing: the
 * count, the sentence that distinguishes a locked vault from a wrong password,
 * and the retry that happens without the owner being asked twice.
 *
 * A second gap sat behind the first one: _mailBootCheck() (the "auto sync
 * වෙන්නේ නෑ" fix) populates `items` on every boot without ever running the
 * heavy loop that increments `locked` — by design, so boot stays cheap. So a
 * device that opened with a locked vault and mail already waiting showed
 * NOTHING actionable: `lockedCount` was still 0, since nothing had been
 * tried and failed yet. The owner had saved the password; the app simply
 * never got a chance to say it needed to be asked for it. The strip now also
 * fires proactively — vault locked, at least one known-sender statement
 * sitting in `waiting`, zero attempts made yet — with wording that says
 * exactly that nothing has been tried, never the "opened it" language.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { QUARANTINE, unlock } from '../wealthflow-mail-intake.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function fn(name) {
    const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
    const m = decl.exec(HTML);
    if (!m) return '';
    const after = HTML.slice(m.index + m[0].length);
    const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
    return next < 0 ? HTML.slice(m.index) : HTML.slice(m.index, m.index + m[0].length + next);
}

describe('the reason code survives the trip to the screen', () => {
    it('THE NAMES THE PAGE USES ARE REAL ONES', () => {
        /* A typo here fails silently and forever: the comparison is simply
         * never true, no statement is ever counted as locked, and the strip
         * that offers the fix never appears. Nothing throws. */
        const body = fn('runMailSync');
        const used = [...body.matchAll(/QK\.([A-Z_]+)/g)].map((m) => m[1]);
        expect(used.length, 'the page no longer reads any quarantine code').toBeGreaterThan(0);
        for (const name of used) {
            expect(Object.prototype.hasOwnProperty.call(QUARANTINE, name),
                `QUARANTINE has no ${name} — this comparison can never be true`).toBe(true);
        }
        expect(used).toContain('PASSWORD_FAILED');
        expect(used).toContain('NO_VAULT_KEYS');
    });

    it('it reads STATEMENT-scope refusals, not row-scope ones', () => {
        /* A row that needs a category is not a statement that would not open,
         * and counting the two together would put the vault strip on screen
         * over forty perfectly readable rows. */
        const body = fn('runMailSync');
        expect(body).toContain("q.scope === 'statement'");
    });

    it('the count is reset at the start of every run', () => {
        /* Otherwise unlocking the vault and re-checking leaves the strip on
         * screen forever, counting statements that opened fine. */
        const body = fn('runMailSync');
        const reset = body.indexOf('_mailSyncState.locked = 0');
        const bump = body.indexOf('_mailSyncState.locked += 1');
        expect(reset).toBeGreaterThan(-1);
        expect(bump).toBeGreaterThan(reset);
    });
});

describe('what the card offers', () => {
    const card = fn('renderMailSync');

    it('says the statements arrived and could not be opened', () => {
        expect(card).toContain('password-protected and could not be opened');
    });

    it('A LOCKED VAULT AND A WRONG PASSWORD ARE DIFFERENT SENTENCES', () => {
        /* They need different actions. "None of your saved passwords opened
         * it" sent to someone whose vault is simply locked is a lie that makes
         * them go and add a password they already have. */
        expect(card).toContain('Your statement vault is locked, so none of your saved passwords were tried');
        expect(card).toContain('None of your saved passwords opened');
        expect(card).toMatch(/vaultLocked\s*$|vaultLocked/m);
    });

    it('the strip appears when something is held for a key, OR proactively when the vault is locked with mail waiting', () => {
        expect(card).toMatch(/const lockStrip = \(lockedCount \|\| proactive\) \?/);
        expect(card).toContain('${lockStrip}');
    });

    it('PROACTIVE: a locked vault with known mail waiting is actionable before any attempt fails', () => {
        /* lockedCount only ever grows inside runMailSync()'s heavy loop, which
         * _mailBootCheck() never runs. Gating the strip on lockedCount alone
         * meant a fresh boot with a locked vault and mail already waiting
         * showed nothing — the owner had to press Check now, watch it fail,
         * THEN see the strip, for a password they had already saved. */
        expect(card).toMatch(/const pendingKnown = [\s\S]{0,200}stage === 'waiting'/);
        expect(card).toContain("it.known !== false");
        expect(card).toMatch(/const proactive = lockedCount === 0 && vaultLocked && pendingKnown > 0/);
    });

    it('PROACTIVE wording never claims a password was already tried', () => {
        /* The reactive strip says "could not be opened" / "were tried" —
         * both false when nothing has run yet. Saying either to someone who
         * only just opened the app would be a lie about what happened. */
        const head = /const headTxt = proactive\s*\?\s*`([\s\S]*?)`\s*:/.exec(card);
        const tail = /const tailTxt = proactive\s*\?\s*'([\s\S]*?)'\s*:/.exec(card);
        expect(head, 'could not isolate the proactive headTxt branch').toBeTruthy();
        expect(tail, 'could not isolate the proactive tailTxt branch').toBeTruthy();
        expect(head[1]).toContain('waiting, and your statement vault is locked');
        expect(tail[1]).toContain('nothing is opened until you do');
        expect(head[1] + tail[1]).not.toMatch(/could not be opened|were tried/);
    });

    it('the proactive count is the same "known, waiting" set the owner sees listed — not raw item count', () => {
        expect(card).toMatch(/const n = proactive \? pendingKnown : lockedCount/);
    });

    it('the button is wired — a strip that opens nothing is decoration', () => {
        expect(card).toMatch(/querySelector\('#_ms_vault'\)[\s\S]{0,500}openBankVault\(/);
    });

    it('AND IT RE-CHECKS ITSELF once the vault is open', () => {
        /* The statements are already in the store; the only thing missing was
         * the key. Making the owner press Check now again is asking them to
         * take the same decision twice. */
        expect(card).toMatch(/onClose:[\s\S]{0,240}runMailSync\(\)/);
        expect(card).toContain('WFVault.isUnlocked()');
    });

    it('it does not re-enter a run that is already going', () => {
        expect(card).toContain("_mailSyncState.stage !== 'running'");
    });
});

describe('the vault modal can tell its caller it closed', () => {
    it('openBankVault takes options and calls onClose', () => {
        const body = fn('openBankVault');
        expect(body).toContain('opts = {}');
        expect(body).toMatch(/close = \(\) => \{[\s\S]{0,300}opts\.onClose/);
    });

    it('a throwing callback still closes the modal', () => {
        /* The overlay is removed before the callback runs, and the callback is
         * wrapped. A caller's bug must not leave a modal the owner cannot
         * dismiss. */
        const body = fn('openBankVault');
        expect(body).toMatch(/removeChild\(overlay\)[\s\S]{0,200}try \{ if \(typeof opts\.onClose/);
        expect(body).toMatch(/opts\.onClose\(\); \} catch \(_\)/);
    });
});

describe('a password with no bank name is not silently lost', () => {
    /* THE BUG: "N password(s) encrypted" told the owner a save had succeeded
     * while a row with an empty Bank field never reached WFVault.save() at
     * all — dropped by a filter that required Bank to be non-empty. The
     * owner typed a real password, the app said it was saved, and it never
     * existed in the vault to be tried against anything. */
    const body = fn('openBankVault');

    it('only requires a password to keep a row — not a bank name', () => {
        expect(body).toMatch(/const usable = rows\.filter\(r => r\.password && r\.password\.trim\(\)\)/);
        expect(body).not.toMatch(/const usable = rows\.filter\(r => r\.bank/);
    });

    it('candidatesFor() already tries every password regardless of bank match — this is the same rule, one step earlier', () => {
        const cf = fs.readFileSync(path.join(ROOT, 'wealthflow-vault.js'), 'utf8');
        expect(cf).toContain('ORDER, NOT EXCLUSION');
    });
});

describe('the iteration this depends on, still relentless', () => {
    it('every candidate is tried before it gives up, and the count is reported', async () => {
        const tried = [];
        const open = async (bytes, pw) => {
            tried.push(pw);
            if (pw === 'third') return { doc: true };
            throw new Error('wrong password');
        };
        const r = await unlock(new Uint8Array([1]), ['first', 'second', 'third'], open);
        expect(r.ok).toBe(true);
        expect(r.usedIndex).toBe(2);
        /* The null attempt first — an unencrypted statement must not consume a
         * key — then each candidate in order. */
        expect(tried).toEqual([null, 'first', 'second', 'third']);
    });

    it('and the failure names how many were tried, never which', async () => {
        const open = async () => { throw new Error('wrong password'); };
        const r = await unlock(new Uint8Array([1]), ['a-real-password', 'another'], open);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(QUARANTINE.PASSWORD_FAILED);
        expect(r.detail.tried).toBe(2);
        expect(JSON.stringify(r)).not.toContain('a-real-password');
    });

    it('an empty vault is its own reason, not a failed attempt', async () => {
        const open = async () => { throw new Error('locked'); };
        const r = await unlock(new Uint8Array([1]), [], open);
        expect(r.reason).toBe(QUARANTINE.NO_VAULT_KEYS);
    });
});
