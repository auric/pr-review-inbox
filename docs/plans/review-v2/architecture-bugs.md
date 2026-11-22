# Architecture bugs: find and measure

Status: design of 2026-11-21. WP-AR0 (docs) is done. WP-AR1 is built as the opt-in variant "architecture". WP-SG0, WP-SG1, and WP-SG2 of seeded-truth.md are built with the ninth kind. User requirement of 2026-11-21: "we should also be able to find the architecture bugs". The user decided questions 1 to 4 of section 10 on 2026-11-21. Packages: WP-AR0 (docs), WP-AR1 (variant "architecture"), and deltas to WP-SG0, WP-SG1, and WP-SG2 of seeded-truth.md.

Sources: seeded-truth.md, review-quality-2026.md (items 6, 7, 11), review-v3.md (V2, D2, WP-V8, WP-V12), src/server/review/catalog.ts, src/shared/review.ts, scripts/eval/run.ts, ab.ts, and score.ts. The lenses3 text lives in the recall plan outside the repository. This file names no app, company, host, project, case ID, or PR number.

## 0. Short answer

- No part of the review or the eval targets architecture bugs today. Some kinds and checks overlap in part (section 1).
- An architecture bug leaves the route that the repository uses for the same operation. It so skips a step that the route does.
- Two tiers. Tier 1 gives a wrong result for a concrete input. Tier 2 breaks a convention with no wrong result today. This design covers tier 1 only (question 1, decided).
- The example "a contract change that one module honors and another does not" stays in the kinds contract and omission. Its proof is a dependent, not a precedent.
- Seeds: a ninth kind "architecture", about 6 to 7 of the 60 seeds, floor 4. Four sub-kinds are seedable with one small edit.
- Power: the whole-set MDE does not change. The architecture row is descriptive only. A lever on architecture seeds alone cannot pass the seeded ship rule.
- Finding: a new opt-in variant "architecture". It ships only inside a wider lever: L2 of "lenses3", or the stacked candidate "callers,architecture".
- The do-not-flag item "a choice between two correct designs" stays. A way that skips a needed step is not a correct design.

## 1. What exists today

| Place | What it covers | Gap |
|---|---|---|
| seeded-truth.md:32, :60-69 | Eight kinds. contract (:63) and omission (:64) cover a broken dependent. lifetime (:62) and leak (:67) cover ownership. | No kind needs a precedent in the repository. |
| src/shared/review.ts:285-290 | Bug classes security, concurrency, resource, behavior. | Classes name the effect, not the cause. |
| catalog.ts:93-97 (REVIEW_LENS) | Effects on callers outside the diff. :95 a caller with the same bug as a fixed one. | Dependents only. |
| catalog.ts:609 | Finder categories, the same four classes. | No cause class. |
| catalog.ts:132 | Shipped modules: security, concurrency, api, rules, intent. | simplify and performance are not shipped. |
| catalog.ts:727-733 (api) | Users of a changed public interface. | A dependent, not a precedent. |
| catalog.ts:746-753 (rules), validate.ts:250-315 | A break of a written rule, with a quote that the app checks. | Most conventions are not written. |
| catalog.ts:160-165, :742-745 (simplify) | "Does the repository have it?", category reuse, minor. | A cut, not a bug. Not shipped. |
| catalog.ts:714 (performance) | Blocking calls on an async path or a UI thread. | Not shipped. Cost, no wrong result. |
| catalog.ts:658-664 (variant "callers") | Callers and consumers of each changed symbol. | Who uses the change, not who does the same thing. |
| catalog.ts:1456-1457 (obligations) | A test or guard that the repository keeps for the same kind of interface. | Tests and guards only. :1462 excludes design choices. |
| catalog.ts:622 | Do-not-flag: "a choice between two correct designs". | Correct. It stays. |
| review-quality-2026.md:258-269 (classes) | The kinds that authors fix most. | No architecture item. |
| review-v3.md:230-237 (WP-V8), :278-283 (WP-V12) | Checks per repository; a blind design sketch. | WP-V8 not built. WP-V12 superseded. |
| lenses3 | seeded-truth.md:60-69 maps kinds to L1, L2, L3. | Text outside the repository (unverified). |

## 2. Definition

### 2.1 Three checks

A finding or a seed is an architecture bug when all three checks hold. Each check reads repository code only.

- A1 Route. At BASE, a route does the operation: a helper, a wrapper, a layer, a registry, or one owner of the state. At least two places outside the diff use it.
- A2 Deviation. A changed line does the same operation without the route. Or a new peer leaves out a route call that the peers at BASE make. Peers are handlers, routes, providers, commands, or migrations.
- A3 Hidden step. The route does a step that the changed line does not show. A concrete input, sequence, platform, or configuration reaches that step. The changed code then gives a wrong result, and the route gives the right one.

Not an architecture bug:

- A3 fails: both ways give the same result for each reachable input. This is "a choice between two correct designs" (catalog.ts:622).
- A1 fails: fewer than two uses. No convention exists.
- The step shows at the changed line, such as a lock or a release. That is a lifetime, concurrency, leak, or error bug.
- The proof is a dependent of the change. That is a contract or omission bug.
- Tier 2: dependency direction, a cycle, a wrong folder, a missing abstraction, or growth with no trigger. The finder and the verifier drop it (catalog.ts:619, :622, :1511).

### 2.2 Sub-kinds

| Sub-kind | Example | Seedable with one edit | Why not, when not |
|---|---|---|---|
| bypass: a lower layer replaces the route call | a layer or boundary that the repository uses elsewhere | Yes, when the lower name is in scope: imported, a member in scope, or a global. | A new import is a second block far from the PR lines (check 3). |
| duplicate: an inline copy replaces the route call and misses one case | logic copied instead of the helper | Yes, 2 to 6 lines. | A copy with no lost case has no wrong result (validator). |
| shadow state: a read of a copy replaces a read of the owner | a second source of truth | Only when a copy is already in scope near the PR lines. | A new field and its writers: more than 8 lines (check 2) or more than one path (schema, seeded-truth.md:139). |
| peer step: a new peer leaves out a route call that every peer makes | - | Yes, when the PR adds a peer. 1 to 2 lines. | - |
| execution model: a sync or other-thread form replaces the route | a sync call on an async path | Only with a wrong result, such as a reorder or a thread-only API. | Latency alone is not severity high (seeded-truth.md:188). |
| cross-module contract | a contract that one module honors and another does not | Seeded as contract or omission. | - |
| ownership across modules | wrong owner or lifetime | Seeded as lifetime or leak, or as bypass when the release is inside the route. | - |
| structure (tier 2) | - | No. | No wrong result (validator). |

### 2.3 Kind order

A seed takes the first kind in this list whose test holds. The test is the code that a reviewer must read to see the defect.

1. contract: a caller or consumer outside the seed lines.
2. omission: a companion edit of the PR that the seed reverts.
3. architecture: the route body and its uses at BASE (A1 to A3).
4. lifetime, concurrency, leak, error, entry: by their definitions (seeded-truth.md:62-68).
5. local: the function alone.

Since 2026-11-22, the kind security comes before contract (seeded-truth.md section 4.5). A dropped sanitize or auth call is security, not architecture.

## 3. Seeds and scoring

### 3.1 Kind row (seeded-truth.md section 4.1)

| Kind | Definition | Abstract edit patterns | Anchor and alt | Lens |
|---|---|---|---|---|
| architecture | The change does an operation without the route that the repository uses for it, and skips a step inside the route. The route is a helper, wrapper, layer, registry, or owner of state that at least two places use at BASE. A concrete input reaches the skipped step. | A lower-layer call in scope replaces the route call. An inline copy replaces the call and misses one case. A read of a copy in scope replaces a read of the owner. A new peer leaves out a route call that the peers make. | The changed line that leaves the route. | L2 |

### 3.2 Count and power

- No quota. The build balance (seeded-truth.md:82) gives about 6 to 7 of 60. The floor is 4.
- The total stays 60, so the MDE of seeded-truth.md section 4.3 does not change.
- The per-kind floor sum goes from 32 to 36 seeds: MDE 18.6 points, power 16%, 38%, and 64% at +5, +10, and +15 points. The model is that of section 4.3: R_A 3, R_B 2, rho 0.1.
- The architecture row is descriptive only. At 7 seeds, its own paired MDE is about 41 points.
- 7 of 60 seeds move the whole-set paired delta by 11.7 points at most. The MDE is 14.8 to 16.5 points. So a lever on architecture seeds alone cannot pass "better" (seeded-truth.md section 6.5).
- The floor of 4 serves the per-kind table, not power (seeded-truth.md:107). Since seeded-truth.md section 14 row 13, the floor blocks no kind. For the architecture kind, the floor never blocked the build. If the kind stays under 4 after one targeted re-propose round, the build goes on. It prints "kind architecture: under floor". The requirement is then not measured, and the orchestrator tells the user.

### 3.3 Seeder (seeded-truth.md section 5.1)

- Schema: each seed gets `route`, a string. It is empty for every kind except architecture.
- kinds.md holds the section 4.1 text with the architecture row and the kind order of section 2.3.
- New lines after "Prefer edits that a careful author could make by mistake: ...":

```
For an architecture defect, find a route that the change uses: a helper, wrapper, layer, or owner of state.
At least two files outside the change must call the route at BASE.
Make the change leave the route at one place, so that it skips a step inside the route.
Give the route name in route. Leave route empty for every other kind.
In why, name the skipped step and two places that call the route, with path:line.
```

- WP-SG3 replaced the line "Leave no unused import or name behind." with a general line before these: "Leave no name unused or dangling. No function, variable, import, field, or parameter may lose its last use, and each new name needs a use." seeded-truth.md section 5.1 holds the current prompt.

### 3.4 Mechanical check 10 (seeded-truth.md section 5.2)

10. Kind architecture only. `route` is one identifier. `find` holds it as a whole word, and `replace` does not. `git grep -w -F -l <route> <base>` lists at least 3 files besides the seed path.

- Reason: one file can define the route, and two files use it (A1). The check reads the merge base only, so the seed cannot change the count.
- It is a necessary condition. A common name passes it. The validator and the user sample judge the rest.
- A validator proof cannot carry this check. A proof is a failure path (seeded-truth.md:195), so a contract or lifetime seed also has proof lines outside the diff.

### 3.5 Validator (seeded-truth.md section 5.4)

One line that applies to every kind, after "First try to show that the new code still works ...":

```
When the old lines call code that the new lines leave out, read that code to its end.
```

WP-SG3 added `kindOk` to the keep conditions, and `./context/kind.md` with the claimed kind, the kind table, and the kind order (seeded-truth.md section 5.4 and section 14 row 20). A seed of kind architecture that fits an earlier kind of the kind order is refuted.

### 3.6 Human sample (seeded-truth.md section 5.5)

The user decided that the hand review covers less than 25% of the seeds. The old rule, max(2, ceil(25%)) per kind, gives 16 to 20 of 60, and 18 or more with 9 kinds.

- Draw 1 confirmed seed per kind (10 seeds since the security kind, seeded-truth.md section 4.5). Then draw 1 more from each of the four kinds with the most confirmed seeds (five with 9 kinds). Ties go by the kind order of seeded-truth.md section 4.1. That gives 14 seeds, 23% of 60, about 1 h.
- The draw keeps the build caps: at most 3 seeds per host (a twin group counts as one) and 1 per file (seeded-truth.md section 14 row 18).
- The draw reads no eval result. It uses mulberry32 with seed 2026.
- The user checks a fourth point: the kind fits the kind order.
- Release: a settled kind with 0 drops releases its unsampled confirmed seeds to kept. A kind with 1 or more drops escalates to full review. More than 20% drops in the whole sample escalates every kind.
- An escalation needs the user's OK at that time (question 3, decided). Without it, the unsampled confirmed seeds of that kind stay confirmed, and the build leaves them out. The set can then fall under 48 seeds.

### 3.7 Scoring

- The seeded case.json needs no new rule. Kind architecture gets module `core` and no category by the rules of seeded-truth.md section 6.1. Its class row is "other" (score.ts:694-699, review.ts:292-297).
- The WP-SG0 row `kind architecture` is the measurement. compare.ts prints it for A and B. It is descriptive only.
- Matching: the anchor line with T = 3, and the LLM matcher on the seed comment. "One fix would fix both" matches a finding about the effect to a seed about the route.
- The natural set gives no architecture number. No label exists, and the judge category list has none (review-quality-2026.md:101).

## 4. Finding: variant "architecture"

### 4.1 Finder lines

`ARCHITECTURE_LINES` in catalog.ts. rl-main and rl-reviewer get them after `CALLERS_LINES` (catalog.ts:938, :1372). The salvage run does not.

```
For each new call, state, or handler in the change, find how the repository does the same thing elsewhere.
Search with the codegraph tools when the run has them. Else use Grep and Read.
The repository way is a helper, a wrapper, a layer, a registry, or one owner of the state.
It counts only when two places outside the diff use it.
Compare the change with that way. Find a step of that way that the change skips.
Examples: a check, a lock, a conversion, an escape, a cleanup, a cache update, or an error mapping.
The change can also copy state that has an owner elsewhere. Report the copy when a reachable path makes it differ from the owner.
Report a skipped step when a concrete input reaches it, and the change then gives a wrong result.
In trigger, give that input and the wrong result. In evidence, also give path:line of the two places.
A different way that gives the same result for each input is a choice between two correct designs. Do not report it.
```

- category stays by effect (catalog.ts:609). module stays core.
- The eval profile has no MCP server, so the eval measures the Grep path only (review-v3.md:185).

### 4.2 Verify lines

`ARCHITECTURE_VERIFY` in verifyRules, after the preexisting lines (catalog.ts:1523), only under the variant:

```
A candidate can say that the change leaves a way that the repository uses elsewhere.
Read the places that its evidence names. Confirm it only when that way does a step that the change skips, and the trigger reaches that step.
When both ways give the same result for each reachable input, refute it as a choice between two correct designs.
```

### 4.3 The do-not-flag item

- DO_NOT_FLAG (catalog.ts:614-624) does not change. An edit changes the default prompt bytes, and eval:ab then refuses the stored baselines (ab.ts:278).
- The last finder line and the third verify line apply the item. A way that skips a needed step gives a wrong result, so it is no correct design.
- The finder must name two uses. A preference with no precedent has no such evidence and no trigger.

### 4.4 Where it ships

- The variant alone cannot pass the seeded ship rule (section 3.2). It ships only inside a wider lever.
- Route 1: L2 of "lenses3" takes `CALLERS_LINES` and `ARCHITECTURE_LINES`. The lenses3 text is outside the repository (question 2, decided: L2 takes the lines). No extra run.
- Route 2: the stacked candidate "callers,architecture", one finder run. It targets the contract, omission, and architecture seeds, about 20 of 60.
- Zero-cost gate for route 2, from SG-A: H = 100 x sum over k in {contract, omission, architecture} of n_k x (1 - r_k) / n. n_k is the seed count of kind k. r_k is the SG-A recall of row "kind k". n is the count of all seeds. Run the candidate only when H is at least the SG-A MDE at R_B = 2. This is a necessary condition only.
- Timing (question 4): run it after every SG-A candidate that can change the default prompt. Read the G-L2 `pass 2` rows first ($0).
- Outcome: a pass ships both variants. An inconclusive result keeps both opt-in. A pass is no evidence for the architecture lines alone: the `kind architecture` row is descriptive.
- Command (with `--seeded` of WP-SG0): `bun run eval:ab -- --seeded --baseline eval-results/seeded/baseline --candidate-variants callers,architecture --candidate-repeat 2 --review-only --results eval-results/seeded/outside`.
- Cost: about $70-90 at C1b prices. The cost factor of 1.2 to 1.5 is not measured.
- Ship rule: "better" of seeded-truth.md section 6.5. A pass ships "callers" and "architecture" together. The kind rows give no attribution.
- `--candidate-replay` refuses both variants, because they change the finder (run.ts:288-301).

### 4.5 Not adopted

| Idea | Reason |
|---|---|
| A module "architecture" | A module ID is profile state that users see (dto.ts MODULE_IDS). A variant is the gate pattern (review-v3.md V2). A winner can become a module later. |
| A bug class or category "architecture" | It changes the Drafts sort and neverHidden (review.ts:285-300, spec.md AC-R25). The effect classes already apply. |
| An app check of the two cited places | It needs a finding schema field. Evidence checks had no effect (review-quality-2026.md item 8). |
| An edit of DO_NOT_FLAG | It changes the default prompt and kills the baselines (section 4.3). |
| Tier 2 seeds | No wrong result, so the validator refutes them. |
| A per-seed "precedent opened" fact | More case.json fields. Add it only if the architecture row stays low after lenses3. |

## 5. Gates

| Step | Needs | Pass |
|---|---|---|
| U-SG1 | WP-SG0 to WP-SG2 with the deltas | At least 48 seeds. Each kind except architecture has at least 4. Architecture has at least 4, or the build prints "under floor". |
| SG-A | the next prompt version bump | seeded-truth.md section 9. It prints the `kind architecture` row. |
| runs3 and lenses3 | SG-A | seeded-truth.md section 6.5. The architecture row is information only. |
| callers,architecture | SG-A, every SG-A candidate that can change the default prompt, the G-L2 `pass 2` rows, the zero-cost gate (question 4) | seeded-truth.md section 6.5. A pass ships both variants. |

## 6. Work packages

### WP-AR0. Docs (implementer)

- This file, and the patches to seeded-truth.md, review-quality-2026.md, review-ledger.md, and CLAUDE.md.

### WP-AR1. Variant "architecture" (implementer)

Status: built. tests/review/architecture.test.ts holds AC-R68 to AC-R72.

- Files and symbols: src/shared/dto.ts `VARIANTS`; src/server/review/catalog.ts `ARCHITECTURE_LINES`, `ARCHITECTURE_VERIFY`, `mainAgent`, `reviewerAgent`, `verifyRules`; tests/review/prompt.test.ts; tests/review/jobs.test.ts.
- Behavior change: `--variants architecture` adds the lines of section 4. The default prompts keep their bytes.
- Tests: the default snapshot hashes do not change. The lines appear in rl-main and rl-reviewer after `CALLERS_LINES`. Stacked with "callers", the order is callers, then architecture. The verify lines appear in rl-verify and rl-verifier only under the variant. The salvage prompt has none. prompt_version ends in "+architecture".
- Control mutation: add the lines without the variant. The default snapshot test fails.
- No REVIEW_PROMPT_VERSION, PROFILES_VERSION, or UI change. No file under scripts/eval or tests/eval changes.
- Risk: Gate A may run in the main checkout. Build in a worktree. The baseline profile keeps its promptVersion and revision (catalog.ts:245, ab.ts:276-283).

Acceptance criteria:

- AC-R68. With the variant off, every prompt keeps its bytes. No prompt holds a line of the variant. DO_NOT_FLAG does not change.
- AC-R69. With the variant on, rl-main and rl-reviewer hold ARCHITECTURE_LINES once, at the place of CALLERS_LINES. Stacked with "callers", they follow CALLERS_LINES. The Explain rl-main gets none.
- AC-R70. With the variant on, rl-verify and rl-verifier hold ARCHITECTURE_VERIFY once, after the pre-existing lines. Without the variant, they hold none.
- AC-R71. The salvage prompt keeps its bytes. promptVersion ends in "+architecture".
- AC-R72. Each sentence of the lines has at most 20 words. The lines hold no CRITICAL, MUST, or IMPORTANT.

### Deltas to the seeded packages

- WP-SG0: `SEED_KINDS` holds 9 kinds.
- WP-SG1: the store keeps `route`. Check 10. The build prints "kind architecture: under floor" when it has fewer than 4. Tests: one rejecting test per condition of check 10. Control mutation: skip check 10, and its test fails.
- WP-SG2: the seeder schema and lines, the validator line, kinds.md with the kind order, and the sample rule of section 3.6. Tests: the draw gives 14 seeds with 9 kinds. The second draws go to the five largest kinds. A kind releases on 0 drops and escalates on 1. An escalation needs an explicit user command; without it, the seeds stay confirmed.

## 7. Invariants and evidence

| Invariant | Evidence |
|---|---|
| An opt-in variant keeps the stored baselines valid. | catalog.ts:245; ab.ts:276-283 |
| run.ts accepts each name of dto.ts VARIANTS. | run.ts:227-228 |
| A finder variant cannot be replayed. | run.ts:288-301 |
| Variant finder lines follow the finder rules in rl-main and rl-reviewer. | catalog.ts:937-938, :1371-1372 |
| Verify lines of a variant go into verifyRules. | catalog.ts:1523-1526 |
| The verifier refutes do-not-flag items and confirms only with a wrong result. | catalog.ts:1511-1512, :1531 |
| A seed needs a wrong result at severity high. | seeded-truth.md:153, :188, :195 |
| A seed is one block of 1 to 8 lines near the PR lines, one per file. | seeded-truth.md:150, :166-168, :174 |
| The per-kind floor serves the table, not power. | seeded-truth.md:107 |
| Slice rows come from module and category. | score.ts:694-699; review.ts:292-297 |
| The eval profile has no MCP server. | review-v3.md:185 |

## 8. Risks

- Preference findings. The guard is the noise row of the ship rule (seeded-truth.md:260). Judge labels are no guard, because "Trivial" (review-quality-2026.md:95) does not cover a convention break.
- A search for precedents on large PRs can cost recall elsewhere. Watch the `kind local` row (seeded-truth.md:72) and the large-case slice.
- Low yield: few architecture seeds reach severity high. Section 3.2 gives the fallback.
- Wrong kinds from the seeder. Check 10 and sample point 4 limit them.
- A longer prompt can cost recall (languages.ts:10).

## 9. Unverified

- UA1: the lenses3 L2 text.
- UA2: the architecture seed yield per host.
- UA3: the cost factor of the variant.
- UA4: the share of natural misses that are architecture bugs. No label exists.

## 10. Questions and decisions

1. Tier 2 (a convention break with no wrong result today): keep it out of scope? Recommended: yes. Written rules stay with the rules module. Tier 2 cannot be seeded, and it needs a precision design on the natural set. Decided 2026-11-21: yes, out of scope.
2. Does the lenses3 package take `ARCHITECTURE_LINES` into L2? Recommended: yes. Without it, the stacked candidate is the only ship route. Decided 2026-11-21: yes.
3. Is "less than 25%" the first sample (14 seeds, escalation stays) or a hard cap? Recommended: the first sample. A hard cap replaces escalation with "the unsampled seeds of the kind stay out", and the set can fall under 48. Decided 2026-11-21: the first sample of 14 seeds. An escalation to more review needs the user's OK at that time, because the user may have no time. Without the OK, the unsampled seeds of that kind stay out.
4. Run the stacked candidate "callers,architecture" after runs3 and lenses3, when the zero-cost gate passes (about $70-90)? Decided by the user on 2026-11-21: yes, on the seeded set. Run it after every SG-A candidate that can change the default prompt. Read the G-L2 `pass 2` rows first ($0). A pass ships both variants. An inconclusive result keeps both opt-in. A pass is no evidence for the architecture lines alone, because that row is descriptive.
