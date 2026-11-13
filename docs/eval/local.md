# Local eval set

The local eval set measures the review against your own decisions (docs/plans/review-v3.md WP-V1, WP-V3). It holds company code and your comments. Keep it out of git. Only aggregate numbers go to docs/eval/results.md.

## Run the gate (U-V1)

1. Close the app.
2. Run `bun run eval:ab`.
3. Send the printed tables.

The command builds the local set from the data folder of the app into `eval-local/`. Then it runs the shipped profile (A) and the candidate (B) on the set with your Claude CLI. It prints one table for the review cases and one for the re-review cases, with cost and time, and the paths of the result files. It skips a mode without cases. It exits with code 1 when a run fails, and with code 2 on a usage error or an unknown name.

- Review cases: the candidate adds the variants `order,rules2` and the `failures` module to the shipped profile. The verify mode stays as shipped.
- `order`: a fixed review order. `failures`: a failure checklist.
- The variant `signal` (high-signal finder rules) is removed. U-V1 showed that it cut recall from 30.8% to 11.5%. A saved profile that still lists it loads without it.
- `rules2`: a rule-only finding gets severity minor, unless it causes a real bug. The rules section also flags a change that makes the project instructions out of date.
- `rules2` also reads `REVIEW.md` at the repository root of the target branch, as project instructions with the CLAUDE.md caps. Only review and re-review runs read it.
- `rules2` adds generated files, lock files, and vendored third-party code to the do-not-flag list. The verify phase gets four examples of false positives to refute.
- Re-review cases: the candidate also adds `rereview-strict`.
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
- `bun run eval:ab` builds the set again before each run, without `--clean`. Its set then has no clean cases.

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

- `--repeat N`: run each side N times (1 to 10). Default: 1.
- `--candidate-variants a,b`: the variants that the candidate adds. Default: `order,rules2`. An empty value adds none.
- `--candidate-modules a,b`: the modules that the candidate adds to the shipped modules. Default: `failures`. An empty value adds none.
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

## Reuse a baseline

A new candidate does not need a new baseline run. Give the folder of an earlier run, and only the candidate runs:

```
bun run eval:ab -- --baseline eval-results/ab-<stamp>-<commit> --candidate-variants order,rules2
```

- The command reads the baseline results from `review-baseline/` and `rereview-baseline/` of that folder.
- A mode without its folder runs the baseline as usual. The output says so in one line.
- The command refuses the reuse with exit code 2 when the stored baseline has a different set fingerprint, effort, profile version, profile revision, prompt version, model, or repeat count. The check runs before any run.
- Give the same `--effort` and `--repeat` as the earlier run. A new commit or CLI version is allowed. The A and B header lines show both.
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

## Bisect when the result is mixed

Run the command again with one change at a time: `--candidate-variants order --candidate-modules ""`, then `--candidate-variants rules2 --candidate-modules ""`, then `--candidate-variants "" --candidate-modules failures`. Each run builds the same set again, so the tables compare.
