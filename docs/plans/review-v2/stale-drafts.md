# Stale accepted drafts

Status: analysis and fix plan of 2026-11-18. Not started.

## 1. Problem

The user, 2026-11-18: accepted comments that were not posted cannot post after the code changed. They are not removed either, also after the next review round. They stay in "Ready to post".

Root cause: an accepted finding belongs to the run that found it, and it posts against the commits of that run. Only a re-review ("Review changes", key c) moves accepted drafts, and only from the newest review run. A full review, a new head, the out-of-date checks, and Ready to post never touch the drafts of earlier runs.

- The post plan takes accepted items of all runs of the PR (src/server/publish/routes.ts:25-28, plan.ts:115-118). Confirm checks the head of each run in the plan, and one stale run gives 409 for the whole confirm (outbox.ts:517-529). So the stale drafts also block every fresh draft and reply of the PR.
- blockedDrafts covers replies only (outbox.ts:200-204). The out-of-date alerts never cover findings.
- The Drafts list shows only the newest review run (src/web/review/useReview.tsx:135-139). No screen offers a discard of an older run's items.
- Ready to post counts the stale drafts as ready (src/web/publish/data.ts:80-88).
- The user's database on 2026-11-18: 3 accepted, unposted findings on one PR, all on one run whose head is no longer the PR head. A later full review became the base run, so a re-review would carry none of them.

## 2. State machine

ItemStatus is new, accepted, discarded, or posted (dto.ts:721). "Postable" is not stored: accepted, and the run head is the live head.

Today:

| From | Event | To | Where |
|---|---|---|---|
| (none) | run ends | new | jobs.ts run end |
| new | user accepts | accepted | item route |
| new, accepted | user discards | discarded | item route |
| accepted | Post confirm | posted | outbox enqueue |
| new, accepted on the base run only | re-review ends with a result | discarded, plus a copy (open: same status, new anchor; fixed or outdated: discarded) | rereview.ts:31-69 |
| accepted, run head is not the PR head | new head | no transition | missing |
| accepted on a run older than the base run | re-review | no transition | missing |
| accepted on any earlier run | full review | no transition | missing |
| accepted on an earlier run | user discard | no UI path | missing |

Proposed. One derived state, no new stored status:

| From | Event | To |
|---|---|---|
| accepted, run head is not the stored PR head | plan read | blocked "older commit": not in posts, not counted as ready, other drafts post |
| blocked "older commit" | user clicks Discard on the blocked line | discarded |
| new or accepted on the base run, or accepted on any earlier review run | re-review ends with a result | discarded, plus a copy (open: accepted on the new run with the new anchor; fixed or outdated: discarded) |
| blocked "older commit" | the PR head returns to the run head | postable again (derived, no write) |

## 3. Fix

F1. Stop stale drafts from blocking posts and from counting as ready.
- outbox.ts blockedDrafts: an accepted finding or question whose run source_head differs from pull_request.source_head is blocked with reason "older-commit". Revisions (payload.revises) stay out. Confirm keeps the live headCheck, because the stored head can lag behind the server.
- dto.ts: add "older-commit" to BlockedReason. BlockedDraft.thread becomes optional, because a finding has no thread. Check each user of b.thread (PostBar.tsx toThread, blockedList).
- PostBar.tsx act: for "older-commit", send the item discard. The blocked line reads "N drafts are on an older commit. Review changes (c) carries them, or Discard."
- useReadyToPost and readyLine then show "N cannot post" and no longer count them as ready. Post works for everything else of the PR.

F2. The next re-review carries them.
- run-rows.ts SQL.carry also takes accepted findings and questions of earlier review runs of the same PR: (run = $base AND status IN ('new','accepted')) OR (status = 'accepted' AND run IN (SELECT id FROM review_run WHERE pr = $pr AND kind = 'review' AND id < $base)). jobs.ts rereview passes pr. MAX_EARLIER still caps the count.
- carryOver and the verdicts need no change: open re-anchors, fixed or outdated discards, and code that is gone becomes outdated (validate.ts validateEarlier).

Not now (F3): a full review re-anchors earlier accepted drafts. It duplicates findings that the full review finds again, and NO_VERDICT lines make the run incomplete.

## 4. Tests

- Unit (tests/publish): an accepted finding on a run with an old head is blocked with "older-commit" and is not in posts. Confirm of the other items gives 202, not 409. Discard of the blocked draft leaves nothing to post.
- Unit (tests/review/rereview.test.ts): run A at h1 has an accepted X, full run B at h2 has nothing, a re-review at h3 carries X: an open copy is accepted on the new run, and X becomes discarded. A fixed verdict gives a discarded copy. A new (not accepted) item of run A is not carried.
- Unit: an item accepted while a re-review runs stays on the old run (rereview.ts:36). F1 shows it blocked, and F2 carries it on the next re-review. This path is derived from code only.
- e2e (rereview.e2e.ts or acceptance.e2e.ts): accept a finding, move the head with the fake Bitbucket control, run a full review. The Post bar shows the blocked line. Discard clears it, and Post of a new-run draft succeeds. acceptance.e2e.ts:81-84 changes, because a stale-only plan now shows a blocked line instead of the 409.

## 5. Open

- Whether the 3 stuck anchors are still in the current diff. The current PR head was not in the cache at the check.
- A PR with more than 20 runs leaves the stale run out of usePrRuns, so the confirm note does not show. F1 makes this case show as blocked instead.
