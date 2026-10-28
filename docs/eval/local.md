# Local eval set

The local eval set measures the review against your own decisions (docs/plans/review-v3.md WP-V1). It holds company code and your comments. Keep it out of git. Only aggregate numbers go to docs/eval/results.md.

## What goes into the set

- One case for each reviewed pull request head. A case comes from the completed and incomplete review runs at one head and one merge base. Two runs on one head make one case.
- Must find (bugs): the findings that you posted, at their anchor, with the posted severity.
- Must find (human): your own root inline comments at a reviewed head. They score apart as human recall. A comment that the app posted is not one of them.
- Must not raise (traps): the findings that you discarded as Not a bug or Intended.
- Neutral (extras): the findings that you discarded as Not worth fixing, Duplicate, or Wrong place, or without a reason. A shown finding on an extra counts for no metric but extras.
- Left out: the findings that the check refuted and you did not restore, the findings that a fix commit, a re-review, or a session closed, and the findings without a decision.
- A carried finding of a re-review takes the decision on its newest copy.
- A must-find item and a must-not-raise item on overlapping lines of one case both go out of the set.
- Your comment counts at the head that its anchor names (toHash). A comment on a removed line also needs the merge base of the case (fromHash).
- A case holds the PR title, the PR description, and the task rows of the PR. It holds no PR comments, because they show the answers. Attachment files stay out. task.md lists them without their files.

## Build the set (gate U-V1)

1. Close the app.
2. Copy the data folder to a new folder, for example `D:\eval-copy`. The data folder is `REVIEW_LOOP_DATA_DIR` when you set it. Else it is `%LOCALAPPDATA%\review-loop` on Windows and `~/.local/share/review-loop` on Linux.
3. Find the database file in the copy. Its name is `db-<hash>.sqlite`.
4. Run the builder:

```
bun run eval:local -- --db D:\eval-copy\db-<hash>.sqlite --cache D:\eval-copy\git --out D:\eval-local
```

5. Read the counts. `MANIFEST.json` in the out folder holds the same counts and the fingerprint of the set.

Builder rules:

- The builder refuses a path in the live data folder. The default data folder stays live when `REVIEW_LOOP_DATA_DIR` names another folder.
- The builder reads a temp copy of the database. It writes nothing to your copies.
- `--out`: the folder of the set. Default: `REVIEW_LOOP_EVAL_LOCAL`, else `eval-local/` in the repository, which git ignores. The builder refuses a folder in the repository that git does not ignore, and a folder with other files. A new build replaces `cases/`, `bundles/`, and `MANIFEST.json`.
- `--user <slug>`: your user slug. Default: `userSlug` of `config.json` beside the database file.
- The builder prints counts only: no path, host, or name.
- A case whose commits are not in the cache copy goes out of the set. The count shows it.
- The builder uses every review run in the copy. The recommended minimum is 30 cases, 40 posted findings, and 20 must-not-raise findings (review-v3.md Q3). The builder says when the set is smaller. Then review more pull requests with the app and build the set again.

## Run the baseline (gate U-V1)

Point `REVIEW_LOOP_EVAL_LOCAL` at the out folder. In PowerShell:

```
$env:REVIEW_LOOP_EVAL_LOCAL = "D:\eval-local"
bun run eval -- --real --set local --repeat 2
bun run eval -- --real --set v1
bun run eval -- --real --set hard
```

- Run the three commands on one commit with the current shipped profile.
- The spread between the two repeats of the local run sets the minimum gain of review-v3.md section 0.
- Set v1 and set hard give the guard baseline. Prompt version 2.3 differs from the G-EVAL-1 files (2.2).
- Each local case unpacks its bundle into a temp folder. A big repository needs disk space and time for each case.

## Run the variant matrix (gate U-V2)

Each row of review-v3.md section 5 runs the local set twice and each guard set once, on one commit. Use the `--model` and `--effort` flags of the U-V1 baseline, or none when the baseline had none. In PowerShell:

```
$env:REVIEW_LOOP_EVAL_LOCAL = "D:\eval-local"

# A: the verify phase off
bun run eval -- --real --set local --repeat 2 --verifier off
bun run eval -- --real --set v1 --verifier off
bun run eval -- --real --set hard --verifier off

# B: high signal, one pass
bun run eval -- --real --set local --repeat 2 --variants signal --verifier off
bun run eval -- --real --set v1 --variants signal --verifier off
bun run eval -- --real --set hard --variants signal --verifier off

# C: high signal with the verify phase
bun run eval -- --real --set local --repeat 2 --variants signal --verifier on
bun run eval -- --real --set v1 --variants signal --verifier on
bun run eval -- --real --set hard --variants signal --verifier on

# D: the failure checklist on top of the shipped checks
bun run eval -- --real --set local --repeat 2 --modules security,concurrency,api,rules,intent,failures
bun run eval -- --real --set v1 --modules security,concurrency,api,rules,intent,failures
bun run eval -- --real --set hard --modules security,concurrency,api,rules,intent,failures

# E: the ordered process
bun run eval -- --real --set local --repeat 2 --variants order
bun run eval -- --real --set v1 --variants order
bun run eval -- --real --set hard --variants order
```

- F (strict re-review) needs the `--rereview` mode of WP-V3: `bun run eval -- --real --set local --repeat 2 --rereview --variants rereview-strict`. Without `--rereview`, the variant changes no prompt.
- G: put the winning flags of A to E into one command, for example `--variants order,signal --verifier off`. Run it as the rows above.
- Compare each file with the U-V1 baseline of the same set: `bun run eval:compare eval-results/<baseline>.json eval-results/<variant>.json`.
- compare warns that the profiles or the verify modes differ. That is expected: the switch is the change that you measure.
- The result file records the variants in `promptVersion`, such as `2.3+order+signal`. The `--modules` value shows in `profile.modules`.
- Only the aggregate numbers go to docs/eval/results.md. Keep the result files out of git.

## Score

- A shown finding hits a bug or your comment when it is on the same path and side, and its lines overlap the range widened by T lines on each end. A local run records T = 3 in the result file as `tolerance`.
- An extra uses the same T. A trap uses T = 0: only overlapping lines count.
- human recall: your comments with a shown hit, over all your comments. A hit on your comment also counts for precision.
- The result file records `fingerprint`: the hash of the case files that ran. `eval:compare` refuses two results with different fingerprints or tolerances. A run with `--cases` has its own fingerprint.
- Re-score a result with T = 0 and T = 10:

```
bun run eval:rescore eval-results/<file>.json --tolerance 0 --out eval-results/<file>-t0.json
bun run eval:rescore eval-results/<file>.json --tolerance 10 --out eval-results/<file>-t10.json
```

## Layout of the out folder

- `cases/<id>/case.json`: one case. The ID is `pr<local PR row>-<head>-<merge base>`, with short hashes.
- `bundles/<hash>.bundle`: one git bundle per repository with the base and head commits of its cases. The name hides the project and the repository.
- `MANIFEST.json`: the counts, the left-out counts, and the fingerprint.
