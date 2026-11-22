# Postable risks

Status: designed 2026-11-21. WP-PR1 and WP-PR2 are built together with WP-RC4. The user decided section 8 on 2026-11-21. Gate RC-A (risk-check.md section 7) passes under the fallback of 2026-11-17. WP-RC3 ships the risk check as the default in prompt 2.9, with all asked risk questions dropped (cascade step 2 of Q2). So only found risks make a draft, and only R4 needs the link. Design item 7. It changes no prompt byte and needs no eval gate.

## 1. Request and answer

The request: a real, confirmed risk becomes a PR comment with one click, like a finding. Nothing posts without a user click. The app posts, not the AI.

- Before prompt 2.9, no risk could post on a default run. A risk was a line of text in the run summary. It is not an item, and the post plan reads only items.
- Since prompt 2.9, each review run checks its risks. A confirmed risk with a place is a finding draft. It posts with Accept and Post, like any finding. A confirmed risk without a place gives open with no item (risk-check.md section 7, cascade step 2).
- One gap remained: the run line did not show which draft came from which risk.
- This design adds no new post path. It links each risk entry to its draft. The check stays the only way that a risk becomes a draft.

## 2. Facts

How risks are made:
- The finder returns `risks: z.array(z.string())` (src/shared/review.ts:115). No finder rule defines a risk. The task line says "Give the findings, the risks, and your questions" (src/server/review/prompt.ts:143).
- One profile prompt sends defects to risks: "Put a defect that you notice into risks, not into findings." (src/server/review/catalog.ts:167, OVER_PROMPT). So real defects can be in the risk list.
- Explain risks use another schema, with places (review.ts:386-397). They show only on the Explain page.

How risks are checked (variant "risk-check", WP-RC1):
- Before prompt 2.9, `riskCheck` turned the check on (catalog.ts:1422), and the variant was opt-in (src/shared/dto.ts:223). WP-RC3 makes the check the default in prompt 2.9. WP-RC4 (UI) is not started (review-ledger.md section 3).
- settle gives each risk one outcome, by rows R0 to R10 (src/server/review/judge.ts:548-582, 903-929). The outcomes are found, asked, cleared, covered, and open.
- found (R4): the check confirmed the risk, and the validator anchored the defect. The item is a finding with category "risk", evidenceStatus code, confidence high, and the confirmed mark (judge.ts:557-563, 598-615, 926).
- asked: R5 (confirmed, but no valid place) and R6 (a question verdict) make a question item {text, why} (judge.ts:551, 564-568, 927, 972). R5 loses the verdict severity.
- cleared, covered, and open make no item. They exist only in `summary.finderRisks.list` as {text, outcome, note} (dto.ts:641-648, judge.ts:925).
- A list entry holds no item ID, and no item holds a risk index. No code in src/web reads `finderRisks`.

Where risks are shown:
- The run line shows "Risk areas: N" and a bullet list of the raw text, with no action (src/web/review/RunLine.tsx:410, 564-568, 607-617). It looks the same with and without the variant.
- A found risk shows in Drafts like any finding, with "risk" in its category line (src/web/review/Drafts.tsx:337). An asked risk shows as "Question from <runner>" with "It posts as a general comment." (Drafts.tsx:167-170, 417).
- risk-check.md section 4.8 plans an outcome toggle and one entry per risk. It says "no post button, no action per line, and no new panel".

How drafts post:
- The plan takes only accepted items (src/server/publish/plan.ts:120). A finding on an added or context line posts inline (plan.ts:151-172). An old-side or outside finding goes into the general comment with its path:line (plan.ts:174-180). Each question item goes into the one general comment of its run (plan.ts:146-150, generalText at 99-105).
- items.ts refuses Accept for a finding with no place (src/server/review/items.ts:75-82). So a risk without a place cannot be a finding item. The question kind is the only existing route to the general comment.
- An accepted finding or question of a run on an older head is blocked as "older-commit" (src/server/publish/outbox.ts:203-216, stale-drafts.md F1).

Why a risk does not post today:
- On a default run, the risk is text in summary_json, not a review_item row.
- On a variant run, cleared, covered, and open risks make no item by design (risk-check.md section 4.4). The user said on 2026-11-17: "I don't want to simply post the risk." (risk-check.md section 1). risk-check.md section 11 puts "A post action for a raw risk" out of scope.

Facts about the payload, for the link:
- toItemDto reads payload_json with JSON.parse and no zod parse (src/server/review/run-rows.ts:407-438). An extra key stays. Old rows without the key read the same.
- A re-review copies the payload into the new run (src/server/review/rereview.ts:39-65). A Discuss revision copies the finding payload, with `revises`, into the same run (src/server/review/discuss.ts:165-168).
- No prompt builder writes a payload as JSON. questions.md writes only the kind and the body of a posted item (src/server/review/context-files.ts:634-640).

Facts about focus and triage in the UI:
- `openDraft` opens the fold of a draft and its row (src/web/review/useReview.tsx:254-255). The Ledger uses it (RunLine.tsx:104-122, useRunRecord.tsx:64).
- After Accept, `advance` moves the focus to the next new draft, not to the accepted draft (src/web/review/useTriage.ts:116-124).
- The run record `items` holds every item of the newest review run, posted ones too (useReview.tsx:152-155). Drafts drops posted items (src/web/review/model.ts:592-593).

## 3. Options

| | A. Post the raw risk text | B. Accept on the risk entry | C. Link the entry to the draft that the check made (chosen) | D. A risk without a place as a finding item |
|---|---|---|---|---|
| What | "Post" or "Make a draft" on each risk line. | An Accept button in the run line accepts the draft of a found or asked risk. | Each found or asked entry shows the state of its draft and a "Show draft" link. Triage stays in Drafts. | R5 becomes a finding row with no anchor. |
| Fit to the request | No. The decision of 2026-11-17 rejects it. A raw risk is a hypothesis that nobody checked. | Partly. It is one click, but the user accepts text that they have not read. The entry shows the risk, not the draft body and its code. | Yes. A confirmed risk is a finding row, and Accept (key a) is one click, as for any finding. | Yes for the framing. |
| Code | A new route that makes items, and a new item origin. | A second triage place: busy state, conflicts, and new focus code, because `advance` moves the focus to another draft. | 2 lines in settle, 1 type key, a pure helper, and the entry markup. | items.ts, plan.ts, Drafts, Fix, Discuss, Show in diff, and carry all expect a place. |
| Prompt bytes | None | None | None | None |

Pick C. A gives the noise that the user rejected. B accepts text that the user did not read, and it needs new focus code. D changes every finding path for a rare row. C reuses `openDraft`, the item route, and the post plan with no change.

Anchor rules. The code does not change. The rules are:
- A found risk has a checked line. It posts inline. When the line is outside the diff or on the old side, it posts in the general comment with its path:line.
- A confirmed risk without a valid place (R5) is a question item. It posts in the general comment.
- The app never invents a line for a risk. A risk with no item never posts.

## 4. Design

### 4.1 Data path (WP-PR1)

- settle writes the risk index k into the payload of each item that a risk row makes: `fromRisk: k`. k is the index in `summary.finderRisks.list` of the same run.
- In the settle loop (judge.ts), the R4 finding payload gets `fromRisk: k`. Since prompt 2.9, R5 and R6 make no item. If a later step brings their question items back, they get `fromRisk: k` too.
- riskOutcome stays pure and keeps its signature. Its row tests do not change.
- Only TypeScript types change. FindingPayload gets `fromRisk?: number` (review.ts). The shared intersection of ReviewItemDto.payload gets `fromRisk?: number` (dto.ts:749-755). The zod objects `finding`, `question`, and `verifyVerdict` do not change, so `--json-schema` keeps its bytes.
- No migration, no new item kind, no new route, and no change to `FinderRisks`.
- Runs stored before WP-PR1 have no link. Their entries show only the note.

### 4.2 Link rule

The draft of entry k of run R is the one item that has `run === R` and `payload.fromRisk === k`, and has no `payload.carried` and no `payload.revises`.
- A carried copy belongs to a newer run, and its index points into the list of the older run.
- A Discuss revision is not a draft (review.ts:227-230). "Use the new text" keeps the finding as the item that posts (plan.ts:113-114).
- At most one item matches, because each risk row makes at most one item.

### 4.3 UI (WP-PR2)

The run line keeps the one toggle of risk-check.md section 4.8. Only line 2 of an entry changes, and only for found and asked entries with a matching draft:
- Line 2 shows "<state>: <draft title>", then the link "Show draft". The title comes from `draftTitle(item)`, so an edit shows.
- The state word: new gives "Draft", accepted gives "Accepted", discarded gives `closedLabel(item)` or "Discarded", and posted gives "Posted".
- "Show draft" calls `openDraft(item.id)`. If the draft is in the More fold, the fold opens. A posted item gets no link, because Drafts drops posted items.
- An entry with no matching draft keeps line 2 of section 4.8.
- cleared, covered, and open entries get no control.
- A run without `finderRisks` keeps "Risk areas: N" and its list.
- The link is a text button in the `linkish` style of the run line, like "Show log". Its sr-only name is "Show draft of risk <n>".
- useRunRecord builds the risk list as a ReactNode from `o.items` and `o.openDraft`, the same way that it builds `refuted` (useRunRecord.tsx:63-65). RunLine shows it in place of the section 4.8 list when the summary has `finderRisks`.
- A pure helper `riskEntries(summary, items, run)` in model.ts returns {text, outcome, note, draft?: {id, state, title, linked}}. Tests pin its output.

Drafts list: no change. A found risk is a finding row. An R5 or R6 risk is a question row. Accept, Edit, Discard, Post, Fix, and Discuss work as today.

### 4.4 Publish plan

No change in src/server/publish/. The plan already posts accepted finding and question items with the AI mark and the severity prefix (plan.ts:28-64, 107-192). The confirm dialog shows each body before the post.

### 4.5 States of a risk entry

The state comes from the item at render time. Nothing new is stored.

| Draft of the entry | Event | Entry shows | Control |
|---|---|---|---|
| none (cleared, covered, open, or a run before WP-PR1) | none | outcome and note | none |
| new | the run ends | "Draft: <title>" | Show draft |
| new | Accept or Edit in Drafts (items.ts:107-114, 158-163) | "Accepted: <title>" | Show draft |
| new or accepted | Discard, a Fix commit, or a Discuss withdraw | closedLabel: "Discarded", "Fixed in <hash>", or "Withdrawn" | Show draft |
| discarded | Restore | the earlier status | Show draft |
| accepted | Post confirm | "Posted: <title>" | none |
| accepted, and the run head is not the PR head | new commits | "Accepted: <title>". The run line says "N commits since". The Post bar names the older-commit block. | Show draft |
| any | "Review changes" ends | The re-review is now the newest review run, and its own entries show. The carried copy matches no entry. | none |
| any | a full review ends | The new run shows its own entries. The older accepted draft stays blocked until Discard, or until a re-review carries it (stale-drafts.md F2). | none |

The item route updates the run cache (useTriage.ts:103-104), so the entry changes together with the Drafts row.

### 4.6 Invariants

- I1. Nothing posts without the user's Accept and Post confirm. The design adds no write route and no automatic accept (items.ts:107-114, plan.ts:120).
- I2. No prompt byte changes. The zod schemas behind `--json-schema` do not change. No prompt builder writes payload JSON (context-files.ts:634-640). REVIEW_PROMPT_VERSION stays "2.9".
- I3. Only the risk rows set `fromRisk`. Since prompt 2.9, only R4 sets it. A run without finderRisks keeps "Risk areas: N".
- I4. An item links to at most one entry, and an entry links to at most one item (section 4.2).
- I5. Runs from before WP-PR1 read the same as today, because the key is optional and the payload gets no zod parse (run-rows.ts:407-438).

## 5. Eval gate

No eval gate is necessary. WP-PR1 and WP-PR2 change no prompt, no agent definition, no `--json-schema`, and no candidates.md byte. The eval run files count item kinds (scripts/eval/run.ts:849), and the kinds do not change. The proof: the byte tests in tests/review/risk-check.test.ts (AC-R41, lines 194-249) and tests/review/prompt.test.ts stay green with no snapshot update. Joint Gate A and Gate RC-A keep their inputs.

## 6. Tests

WP-PR1:
- risk-check.test.ts, settle: a run with a found risk that is not the first risk. The R4 finding has `fromRisk` equal to its list index. R5, R6, cleared, covered, and open make no item. No candidate finding and no finder question item has `fromRisk`.
- The AC-R45 test: the found item equals the placed finding plus `fromRisk`.
- The AC-R41 byte test and prompt.test.ts stay green with no snapshot change.
- tests/tasks/loop.test.ts:557 (task review under the variant) stays green.

WP-PR2:
- tests/web/risks.test.tsx, riskEntries: each state word is correct. A posted draft gives no link. A carried copy and a Discuss revision never match. An item of another run never matches. A run from before WP-PR1 shows only the note. A run without finderRisks gives null.
- One render test in a .tsx file, in the shape of tests/web/preexisting.test.tsx: "Show draft" calls openDraft with the item ID.
- No new e2e test. "Show draft" calls `openDraft`, which the Ledger e2e tests already cover. The demo run shows found, cleared, covered, and open risks for the screenshots.
- m2.e2e.ts checks "Risks: 2 open", because each review run since prompt 2.9 has finderRisks. A unit test keeps "Risk areas: N" for a run without finderRisks.

## 7. Work packages

| # | Package | Tier | Files | Tests | Done when |
|---|---|---|---|---|---|
| 0 | WP-PR0: docs | main session | This file. risk-check.md section 4.8 (one link per entry with a draft) and the WP-RC4 row of section 9 (add the link). review-ledger.md (a row "Postable risks: WP-PR1, WP-PR2"). | none | committed |
| 1 | WP-PR1: risk link in the payload (built) | implementer | src/shared/review.ts (FindingPayload type), src/shared/dto.ts (ReviewItemDto.payload type), src/server/review/judge.ts (settle risk loop), tests/review/risk-check.test.ts | Section 6 | `bun run check` is green, and the byte tests do not change. |
| 2 | WP-PR2: risk entries with their drafts (built with WP-RC4) | implementer | src/web/review/model.ts (riskEntries), src/web/review/RunLine.tsx, src/web/review/useRunRecord.tsx, tests/web/review-v2.test.ts, a .tsx render test, tests/e2e/review-v2.e2e.ts and its serve.ts profile with the variant, scripts/demo.ts, tests/support/fake-claude.ts, README.md, CHANGELOG.md, docs/screenshots | Section 6 | check and test:e2e are green. The screenshots hold no real names. The skills shadcn, vercel-react-best-practices, and web-design-guidelines ran. |

Order:
- Hold WP-PR1 until the user decides WP-RC3 (Q4). WP-RC3 shipped in prompt 2.9, so WP-PR1 can start. Each review run stores the link from then on.
- WP-PR2 shares RunLine.tsx, model.ts, the demo, the e2e tests, README, and CHANGELOG with WP-RC4. So WP-PR2 is the run-line half of WP-RC4 (the toggle, the entries, and the link). WP-RC4 keeps stats.ts, quality.ts, and the runningText.
- WP-PR2 ships with WP-RC4, as one package (Q4). Never build them in parallel.
- fake-claude gives no verdict for a "## Risk N" block, so its risks end as open. The demo sets its own verdicts for its four risks.

Docs in WP-PR2:
- README, review section, one paragraph: "With the risk check, the run line lists each risk with its outcome. A confirmed risk becomes a draft. Show draft opens it in the Drafts list."
- CHANGELOG, only what the user sees: "Review: each risk of a checked review shows its outcome. A confirmed risk is a draft, and Show draft opens it."
- Screenshots: run `bun run screenshots` with a demo run under the variant.
- review-ledger.md: the status of WP-PR1 and WP-PR2.

## 8. Open questions

Q1. Do open and unchecked risks get any path to a draft? Decided by the user on 2026-11-21: no. An open or unchecked risk never becomes a draft. Only the check makes a risk draft.
Q2. How does the fallback of risk-check.md section 7 treat R5 and R6? Decided by the user on 2026-11-21: as a cascade, fixed before anyone reads the R5 share. When only rule 4 of Gate RC-A fails, drop the R6 question items first. If rule 4 still fails, drop the R5 question items too. Rule 4 counts every question item that remains, R5 included. The R5 and R6 split needs the recorded verify calls or a split in RISK_KEYS. Neither is built.
Q3. Does R5 post as a statement with the verdict severity? Decided by the user on 2026-11-21: not now. Gate RC-B counts only findings of category risk, so it cannot answer this. WP-RC4 adds posted and discarded counts of `fromRisk` question items to the stats. The decision follows those counts. Note: since prompt 2.9, R5 and R6 make no item, so these counts stay at 0. They count only after a step brings R5 or R6 question items back.
Q4. When does WP-PR2 ship? Decided by the user on 2026-11-21: WP-PR2 ships with WP-RC4. WP-PR1 waits until WP-RC3 is decided.
Q5. Do found obligation drafts get the same link (`fromObligation`) in WP-OB4? Decided by the user on 2026-11-21: yes, with the same link rule as section 4.2.

## 9. Out of scope

- A post action for a raw, open, cleared, or covered risk.
- An Accept button in the run line.
- A link from a covered entry to the finding that makes the same point. The list holds no candidate item ID.
- A link from a posted entry to its thread.
- A file-level Bitbucket comment for a risk without a line.
- The risks on the Explain page. They are reading guidance from a run with no check.
