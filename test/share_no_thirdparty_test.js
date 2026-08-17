/* =============================================================================
 * test/share_no_thirdparty_test.js — a financial statement may never be
 * uploaded to a third-party host
 * -----------------------------------------------------------------------------
 * WHAT WAS THERE
 *
 * Sharing a statement ran a five-step fallback chain. Steps 3, 4 and 5 uploaded
 * the statement HTML to public, zero-auth third parties:
 *
 *     dpaste.com/api/v2/         → ?dp=<id>
 *     tmpfiles.org/api/v1/upload → ?tstmt=<id>
 *     file.io/?expires=1w        → the file.io link itself
 *
 * The payload is a loan statement or an Elite Report — balances, transactions,
 * lender details. The uploads ran AUTOMATICALLY, with no prompt and no
 * disclosure, whenever the two Firestore paths above them failed. A user who
 * clicked Share during a server blip published their finances to a pastebin and
 * saw a normal success dialog.
 *
 * file.io was worst: it returned its own domain as the share URL, so the link the
 * user copied and sent onward pointed at a third-party file host rather than at
 * this application.
 *
 * They were written as resilience — one is commented "guarantees success on
 * purely static hosting" — which is precisely what made them dangerous. A share
 * that fails and says so is strictly better than one that silently succeeds
 * somewhere the owner never chose.
 *
 * WHY A TEST AND NOT JUST A DELETION
 *
 * The next outage will make "add a quick pastebin fallback" look reasonable
 * again, exactly as it did the first time. This fails if one comes back.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Executable source only. This file NAMES the hosts it bans in order to explain
 *  them, and so does index.html's replacement comment — matching raw text would
 *  flag the explanation and fail against a correct file. That mistake has already
 *  cost two CI rounds in this repository. */
function executable(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
}

const CODE = executable(HTML);

/** Hosts that must never receive a statement payload. */
const BANNED = ['dpaste.com', 'tmpfiles.org', 'file.io', 'pastebin.com', 'transfer.sh', '0x0.st'];

describe('the share chain uploads to no third party', () => {
    it('the scan is reading real code (guards a vacuous pass)', () => {
        expect(CODE.length).toBeGreaterThan(100000);
        expect(CODE, 'the share function is gone — retarget this test').toMatch(/statement-store/);
    });

    for (const host of BANNED) {
        it(`never uploads to ${host}`, () => {
            /* An UPLOAD, specifically — not any mention of the host.
             *
             * The read handlers for ?dp= and ?tstmt= are deliberately kept so that
             * links users already sent to other people keep resolving; they GET
             * data that is already published and send nothing new. A first version
             * of this assertion banned every request naming the host and flagged
             * those reads, which would have pushed me to delete working links to
             * make a test pass. The distinction that matters is direction: a call
             * carrying a method or a body is sending something. */
            const uploads = [];
            for (const m of CODE.matchAll(new RegExp(`(?:fetch|_fetchWithTimeout|_wfFetchT)\\s*\\(`, 'g'))) {
                const open = CODE.indexOf('(', m.index);
                let depth = 0, end = open;
                for (let i = open; i < CODE.length && i < open + 600; i++) {
                    if (CODE[i] === '(') depth++;
                    else if (CODE[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
                }
                const args = CODE.slice(open, end);
                if (!args.includes(host)) continue;
                if (/method\s*:\s*["']POST["']|body\s*:/i.test(args)) {
                    uploads.push(CODE.slice(0, m.index).split('\n').length);
                }
            }
            expect(uploads, `index.html UPLOADS to ${host} at line(s) ${uploads.join(', ')} — `
                + 'statement HTML must never be sent to a third party').toEqual([]);
        });
    }

    it('sends no FormData/Blob upload anywhere off-origin', () => {
        // The two file hosts were reached with FormData + Blob. Catching the shape
        // as well as the hostnames stops the next one arriving under a new name.
        const uploads = [...CODE.matchAll(/fd\.append\(\s*["']file["']/g)];
        expect(uploads.map((m) => CODE.slice(0, m.index).split('\n').length),
            'a file upload was reintroduced into index.html').toEqual([]);
    });

    it('ends the chain with an honest failure rather than a silent success', () => {
        expect(CODE, 'the chain no longer surfaces an error when every path fails')
            .toMatch(/SHARE_ALL_FAILED/);
    });

    it('KEEPS the read handlers, so links already sent still resolve', () => {
        // Removing these would break links users have already given to other
        // people. They fetch data that is already published and send nothing new,
        // so they are not part of the exposure.
        expect(HTML, 'the ?dp= reader was removed, breaking already-shared links').toMatch(/\?dp=|'dp'/);
    });

    it('the ban can actually fail (guards the guard)', () => {
        const withUpload = `const res = await _fetchWithTimeout("https://tmpfiles.org/api/v1/upload", { method: "POST", body: fd }, 15000);`;
        expect(/method\s*:\s*["']POST["']|body\s*:/i.test(withUpload) && withUpload.includes('tmpfiles.org'),
            'the detector does not detect a real upload').toBe(true);
        // …and a READ of the same host is correctly not an upload.
        const read = `fetch('https://tmpfiles.org/dl/' + tstmtId + '/stmt.txt')`;
        expect(/method\s*:\s*["']POST["']|body\s*:/i.test(read),
            'a plain GET is being counted as an upload').toBe(false);
    });
});
