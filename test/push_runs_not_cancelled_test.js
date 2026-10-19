import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A MERGE TO MAIN IS NEVER CUT SHORT BY THE NEXT MERGE.
//
// Two pull requests merged a minute apart. The second push started the same workflow in the same concurrency group with `cancel-in-progress: true`, so GitHub cancelled the first
// commit's "Pipeline liveness" run, and the first commit showed a red mark (1 cancelled, 5 of 7) in the commit list although nothing about it was wrong. A newer push to a PR branch
// may replace an older one (the older commit is not what will merge); a push to main may not. These two workflows run on pushes to main, so for a push their group is the commit
// itself and nothing is cancelled; every other trigger keeps the old behaviour.

const read = (name) => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const block = (text) => {
    const m = text.match(/^concurrency:\n((?:[ ]{2}.*\n?)+)/m);
    return m ? m[1] : '';
};

describe.each([
    ['pipeline-liveness.yml', /^\s*group: pipeline-liveness-\$\{\{ github\.event_name == 'push' && github\.sha \|\| 'scheduled' \}\}$/m],
    ['secret-scan.yml', /^\s*group: secret-scan-\$\{\{ github\.event_name == 'push' && github\.sha \|\| github\.event\.pull_request\.number \|\| github\.ref \}\}$/m],
])('%s', (file, groupLine) => {
    const text = read(file);
    const c = block(text);

    it('runs on a push to main', () => {
        expect(text).toMatch(/^on:[\s\S]*?\n  push:\n    branches: \[main\]/m);
    });

    it('gives each push its own group, so one merge never waits for or replaces another', () => {
        expect(c).toMatch(groupLine);
    });

    it('cancels an older run only when the trigger is not a push', () => {
        expect(c).toMatch(/^\s*cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}$/m);
        expect(c).not.toMatch(/cancel-in-progress: true/);
    });
});
