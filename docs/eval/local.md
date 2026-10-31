# Local eval set

The local eval set measures the review against your own decisions (docs/plans/review-v3.md WP-V1, WP-V3). It holds company code and your comments. Keep it out of git. Only aggregate numbers go to docs/eval/results.md.

## Run the gate (U-V1)

1. Close the app.
2. Run `bun run eval:ab`.
3. Send the printed tables.

The command builds the local set from the data folder of the app into `eval-local/`. Then it runs the shipped profile (A) and the candidate (B) on the set with your Claude CLI. It prints one table for the review cases and one for the re-review cases, with cost and time, and the paths of the result files. It skips a mode without cases. It exits with code 1 when a run fails, and with code 2 on a usage error or an unknown name.

- Review cases: the candidate adds the variants `signal,order,rules2` and the `failures` module to the shipped profile. The verify mode stays as shipped.
- `signal`: high-signal finder rules. `order`: a fixed review order. `failures`: a failure checklist.
- `rules2`: a rule-only finding gets severity minor, unless it causes a real bug. The rules section also flags a change that makes the project instructions out of date.
- `rules2` also reads `REVIEW.md` at the repository root of the target branch, as project instructions with the CLAUDE.md caps. Only review and re-review runs read it.
- `rules2` adds generated files, lock files, and vendored third-party code to the do-not-flag list. The verify phase gets four examples of false positives to refute.
- Re-review cases: the candidate also adds `rereview-strict`.
- The output names no case. It shows `case 1`, `case 2`, and so on. The result files keep the case IDs.
- Recall leaves out each must-find item that the volume of the run cannot show: nit items under `balanced`, and nit and minor items under `quiet`.
- The builder only reads the data folder: a temp copy of the database, and read-only git commands on the cache. It refuses an `--out` folder in the data folder.

## Optional flags

- `--repeat N`: run each side N times (1 to 10). Default: 1.
- `--candidate-variants a,b`: the variants that the candidate adds. Default: `signal,order,rules2`. An empty value adds none.
- `--candidate-modules a,b`: the modules that the candidate adds to the shipped modules. Default: `failures`. An empty value adds none.
- `--effort low|medium|high|xhigh|max`: the effort of the baseline and candidate runs. Default: none, so both sides run with the effort of the shipped profile. The eval header shows the effort of each run.
- `--candidate-effort low|medium|high|xhigh|max`: the effort of the candidate runs. Default: none, so the candidate runs with the effort of the baseline. With this flag, the table says that the efforts differ.
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

## Bisect when the result is mixed

Run the command again with one change at a time: `--candidate-variants signal --candidate-modules ""`, then `--candidate-variants order --candidate-modules ""`, then `--candidate-variants rules2 --candidate-modules ""`, then `--candidate-variants "" --candidate-modules failures`. Each run builds the same set again, so the tables compare.
