import { describe, it, expect } from 'vitest';
import { reportSuspectReading, reportBody, safeShape, SELF_REPORT_LABEL } from '../wf-statement-self-report.mjs';

const ENV = { GH_PAT: 'x', GITHUB_REPO: 'owner/repo' };
const reply = (ok, body) => ({ ok, json: async () => body });
const SHAPE = { sources: { layout: 8, marker: 3, 'weird 4000 0000 0000 0001': 99999 }, balanceColumn: false, type: 'card', opening: true, closing: true, reconciled: 'no', printed: 'differs', invalid: { noDate: 0, noAmount: 1, noWords: 0 } };

describe('the reader reports a reading it does not trust (public repository: counts and fixed words only)', () => {
    it('writes no amount, date, card number or line of the statement', () => {
        const body = reportBody('printed-total-differs', { bank: 'HNB 4000 0000 0000 0001', shape: SHAPE, rows: 24 });
        expect(body).not.toMatch(/\d{4,}/);
        expect(body).toContain('printed-total-differs');
        expect(body).toContain('rows that are not whole transactions');
    });

    it('bounds every count and drops unknown keys', () => {
        const s = safeShape({ ...SHAPE, extra: 'secret line 123456' });
        expect(JSON.stringify(s)).not.toMatch(/secret|\d{4,}/);
        expect(s.sources.marker).toBe(3);
    });

    it('does nothing when the deployment cannot file issues', async () => {
        expect(await reportSuspectReading('printed-total-differs', {}, { env: {} })).toEqual({ filed: false, reason: 'not-configured' });
    });

    it('does not file a second issue while one of the kind is open', async () => {
        const calls = [];
        const out = await reportSuspectReading('printed-total-differs', { shape: SHAPE }, { env: ENV, fetchImpl: async (url, init) => { calls.push([url, init && init.method]); return reply(true, [{ number: 7 }]); } });
        expect(out).toEqual({ filed: false, reason: 'already-open', issue: 7 });
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toContain(SELF_REPORT_LABEL);
    });

    it('files one issue for the fix agent when none is open', async () => {
        let created = null;
        const out = await reportSuspectReading('printed-total-differs', { bank: 'HNB', shape: SHAPE, rows: 24 }, { env: ENV, fetchImpl: async (url, init) => {
            if (init && init.method === 'POST') { created = JSON.parse(init.body); return reply(true, { number: 9 }); }
            return reply(true, []);
        } });
        expect(out).toEqual({ filed: true, reason: 'filed', issue: 9 });
        expect(created.labels).toEqual(expect.arrayContaining(['bug', 'autonomous', 'critical', SELF_REPORT_LABEL, 'wf-printed-total-differs']));
        expect(created.body).not.toMatch(/\d{4,}/);
    });

    it('never throws and never claims it filed when GitHub fails', async () => {
        expect((await reportSuspectReading('printed-total-differs', {}, { env: ENV, fetchImpl: async () => { throw new Error('down'); } })).filed).toBe(false);
        expect(await reportSuspectReading('printed-total-differs', {}, { env: ENV, fetchImpl: async () => reply(false, {}) })).toEqual({ filed: false, reason: 'lookup-failed' });
        expect((await reportSuspectReading('printed-total-differs', {}, { env: ENV, fetchImpl: async (u, init) => (init && init.method === 'POST' ? reply(false, {}) : reply(true, [])) })).reason).toBe('create-failed');
        expect((await reportSuspectReading('nope', {}, { env: ENV })).reason).toBe('unknown-kind');
    });
});
