# The system thinks of its own improvements

Owner, 2026-11-07: "The system must be able to think for itself ... introduce new ideas, features and options by itself ... nothing may need my hand."

## What runs

`.github/workflows/feature-proposals.yml` runs every day at 02:30 UTC and calls `autonomy/ideate.mjs` (library: `autonomy/propose.mjs`, rules: `autonomy/ideas.mjs`). It thinks of **at most one** idea per run and holds at most **2 ideas in the pipeline** (waiting or being built).

## What it studies (each item gets an id the idea must quote)

| Id | Source |
| --- | --- |
| R | the ranked roadmap in `docs/superior-system-research.md` section 4 (rows already built, or marked the owner's decision, are left out) |
| G | the measured gaps in the same document ("Still failing", "Not measured at all") |
| F | real feedback in the queue |
| H | what became of its earlier ideas (built, declined, being built, waiting) |
| P | titles of recently merged pull requests (what already exists) |
| A | the screens and modules that exist |

## How an idea is decided (no owner in the loop)

1. **Not a repeat**: a near-copy of any earlier idea, open or closed, is dropped (`isRepeat`).
2. **Grounded**: it must cite at least one id it was really given.
3. **Reasoned**: two or more "if X, then Y" steps, and its own scores: ease, value, smallness, risk. User-friendliness first: ease must be 4 or 5, value and smallness at least 3, risk at most 2.
4. **Safe by rule** (`guardIdea`, no model): nothing about sign-in, encryption, money arithmetic, paid services, new dependencies, sending data somewhere new, or destructive actions; scope may not name auth, `firestore.rules`, `package.json`, `.github/`, `api/` or `autonomy/`.
5. **Agreed**: at least two AIs on different providers read it through `concept-board.mjs`. **One** ASK_OWNER vote stops it; fewer than two voters is "try again tomorrow", never a yes.

Only then is the issue filed with `feature-proposal`, `approved-feature` and `auto-approved`, the board's discussion is posted on it, and the fix agent is woken. A refused idea is filed **closed** with `idea-declined` and the reason, so it is remembered and never proposed again.

## What it builds with

The fix agent builds an approved idea like any other feature (`roleFor` sends every `feature-proposal` to the feature lane, then the build lane if no module can take it): a normal pull request through the tests, the cross-provider review, the policy gate and the usual rollback. A new option or screen shows the NEW tag, which counts 7 days from the person's first look (`docs/design-system.md`).

## How the owner can still steer (optional, never required)

- Close an idea's issue before its pull request merges: it is not built.
- Set the repository variable `WF_IDEAS_AUTO=0`: ideas are filed in the old form and wait for the `approved-feature` label.
- Run the workflow by hand with `dry_run`: it prints what it would do and files nothing.

## Honest limits

- Passing the five checks means an idea is grounded, reasoned, safe by rule and not objected to by independent models. It does not prove the owner will like it; the owner's veto after the fact is the closed issue or the rollback.
- The free-tier providers decide how many AIs can be reached on a given day; the idea engine uses only the background share left after the pull-request review reservation (`provider-budget.mjs`).
- The first real run can only happen after this is merged to the default branch (scheduled workflows run from there). Until then it is proven by `test/ideas_test.js` with the models and GitHub faked.
- The roadmap rows are read from one document. When all of them are built, the engine falls back to gaps, feedback and the screens, and says "nothing worth building" if none of that yields an idea.
