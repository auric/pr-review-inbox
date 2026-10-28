# Review eval cases

These cases measure how well a review finds real bugs and how much noise it adds. docs/plans/review-v2/spec.md section 4.3 is the spec. The code is in `scripts/eval/`. All code in the cases is synthetic. It holds no real names, hosts, or paths.

## Smoke test

Run this first to check the harness end to end with a cheap model. Its scores do not count:

```
bun run eval -- --real --cases ts-cache-race --repeat 1 --model haiku
```

## Baseline run (gate G-EVAL-0)

Run this once on the current prompts (prompt version 1), before any review v2 prompt change lands:

```
bun run eval -- --real --cases all --repeat 2 --model opus
```

- Profile: the shipped `general` profile of that time, unedited, with `--model opus`. Its effort was unset, so the default effort of your Claude Code settings applied. The harness never reads your own config or profiles.
- Profile version 5 changed the shipped `general` profile (now Review): a new note and prompt, and effort high. `--profile-version 4` restores only that profile. It does not restore the pipeline of this baseline. To run the baseline pipeline again, see "Run the v1 pipeline again" below.
- Later runs must use the same `--model` and `--effort` values, or the numbers do not compare. Without both flags, the result depends on your Claude Code default model, and the harness prints a warning.
- The result file records the requested model and effort (`requested`, or `default` for no flag). Each run records the model that ran (`model`, `models` with the subagent models), its effort (`effort`, `effortDefault`), and its coverage (`coverage`).
- The first baseline file (commit 9391ec4) has no `requested` field. It ran Opus 5.5 at the default effort, high. compare.ts compares such a file by the models and efforts that ran, so a later run with `--model opus` gives no false warning.
- Runs: 12 cases x 2 repeats = 24 review runs, one after the other in the one run slot. `--repeat 1` halves the quota, but the numbers get more noise.
- Time and cost: measured on the first baseline (Opus 5.5, effort high, 150 to 500 changed lines): 0.6 to 0.9 minutes and $0.13 to $0.31 of reported cost per run. 24 runs take about 20 minutes.
- Before the run: `claude` is on PATH (the native `claude.exe` on Windows), and `claude auth status` shows `authMethod` `claude.ai`. The harness checks this and stops on a mismatch.
- Ctrl+C stops after the current case. A second Ctrl+C quits at once and stops the CLI. The result file gets each case as it ends, so a stopped run keeps its finished cases.
- PASS: a result file with all 12 cases. The run prints its path.
- A run with skipped or unavailable coverage ends `incomplete`. Its run line prints those entries, and the result file keeps them.

## Hard set baseline

The v1 set is at its ceiling: the first baseline found all 27 bugs in repeat 1. The hard set in `fixtures/eval/hard/` has bugs that need unchanged code, bugs that look correct, two diffs of about 1100 lines, 3 or 4 traps per case, and two cases with no bug. Run its baseline once, without `--model`, on the v1 pipeline (see "Run the v1 pipeline again" below).

### Run the v1 pipeline again

Since prompt version 2.0 and the new schema fields, the current pipeline differs from the first baseline. `--profile-version 4` restores only the profile, not the prompts of prompt version 1. The git tag `eval-v1-hard` (commit 8ccaa27) holds the pipeline before those changes, with the hard set and the scoring fixes. Run the baseline from that tag in a separate worktree:

```
git worktree add ..\review-loop-eval-v1 eval-v1-hard
cd ..\review-loop-eval-v1
bun install
bun run eval -- --real --set hard --repeat 2
```

- Copy the result file from `eval-results/` of that worktree into `eval-results/` of this repository. Then compare it with a later run with `bun run eval:compare`.
- That tag ran the shipped `general` profile of profile version 4: name General, the version 4 prompt, no effort, and the default reviewer. The first baseline (commit 9391ec4) ran this profile, revision `3a4df472`.
- The run prints the model and the effort that it uses. With that profile both come from your Claude Code settings. The first baseline ran Opus 5.5 at the default effort, high.

### Compare profile changes

`--profile-version N` runs the shipped values of an earlier profile on the current pipeline. Use it to measure a profile change alone: run the same command with and without `--profile-version 4`, then compare the two files with `bun run eval:compare`. compare warns that the profiles differ. That is expected: the profile is the change that you measure.

### Hard set notes

- Runs: 9 cases x 2 repeats = 18 review runs. `--cases all` without `--set` still means the 12 v1 cases, so the v1 baseline stays comparable.
- Time and cost: an estimate from the v1 baseline, not measured. The 7 cases of 150 to 290 lines take about 0.6 to 0.9 minutes and $0.15 to $0.31 each. The 2 cases of about 1100 lines take about 1.5 to 3 minutes and $0.40 to $0.80 each. One repeat takes about 7 to 12 minutes and $2 to $4; two repeats take about 15 to 25 minutes and $4 to $8 of reported cost.
- Compare a later run with `bun run eval:compare <baseline>.json <new>.json`. If the case files changed after the baseline, re-score it first (see below).

## Re-score a result file

`bun run eval:rescore <result.json> [--tolerance N] [--out <file>]` scores the runs of a result file again with the bugs, traps, and extras of the current case files. It needs no CLI and no network.

- It prints the suite numbers with the stored and the current bugs and traps, and the delta. `--out` writes the re-scored result file, which `eval:compare` reads. It never changes the input file.
- It finds each case by its ID in all sets. A case with no fixture keeps its stored bugs and traps. A case of the local set always keeps them.
- It builds each case repository again and warns when the head commit differs from the file: the runs then reviewed other code.
- `--tolerance N` scores with the near-line tolerance N and records it in the output file (docs/eval/local.md).

Re-score a baseline after you add `alt` places or `extras`, then compare it with a later run:

```
bun run eval:rescore eval-results/<baseline>.json --out eval-results/<baseline>-rescored.json
bun run eval:compare eval-results/<baseline>-rescored.json eval-results/<new>.json
```

Each run uses the review pipeline of the app: a sanitized snapshot of a temp git repository, the auth route check, the scrubbed env, and no `--bare`. The harness serves the repository through the `gitRemote` option and keeps its data in a temp folder with memory secrets. No run reaches Bitbucket or your data folder.

## Compare a later run

Run the same command on the new head, then compare the two files:

```
bun run eval:compare eval-results/<baseline>.json eval-results/<new>.json
```

It prints one table per metric with the delta, for all cases and for each case. It warns when a case changed between the two files; the numbers of such a case do not compare. It also warns when the two files used different models, efforts, or verify modes, or profiles with different revisions. The revision hashes each profile field that changes the run, so a file without a profile version still compares by its revision. It refuses two files with different set fingerprints or tolerances, with exit code 2. A file without these fields reads as no fingerprint and tolerance 0.

## Options

- `--real`: run the `claude` CLI on PATH. Without `--real` or `--runner`, the harness prints the plan and exits with code 2.
- `--set v1`, `--set hard`, or `--set local`: the case set, `fixtures/eval/cases/`, `fixtures/eval/hard/`, or the local set from your own decisions in `REVIEW_LOOP_EVAL_LOCAL` (docs/eval/local.md). Default: v1.
- `--cases all` or `--cases id,id`: the cases of the set to run. Default: all.
- `--profile <id>`: a shipped review profile. Default: `general`.
- `--profile-version N`: run the shipped values of the profile at profile version N, 1 to the current version (6). The result file records it as `profileVersion`. Default: no flag, so the current shipped profile runs. The flag changes only the profile. The prompts and the schema stay those of the current pipeline.
- `--modules a,b` and `--volume quiet|balanced|thorough`: profile fields of prompt version 2. Prompt version 1 refuses them. `--modules` also takes the trial module `failures` (docs/plans/review-v3.md WP-V2), which the app UI does not offer. An unknown module name exits with code 2. An empty value runs no check section.
- `--variants a,b`: the prompt variants of docs/plans/review-v3.md WP-V2, for this eval only: `order`, `rereview-strict`, and `signal`. An unknown name exits with code 2. The result file records the variants in `promptVersion`, sorted, such as `2.3+order+signal`. Default: the variants of the profile (none).
- The run prints `Model:` and `Effort:`: the value of the profile after `--model` and `--effort`, else the default of your Claude Code settings.
- `--model <name>`: the model of the runs, for this eval only. A model alias such as `haiku`, `sonnet`, or `opus`, or a full model ID such as `claude-opus-5-5`. Default: the model of the profile, else your Claude Code default.
- `--effort low|medium|high|xhigh|max`: the effort of the runs, for this eval only. Default: the effort of the profile (high for the current Review profile), else your Claude Code default.
- `--verifier on|off`: the verify mode of the profile, for this eval only. `off` runs the finder only. The result file records the mode as `requested.verifier`, and the run prints it. `eval:compare` warns when two files used different modes. Default: the mode of the profile (on).
- `--repeat N`: runs of each case, 1 to 10. Default: 1.
- `--out <folder>`: the folder for the result file. Default: `eval-results/` in the repository, which git ignores.
- `--keep`: keep the temp folders of each case for a look at the run.
- `--runner <command> <args...>`: run another CLI, such as the fake CLI of the tests. It must come last. Give absolute paths, because the CLI starts in the run folder. On Windows the command must end in `.exe`. Example: `--runner C:/path/to/bun.exe D:/path/to/tests/support/fake-claude.ts D:/path/to/scenario.json`.

## Metrics

- An item matches a bug or a trap when the path and the side are the same and the line ranges overlap, both ends included. An item on an `alt` place matches too.
- The result file records the tolerance T as `tolerance`: 0 for sets v1 and hard, 3 for the local set. T widens each bug, human comment, and extra range by T lines on each end. A trap always uses 0.
- human recall: local set only. Your own inline comments with a shown match, over all of them.
- Shown items: the main list of the run. Prompt version 1 has no verify phase, so it shows each finding. Version 2 uses the volume rules of spec.md section 1.4.
- recall: bugs with a shown match, over all bugs.
- precision: shown items that match a bug or one of your own comments, over shown items.
- trap rate: shown items on a trap that match no bug, over all traps.
- noise: shown items that match no bug and no trap, per case.
- false positives: shown items that match no bug, trap hits included, per case. For a case with no bug, it is the number of shown items.
- extras matched: shown items on an `extras` place that match no bug, per case. Such an item counts for no other metric: not for precision, noise, false positives, or the trap rate.
- severity ok: found bugs whose best shown match has at least the minimum severity, over found bugs.
- candidate recall: bugs that any item matched, refuted and duplicate items included. It shows what a verify phase lost.
- Since prompt version 2.1, each review runs a finder process and then a check process. A finding that the check refutes or marks duplicate leaves the shown items, so recall drops, but candidate recall still counts it. The result file records the verdict counts as `verify` and the time and usage of each phase as `phases`. The cost is the sum of both phases.
- Since prompt version 2.2, the finder and the check also read `./context/pr-context.md`, and their agents get the PR context rules (spec.md section 2.10).
- Since prompt version 2.3, a gap of the check phase goes to `notChecked` and does not make the run incomplete. The Build section of `pr-context.md` stays out of coverage. A rule finding that quotes a rule of another scope stays as a core finding.
- Each number is the mean over the repeats, with the min and the max.

## v1 cases

| Case | Seeds |
|---|---|
| `ts-cache-race` | A race: a missed lookup caches a row after an update deleted the key. An off-by-one in the cache size limit. Traps: a caught fire-and-forget refresh with a guard, and staleness that the PR text names. |
| `ts-orders-search` | SQL injection through the sort direction. A missed caller: the daily report still passes page numbers to `listOrders`, which now takes an offset. Traps: status values that an allowlist guards, and an API change that the PR text names. |
| `ts-upload-audit` | A temp file leak on the early 415 return. A task requirement that the code misses: no audit event. Traps: short names (style only), and a Content-Length check that the stream limit backs. |
| `ts-settings-api` | About 500 changed lines, for timing. A renamed field in the `/v1` response. A rule of the scoped `src/api/CLAUDE.md` broken: a body read by hand. An unchecked error: a missing overrides file. Traps: the removal of `/v0` that the PR text names, and a route parameter that the route pattern guards. |
| `cpp-job-queue` | Two races: a wait without a predicate loop, and a stop flag read without the mutex. Traps: a helper whose contract says the caller holds the lock, and dropped jobs that the PR text names. |
| `cpp-packet-parser` | An off-by-one: a 32-byte label writes its NUL past the field. An unchecked error: the checksum read. Traps: a subtraction that an earlier size check guards, and noisy casts (style only). |
| `cpp-log-rotate` | A `FILE*` leak on an early return. A missed caller: `main()` still expects `openLog` to throw, but it now returns null. Traps: 5 archives instead of 10, as the PR text says, and a lint suppression with a reason. |
| `cpp-engine-abi` | A struct field inserted in the middle of a public C ABI struct. A rule of the scoped `include/CLAUDE.md` broken: an exception leaves a C ABI function. A task requirement that the code misses: the version query needs an engine. Trap: a worker limit that the PR text names. |
| `py-report-sql` | SQL injection through the region. An unchecked error: the exit code of `wkhtmltopdf`. Traps: an `int()`-guarded limit, and rounding to whole euros that the PR text names. |
| `py-downloader-race` | A race: a counter updated outside the lock, so `run()` can wait forever. A response leak on an early return. Traps: a helper whose contract says the caller holds the lock, and a content type filter that the PR text names. |
| `py-pager-client` | An off-by-one in the retry loop, so the last failure never raises. A missed caller: the sync job still starts at page 1 after pages moved to count from 0. Traps: fewer retries, as the PR text says, and one-letter names (style only). |
| `py-export-rules` | A rule of the scoped `app/handlers/CLAUDE.md` broken: the handler reads `os.environ`. A task requirement that the code misses: soft-deleted accounts are exported. A CLI flag renamed with no alias, so the nightly script fails. Trap: new columns that the task names. |

## Hard cases

Each line names what the case seeds and why a strong reviewer can miss it. Each bug was proven on the built repository: a C++ bug under AddressSanitizer, ThreadSanitizer, or a demo program; a Python or TypeScript bug by a test or a demo run. All fixture tests pass on base and head.

| Case | Lines | Seeds | Why it is hard |
|---|---|---|---|
| `ts-payment-retry` | 287 | A retry that sends a new idempotency key per attempt, so a timed-out charge is charged again. A declined charge marked paid, because `charge()` resolves a decline and only `authorize()` throws `CardDeclined`. Traps: check-then-claim, an uncapped backoff, a floating audit promise. | Both bugs follow only from the contract in the unchanged `gateway.ts`. The fake gateway of the tests throws `CardDeclined`, so the tests pass. |
| `ts-session-split` | 1081 | A module split where `nextExpiry()` changes from `Math.min` to `Math.max`: no idle timeout and no absolute lifetime. The moved absolute-lifetime test loses its call parentheses (`toBeNull`) and can never fail. Traps: an unchecked token split, `timingSafeEqual` lengths, an unbounded session map. | One token in 1081 moved lines, between the mechanical renames of the store maps, under a PR text that says "no behavior change". The broken test keeps CI green. |
| `ts-webhook-verify` | 176 | No bug. Traps: `timingSafeEqual` lengths, seconds against milliseconds, an unguarded `JSON.parse`, a has-then-add race. | Each trap looks like a classic bug, and the unchanged header parser, error wrapper, and event store guard it. It scores false positives. |
| `cpp-record-reader` | 179 | A borrowed `Registry::find()` pointer used after `add()`, which can move every entry (heap use after free). An overflow guard `recordBytes < count` for a multiplication. Traps: `stoul`, a null `FILE*`, a memcpy without byte swap. | The pointer rule is in the unchanged `registry.h`; the test has room for one more entry, so it passes. The guard is the right idiom for an addition, and the test uses a count that it catches. |
| `cpp-sink-flush` | 153 | `push()` calls the registry while it holds the sink mutex, against the lock order that the unchanged `registry.h` states (deadlock with `remove()`). `flush()` waits for an empty queue, but the worker pops a batch before it writes it. Traps: `pop_front()` on a full queue, an oversized record, JSON escaping. | Each bug needs a second file or the unchanged worker loop. `flush()` uses a correct-looking predicate loop. |
| `cpp-buffer-split` | 1105 | A file split and a namespace rename where `Buffer::view()` checks `capacity_ - offset` instead of `size_ - offset`: pooled buffers leak the bytes of other clients. Traps: a power-of-two mask, an unchecked `commit()`, a span that `consume()` invalidates. | One token in 1105 moved lines. The test helper sizes each buffer exactly, so no test can see it. |
| `py-archive-import` | 163 | A TOCTOU between `exists()` and `os.rename()` with 4 parallel workers, so a second batch replaces the audit copy. `read_header()` returns `None` for an empty upload, which the importer dereferences. A lock timeout in milliseconds used as seconds (8.3 hours). Traps: a path from the file, an f-string table name, an unbounded read. | Each bug needs the unchanged scheduler, settings, upload API, or header reader. The test sets the timeout to 0.2 and hides the unit. |
| `py-price-cache` | 151 | A cache that drops entries only on `price.changed`, while the unchanged bulk import publishes `catalog.reloaded`, and there is no TTL. A test that uses `assertTrue(x, expected)`, which can never fail and hides the stale price. Traps: a dict without a lock, an unbounded `IN` list, shared cached objects. | The event contract is in the unchanged `events.py` and `importer.py`. The broken test claims to cover the supplier feed. |
| `py-heartbeat` | 161 | No bug. Traps: a cross-thread read of `job_id`, a swallowed heartbeat error, a queue shared across threads, a first heartbeat one interval late. | Each trap looks like a classic concurrency bug, and the unchanged `JobState`, supervisor, `Pool`, and `claim()` guard it. It scores false positives. |

## Case format

Each case folder holds:

- `case.json`: the PR title and text, the optional task text (it becomes `context/task.md`), the optional project rules text (it becomes the extra instructions of the repository), the bugs, and the traps. Each bug and trap names a path, a side, and a line range on that side. `scripts/eval/cases.ts` has the schema.
- `alt` (optional, on a bug or a trap): more places of the same bug or trap, each with a path, a side, and a line range. An item on any place matches. Add one only where a fix can go too: a declaration and its definition, a caller and its changed callee, or a field that must become atomic. Each alt range must hold text, like the main range.
- `extras` (optional): real issues of the change that are no seeded bug, each with a path, a side, a line range, and a note. A shown item on an extra counts only for `extras matched`. Add one only for an issue that you checked in the fixture source. Each extra range must hold text.
- `base/`: the files of the base commit, which is also the target branch. A `CLAUDE.md`, `CLAUDE.local.md`, or `AGENTS.md` file is stored with the suffix `.fixture`, so Claude Code sessions in this repository never load it as instructions. The harness writes it under its real name into the temp repository. The loader refuses such a file without the suffix.
- `head.patch`: a unified diff that `git apply` applies to `base/`. Make it with `git diff --no-renames` in a scratch repository. The app diffs with `git diff -M`, so check that a moved file does not pair as a rename (`git diff -M --summary`) when a case needs the whole move in view.

To add a v1 case, keep 150 to 500 changed lines, 1 to 3 bugs, and 1 or 2 traps. A hard case has 150 to 1500 changed lines, 0 to 3 bugs, and 3 or 4 traps. Case IDs are unique over both sets. Then run `bun test tests/eval`. It applies each patch, checks the changed-line count and the limits of the set, and checks that each bug, trap, and alt range holds text on its side.

## Reply cases

`bun run eval -- --replies --real --repeat 2` runs one reply run per case of `fixtures/eval/replies/` (docs/plans/review-v2/spec.md section 2.13). Each case gets a temp repository, a temp database, and the stored threads of its `case.json`. The run drafts replies for the threads of `run`. The score checks the judgement, the action, and the cites of each reply against `expect` only. Nothing posts, and no run reads Bitbucket. `--cases`, `--profile`, `--model`, `--effort`, `--repeat`, `--out`, `--keep`, and `--runner` work as above. Without `--real` or `--runner`, it prints the plan and exits with code 2. The result file ends in `-replies.json`.

| Case | Seeds |
|---|---|
| `general-decision` | Inline thread 101 asks for a retry in the client. The newer general thread 230 agrees that the callers retry and the client must not. Pass: thread 101 gets judgement invalid, action reply, and cites 230. |
| `general-decision-control` | The same code and thread 101 without thread 230. Pass: judgement valid or partly. The pair shows that the decision in the other thread changed the reply. |

A reply case folder holds `case.json` (`scripts/eval/replies.ts` has the schema), `base/`, and `head.patch` as above. The user is the PR author.
