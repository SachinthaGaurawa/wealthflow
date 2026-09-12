import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Structural regression checks only: these do not replace a Firestore emulator
// or verify which rules are currently deployed in the production project.
const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8')
    .replace(/\/\/[^\n]*/g, '');
const userMatches = [...rules.matchAll(/match\s+(\/users\/[^\n]+?)\s+\{\s*([\s\S]*?)\n\s*\}/g)]
    .map(([, path, body]) => ({ path: path.trim(), body }));
const root = userMatches.find(match => match.path === '/users/{uid}');
const descendants = userMatches.find(match => match.path === '/users/{uid}/{collection}/{document=**}');

describe('cloud statement server-owned Firestore paths (structural checks)', () => {
    it('preserves owner-only root financial document access', () => {
        expect(root).toBeDefined();
        expect(root.body).toMatch(/allow\s+read\s*,\s*write\s*:\s*if\s+isOwner\(uid\)\s*;/);
        expect(root.body).not.toMatch(/if\s+true/);
    });

    it('keeps private descendant reads and excludes all trusted collections from the same write grant', () => {
        expect(descendants).toBeDefined();
        expect(descendants.body).toMatch(/allow\s+read\s*:\s*if\s+isOwner\(uid\)\s*;/);
        const write = descendants.body.match(/allow\s+write\s*:\s*if\s+([^;]+);/);
        expect(write).toBeTruthy();
        expect(write[1]).toMatch(/^isOwner\(uid\)\s*&&\s*!\(collection\s+in\s+\[[^\]]+\]\)$/);
        const reserved = [...write[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
        expect(reserved).toEqual(expect.arrayContaining(['statementLedger', 'statementReview', 'statementLayouts']));
        // Another allow statement would OR with the guarded grant and defeat it.
        expect([...descendants.body.matchAll(/allow\s+[^:]+\s*:/g)]).toHaveLength(2);
    });

    it('has no overlapping broad users write grant that bypasses those exclusions', () => {
        expect(userMatches.map(match => match.path).sort()).toEqual([
            '/users/{uid}',
            '/users/{uid}/shared_stmts/{docId}',
            '/users/{uid}/{collection}/{document=**}',
        ].sort());
        const legacy = userMatches.find(match => match.path === '/users/{uid}/shared_stmts/{docId}');
        expect(legacy.body).toMatch(/allow\s+list\s*,\s*write\s*:\s*if\s+isOwner\(uid\)\s*;/);
        expect(legacy.path).not.toMatch(/statement(?:Ledger|Review|Layouts)/);
    });
});
