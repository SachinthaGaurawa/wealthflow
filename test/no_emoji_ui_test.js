import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHIPPED_EXTENSIONS = new Set(['.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.yaml', '.yml']);
const SKIP_DIRECTORIES = new Set(['.git', '.github', 'node_modules', 'test']);
const EMOJI = /\p{Extended_Pictographic}/gu;

function shippedFiles(directory = ROOT) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return SKIP_DIRECTORIES.has(entry.name) ? [] : shippedFiles(fullPath);
        }
        return SHIPPED_EXTENSIONS.has(path.extname(entry.name)) ? [fullPath] : [];
    });
}

describe('professional interface copy', () => {
    it('ships no emoji glyphs in application sources', () => {
        const findings = [];
        for (const file of shippedFiles()) {
            const source = fs.readFileSync(file, 'utf8');
            for (const match of source.matchAll(EMOJI)) {
                const line = source.slice(0, match.index).split('\n').length;
                findings.push(`${path.relative(ROOT, file)}:${line}:${match[0]}`);
            }
        }

        expect(findings, findings.join('\n')).toEqual([]);
    });
});
