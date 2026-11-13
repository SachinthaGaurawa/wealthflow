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
| found in review | The repository is public, so anyone can comment on an issue and type the agent's marker. Such a comment used to count as one of the three tries, and with the new trail it could also have ruled a lane out and put its own words in front of the author AI. A comment whose writer is neither the agent's account nor a maintainer is now ignored by the count, the trail and the retry timer. The rule is closed by default: a comment that does not say who wrote it is a stranger's. | `autonomy/route.mjs` (`fromStranger`), `autonomy/work-queue.mjs` (`attemptsFrom`, `lastAttemptAgeMs`) | `test/route_test.js`: a forged attempt changes nothing |
| found in review | One cron line the pacemaker could not read would have stopped the whole beat, so no other job would have been woken. That line is now set aside and shown in the table as "NOT watched", and every other job is still checked. | `autonomy/pacemaker.mjs` (`dueOf`, `cronProblems`, `plan`) | `test/pacemaker_test.js`: a bad file in the folder, the skipped job is still started |

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

## 7. Second round: what the live system showed after the merge (2026-11-12, 08:07Z to 12:50Z)

Sections 1 to 6 were merged at 08:07Z. This section is what the system's own records said in the hours after, and what was changed because of it. Nothing here is a forecast; every line is a run, an issue or a log that can be opened.

### 7.1 What worked, with the run

| Claim | Evidence |
|---|---|
| The pacemaker starts jobs GitHub skipped | Run 43180452315: `autonomous-discover.yml` (248 min overdue), `feature-proposals.yml` (338 min), `security-updates.yml` (158 min) were started and all three finished green |
| The idea engine can file an idea | Run 43180498898 filed #607, the first idea it ever approved: 6 ideas from 3 AIs in 2 rounds, 2 passed the rules |
| A release waits for the merges to settle | Run 43180330026: the `gather` job waited 45 minutes (08:07Z to 08:52Z), then the release job ran |
| A release is not cut when the app did not change | Same run: 22 files changed, all pipeline code, so the gate said "NOT substantive. Refusing to cut a fake release" and the version stayed at v7.69.90 |
| A program-filed report no longer goes to the layout lane | #559: attempts after the merge are in the `swarm` lane, each with a `**Lane:**` line |
| Discovery works when woken | The woken discovery scan filed #608, a real unguarded `JSON.parse` in the pacemaker itself |

### 7.2 What did not work, measured

1. **The pacemaker never ran on its own clock.** From 08:07Z to 12:45Z its cron (`7,27,47 * * * *`) was due 14 times and GitHub started it 0 times. In the same hours GitHub started 3 other scheduled jobs, and the day's full count is 8 scheduled starts for about 21 due slots, arriving 22 minutes to 8 hours 22 minutes late (the 04:00Z discovery slot ran at 12:22Z). GitHub is not dropping the slots, it is delivering them hours late, and the pacemaker's clock is the same kind of slot.
2. **The deploy check never woke it.** `workflow_run` listed `Health watchdog + auto-rollback (free)`. That workflow finished green three times after the merge (08:07Z, 12:46Z, 12:48Z) and the pacemaker did not start. A finished release did start it (08:52Z). The two listed names differ in one way: the `+`. GitHub reads the list as filter patterns, in which `+` is not a plain character.
3. **The first idea named files that do not exist.** #607's "Likely scope" is `src/screens/settings/software-update.js` and `src/i18n/en.json`. This app has no `src/` folder. The real files with those words in their name are `pwa-updater.js`, `wealthflow-live-update.js` and `wealthflow-update-policy.js`.
4. **The review board failed a change for screens that do not exist.** On six of the nine review rounds of the first pull request the user-impact seat wrote "the user will see a new update notice" (its evidence: a row of an ideas table in a document) and "a new screen, Pacemaker" (its evidence: the `name:` line of a workflow). No file of the app was in that change. The seat is told to name what the person will see and is forbidden to say "nothing", so with nothing to see a weaker model invented a screen.
5. **#559 is still not fixed.** In the right lane the agent tried `wealthflow-statement-parser.js`, `statement-sync.js` and `wealthflow-ai-v4.js`; its own third attempt says the check lives in `statement-direction.mjs`. Its proving test never went from failing to passing, because the report holds counts only and the agent has no statement to reproduce the mis-reading with. This is the second item of section 5, now with a measurement behind it.
6. **Only 4 of 12 AI providers answer** (#609, filed by the board watch). The others fail on the account side: credits used up, a model withdrawn from the free tier, a trial key's monthly limit, a wrong key. No code change can fix a key.

### 7.3 What was changed

| Fault | Change | Where | Proof |
|---|---|---|---|
| 1, 2 | Every scheduled job that finishes wakes the pacemaker, and it then starts the ones that are overdue. (Corrected in section 8.1: a job the pacemaker itself starts does not wake it when it finishes, so the sentence first written here, "their finishing wakes it again; one late job catches the whole system up", was wrong for those.) A name holding a pattern character is listed as written and escaped, so one of the two matches whichever way the list is read. A watched job that was skipped or cancelled is not a beat and costs no runner | `.github/workflows/pacemaker.yml`, `autonomy/pacemaker.mjs` (`beatTriggerNames`, `escapeFilter`, `workflowRunNames`) | `test/pacemaker_test.js`: the list is compared with the workflow files, so a new scheduled workflow cannot be forgotten |
| 3 | A program checks an idea's scope against the files of the repository: a real file is kept, an invented one is named as such, and the real files with the same words are offered. Proposers are told the real naming. No model is asked | `autonomy/ideas.mjs` (`groundScope`, `closestFiles`), `autonomy/propose.mjs` | `test/ideas_test.js`: replay of #607 |
| 4 | Before it answers, the user-impact seat is given computed facts: which changed files are served to the person's device (from `.vercelignore`) and which never are. When none is served it is told that nothing on the screen changes and asked to judge the indirect effect instead. An objection that says the person will see something, about a line in a file that is never served, is set aside with the reason printed. An objection about an indirect effect, about a served file, or from another seat is untouched, and nothing is concluded when the same change edits the deploy list | `autonomy/ships.mjs`, `consensus-review.mjs` | `test/ships_test.js`: replay of both false fails, and the cases that must never be thrown out |
| #608 | The answer from GitHub is read through `readJson`: an empty body is null, anything that is not JSON is an error naming what was asked and what came back, and the beat leaves that one job alone | `autonomy/pacemaker.mjs` | `test/pacemaker_test.js` |

### 7.4 What is still open, said plainly

- **A quiet day is still a risk for the background jobs.** If GitHub starts no scheduled job for hours and nothing is merged, deployed or reported, nothing wakes the pacemaker. A person's feedback is not affected: the fix agent starts on the issue itself, not on a clock. The complete cover is a tick from outside GitHub (section 5, first item); it needs one token with the right to start workflows.
- **A slot GitHub delivers hours late runs a second time** after the pacemaker already did its work (the idea engine at 08:08Z and again at 09:58Z, discovery at 08:08Z and again at 12:22Z). The idea engine refuses the second run by its own one-a-day rule; discovery scans twice. A late run that sees its slot already served should stop at once; that is the next efficiency change.
- **#559 and reports like it** need the masked shape of the statement in the report (section 5, second item), and the kind of report should name the code that raised it.
- **The AI board** runs on 4 providers until the keys and credits of the other 8 are renewed (#609).

## 8. Third round: what the merges showed, and one cause behind two stuck reports (2026-11-12, 13:03Z to 19:10Z)

Same method: read the system's own runs, change what a run shows to be wrong, and measure again on production.

### 8.1 What the live runs showed after the second round was merged

| What | Measured | Run |
|---|---|---|
| A finished job wakes the pacemaker | Between 13:03Z and 18:41Z the pacemaker ran 9 times: 8 woken by a finished job, 1 by its own clock. Beats followed the security updates (13:54Z), the release (14:38Z), the watchdog (15:02Z) and the liveness check (15:59Z) within seconds of each finishing | 43223725714, 43224033878 and seven more |
| A skipped job is not a beat | 5 pacemaker runs ended `skipped` with no runner, each after a watched job that was itself skipped or cancelled | the same list |
| A job GitHub skipped is started | The merchant sync (the 12:40Z slot) was started at 13:05Z, and the PR recovery (the 15:41Z slot, 74 minutes late) at 16:54Z | 43224082328, 43263762279 |
| The pacemaker's own clock | Fired for the first time at 16:54:37Z, about eight hours after it was merged | 43263762279 |
| A merge of code that only the server runs cuts no release | `server-only (live already, not on the phone): wf-llm-router.mjs` → no version | 43282390887 |
| The router's replacement rule | OpenRouter's withdrawn model was replaced from a list of unknown names and the seat's vote came from it | 43224088646 |

**A correction to section 7.3.** A job the pacemaker starts does not wake the pacemaker when it finishes. The merchant sync finished at 13:06:50Z and the PR recovery at 16:55:30Z, and no beat followed either one. GitHub does not start a workflow from an event raised with the repository's own token, which is its guard against loops. So the pacemaker is woken by what GitHub, a merge, a deployment or a person starts, and not by its own work.

**The quiet period was seen.** From 16:55Z to 18:41Z nothing woke the pacemaker while three slots were due (the release at 18:00Z, the watchdog at 18:10Z, the fix agent at 18:25Z). The merge at 18:41Z woke it. This is the open item of section 7.4 observed, not a new one.

**The two providers the router was changed for are still unreliable, for reasons outside the code.** On the next two review runs the OpenRouter model answered with an empty completion both times. NVIDIA was asked for three replacements from its own list and each answered `Not found for account`.

### 8.2 One cause behind #559 and #609

Two reports the system files about itself had ended, or were about to end, as `ai-stuck`:

- **#559**, the reader's printed Total Payment check: three attempts, each on a file that does not hold the check.
- **#609**, the AI board below its floor: two attempts. The report says "read `ai-models.mjs`, `ai-chat.mjs`, `api/ai.js`", and the author model answered each time that the failures live in those files, "none of which is the file I am permitted to edit".

The cause is one line. The fix agent's rule for a file it may edit was "ends in `.js`, at the top of the repository". The statement reader and the AI board are `.mjs` modules (97 of them), and `api/ai.js` is in a folder. `printedPaymentsCheck` is in `statement-direction.mjs`. So the watchers filed work the agent was not allowed to touch, and the agent spent its attempts on the nearest file it was allowed to touch.

A second cause sat behind the first. The instructions for the proving test said every file "is a browser IIFE with no export" and sent the test author to a loader for browser scripts. For a module that has exports that sentence is false.

### 8.3 The app's AI board, read from its own canary

`GET /api/ai?canary=1` on production, 18:46Z: 4 of 12 answered, floor 5. Below the floor every statement row that needs the board keeps the rules' answer, often "Other". What each failing provider said:

| Provider | What it said | Whose it is |
|---|---|---|
| OpenRouterFinance | asked for `inclusionai/ling-3.0-flash-fin:free` → 404, then `thinkingmachines/inkling-2-small:free` → 403 | the code: the role's first rule was `/ling|fin/`, and "ling" is inside "inkling" |
| OpenRouterNemotron | deadline exceeded (13 s) on its 550b default, four canary runs in a row | the code: nothing moved the role to a quicker model |
| NVIDIA | default 410, three replacements 404; in the pipeline four more models `Not found for account` | the account behind `NVIDIA_API_KEY` |
| GitHubModels | `200 "OK"` as plain text, with a token and with none | nobody's: GitHub ended the service (section 8.6). This line first said "the token"; that was a guess from the reply alone, and it was wrong |
| Gemini, Ollama | 402 | credit |
| Mistral, Cohere | 429 | the provider's limit for the key |

### 8.4 What was changed

| Fault | Change | Where | Proof |
|---|---|---|---|
| The finance role took "inkling" for "ling" | The rule matches a name: a path part beginning `ling-`, a `-fin` part, or `financ` | `ai-models.mjs` | `test/ai_board_heal_2026_11_12_test.js`; production 19:05Z: the replacement asked for was `google/gemma-4-26b-a4b-it:free` |
| A refused or busy replacement ended the search | A model chosen from the provider's list that answers 403 is set aside and the next is tried. On OpenRouter the same holds for 429: one key, the same second, one role's model answered 200 and another's 429 (`temporarily rate-limited upstream`), so the limit is the model's. The provider's own default still stops on either | `ai-chat.mjs` | the same test file, with the 19:05Z and 19:08Z answers replayed |
| A model slower than the deadline stayed the role's model | A model that misses the board's deadline is set aside for half an hour and the list is asked for another. The first rule was "two misses in a row"; production showed it never fires, because each serverless instance counts only its own misses (19:05Z, 19:07Z, 19:09Z: three misses, no set-aside). One miss is enough | `ai-chat.mjs` (`setAsideSlowModel`), `api/ai.js` (`runWithin`) | the same test file, one case through the endpoint |
| Roles of one account could settle on one model | A model another role of the same list is using, or was just handed, is not offered; a role left with nothing stays out. Two voters on one model are one voter | `ai-models.mjs` (`createModelBook`) | the same test file |
| The agent could not open the files its own watchers name | `.mjs` modules are opened by name, each with its reason: `statement-direction.mjs`, `statement-merchants.mjs`, `statement-merchant-name.mjs`, `ai-models.mjs`, `ai-chat.mjs`. The other 92 stay closed (the Gmail and text senders, the tenant portal, the vault, the agent's own router) | `autonomy/reach.mjs` (`MJS_REACH`, `reachOf`), `autonomy/agent-swarm.mjs` | `test/agent_reach_test.js`: the open list is compared with the files on disk |
| The report did not say where the code is, or the agent did not read it | A file a report names goes first and no model is asked to choose. Reader self-reports and the board watch carry a `Where the code is` section naming the file and the function | `autonomy/reach.mjs` (`namedFiles`, `ownerFiles`), `wf-statement-self-report.mjs` (`OWNERS`), `autonomy/board-watch.mjs` | replays of #559 and #609 through `runSwarm`; a test fails when a watcher names a file that does not exist, does not hold the function, or is outside the agent's reach |
| Three attempts were spent before saying "not mine" | When a report says where the code is and the agent may open none of it, that is said at once with the reason per file. No model is asked, no attempt is counted, and the issue is handed over | `autonomy/agent-swarm.mjs` (stage `reach`), `autonomous-fix-agent.js` | `test/agent_reach_test.js` |
| A module with exports was tested as a browser script | The proving-test instructions for an ES module say: import it, call the function with invented input | `autonomy/reach.mjs` (`moduleShape`, `esmTestGuide`), `testPrompt` | `test/agent_reach_test.js` |
| The board watch gave the fix agent what only a person can fix | A bare `OK` in place of a completion is `service-gone` (a person reads the provider's page; no key is named); a default and three or more replacements all "not found" is `account-has-no-model`. Each line for the owner names the Vercel variable. Each line for the agent lists the models that were asked for. An open report whose text is no longer true is replaced | `autonomy/board-watch.mjs` | `test/board_watch_test.js`, with the 18:46Z canary replayed |

### 8.5 What is still open, said plainly

- **The board is still at 4 of 12 at the time of writing.** The two OpenRouter roles now choose correctly, and whether the models they move to answer inside the deadline is only known once production has run them. Five of the eight failures are accounts, and no change to the code reaches them: `GEMINI_API_KEY` and `OLLAMA_API_KEY` (credit), `MISTRAL_API_KEY` and `COHERE_API_KEY` (limit), `NVIDIA_API_KEY` (the account can call no model). The eighth, GitHub Models, is not an account at all (section 8.6).
- **What each instance learns, only it knows.** A model set aside, or a replacement that answered, is remembered by the serverless instance that saw it. Another instance learns it again on its own first call. Sharing that memory needs a store both can read.
- **The agent's reach is five modules wide.** A report about any other `.mjs` module is now refused at once with the reason, which is honest, and is not a fix. Each further module is opened by a person, by name.
- **The quiet period and the late slot that runs twice** (section 7.4) are unchanged.
- **A report holds counts and names of code, never statement text.** The agent now knows where the rule lives; it still cannot see the line the rule misread. The masked shape of the statement (section 5) is not built.

### 8.6 GitHub Models: the seat that could never answer (2026-11-13)

**What was measured.** On every production canary since 2026-10-01 GitHub Models answered `HTTP 200` with the body `OK` as `text/plain`. From the session the same address gives the same answer to any path, with a token and with none (the catalogue address and the chat address, 2026-11-13).

**What it was taken for.** A token without the "Models: read" permission. On 2026-10-03 the owner added that permission to `GH_PAT` and the code was changed to send `GH_PAT` first. The reply did not change. On 2026-11-12 the board watch still told the owner that `GH_PAT` "needs the permission".

**What it is.** GitHub's own page (docs.github.com/en/github-models, opened and read 2026-11-13) says: "As of July 30, 2026, GitHub Models has been fully retired. The playground, model catalog, inference API, and bring your own key (BYOK) are no longer available to any customer." The REST page for inference carries the same notice. One file in this repository already knew (`wf-screenshot-reader.mjs`, from the vision probe); the app's board, the scanner, the statement reader's roster and the pipeline's router did not.

**Why the bare `OK` and not an error.** Not known. GitHub's page says the service is gone; it does not say what the old address answers. What is known is the reply itself and that it is the same for every request.

**What was changed.**

| Where | Before | Now |
|---|---|---|
| `ai-models.mjs` | nothing said a whole service can end | `RETIRED_SERVICES`: the provider, the date, the page, GitHub's sentence. One place |
| `api/ai.js` (the app's board) | GitHub Models was a configured member whenever `GH_PAT` or `GITHUB_MODELS_TOKEN` was set: asked on every call, failed on every call | not a member. The board in production is 11 seats, and the canary no longer lists it |
| `api/vision-scan.js` | asked in the one-after-another scan and in the ultra scan | not asked |
| `statement-llm-router.mjs` | named in the third tier | not named |
| `wf-llm-router.mjs` (the pipeline) | a provider whenever `GITHUB_MODELS_TOKEN` was set, and a "missing key" when it was not | marked `retired`, never asked, never listed as missing |
| `autonomy/board-watch.mjs` | `token-not-accepted`, with `GH_PAT` named as the variable to fix | `service-gone`: read the provider's page; no variable is named |
| `autonomous-fix-agent.js`, `AUTONOMY.md` | `GITHUB_MODELS_TOKEN` in the list of keys that start the system | removed from the list |

`GH_PAT` itself is untouched: the app still files feedback issues with it. `GITHUB_MODELS_TOKEN` is still read where it only stands in as a GitHub token for issues (`autonomy/work-queue.mjs`, `feedback-status.js`); that use never reached GitHub Models.

**The lesson kept.** The reply was classified from its words alone, twice, and each time the owner was handed a step that could not help. A provider's own page was one request away. `service-gone` now sends a person to that page before anything else.

### 8.7 Production after the third round was merged (2026-11-13, 02:39Z to 02:41Z)

Read from `GET /api/ai?canary=1` and the function's own log, deployment `dpl_A24RXgpoUqKi1LoBQ4pARdsRhCSy`.

**What worked.**

- The board is reported as it is: "only 4 of 11 answered". GitHub Models is not asked and not listed.
- The one-miss rule fires. 02:39:50Z, the first call of a new instance: `{"evt":"ai-slow-model","provider":"OpenRouterNemotron","model":"nvidia/nemotron-3-ultra-550b-a55b:free"}`. With the rule of two (round before) three misses in a row left no such line.

**What did not, measured.**

- The finance role missed the deadline in both calls and no `ai-slow-model` line names it. Its default answers 404 at once, a replacement from the list is asked, and the 13 seconds run out on that request. The rule looked at the remembered model, then at the default; the default was already set aside for the 404, so nothing was done and the slow replacement stayed first in line.
- The two calls landed on two instances (both show Fireworks and the Qwen role healing from their first model again). The second instance set the same Nemotron model aside a second time. What one instance learns, another still learns again (section 8.5).
- The board did not come back above its floor. 4 answer: DeepSeek, Groq, Fireworks, the Qwen role. Cohere now also misses the deadline instead of answering 429.

**What was changed for the first of these.**

| Fault | Change | Where | Proof |
|---|---|---|---|
| The deadline fell on a replacement and the rule set nothing aside | The asker tells the book which model its request is out to. The model set aside is that one | `ai-models.mjs` (`asking`, `landed`, `flying`), `ai-chat.mjs` (`setAsideSlowModel`) | `test/ai_board_heal_2026_11_12_test.js`: the 02:39Z call replayed through the endpoint; the log line names the model that stalled and the next call asks neither it nor the one that is gone |
| A request the board walked away from is not cancelled; when it answers late it was remembered as the slot's model again | A model that is set aside is not remembered | `ai-models.mjs` (`remember`) | the same file |
| The proving-test instructions for a module with only a default export showed an import of a made-up name (the review board's note on #614) | Such a module is imported as a default | `autonomy/reach.mjs` (`moduleShape`, `esmTestGuide`) | `test/agent_reach_test.js` |

Whether the finance and Nemotron roles then land on a model that answers inside 13 seconds is not known until production has run it; that is the next measurement, not a claim.


### 8.8 Production after the in-flight rule was merged (2026-11-13, 08:42Z to 08:44Z), and the hedged request

Read from `GET /api/ai?canary=1` and the function's own log, deployment `dpl_Ga8Qudbd6zssiq8mjuYLnVu9eHaG` (main `2d57803`, #615).

**What worked.** The log names the model whose request was out when the deadline fell, for both roles: `{"evt":"ai-slow-model","provider":"OpenRouterFinance","model":"nvidia/nemotron-3.5-lightning:free","note":"its request was out when the deadline fell ..."}` and the same for `OpenRouterNemotron` (`nvidia/nemotron-3-ultra-550b-a55b:free`). The finance role, silent in section 8.7, is now named.

**What did not, measured.**

- Two canary calls, 08:42Z and 08:44Z, read 5 of 11 (GOOD, floor 5, Cohere answered at 7.9 s) and then 4 of 11 (below the floor). Finance and Nemotron ran into the 13-second deadline in both.
- The cause is the one section 8.5 predicted: a set-aside lives in one serverless instance. The second call landed on an instance that had not seen the first one's miss (the log shows the function in two regions, `sin1` and `iad1`). Setting a model aside by name is right and is not enough while the memory is per instance.

**What was changed.** A shared memory needs a store (not built). A hedged request does not need one. A request still out after `HEDGE_MS` (5 s, inside the 13-second board deadline) is asked of a second model of the same provider (`book.replacement`, never the slow one, never one another role of the account holds), and the first usable answer is the board's. The slow model is set aside only when the other one answers first; having been hedged is not a reason. If the deadline falls with both out, both are set aside (`flyingAll`). A provider that cannot list its models is never hedged. The cost is one extra call to a free model, only when the first is already slow.

| Fault | Change | Where | Proof |
|---|---|---|---|
| A cold instance asks the same stalled model for the whole deadline | Hedge at 5 s with a second model; first answer wins | `ai-chat.mjs` (`askHedged`, `HEDGE_MS`), `ai-models.mjs` (`flyingAll`) | `test/ai_hedge_test.js` (9 cases: second wins and the slow one is set aside; default wins late and is not; no hedge on a fast answer, without a list, or at 0; second never the slow one or another role's; both stall and both are set aside; a thrown error is passed on) |

Whether the board then holds its floor on every call is not known until production has run it; the next measurement is two canary calls 95 s apart and the `ai-hedge` log lines.

**Measured after #618 was deployed** (`dpl_5xjrw8iMFQkH6ZrG2ney8dnypnRe`, 09:06Z and 09:08Z, 95 s apart): 5 of 11 (GOOD, Cohere answered at 9.7 s) and then 4 of 11 (Cohere past the deadline). The hedge fired: the log names two models per role in `ai-slow-model` (`nvidia/nemotron-3-ultra-550b-a55b:free, nvidia/nemotron-3.5-super-vl:free` and `nvidia/nemotron-3.5-lightning:free, dots-studio/dots-3-note-preview:free`), so both requests were out and both were set aside. Neither answered: the free models those two roles reach are slow upstream, not slow by one unlucky pick, while the Qwen role's free model answers in 3 to 5 s. So the code now does what it can with the models it is given (it asks two, names both, keeps neither); what remains is capacity the owner's accounts and OpenRouter's free tier give: Cohere (trial key, 9.7 s then over 13 s), the two OpenRouter free roles, and the five account-side failures in section 8.3. A third path (a faster model for these two roles) needs a measurement of which free models answer inside 8 seconds, which a session without the OpenRouter key cannot take; the daily board watch (`ai-board-health`, #609) records it from production.

### 8.9 Late duplicate slots (2026-11-13)

**Measured, 2026-11-12, from the runs lists of three workflows.** GitHub delivers a `schedule:` run hours late; the pacemaker had already started the same workflow for that slot. Three jobs ran twice on one day, each on free-tier model quota: `autonomous-discover` 08:08Z (pacemaker) and 12:22Z (schedule), `security-updates` 08:08Z and 13:54Z, `feature-proposals` 08:08Z and 09:58Z. The pacemaker never starts a slot twice, but it cannot hold back a run GitHub delivers itself. Today (2026-11-13) the same shape is waiting: the slots at 04:00Z, 05:30Z and 02:30Z were served by dispatch (05:05Z, 06:28Z, 02:55Z) and their schedule runs have not arrived yet.

**Changed.** `autonomy/slot-guard.mjs`, run as the first step after checkout in those three workflows and only for `schedule` runs: it asks GitHub whether another run of the same workflow did or is doing the work of the latest slot, and if so cancels itself. Rules, each a case in `test/slot_guard_test.js`: served means a run of the same workflow, not this one, started before this one, at or after the slot (less the pacemaker's 5 minutes), in progress or successful; a failed run does not serve the slot (the late run is its retry); a skipped or cancelled run did nothing; two late runs delivered together cannot cancel each other (only the later stops); dispatch, push and manual runs are never held back; any doubt (no token, API error, cancel refused) runs the job. `security-updates.yml` gained `actions: write` for the cancel only; the other two already had it.

**Proof.** The guard was replayed against the real runs list of `autonomous-discover` at 2026-11-12 12:22:40Z: `slot guard: STOP, run 43180495974 (workflow_dispatch) started 08:08Z and success: it did the slot due 04:00Z`. Not yet proven live: the first real late schedule run after merge (the run page will show it cancelled, with the guard's line in its summary).

**What is not duplicated any more than before.** The review board of a pull request ran 5 times per diff before section 8's label rule and runs once, or twice when `human-approved` is applied after the last push (measured on #617: attempt 2 and attempt 1). The "three times per push" item of the earlier open list is closed.

### 8.10 A second author when the first change is refused (2026-11-13)

**Measured.** The open list of 2026-11-12 held "author quality (#607)": attempt 1 wrote JavaScript that did not parse; attempt 2 was stopped by the independent security reviewer (an XSS sink). Each ended the attempt, and each was a failure of the model that wrote the change, not of the issue: the second attempt of an unchanged issue is the same model with the same prompt, and the fix agent counts three of those before `ai-stuck`. What was missing is a different author inside one attempt.

**Changed.** In `runSwarm` (`autonomy/agent-swarm.mjs`) the authoring of one file is a function, `authorOnce`. When the first change is refused at the mechanical gates (`structure`, `syntax`) or vetoed by the reviewer (`security`) the same file is asked for again, once (`MAX_SECOND_AUTHORS`), with `exclude: [first provider]`, and the author is shown the refusal. The reviewer's words are model text, so they reach the second author inside the same untrusted-data fence the issue gets (`secondAuthorFeedback`); the prompt asks for a different change and does not argue with the veto. The new change goes through exactly the same gates, and the reviewer still excludes whoever authored it. Nothing is relaxed: no gate is skipped, no third author is asked, and a second author that turns out to be the first (nobody else reachable) is refused. When no second author can be reached, or the second change is refused too, the run ends with the first refusal and a `secondAuthor` record (`first`, `second`, `stage`, `outcome`) so the issue comment can say what happened. Later stages (revision for "no visible effect", test proving, repair rounds) have their own loops and are not repeated.

**Proof, and what is not proven.** `test/swarm_second_author_test.js` (9 cases) runs the real `runSwarm` with a scripted model: unparseable first change then a good one from another provider; veto then a good one, reviewed again; reviewer text fenced; second refusal ends the run with both attempts recorded; same-provider and unreachable second author handled; a change that passes asks nobody twice. Not proven live: no real agent attempt has yet used it. The first real use will show as `a second author (not <provider>) is asked` in the agent run log.
