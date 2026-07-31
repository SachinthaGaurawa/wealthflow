// =============================================================================
// WealthFlow Shadow Test Harness — GitHub Actions runtimes
// =============================================================================
// GitHub deprecated the Node 20 runtime and began force-running node20 actions
// on node24, emitting a warning on every job. A warning is easy to scroll past,
// which is exactly the problem: when the forced fallback is eventually removed,
// the actions stop working and the whole pipeline stops with them.
//
// Bumping the versions once fixes today. This file is what stops it coming back:
// a copy-pasted `actions/checkout@v4` from any tutorial would reintroduce the
// deprecation silently, and nothing else in CI would object.
//
// The floors below are not guesses — each was read from the action's own
// action.yml `runs.using` field:
//   actions/checkout@v7        -> node24
//   actions/setup-node@v6      -> node24
//   actions/upload-artifact@v7 -> node24
//   step-security/harden-runner@v2 -> node24   (already fine, left alone)
//   peter-evans/enable-pull-request-automerge@v3 -> composite (no runtime)
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cronsIn } from '../autonomy/actions-budget.mjs';

const DIRS = ['.github/workflows', '.github/actions'];

/** Every workflow / composite-action YAML in the repository. */
function actionFiles() {
    const out = [];
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.ya?ml$/.test(e.name)) out.push(p);
        }
    };
    for (const d of DIRS) walk(d);
    return out;
}

/** Every `uses:` reference, with the file and line that declares it. */
function usesRefs() {
    const refs = [];
    for (const file of actionFiles()) {
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            const m = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/.exec(line);
            if (m) refs.push({ file, line: i + 1, ref: m[1] });
        });
    }
    return refs;
}

/** Minimum major version that runs on node24, per each action's action.yml. */
const NODE24_FLOOR = {
    'actions/checkout': 7,
    'actions/setup-node': 6,
    'actions/upload-artifact': 7,
};

describe('workflows: no action is left on the deprecated Node 20 runtime', () => {
    const refs = usesRefs();

    it('finds the workflows at all (guards against a vacuous pass)', () => {
        // Every assertion below iterates `refs`. An empty list would make them
        // all trivially true, which is the failure mode this whole project keeps
        // running into: green because nothing was examined.
        expect(refs.length).toBeGreaterThan(15);
        expect(actionFiles().length).toBeGreaterThan(10);
    });

    it.each(Object.entries(NODE24_FLOOR))('uses %s at v%i or newer', (action, floor) => {
        const stale = refs
            .filter((r) => r.ref.startsWith(`${action}@v`))
            .map((r) => ({ ...r, major: Number(/@v(\d+)/.exec(r.ref)?.[1] ?? 0) }))
            .filter((r) => r.major < floor);
        const detail = stale.map((r) => `${r.file}:${r.line} ${r.ref}`).join('\n');
        expect(stale, `these still target the deprecated node20 runtime:\n${detail}`).toHaveLength(0);
    });

    it('pins every third-party action to a version, never a moving branch', () => {
        // `@main` silently changes what runs in CI, which for a pipeline that can
        // merge its own pull requests is a supply-chain risk, not a convenience.
        const unpinned = refs.filter((r) =>
            !r.ref.startsWith('./')                       // local composite action
            && !/@(v?\d[\w.-]*|[0-9a-f]{40})$/.test(r.ref));
        const detail = unpinned.map((r) => `${r.file}:${r.line} ${r.ref}`).join('\n');
        expect(unpinned, `unpinned action reference(s):\n${detail}`).toHaveLength(0);
    });

    it('keeps setup-node asking for Node 24 explicitly', () => {
        // The action's own runtime and the Node it INSTALLS are different things.
        // Bumping to v6 fixes the former; this pins the latter, so the scripts
        // still run on the version they were written and tested against.
        const versions = new Set();
        for (const file of actionFiles()) {
            for (const m of fs.readFileSync(file, 'utf8').matchAll(/node-version:\s*'?"?([\d.x]+)/g)) {
                versions.add(m[1]);
            }
        }
        expect([...versions]).toEqual(['24']);
    });
});

// =============================================================================
// Auto-merge must not try to merge a draft
// =============================================================================
// GitHub refuses to enable auto-merge on a draft pull request — the mutation
// answers `GraphQL: Pull Request is still a draft (mergePullRequest)` and the
// step exits 1. Since PRs here are opened as drafts, every auto-safe change
// turned the "Enable auto-merge" job red.
//
// The damage is not the red X itself, it is what a permanently-red check does to
// the person reading it: a job that fails every single time teaches you to scroll
// past red, and then the one that actually matters gets scrolled past too. This is
// the same vacuous-signal failure as a test suite that runs no tests — it looks
// like a gate and reports nothing.
//
// Two halves, both required, so this is asserted as two separate facts:
//   • the job is skipped while the PR is a draft;
//   • `ready_for_review` is a trigger, so undrafting enables auto-merge without
//     anyone re-running a job by hand.
// =============================================================================
describe('auto-merge: never attempts a draft', () => {
    const yml = fs.readFileSync('.github/workflows/auto-merge.yml', 'utf8');

    it('reads the workflow at all (guards against a vacuous pass)', () => {
        expect(yml.length).toBeGreaterThan(500);
        expect(yml).toMatch(/name:\s*Enable auto-merge/);
    });

    it('guards the auto-merge job on the PR not being a draft', () => {
        // Anchored to the `if:` line rather than searching the whole file, so a
        // mention of "draft" in a comment cannot satisfy this.
        const guard = /^\s*if:\s*needs\.classify\.outputs\.safe == 'yes'\s*&&\s*github\.event\.pull_request\.draft == false\s*$/m;
        expect(yml, 'the Enable auto-merge job must skip drafts').toMatch(guard);
    });

    it('re-runs when a draft is marked ready for review', () => {
        const types = /pull_request_target:[\s\S]*?types:\s*\[([^\]]+)\]/.exec(yml);
        expect(types, 'could not find the pull_request_target trigger types').toBeTruthy();
        const list = types[1].split(',').map((s) => s.trim());
        expect(list).toContain('ready_for_review');
        // Without this the classify job would only ever have run while merging was
        // impossible, so auto-merge would never be enabled for that PR.
        expect(list).toContain('synchronize');
    });
});

// =============================================================================
// The preview-sync workflow must not become a privilege-escalation hole
// =============================================================================
// It exists so ONE Vercel preview URL can be whitelisted in Firebase once,
// instead of a new domain per branch forever. The risk is in how it is built:
// `pull_request_target` runs with a WRITE token in the base repository's context,
// so checking out the pull request there would execute a contributor's code with
// that token in scope. That is the classic Actions escalation, and it is exactly
// the shape a well-meaning "just check out and push" implementation takes.
//
// This job moves a ref through the API and never checks out the PR. These tests
// pin that, because the unsafe version is the more obvious one to write.
// =============================================================================
describe('preview-sync: safe by construction', () => {
    const yml = fs.readFileSync('.github/workflows/preview-sync.yml', 'utf8');

    it('reads the workflow at all (guards against a vacuous pass)', () => {
        expect(yml.length).toBeGreaterThan(500);
        expect(yml).toMatch(/refs\/heads\/preview/);
    });

    it('NEVER checks out the pull request', () => {
        // The single assertion that matters. With pull_request_target in the
        // trigger list, any checkout of PR code puts a write token next to code the
        // repository owner has not read.
        expect(yml).not.toMatch(/actions\/checkout/);
    });

    it('only responds to the preview label, not to every label change', () => {
        // This repo churns `auto-safe` and `human-approved` constantly; without the
        // filter every one of those would redeploy the preview.
        expect(yml).toMatch(/github\.event\.label\.name == 'preview'/);
    });

    it('has no schedule, so it costs nothing against the monthly budget', () => {
        expect(cronsIn(yml)).toEqual([]);
    });

    it('refuses to deploy a closed pull request', () => {
        expect(yml).toMatch(/Refusing to deploy a closed pull request/);
    });

    it('force-updates the ref, because a preview is a pointer and not history', () => {
        // Successive previews are unrelated commits; a fast-forward push would fail
        // on the second one and the workflow would look broken.
        expect(yml).toMatch(/force=true/);
    });
});
