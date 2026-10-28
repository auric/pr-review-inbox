# Local eval set

The local eval set measures the review against your own decisions (docs/plans/review-v3.md WP-V1, WP-V3). It holds company code and your comments. Keep it out of git. Only aggregate numbers go to docs/eval/results.md.

## Run the gate (U-V1)

1. Close the app.
2. Run `bun run eval:ab`.
3. Send the printed tables.

The command builds the local set from the data folder of the app into `eval-local/`. Then it runs the shipped profile (A) and the candidate (B) on the set with your Claude CLI. It prints one table for the review cases and one for the re-review cases, with cost and time, and the paths of the result files. It skips a mode without cases. It exits with code 1 when a run fails, and with code 2 on a usage error or an unknown name.

- Review cases: the candidate adds the variants `signal,order` and the `failures` module to the shipped profile. The verify mode stays as shipped.
- Re-review cases: the candidate also adds `rereview-strict`.
- The builder only reads the data folder: a temp copy of the database, and read-only git commands on the cache. It refuses an `--out` folder in the data folder.

## Optional flags

- `--repeat N`: run each side N times (1 to 10). Default: 1.
- `--candidate-variants a,b`: the variants that the candidate adds. Default: `signal,order`. An empty value adds none.
- `--candidate-modules a,b`: the modules that the candidate adds to the shipped modules. Default: `failures`. An empty value adds none.
- `--db <file>` and `--cache <folder>`: another database file and git folder. Default: those of the data folder.
- `--out <folder>`: the folder of the set. Default: `REVIEW_LOOP_EVAL_LOCAL`, else `eval-local/`, which git ignores.
- `--user <slug>`: your user slug. Default: `userSlug` of `config.json` beside the database file.
- `--results <folder>`: the folder of the result files. Default: a new folder in `eval-results/`.

## Bisect when the result is mixed

Run the command again with one change at a time: `--candidate-variants signal --candidate-modules ""`, then `--candidate-variants order --candidate-modules ""`, then `--candidate-variants "" --candidate-modules failures`. Each run builds the same set again, so the tables compare.
