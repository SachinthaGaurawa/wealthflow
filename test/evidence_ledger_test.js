import { describe, it, expect } from 'vitest';
import { evidenceLedger } from '../autonomy/evidence-ledger.mjs';
import { prBody } from '../autonomous-fix-agent.js';

const swarm = { lane: 'swarm', verified: true, providers: { author: 'ollama', security: 'fireworks', qa: 'ollama' }, review: { verdict: 'PASS' }, mutation: { skipped: false, killed: 4, total: 5, weak: false } };

describe('evidence ledger: what a PR may claim, written by a program', () => {
    it('lists only what the run recorded as verified, with the exact counts', () => {
        const l = evidenceLedger({ result: swarm, testWritten: 'test/x_test.js' });
        expect(l.verified.join('\n')).toMatch(/test\/x_test\.js` ran twice/);
        expect(l.verified.join('\n')).toMatch(/caught 4 of 5/);
        expect(l.verified.join('\n')).toMatch(/Security review by fireworks: PASS/);
        expect(l.markdown).toMatch(/Written by a program from what this run recorded, not by a model/);
    });

    it('always says what no run here can verify', () => {
        const l = evidenceLedger({ result: swarm, testWritten: 't.js' });
        expect(l.notVerified.join('\n')).toMatch(/real phone/);
        expect(l.notVerified.join('\n')).toMatch(/live data/);
    });

    it('an unconfirmed test, a weak test and a same-provider reviewer are stated as not verified', () => {
        expect(evidenceLedger({ result: { ...swarm, verified: false }, testWritten: 't.js' }).notVerified.join('\n')).toMatch(/NOT confirmed red then green/);
        expect(evidenceLedger({ result: { ...swarm, mutation: { killed: 1, total: 5, weak: true } }, testWritten: 't.js' }).notVerified.join('\n')).toMatch(/weak/);
        const same = evidenceLedger({ result: { ...swarm, providers: { author: 'groq', security: 'groq' } }, testWritten: 't.js' });
        expect(same.notVerified.join('\n')).toMatch(/same provider/);
        expect(evidenceLedger({ result: {}, testWritten: null }).notVerified.join('\n')).toMatch(/no proving test/);
        expect(evidenceLedger({ result: { ...swarm, mutation: undefined }, testWritten: 't.js' }).notVerified.join('\n')).toMatch(/No sabotage check ran/);
    });

    it('a layout fix is a measurement and says so; a build lane module is only machine-checked', () => {
        const lay = evidenceLedger({ result: { lane: 'layout', layout: { widths: [320, 390], verdict: 'fixed' }, providers: {}, review: { verdict: 'PASS' } } });
        expect(lay.verified.join('\n')).toMatch(/real Chromium on invented books at 320, 390 px.*FIXED/);
        const b = evidenceLedger({ result: { lane: 'build', file: 'wealthflow-x.js', providers: {} } });
        expect(b.notVerified.join('\n')).toMatch(/only the owner can judge/);
        expect(b.notVerified.join('\n')).toMatch(/No independent security review/);
    });

    it('says plainly when the screenshot was not read or the report was not translated', () => {
        expect(evidenceLedger({ result: swarm, testWritten: 't.js', shot: { status: 'unreadable' } }).notVerified.join('\n')).toMatch(/screenshot was NOT read \(unreadable\)/);
        expect(evidenceLedger({ result: swarm, testWritten: 't.js', shot: { status: 'read', provider: 'ollama' } }).verified.join('\n')).toMatch(/read by ollama/);
        expect(evidenceLedger({ result: swarm, testWritten: 't.js', translation: { status: 'untranslated', note: 'x' } }).notVerified.join('\n')).toMatch(/not in English/);
        expect(evidenceLedger({ result: swarm, testWritten: 't.js', rules: ['size-ceilings'] }).markdown).toMatch(/`size-ceilings`/);
        expect(evidenceLedger({ result: swarm, testWritten: 't.js', shot: null }).verified.join('\n')).not.toMatch(/screenshot/);
    });

    it('the pull request description carries the ledger, before the footer', () => {
        const ledger = evidenceLedger({ result: swarm, testWritten: 't.js' }).markdown;
        const body = prBody({ issue: { title: 'x' }, number: 7, result: swarm, testWritten: 't.js', ledger });
        expect(body).toMatch(/### Evidence ledger/);
        expect(body.indexOf('### Evidence ledger')).toBeGreaterThan(body.indexOf('### Still to pass in CI'));
        expect(prBody({ issue: { title: 'x' }, number: 7, result: swarm, testWritten: 't.js' })).not.toMatch(/Evidence ledger/);
    });
});
