import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'test', 'docs', '.superpowers']);
const SKIP_FILES = new Set(['version.json', 'package-lock.json']);
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.json', '.md', '.yml', '.yaml']);
const LEGACY = /wealthflow-personal\.vercel\.app|wealthflow-peach\.vercel\.app|sachinthagaurawa\.github\.io\/wealthflow|onboarding@resend\.dev|noreply@wealthflow\.com|owner@wealthflow\.app/gi;

function filesUnder(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (SKIP_DIRS.has(entry.name)) return [];
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(absolute);
        if (SKIP_FILES.has(entry.name) || !TEXT_EXTENSIONS.has(path.extname(entry.name))) return [];
        return [absolute];
    });
}

function isMigrationReference(relative, line) {
    if (relative === 'wealthflow-public-identity.mjs') return /LEGACY_VERCEL_HOSTS|wealthflow-(?:personal|peach)\.vercel\.app/.test(line);
    if (relative === 'vercel.json') return /wealthflow-(?:personal|peach)\.vercel\.app/.test(line);
    if (relative === 'index.html') return /_wfCanonicalizePublicUrl|wealthflow-(?:personal|peach)\.vercel\.app/.test(line);
    return false;
}

describe('legacy public identity inventory', () => {
    it('contains legacy hosts only in explicit migration boundaries', () => {
        const violations = [];
        for (const file of filesUnder(ROOT)) {
            const relative = path.relative(ROOT, file);
            fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
                LEGACY.lastIndex = 0;
                if (LEGACY.test(line) && !isMigrationReference(relative, line)) {
                    violations.push(`${relative}:${index + 1}: ${line.trim()}`);
                }
            });
        }
        expect(violations).toEqual([]);
    });
});
