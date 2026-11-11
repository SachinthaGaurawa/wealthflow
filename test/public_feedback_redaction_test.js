// system/* is readable by anyone (firestore.rules), so what release-brain writes there must not carry
// the e-mail, phone or account numbers a user typed into a bug report (wf-redact.mjs).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { redactText, publicClusters } from '../wf-redact.mjs';

describe('redactText', () => {
    it('removes e-mail addresses, links and long numbers and leaves the sentence readable', () => {
        const r = redactText('Login fails for me, mail sachin@example.com, call 077 123 4567, card 4111111111111111, see https://x.test/a?t=1');
        expect(r).not.toMatch(/example\.com|077|4111|x\.test/);
        expect(r).toContain('Login fails for me');
        expect(r).toMatch(/\[email\]/);
        expect(r).toMatch(/\[link\]/);
        expect(r).toMatch(/\[number\]/);
    });
    it('keeps amounts a person would write: small numbers and comma-grouped money', () => {
        expect(redactText('Rs. 15,000 was charged twice, 3 times')).toBe('Rs. 15,000 was charged twice, 3 times');
        expect(redactText('total 1,250,000.50 shown wrong')).toContain('1,250,000.50');
    });
    it('masks a bare account or reference number of four digits or more, and a long token', () => {
        expect(redactText('account 12345678 missing')).toBe('account [number] missing');
        expect(redactText('token abcdefghijklmnopqrstuvwxyz0123456789 leaked')).toContain('[token]');
    });
    it('is safe on junk', () => {
        expect(redactText(null)).toBe('');
        expect(redactText(undefined)).toBe('');
        expect(redactText(42)).toBe('42');
    });
});

describe('publicClusters', () => {
    it('redacts sample, keeps key and every other field, and does not mutate the input', () => {
        const input = [{ sample: 'mail me at a@b.co about 987654', key: 'mail me about', count: 3, priority: 'high' }];
        const out = publicClusters(input);
        expect(out[0].sample).toBe('mail me at [email] about [number]');
        expect(out[0]).toMatchObject({ key: 'mail me about', count: 3, priority: 'high' });
        expect(input[0].sample).toContain('a@b.co');
        expect(publicClusters(null)).toEqual([]);
    });
});

describe('release-brain writes only redacted text to the public documents', () => {
    const src = fs.readFileSync('release-brain.js', 'utf8');
    it('imports the redaction and writes feedbackPriority from the public view, on both paths', () => {
        expect(src).toMatch(/from '\.\/wf-redact\.mjs'/);
        expect(src).toMatch(/clusters: rpublic,/);
        expect(src).toMatch(/clusters: enrichedPublic,/);
        expect(src).not.toMatch(/clusters: (rclusters|enriched),/);
    });
    it('builds the public release notes and proposed changes from the redacted clusters', () => {
        expect(src).toMatch(/buildNotes\(nextV, rpublic, true\)/);
        expect(src).toMatch(/proposedChangesFrom\(rpublic\)/);
        expect(src).toMatch(/buildNotes\(nextVersion, clustersPublic, isUrgent\)/);
        expect(src).toMatch(/proposedChangesFrom\(clustersPublic\)/);
    });
});
