// The fix workflow must wait for a burst of feedback WITHOUT holding the shared push lock, and must ship a same-day group as one pull request.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const yml = fs.readFileSync(new URL('../.github/workflows/autonomous-fix.yml', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../autonomous-fix-agent.js', import.meta.url), 'utf8');
const job = (name) => { const m = yml.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n|$)`)); return m ? m[1] : ''; };

describe('autonomous-fix workflow: one update for a day of feedback', () => {
    it('the wait is its own job, debounced per event type, and does not hold the push lock', () => {
        const g = job('gather');
        expect(g).toMatch(/cancel-in-progress: true/);
        expect(g).toMatch(/group: wealthflow-feedback-gather-\$\{\{ github\.event_name \}\}/);
        expect(g).not.toMatch(/wealthflow-main-push/);
        expect(g).toMatch(/feedback-window-cli\.mjs/);
    });
    it('the fix job needs the wait, takes the push lock itself, and only starts when the wait finished', () => {
        const f = job('fix');
        expect(f).toMatch(/needs: gather/);
        expect(f).toMatch(/group: wealthflow-main-push/);
        expect(f).toMatch(/needs\.gather\.result == 'success'/);
        expect(yml.split('\nconcurrency:\n').length).toBe(1);          // no workflow-level lock any more
    });
    it('grouping is off for the direct ship path and on otherwise', () => {
        expect(yml).toMatch(/AGENT_GROUP: \$\{\{ vars\.AUTONOMY_LEVEL == 'direct' && '0' \|\| '1' \}\}/);
    });
    it('every report of a group is closed by the one pull request', () => {
        expect(yml).toMatch(/\.group\)\|\|\[\]\)\.map\(g=>g\.issue\)/);
        expect(yml).toMatch(/Closes #%s/);
        expect(yml).toMatch(/\"\$N\" = \"\$ISSUE\"/);
    });
    it('the agent works the same-day siblings on top of the first fix and writes the group into ai-fix-pr.json', () => {
        expect(agent).toMatch(/siblingsOf\(issue, queue\.issues\)/);
        expect(agent).toMatch(/groupTitle\(done\.map/);
        expect(agent).toMatch(/process\.env\.AGENT_GROUP !== '0'/);
    });
});
