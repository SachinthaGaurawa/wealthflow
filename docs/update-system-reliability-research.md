# The update system, measured: what was wrong on 2026-11-12 and what was changed

Owner's ask (2026-11-12, 04:30Z to 04:35Z): the autonomous update system is "not accurate enough", "low level", "does not seem to work properly"; research deeply, think in if/then steps, and develop it; every AI must contribute; a short feedback must be understood end to end; diagnosis must stand by; updates must be collected and sent together like Android and iOS; user-friendliness first.

This document is the answer in the order the work was done: **measure first, then research each fault, then reason, then build.** Nothing below is a prediction. Every fault has the run or the issue that shows it, and every fix has a test that replays the real case.

## 1. What was measured

The evidence is this repository's own history, read through the GitHub API on 2026-11-12 between 04:30Z and 04:45Z: 500 workflow runs from 2026-11-11 09:52Z onward, every issue since 2026-10-25, and the comment trail of each report the fix agent tried.

| # | Fault | The evidence |
|---|---|---|
| 1 | **A report was sent to the wrong kind of work, three times.** | Issue #559 was filed by the statement reader: a card statement's payments do not add up. One template sentence in it says "the layout convention was closed". The routers read words, "layout" is a layout word, so it went to the CSS lane, which measured every page at seven widths and found nothing (there was nothing to find). Attempts 1, 2 and 3 are word-for-word identical. Then `ai-stuck`. Five days stuck on a critical report. |
| 2 | **A second try was never told what the first had ruled out.** | Same trail: three tries, one obstacle, never passed on. |
| 3 | **The clock the whole system runs on skips more than half its beats.** | At 04:41Z, 5 of the 11 scheduled jobs had been skipped outright (fix agent due 00:25, idea engine due 02:30, PR recovery due 03:41, merchant sync due 00:40, daily scan due 04:00) and 4 more had run 2 to 9 hours late (security updates 442 min, liveness 144 min, the two weekly probes 517 and 523 min). The fix agent ran once in 19 hours instead of three times. Nothing was red. |
| 4 | **The idea engine has never filed an idea.** | Its schedule slot never fired after it went live. Both manual dry runs ended the same way: the one model asked proposed one idea, the idea broke a rule ("too risky (risk 4/5)"; "sign-in or security, a new dependency"), and the day produced nothing. |
| 5 | **Eleven updates in one day.** | v7.69.78 to v7.69.88 on 2026-11-11: every merge cut its own release within minutes. |
| 6 | **Four false alarms "release pushed but NOT live".** | #585, #588, #589, #593 on 2026-11-11. Already fixed by #594 (the check now reads the app shell the way a browser does); listed for completeness. |

What the system did do correctly in the same window: 37 of 40 consensus reviews, every secret scan, every fuzz gate, 10 of 12 releases, and the health watchdog after each production deploy.

## 2. What the research says

Only sources that were opened are cited. Where a page was reached only through a search summary, it says so.

**Scheduled jobs on GitHub.** GitHub's own documentation of the `schedule` event (opened, quoted): "The schedule event can be delayed during periods of high loads of GitHub Actions workflow runs. High load times include the start of every hour. If the load is sufficiently high enough, some queued jobs may be dropped." The same page says a run started with the repository token does not start other workflows "with the exception of workflow_dispatch and repository_dispatch". So a dropped slot is documented behaviour, not a fault in this repository, and the repository's own token is allowed to start the job that was dropped. Community reports of daily jobs 8 to 14 hours late match what was measured here (search summary of a GitHub Community discussion; one user's report, not documentation).

**Agents that repair code.** The 2025 and 2026 papers on issue-resolving agents (PatchPilot; XAgent; SWE-Doctor; Agent-CoEvo; read as abstracts and search summaries, they are preprints) converge on one structure: reproduce, localise, generate, validate, refine; and on one finding: an agent that has not reproduced the failure cannot judge whether its patch is right. This system already measures before it changes (the layout lane) and proves a fix red-to-green (the code lane). What it lacked is the consequence: **a measurement that finds nothing is evidence that the report is in the wrong lane**, and a failed try is information the next try must have.

**Several models working together.** The comparisons are consistent on two points (Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet"; Smit et al., "Should we be going MAD?"; the Mixture-of-Agents paper; a 2026 preprint on the "selection bottleneck"; search summaries): models arguing each other round does not reliably beat the same number of independent answers, and what decides the result is how the winner is selected. Independent answers from different models, then a selection rule, is the form with evidence behind it. The benchmarks are question-answering tasks, so this is a reasoned transfer to idea generation, not a measured result for it.

**How phones deliver updates.** Android's in-app update guide (opened earlier, re-read through search): each release has a priority 0 to 5 and the app can read how many days an update has been available; low priority asks nothing, medium offers a flexible update the person may postpone, only the highest takes the immediate path. Apple's phased release for automatic updates reaches 1%, 2%, 5%, 10%, 20%, 50%, 100% over seven days, can be paused, and a person can always update by hand. Neither platform sends one update per code change: changes are gathered into a version. The choices (later, skip this version, when idle, required but never blocking) were built on 2026-11-07 (`docs/update-model-research.md`); what was missing is the gathering.

## 3. The reasoning, as if/then

1. If a program wrote a report, then its sentences came from a template and say nothing about which lane it needs; its label does. If the router reads the sentences anyway, then one stray word decides, and #559 is what happens. **So: a program-filed report is routed by label and marker only; words are read for people only.**
2. If a lane's first step is a measurement and the measurement finds nothing, then repeating the lane cannot end differently. If the next try is not told, then it repeats. **So: the trail of earlier tries is read before every try; a ruled-out lane is skipped; the author is shown what each earlier try did.**
3. If the report reads as a defect ("on my phone the total is wrong") but contains a layout word, then the layout lane measures nothing and the try is wasted. **So: in that case the same try continues as code.**
4. If every job starts from a clock that may drop a beat without saying so, then "autonomous" silently means "sometimes". A monitor that only reports does not make the job run. **So: something must start the skipped job, and it must not depend on the same single beat: 72 scheduled chances a day plus real events (a deploy, a release).**
5. If one model proposes one idea and a rule refuses it, then the day yields nothing, and the refusal teaches nobody. If four different models each propose, a program applies the rules to all, and the refused reasons are shown before a second round, then one bad idea costs nothing. If two models land on the same idea independently, then that is evidence it is a real need. **So: every AI proposes; a program chooses; agreement counts; the board votes on the best survivor only.**
6. If every merge is its own update, then a busy day is eleven notices and the person learns to ignore them. If updates are held for days, then a fix is late (the owner ruled that out on 2026-11-07). **So: wait for 45 quiet minutes, never more than 2 hours after the oldest waiting change, and never for an urgent one.**

## 4. What was built

| Fault | Change | Where | Proof |
|---|---|---|---|
| 1 | A report a program filed is routed by its label or marker; its wording never decides. | `autonomy/route.mjs`, `autonomy/work-queue.mjs` (`roleFor`), `autonomy/css-lane.mjs` (`layoutLaneFor`) | `test/route_test.js` replays issue #559: role was `ui`, is `bug`; the layout lane applied, now does not. A person's overlap report still goes to the layout lane. |
| 2, 3 | The earlier tries are read before each try (`attemptTrail`). A lane whose measurement found nothing is skipped (`laneRuledOut`). The author is shown what each try did (`attemptBrief`). A layout word in a defect report no longer costs the try. Each attempt comment now names its lane. | `autonomy/route.mjs`, `autonomous-fix-agent.js` | `test/route_test.js` reads the three real attempt comments of #559. |
| 4 (clock) | The pacemaker reads every workflow's own cron lines, asks GitHub when each last really ran, and starts the ones whose slot passed 25 minutes ago with no run. Runs that were skipped or cancelled do not count as a run. At most 4 starts per beat; a refused start turns the run red. | `autonomy/pacemaker.mjs`, `.github/workflows/pacemaker.yml` | `test/pacemaker_test.js` replays 2026-11-12 04:41Z. A live dry run from this change against the real repository printed the table in section 1, row 3. |
| 4 (ideas) | Up to four AIs propose independently; a program applies the rules to every proposal and ranks the survivors (own scores plus 3 for each other AI that proposed the same thing); if none survives, the AIs are shown each refusal and asked once more; the board is asked about the best survivor, then the next. One refused idea at most is kept per day. One idea a day even if the job is started twice. | `autonomy/ideas.mjs`, `autonomy/propose.mjs`, `autonomy/ideate.mjs` | `test/ideas_test.js`: one AI proposes something too risky and another something good, and the good one is built (the old engine filed nothing). |
| 5 | A release waits for the line to go quiet (45 min), never more than 2 h after the oldest waiting change, not at all for a hotfix, security fix, crash fix, rollback or a release started by hand. A newer merge takes over the wait. | `autonomy/release-gather.mjs`, `.github/workflows/auto-release.yml` (job `gather`) | `test/release_gather_test.js` replays yesterday's nine merge-releases: four. |
| found in review | The repository is public, so anyone can comment on an issue and type the agent's marker. Such a comment used to count as one of the three tries, and with the new trail it could also have ruled a lane out and put its own words in front of the author AI. A comment whose writer is neither the agent's account nor a maintainer is now ignored by the count, the trail and the retry timer. | `autonomy/route.mjs` (`fromStranger`), `autonomy/work-queue.mjs` (`attemptsFrom`, `lastAttemptAgeMs`) | `test/route_test.js`: a forged attempt changes nothing |

Two repository variables tune the wait without a code change: `WF_RELEASE_QUIET_MIN` (0 switches gathering off) and `WF_RELEASE_MAX_HOLD_MIN`.

## 5. What was not built, and why

- **A heartbeat from outside GitHub** (a Vercel cron that starts the pacemaker). It would cover a day on which GitHub runs no schedule at all and nothing is deployed. It needs a GitHub token in Vercel that is allowed to start workflows; whether the existing one is, is not known from here. The pacemaker's 72 scheduled chances and its event triggers are the cover for now; the first days of pacemaker runs will show whether that is enough, in numbers.
- **The statement reader's report carrying the shape of the statement.** #559 holds counts only (on purpose: the repository is public), so even in the right lane the agent cannot see what the reader mis-read. A shape with every digit and name masked would let it. That is a privacy design, not a routing fix, and belongs to the statement-reader work.
- **A second author when the first one fails.** When the author model returns no change, the next file is tried with the same model. Asking a different model first is the same "independent answers" idea applied to fixing; it is the next change.
- **Reading routes with a model instead of words for people's reports.** The word rules are still what routes a person's report. A model reading with a program checking its answer would be more accurate on short or unusual feedback; it needs a labelled set of real reports to measure against first, and there are fewer than twenty.

## 6. Known limits of what was built

- The pacemaker cannot start a job sooner than 25 minutes after its slot (GitHub's ordinary lateness is 5 to 20 minutes; starting earlier would run jobs twice).
- If GitHub runs no schedule for hours and nothing is deployed or released, the pacemaker does not beat either. See section 5.
- `security-updates.yml` has a daily and a monthly slot; a pacemaker start runs the daily path.
- The release wait is a sleeping job. A cancelled run is shown as "cancelled" in the Actions tab; that is the newer merge taking over, and the status readers already ignore cancelled runs.
- Agreement between AIs is measured by the likeness of titles, which can miss two ideas that are the same in different words.
- The idea engine's first real approval is still to be observed; this change makes the run happen and makes a survivor likely, it does not make an idea good.
