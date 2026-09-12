import { it, expect } from 'vitest';
import { sealCloud, openCloud, validateEntries, cloudConfig } from '../statement-cloud-vault.mjs';

const deps = { wrap: async p => ({ ciphertext: p.plaintext }), unwrap: async p => ({ plaintext: p.ciphertext }) };
it('round-trips exact passwords while ciphertext reveals no credential', async () => {
    const entries = [{ password: ' Exact PIN 01 ', kind: 'birthday', format: 'DDMMYYYY' }];
    const blob = await sealCloud('owner', entries, deps);
    expect(JSON.stringify(blob)).not.toContain(entries[0].password);
    expect((await openCloud('owner', blob, deps))[0].password).toBe(entries[0].password);
});
it('binds encryption to the authenticated UID even if blob metadata is forged', async () => {
    const blob = await sealCloud('owner', [{ password: 'secret' }], deps);
    await expect(openCloud('attacker', { ...blob, uid: 'attacker' }, deps)).rejects.toThrow('vault-unavailable-or-corrupt');
});
it('rejects tampering and broken key services without exposing a password', async () => {
    const blob = await sealCloud('owner', [{ password: 'secret' }], deps);
    await expect(openCloud('owner', { ...blob, tag: Buffer.alloc(16).toString('base64') }, deps)).rejects.toThrow('vault-unavailable-or-corrupt');
    await expect(sealCloud('owner', [{ password: 'secret' }], { wrap: async () => ({}) })).rejects.toThrow('vault-key-wrap-failed');
});
it('uses a fresh data key and IV for every save', async () => {
    const a = await sealCloud('owner', [{ password: 'secret' }], deps);
    const b = await sealCloud('owner', [{ password: 'secret' }], deps);
    expect(a.iv).not.toBe(b.iv); expect(a.ct).not.toBe(b.ct); expect(a.wrappedKey).not.toBe(b.wrappedKey);
});
it('fails closed without owner and KMS configuration and bounds vault input', () => {
    expect(() => cloudConfig({})).toThrow('statement-cloud-not-configured');
    expect(() => validateEntries([{ password: 'x'.repeat(1025) }])).toThrow('invalid-vault-entry');
    expect(() => validateEntries(new Array(101))).toThrow('invalid-vault-entries');
    expect(() => validateEntries([])).toThrow('invalid-vault-entries');
});
