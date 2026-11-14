# Local eval set

The local eval set measures the review against your own decisions (docs/plans/review-v3.md WP-V1, WP-V3). It holds company code and your comments. Keep it out of git. Only aggregate numbers go to docs/eval/results.md.

## Run the gate (U-V1)

1. Close the app.
2. Run `bun run eval:ab`.
3. Send the printed tables.

The command builds the local set from the data folder of the app into `eval-local/`. Then it runs the shipped profile (A) and the candidate (B) on the set with your Claude CLI. It prints one table for the review cases and one for the re-review cases, with cost and time, and the paths of the result files. It skips a mode without cases. It exits with code 1 when a run fails, and with code 2 on a usage error or an unknown name.

- Review and re-review cases: the default candidate is the shipped profile. `--candidate-variants` and `--candidate-modules` add switches to it. The verify mode stays as shipped.
- `broad` (docs/plans/review-v2/review-quality-2026.md item 3): with the verify phase on, the finder gets no do-not-flag list and no language skip lists. The verify phase gets the skip lists of the languages of the change. With `pr-context.md`, the finder learns that a thread comment is a claim, not a reason to leave out a finding.
- `verify2` (item 4): the verify phase gets a wider duplicate rule and a rule for thread claims. It also gets a rule for findings of the intent section. A split check gives one group to one rl-verifier call. The variant changes only the verify prompts, so `--candidate-replay` can test it.
- `classes` (item 7): rl-main and rl-reviewer get a list of the bug kinds that authors fix most often, after the profile prompt. The list ends with "Report other problems too." The variant changes the finder, so `--candidate-replay` refuses it. Example: `--candidate-variants classes --candidate-repeat 2 --clean 8`.
- `security2` (item 10): the security section of rl-main and rl-reviewer gets more attack kinds and a source-path-sink rule for the trigger. The verify phase gets rules for candidates of category security. A real defect that is no security hole keeps its verdict. The rules adapt anthropics/claude-code-security-review (MIT, THIRD_PARTY_NOTICES.md). The variant changes the finder, so `--candidate-replay` refuses it.
- `security2-verify` (item 10): only the verify rules of `security2`, so `--candidate-replay` can test them on the recorded finder calls.
- `parts`: see "Part files". `failures`: a trial module with a failure checklist.
- The variants `signal`, `order`, `rules2`, and `rereview-strict` are removed. The first three lost in U-V1 (docs/eval/results.md). U-V1 gave no decision for `rereview-strict`, and no plan uses it. A saved profile that still lists one loads without it. `--variants` and `--candidate-variants` refuse them. No run reads `REVIEW.md` now.
- The output names no case. It shows `case 1`, `case 2`, and so on. The result files keep the case IDs.
- Must find: each posted finding, each finding that a Fix commit covered, and each finding that your session accepted (Ask your session). Your own discard still wins over a session accept. Over a Fix commit, only your discard with a reason wins. Your own root comments at a reviewed head are must-find too. A root line comment of another reviewer at a reviewed head is must-find too. It counts when its thread is resolved, or when a later push changed its line (an orphaned anchor). It is a bug with `source: "other"` and severity minor in case.json. So recall counts it only at `balanced` and `thorough`. A comment on the lines of another must-find of the same case adds no second must-find. Comments of the PR author stay out. General comments, file comments, and open comments on unchanged lines also stay out.
- Must not raise: each finding that you discarded as "Not a bug" or "Intended", and each posted finding that you withdrew in its thread. A withdrawal is a reply of "Discuss" with the verdict withdrawn that you posted in the thread of the posted finding.
- MANIFEST.json `sources` counts the selected items by source before carry: `posted`, `fixed`, `session`, `withdrawn`, and `other` (comments of other reviewers). The build prints the same counts on the "Sources before carry" line.
- Recall leaves out each must-find item that the volume of the run cannot show: nit items under `balanced`, and nit and minor items under `quiet`.
- A posted finding, a comment of another reviewer, or a must-not-raise finding also counts at each later head of the same PR while its lines hold. Your own comments stay at their head. The builder maps the lines through the diff from the earlier head to the later head, also through a rename. Old-side lines map through the diff from the earlier merge base to the later one. A changed line or a deleted file keeps the item at its own head. The item never goes to an earlier head.
- When the later head has its own item at the same place, the newer decision stays and the carried item drops. A carried item has `carriedFrom`, the earlier head, in case.json. MANIFEST.json `carried` counts the carried items and those that stayed behind. Each count is per item and later case.
- Re-review cases get no carried items. Their earlier findings are in `rereview.earlier`, and a new item on a posted one counts as a re-raise.
- Each review case.json has `rules`, the version of these must-find rules. A new version changes the set fingerprint. `eval:rescore` keeps the stored truth of a local result. So it refuses the result when the cases on disk have another fingerprint. Run the eval again on the new set. A stopped run also gets this refusal.
- Each case holds the PR threads that existed when its review run started (review-ideas.md idea 2). They are in `threads` of case.json. The run puts them into the comment table, so `pr-context.md` lists them as the app does. A plain case uses the start time of its first run. A re-review case uses the start time of its own run.
- A thread is in a case when another person started it before the run start. Its replies by other people come with it. Your own comments and replies stay out. A thread that you started stays out with all its replies. A comment created or edited from the run start on stays out. An edited root takes its thread with it. A deleted comment stays out. A deleted root with live replies stays, as the app shows it: the root has no text and `deleted: true`.
- A thread that is a must-find of the case stays out. A thread on the lines of a must-find or of your own comment also stays out. Its replies go with it. So no other reviewer's comment shows the answer to the run.
- A re-review case also gets the replies of the PR author in the threads of the posted earlier findings. Each reply has `earlier`, the ID of its earlier finding. The run adds them under the thread of that finding.
- The PR author becomes `eval-author`. Each other person of the PR becomes `reviewer-1`, `reviewer-2`, and so on, in first-comment order over the PR. You become `eval-reviewer`. Every other person of the database (comment authors and PR authors) becomes `someone`.
- In the text, each whole-word slug and login of any person of the database becomes its placeholder, in any case. The full display name of any person of the database changes as stored or with each word capitalized. A single display-name word of 3 or more letters is a first or last name alone, or a one-word display name. It changes only for the PR author, you, and the reviewers with a comment on the PR. It changes only in its capitalized form: "Will, can you check" changes, "this will mark the row" stays. Limits: a single name word of a person of another PR stays. A name in lowercase or in all capitals stays. A slug or login shorter than 4 characters, or a common word like `admin` or `test`, changes only in an @mention. Every @mention of an unknown name (`@name`, `@"name"`, `@{name}`, `[~name]`) becomes `@someone`. Email addresses become `<email>`, and the host part of each URL becomes `<host>`. The text is in Unicode NFC form. Other text stays as stored, like the PR title and description.
- An inline thread keeps its lines when they map to the reviewed head through the diff, as for carry. Otherwise it stays as a file comment without lines. A root on an unchanged line (CONTEXT) is numbered on the old side, as the app does. It also gets `lineType: "CONTEXT"` and `newPlace`, the same lines on the new side at the reviewed head. A thread is resolved only when its resolve time is before the run start. The orphaned state is not stored.
- Caps per case: 60 comments, the newest threads first, and 2,000 characters per comment. MANIFEST.json `threads` and the "PR threads" line of the build give the counts. They count the threads, the comments, and those over the cap. They also count the replies in your threads, the threads on must-find lines, and the edited comments. They also count the threads without lines and the PR author replies of re-review cases.
- `rules` is 3 since the threads, 4 since the run start cutoff and the must-find line rule, and 5 since the gold text, the case fields, and the clean cases. Old case files with `rules: 2` and no threads still run, without threads.
- `bun run eval:threads <result.json>` runs the idea 2 check on a local result. For each must-find that recall counts, it checks for a thread within 10 lines in the same file and side. A CONTEXT root also counts on the new side, with its `newPlace`. It prints the counts for missed and for found must-finds. It counts only completed runs and prints how many runs it left out. It counts a case with threads only when one of its threads has lines. It reads only the result file and the case files, and it refuses a result of another build of the set.
- The result items store `evidence`, `anchorText`, and `cause` of each finding. No metric reads them. Old result files without them still score.
- The builder only reads the data folder: a temp copy of the database, and read-only git commands on the cache. It refuses an `--out` folder in the data folder.

## Gold text and case fields (rules 5)

The matcher and the judge of docs/plans/review-v2/review-quality-2026.md (E3, E4) need the text of each item. Rules 5 adds these fields to case.json:

- `text` on each bug, trap, extra, and own comment. A finding gives its title, trigger, and body, with an empty line between them. The body is the text after your edit, else the text of the finder. Your edit gets the names replaced, as a comment does. A carried finding gives the text of its newest copy. A finding of prompt version 1 gives its body only. A comment gives its text with the names replaced and the 2,000-character cap, as the thread text has them. The same person gets the same placeholder in the text and in the threads.
- `category` on each finding: the category that the finder gave. A comment has none.
- `source` on each item: `posted` (you posted the finding), `fixed` (a Fix commit covered it), `session` (your session accepted it), `other` (a line comment of another reviewer), or `own` (your discard, your withdrawal, or your own comment). So each trap and each extra has `own`.
- `group` on each case: an opaque key of the PR, such as `pr12`. All cases of one PR have the same group, so a bootstrap can resample by PR.
- `hasTask` on each case: true when a task row has its text. The run then gets `task.md`. The name differs from `task`, which holds the task text of a fixture case.
- `large` on each case: true for 1,200 or more changed lines or 30 or more files (catalog.ts `REVIEWER_MIN_LINES`, `REVIEWER_MIN_FILES`). The diff goes from the merge base to the head. The reviewer mode of the profile does not change it.
- MANIFEST.json `categories` counts the findings by decision before the conflict rule and carry, as `sources` does. The decisions are `posted`, `fixed`, `session`, `withdrawn`, `notBugOrIntended`, `otherDiscard`, and `refuted`. `byClass` counts per bug class of shared/review.ts `bugClass`: `security`, `concurrency`, `resource`, `behavior`, and `other`. `byCategory` counts per category in lower case, with `none` for a finding without one. `byModule` counts per module. MANIFEST.json holds no text.
- case.json now holds company text in each item. Keep `eval-local/` out of git. The result files of eval runs copy the items, so `eval-results/` also holds the text.

## Clean cases

A clean case measures noise on a PR with no known defect (SWR-Bench clean PRs). `bun run eval:local -- --clean N` adds up to N clean cases. The default is 0.

- A reviewed head is a candidate when its PR merged with that head as its last source head. The sync stores the state and the last head of each PR.
- The head has no must-find and no trap, also after carry. No decision touched it, so a must-find and a trap that cancel each other do not make a candidate. Extras can stay. They count for no metric but extras.
- No root comment of you or of a reviewer is on the code of the head. A comment at the head counts. A comment at an earlier head also counts, unless a push orphaned it. A file comment counts too. A comment of the PR author and a general comment do not count.
- A head with more than one merge base gives one candidate: the newest run.
- The build takes the N candidates with the oldest first run. A newer merged PR adds a candidate, but it does not change this choice.
- A clean case has `clean: true` and no bugs. It keeps its threads, its task rows, and its extras.
- MANIFEST.json `clean` holds `asked` (N), `candidates`, and `cases`. `counts.cases` includes the clean cases. The build prints them on the "Clean cases" line.
- `bun run eval:ab` builds the set again before each run and passes its `--clean N` to the build. Without `--clean`, its set has no clean cases.

## Probe set

`fixtures/eval/probe/` holds 8 small synthetic cases in git. `bun run eval -- --set probe` runs them. Each case is a known trap for a reviewer:

- 2 cases have a PR thread next to a seeded bug. In the thread, the PR author claims that "this case is handled". The claim is wrong.
- 1 case has a thread with a correct claim on code that looks wrong. The code is a trap.
- 2 cases have task text with acceptance criteria. The change does not meet one criterion. That bug has module `intent`.
- 1 case has task text, and unchanged code meets the criterion. The line that seems to miss it is a trap.
- 1 case has PR text that states no requirement. Its traps are where a reviewer invents one.
- 1 case is clean (`clean: true`). It has no bug and one trap on a line that looks wrong but is correct.

A fixture case can have `threads` and `clean`, as a local case can. The run seeds the threads into the comment table, so `pr-context.md` lists them. A fixture case has no `text` on its items: `note` and `why` describe them.

## Optional flags

- `--repeat N`: run the baseline N times (1 to 10). Default: 1.
- `--candidate-repeat N`: run the candidate N times. N must not be more than the repeats of the baseline. Default: `--repeat`.
- `--candidate-variants a,b`: the variants that the candidate adds. Default: none, so the candidate is the shipped profile.
- `--candidate-modules a,b`: the modules that the candidate adds to the shipped modules. Default: none.
- `--candidate-replay`: the candidate replays the recorded finder and salvage calls of the baseline and runs only the verify calls. The command refuses a candidate flag that changes the finder.
- `--clean N`: the clean cases of the set build (see "Clean cases"). Give the same N to every command of one set. A different N gives a different set fingerprint, and the command then refuses the stored baseline.
- `--effort low|medium|high|xhigh|max`: the effort of the baseline and candidate runs. Default: none, so both sides run with the effort of the shipped profile. The eval header shows the effort of each run.
- `--candidate-effort low|medium|high|xhigh|max`: the effort of the candidate runs. Default: none, so the candidate runs with the effort of the baseline. With this flag, the table says that the efforts differ.
- `--candidate-verifier on|off`: the verify mode of the candidate runs. Default: none, so the candidate keeps the verify mode of the shipped profile. The baseline always keeps it. The eval header shows the verifier of each run.
- `--candidate-reviewer-effort low|medium|high|xhigh|max`: the rl-reviewer effort of the candidate runs. Default: none, so the candidate keeps the rl-reviewer effort of the shipped profile. `--effort` does not change the rl-reviewer effort. The eval header shows it as "reviewer effort".
- `--large`: run only the large review cases. A case is large when the baseline profile gives the review the rl-reviewer agent: 1,200 or more changed lines, or 30 or more changed files. The re-review cases do not run, because a re-review never gets rl-reviewer. The command prints the number of large cases. It exits with code 2 when the set has none.
- `--db <file>` and `--cache <folder>`: another database file and git folder. Default: those of the data folder.
- `--out <folder>`: the folder of the set. Default: `REVIEW_LOOP_EVAL_LOCAL`, else `eval-local/`, which git ignores.
- `--user <slug>`: your user slug. Default: `userSlug` of `config.json` beside the database file.
- `--results <folder>`: the folder of the result files. Default: a new folder in `eval-results/`.
- `--baseline <folder>`: the folder of an earlier eval:ab run. See "Reuse a baseline".
- `--resume`: continue the cut baseline result in each `<mode>-baseline/` folder of `--results`. It needs `--results` and `--baseline-only`, and each folder must hold exactly one result file. Give the flags of the cut run. The run keeps the completed and incomplete runs, runs the other case runs, and writes the same file. See "Run W1 in one command" for the refusal rules.

## Reuse a baseline

A new candidate does not need a new baseline run. Give the folder of an earlier run, and only the candidate runs:

```
bun run eval:ab -- --baseline eval-results/ab-<stamp>-<commit> --candidate-variants broad
```

- The command reads the baseline results from `review-baseline/` and `rereview-baseline/` of that folder.
- A mode without its folder runs the baseline as usual. The output says so in one line.
- The command refuses the reuse with exit code 2 when the stored baseline has a different set fingerprint, effort, profile version, profile revision, prompt version, or model, or fewer repeats than the candidate runs. It also refuses a baseline with fewer finished runs (completed or incomplete, no usage limit) than cases x repeats, such as a cut baseline. Resume that baseline with `--resume` first. The checks run before any run.
- Give the same `--effort` and `--clean` as the earlier run. The candidate can run fewer repeats than the stored baseline.
- Each run records its CLI calls automatically in `<result>.calls/` beside its result file. `--candidate-replay` uses the recording of the baseline result. A new commit or CLI version is allowed. The A and B header lines show both.
- The set must not change. A new decision in the app changes the set fingerprint, and the command then refuses the reuse.
- With `--large`, give the folder of a full-set run or of an earlier `--large` run. A full-set baseline must pass the checks above against the full set. Then the command keeps only its large cases and writes that copy to `review-baseline/` of the new result folder. So the new folder serves as the large baseline of later runs.

## Opened files and rl-reviewer calls

Each run records three facts from its run log. The verify phase does not count.

- `agentCalls`: the number of rl-reviewer calls.
- `opened`: the repository paths that a Read opened under `./repo`, and the path of each git_diff, git_blame, and git_show call. A read of `./context` does not count. A git_diff without a path opens no single file, so `opened` is a lower bound.
- `toolsPerCall`: the most tool calls under one rl-reviewer call.

The tables show two of them:

- "bug opened": the counted bugs whose file is in `opened`. A low value with low recall means a coverage miss. A high value with low recall means a reasoning miss.
- "rl-reviewer calls per case": the mean of `agentCalls`.
- A result file from before these facts shows "-".

The eval runner takes `--reviewer-effort low|medium|high|xhigh|max` for the same rl-reviewer effort as `--candidate-reviewer-effort`.

## Part files (variant parts)

The variant `parts` is opt-in: `--variants parts`, or `--candidate-variants parts` in eval:ab. It acts only when the review gets rl-reviewer in mode auto. The app then splits the changed files into parts in `./context/parts/`. Each part stays under 1,200 changed lines and 30 files, unless it is one file. rl-main makes one rl-reviewer call per part. A part that no rl-reviewer call read gives a "Part N of M" line in coverage.

Each run records two more facts:

- `parts`: the number of part files. A run without the variant, or without delegation in mode auto, records 0.
- `partsRead`: the part files that an rl-reviewer call read. A read by rl-main does not count.

The tables show "part files per case" and "parts read" next to "rl-reviewer calls per case". A result file from before these facts shows "-".

## Run W1 in one command

`bun run eval:w1` runs wave W1 of docs/plans/review-v2/review-quality-2026.md. It writes into `eval-results/w1/`. `--results <folder>` changes the folder.

1. Pre-checks, with no model call: `claude auth status` must show authMethod claude.ai, the app must be closed (nothing listens on 127.0.0.1 at `REVIEW_LOOP_PORT` or 7317), and the data folder of the app must hold the database, the git cache, and a user slug. The command prints the CLI version.
2. Smoke: the probe set once (`bun run eval -- --set probe --repeat 1`). A failed or missing case run stops the command with exit code 1.
3. Baseline: the command prints the cost per case run (about 8 minutes and $4, measured on 2026-11-14; large cases take 13-18 minutes). When an earlier set build exists, it also prints the total for its cases x `--repeat`. Then it asks "Start the baseline? [y/N]" and runs `eval:ab -- --clean 8 --repeat 3 --baseline-only --review-only`. `--repeat N` changes the repeats of the baseline. For example, 42 cases x 3 repeats take about 17 hours and $500.
4. Labels: the command runs eval:label without `--real`, prints the open work and its estimate, and asks "Start the labels? [y/N]". Then it labels with `--real`.
5. Summary: aggregate numbers, case rows by ordinal, and the step costs between two marker lines. Paste these lines to Claude.

- Each finished step writes `<step>.done` into the results folder. A new run prints "Done before: <step>" and skips it. A smoke or label step with a failed run writes no marker.
- A complete baseline with failed runs (not the usage limit) is kept when 25% or fewer of its runs failed. The command prints a warning with the count and the error kinds, and the summary marks them. A failed run scores as a run with no finding. A later eval:ab with `--baseline` refuses the result, because it has fewer finished runs than cases x repeats. Run the failed runs again first: `bun run eval:ab -- --clean 8 --repeat 3 --baseline-only --review-only --results eval-results/w1/baseline --resume`. Above 25%, a stop, or fewer runs than cases x repeats, the baseline writes no marker.
- `costs.jsonl` in the results folder records the cost and the minutes of each step attempt.
- `--yes` answers both questions with yes. Any answer other than y or yes stops the command with exit code 2.
- `--skip-smoke` skips the smoke run and prints a warning.
- Usage limit: the command stops with exit code 3. Run the same command again after the limit resets. eval:label continues from its stored answers.
- A cut baseline resumes. After a usage limit, a crash, or Ctrl+C, the next run finds the result file in `baseline/review-baseline/` and prints "Resuming the baseline: K of N runs are done." It runs `eval:ab` with `--resume`, which keeps the completed and incomplete runs. A failed, cancelled, or error run and a run that hit the usage limit run again. The result stays in the same file.
- A resume refuses a change of the run setup: the prompt version, the profile version and revision, the model and effort flags, the runner, the set and its fingerprint, the mode, the volume, or the tolerance. A new commit or a new Claude Code version is allowed, because Claude Code updates itself almost daily. The command then prints a warning line. The result file keeps the commit and the CLI version of the first run, and records those of each resume in `resumes`. The eval:compare header shows them. A lower `--repeat` is allowed when every finished run fits in it.
- A refused resume stops with exit code 2. To start a new baseline, move the folder `baseline` away and run the command again. A new set build after you used the app can change the fingerprint.
- Exit codes: 0 done, 1 a failed step, 2 a failed pre-check, a usage error, a refusal, or a No answer, 3 the usage limit.

## Label the findings (eval:label)

`bun run eval:label -- <result folder or file> --real` labels the findings of eval results (docs/plans/review-v2/review-quality-2026.md E3, E4). Give the folder of an eval:ab run, or one result file. Without `--real`, the command prints the open work and a cost estimate, and exits with code 2. With no open work, it prints the scores and needs no `--real`. It exits with code 1 when a CLI run fails or gives an invalid answer. Run it again to continue: each stored answer stays.

- Matcher: a Sonnet run at effort low compares the findings with the gold items of the same file. A finding has the files of its anchor and its cause. A gold item has its path and each alt path. One run gets up to 10 findings and 10 gold items. Its folder holds only `context/match.md`. It has the read tools only: no MCP server and no agent. The finding text stays out of stdin. A fixture item has no `text`, so its `note` or `why` stands in.
- Judge: a Sonnet run at effort medium labels each finding that matches no gold item, also a folded or hidden one. A label is tp or fp, with severity, category, and scope. The judge runs in a sanitized workspace of the case head with `pr.md` and `task.md`, the read tools, and rl-git. It gets no Bash and no agent. The PR threads stay out of `pr.md`.
- Reuse: first the matcher compares each new unmatched finding with the labelled findings of the same case. A match takes the stored label. So only new findings cost judge runs.
- Calibration: once per label set, the judge labels the must-finds and your own comments (expected tp) and the traps (expected fp) of each case. The output prints the agreement. It is no ship gate.
- Storage: `<eval-local>/labels/<key>/matches.json` and `labels.json`. The key is the set fingerprint of a local result. A fixture set uses its name and a hash of its case truth. A matcher answer has the item hash, the gold key, the matcher version, and the prompt hash. A judge label has the model, the effort, the prompt hash, and the CLI version. The labels never go into case.json. A second run on the same results costs nothing.
- Disagreements: `labels/<key>/disagreements.md` lists each finding and gold item pair where the line match (T = 3 on the local set, traps at 0) and the matcher disagree. Audit the list once. The matcher becomes the primary column only when you agree with it more often than with the line match. The file holds finding text, so the output gives only the count.
- A `--large` run has another set fingerprint, so its labels go to another folder.
- A local result needs the build of the set that it ran, as for eval:rescore. eval:ab builds the set again before each run, so label a result before a new decision in the app changes the set.
- eval:compare and eval:rescore read the labels of a result when they exist.

### Grounded and augmented metrics

Ship decisions use grounded metrics only. Grounded metrics come from the matcher and the gold items. Augmented metrics also count the judge labels, so they are diagnostics only.

- grounded recall: counted must-finds that a shown finding matches. One finding can find two must-finds.
- grounded precision: shown findings that claim a must-find or one of your own comments, over the shown findings that claim a gold item other than an extra. Findings claim gold items in finding order, and each gold item goes to one finding (ReviewBench 6.2.4). A finding whose matches are all claimed counts as unmatched and goes to the judge. A trap claim is a matched fp. An extra claim is neutral.
- grounded noise: shown findings that claim no gold item, per case run.
- grounded raised and verifier loss: the counted must-finds that any finding matches, and the state of the best finding of each one, in this order: main (in main and not refuted), demoted (refuted, but it stays in the list), folded (in fold and not refuted), duplicate, or refuted (both hidden). All use the counted must-finds as one denominator, so raised = the sum of the five states. A demoted finding in main still counts for grounded recall.
- Recall in bugs per repeat gives the found must-finds of each repeat and their spread. The ship rules read S_R from it.
- augmented precision, augmented recall, and new tp per case add the unmatched shown findings that the judge gives tp. severity above: the share of those findings whose app severity is above the judge severity. Blocker and major are high, minor is medium, nit is low.
- refuted shown: refuted findings that stay in main (the protected classes), per case. `bun run eval:rescore -- <result.json> --fold-refuted` moves them to fold and prints recall and noise for that case.
- The line match (recall, precision, noise) stays in its own rows beside the grounded rows. candidate recall now divides by the counted must-finds, as recall does, so candidate recall - recall is the share that the check lost.
- The summary also prints a mean per case (macro) beside the pooled number (micro), the verifier confusion matrix (the gold or judge label of each finding by its verdict), the slices (severity, source, module, bug class, size, task text, clean cases), union recall over k repeats, and the finder question sums. The probe set is its own slice: run it with `--set probe`.
- Shown security findings (improvement 10): the shown findings whose category is exactly security, per case run, by gold match, judge tp, judge fp, and no label. It prints only with labels: in the eval:label and eval:rescore summaries, and for A and B in eval:compare.
- eval:compare prints a paired delta: the mean of B - A of the hit rate per counted must-find, with a 90% bootstrap interval over the PR groups and a fixed seed. It is information only.
- A result without labels shows "-" for each grounded and augmented metric.

### Evidence references (item 8 gate)

`bun run eval:label -- eval-results/w1/baseline --evidence` checks the `path:line` references in the evidence of each finding against the files at the case head (docs/plans/review-v2/review-quality-2026.md item 8). It runs no CLI, costs nothing, and writes nothing. Run it after `eval:w1` finished the labels.

- A reference is a token with a `/`, `\`, or `.` before `:<line>`, with an optional `-<line>` end, as the finder prompt asks ("path:line"). It starts at the text start, after white space, or after an opening quote, backtick, or bracket. A URL, a word without a dot, and a path with another character (such as `[id]` or `@types`) are no reference. In `a.ts:12, 15`, only line 12 counts.
- Missing file: a reference names a file that is not in the head tree. A path that the parse cut, or a path with a `repo/` prefix, also lands here.
- Line out of file: a reference names line 0 or a line past the end of a file in the head tree. An old-side reference also counts against the head. Parser misses do not reach this column, so trust it more.
- The table counts the findings of all runs, shown, folded, and hidden, by label: must-find, trap, and extra (the matcher claim), judge tp and judge fp, and no label. A finding without a matcher answer or a judge label counts as no label.
- Columns: findings, no evidence field (a result file made before the field existed), no path:line, with path:line, references, missing file and its share, line out of file and its share. Each share is over the findings with path:line.
- The output holds counts only: no path, no finding text, and no case ID.
- Gate: build variant "quotes" only when the shares of judge fp are clearly above those of judge tp and must-find.
- Give the `baseline` folder, not `eval-results/w1`. That folder also holds the probe smoke run, and a `baseline-earlier-<stamp>` folder of a cut run, which the current build of the set refuses.

## Bisect when the result is mixed

Run the command again with one change at a time: `--candidate-variants broad --candidate-modules ""`, then `--candidate-variants verify2 --candidate-modules ""`, then `--candidate-variants "" --candidate-modules failures`. Each run builds the same set again, so the tables compare.
