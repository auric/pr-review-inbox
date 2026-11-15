# PR view v4 plan: detail pane layout, Back, and panels

Status: code complete, 2026-10-15. All packages are done (section 10). The user runs docs/smoke-v3.md part H. Section 12 records the user decisions. Prototype: `prototype/pr-view-v4.html` (open it from disk; the top strip switches scenarios and themes and shows the app URL). Line references point to the code at efd8f8c. The audit screenshots (the app of 2026-10-14 and the prototype) are not in the repo.

## 0. Sources and rules

- Inputs: user feedback of 2026-10-14 (items 1-8 and "Panels"), docs/plans/fix-ux.md (Option A and the user decisions), the session-consult design notes (not in the repo yet), BRIEF.md:69 and :237, `src/web` at efd8f8c.
- Tokens: prototype/v3 through `src/web/index.css`, because the app uses them. `prototype/index.html` is the older spec, and its tokens do not match the app.
- Hue rule stays: `--turn` marks only "your turn". `--err` marks only errors and Blocker. `--pen` marks links and focus. New: `--warn` marks only "Not checked". The token exists in index.css.
- Names: the prototype says "the server" and "the assistant". The app takes the names from GET /api/meta (`tests/ui/names.test.ts`).

## 1. Problems (audit)

| ID | Block | Problem | Evidence |
|---|---|---|---|
| H1 | Header | The key "PROJ1/sample-repo-2 #1001" is plain text. The only PR link is an icon at the far right. | Header.tsx:173, 212-223 |
| H2 | Header | A task chip without a link pattern differs from a linked chip only in text color, and a click does nothing. Only a tooltip says why. | Header.tsx:187-210 |
| H3 | Header | Branch links look like plain code text. The copy button shows only on hover or focus. | Header.tsx:63 |
| H4 | Header | The author shows only as "Opened by ..." at the right edge of Overview. | Sections.tsx:36 |
| A1 | Action bar | Four buttons, three of them split buttons: Ask, Draft replies, Fix all valid, Review · General. | Author PR at 1440 px |
| A2 | Action bar | The Review menu repeats the profile list of the brief. The label names the profile. "Edit profile..." hides in the menu. | RunSplit.tsx; Brief.tsx:126-157 |
| A3 | Action bar | "Draft replies 0" and "Fix all valid 0" are disabled. The reason is in a tooltip only. Fix shows only after a reply draft says Valid. | docs/plans/fix-ux.md |
| A4 | Action bar | Ask is a button at the top and an "Ask" fold at the bottom. The button scrolls to the bottom. | PrDetail.tsx:301-308, 440-450 |
| A5 | Action bar | At 400 px the bar takes two rows. Ask loses its label. | Author PR at 400 px |
| S1 | Summary line | "Files" is a link. "2 unresolved" is plain text. Both look the same. | Header.tsx:284-327 |
| R1 | Run row | One line holds status, counts, hash, profile, model, effort, instruction file size, and Log. At 400 px it takes 6 lines. | Done run at 1440 and 400 px |
| R2 | Run row | "Coverage gaps" is a link. For a review it opens the summary fold above. For other run kinds it opens the Log. The user does not see what was not checked. | useReview.tsx:603 |
| R3 | Run row | After a run, the Log button keeps the focus and its "Key: 3" tooltip. | Running and done run at 1440 px |
| O1 | Overview | The AI summary sits above the description of the author. The questions with Accept, Edit, Discard sit inside the summary. | Findings at 1440 px |
| O2 | Coverage | Read, Skipped, Unavailable, Not checked, and Dropped are one flat list. Gaps look like normal rows. | Coverage fold at 1440 px |
| D1 | Drafts | Findings show inside Threads. The Threads count leaves them out. Questions show in the summary. One result is in two places. | Findings at 1440 px |
| D2 | Drafts | Each finding card is open, with code above and below the card and five actions. Three findings fill two screens. | Findings at 1440 px |
| T1 | Threads | Three ways start a reply draft: Draft replies in the bar, Draft reply per thread, and the reply box. | Author PR with reply drafts |
| T2 | Threads | A reply draft card has two button rows: Accept, Edit, Discard, then Fix and Copy prompt. | Author PR with reply drafts |
| T3 | Threads | "Only threads that need me" is a checkbox at the right edge, far from the groups that it filters. | Reviewer PR at 1440 px |
| F1 | Files (bug) | Without the code, the path of a file row is text. Only the thread count is a button. A file with no thread has no action (Sections.tsx:170-184 renders an empty span). | Sections.tsx:160-184 |
| F2 | Files | "Get the code from ..." shows below the list. The user finds it only after a click that did nothing. | FileDiff.tsx:217, 240-269 |
| F3 | Files | Rows span the full pane width, but other sections stop at 86ch. The count sits at the far right. The row rules lead nowhere. | Files of PR 77 at 1440 px |
| C1 | Commits | The hash is text. It has no copy action. | Sections.tsx:229-232 |
| B1 | Bars | The fix bar and the post bar stack at the bottom. With the sticky action bar, a 400 x 860 screen keeps about 560 px for content. | PrDetail.tsx:463-469 |
| P1 | Panels | The detail width drops from 899 px at a 1279 px window to 684 px at 1280 px (measured). | Section 4.1 |
| P2 | Panels | At 1920 px the prose column is 649 px of 1276 px. On a 1280 px laptop the diff has 636 px. No control gives the diff more room. | Section 4.1 |
| P3 | Panels | Long project and repository names are cut in the sidebar and in the list. | Inbox at 1440 px |

## 2. New layout per block

Scroll order: Header, Action bar (sticky), Status strip, Panel slot (brief or Ask), Review record (once a review exists), Description, Drafts, Threads, Files, Commits. One bottom bar.

### 2.1 Header (H1-H4, item 4)
- Line 1: the key "PROJ/repo #id" with an external icon. It is one link to `webUrl` in a new tab. Follow and Archive stay at the right. The separate external-link icon goes away.
- Line 2: the title (h1).
- Line 3, the byline: author avatar and name, the source branch link with a visible copy button, "into", the target branch link, the task chips.
- A task chip with a URL is a link with an external icon. A chip without a URL is a dashed button. It opens Settings, Task IDs (`/settings/task-ids`). Its name is "<KEY>. No task link yet. Opens Settings, Task IDs."
- The author name links to the user page when the server gives that link (data need N2). Else it is plain text.
- Rule: every name of a server object opens that object. Exception: "PROJ/repo" opens the PR for now (decision D1).

### 2.2 Action bar (A1-A5, items 5 and 6)
- Buttons: Ask (q), Draft replies N, Fix N (own PR only), Review (primary, r), Full width (z, wide layout only), More.
- No split buttons. No profile name in a label.
- Draft replies shows when the PR has threads. N is the count of threads where it is your turn. With N = 0 the button has no count. A click opens a popover: "No thread waits for your reply. Your message is the newest in each open thread. They wait for the other person." With no open thread: "No open thread. Every thread is resolved, so no reply is due."
- Fix N shows on an own PR only and is never disabled. N is the count of open, unresolved threads with a live message (BRIEF:69). A click or F opens the Fix list (2.12).
- Review opens the brief. The brief holds the profile, "Edit <profile>", and the run setup.
- More: "Open on the server", "Copy the pull request link". On an own PR also "Copy for your session..." (section 9). "Paste the answer..." was removed on 2026-10-20.
- When the header leaves the view, the bar shows the key and the title, as today.
- In a pane of 520 px or less: "Draft replies" becomes "Replies", and the stuck title hides. Every button keeps a text label.

### 2.3 Status strip (S1)
- One line of jumps: "Your turn in N threads" (turn hue, y), "N new since <visit>" (n), "N open threads", "N drafts" (2), "N files" (g f).
- Each part is a button. No part is plain text, except "No comments yet". Keys show in tooltips and in the help sheet.

### 2.4 Panel slot (A2, A4, item 5)
- The brief and Ask open in one slot under the strip, one at a time. Esc closes the slot and moves the focus back to its button.
- Brief: task, note, profile radios, a "Last used" tag on the preselected profile, an "Edit <profile>" link at the profile legend (`/settings/profiles/<id>`), run setup, Start, Cancel.
- The brief preselects the profile of this PR's own brief. A PR without one gets the last profile used on any PR (decision D2, data need N3).
- Busy brief: a note names the active run and links to it. Start stays focusable with `aria-disabled` and shows the reason as text.
- Ask: the box, Ask, the help line, and all answers of this PR, newest first. The bottom Ask fold goes away. While a question runs and the slot is closed, the strip shows "Answering...".

### 2.5 Description (O1)
- Renamed from "Overview". The first paragraph and "Show more". Reviewers with status text and a check icon for Approved.
- The "Not followed" notice and the check banner stay here. The AI summary moves to 2.6.
- Once a review exists, the Review record comes before the Description (decision D3).

### 2.6 Review record (R1-R3, O2, item 2)
- One block for the newest run of this PR. A 3 px ink rule at its left marks it as the run record. It is the one bold element of the page.
- Head: "Review", then "<profile> · <head> · <age>".
- Running: spinner (static with reduced motion), "N tool calls · m:ss", Cancel, Log. The counter is outside the live region.
- Done: the one-line summary. Then a ledger of counts, each a jump to its first draft: Blocker (`--err`, icon and word), Major, Minor, Nit, question.
- Then the coverage line: "Read N files", "Not checked: N" (`--warn`, icon and words), "Risk areas: N", "Run setup", "Log". Each of the first three opens in place.
- N of "Not checked" = `coverage.skipped` + `coverage.unavailable`. Only the lines that the app adds mark a run incomplete (judge.ts ended(), review-v2/spec.md section 1.9). The reveal shows one plain line per item. Below: "Also not done, by design: <coverage.notChecked>" and a pointer to the Log.
- "Not checked" starts open the first time a run with N > 0 shows.
- Dropped findings: one line in the same reveal, with "Show it".
- Other run kinds (replies, ask, fix) use the same block with one line: "<kind> done · N ... · head · age · Log". Their gaps use the same "Not checked" reveal and never jump to the Log.
- A run with gaps never says "no issues" (A11, A12). "No findings in what it read" stays.

### 2.7 Drafts (D1, D2, O1)
- Own section after the Description. Findings and questions are in one list. Head: "Drafts N", "Only you see drafts until you post them."
- Each draft is a row: severity, title, file:line, state ("Accepted" with icon, "Discarded" struck through). Enter or o opens the row: code excerpt, comment, evidence, Accept (a), Edit (e), Discard (d), Show in diff (g d).
- The first open draft starts expanded. The others stay rows.

### 2.8 Threads (T1-T3, item 6)
- Head: "Threads N open" and a two-button toggle "All | Need me". It replaces the checkbox.
- Groups stay: Your turn, Waiting on others, Other discussions, "Show N resolved threads".
- Header row: chevron, place (file:line or "General comment"), first name of the author, the snippet while closed, badges ("Your comment", "Posted finding · Major", "new"), age.
- Body: messages, the reply draft card (verdict chip, text, Accept, Edit, Discard in one row), the footer.
- Footer: reply box, "Draft reply" (your-turn thread without a draft), Fix (own PR), More (Show in diff, Copy prompt for your own session, Copy the comment link, Open on the server).
- The verdict chip tooltip says that the judgement sets the default tick in the Fix list.

### 2.9 Files (F1-F3, item 3)
- Head: "Files N", "+a -d" when the code is there, "Open on the server".
- Without the code, a note above the list: "Select a file to see its diff. The first one gets the code of both branches from the server and keeps it in a local cache." Button: "Get the code now".
- Every row is one button. Click, Enter, or o opens the diff under the row.
- Without the code, the row shows a spinner and "Getting the code". The live region says "Getting the code. Fetching <source> and <target>." When the fetch ends, the diff of that file opens. The focus stays on the row. The live region says "Got the code. N changed files. Showing <path>."
- When the fetch fails, the row shows the error text and "Try again".
- Row layout: chevron at the left (the open affordance), change icon with a label, path (folder muted), thread count, "+a -d". Rows keep the 86ch measure while no diff is open. An open diff uses the full pane width. The open file row sticks under the action bar.

### 2.10 Commits (C1)
- The hash is a copy button. Message, author, age. The "Your review covered the commits below" marker stays.
- Commit hashes stay copy-only. The fixtures give no commit link, and a built URL is a guess (decision D7).

### 2.11 Bottom bar (B1)
- One bar for the fix run and the post. Parts: "Fix: checking N points" or "Fix: N edits proposed" with "Review edits", and "Ready to post: N ..." with "Post to <forge>" (p).
- The parts share one row. They wrap only when both show in a narrow pane.

### 2.12 Fix list (item 6, fix-ux Option A)
- Dialog title: "Fix comments on your pull request".
- Group "Open threads · N": one checkbox row per thread with person, place, badge ("Your comment", "Posted finding"), verdict chip or "No judgement yet", snippet.
- Default ticks: Valid and Partly. Your own comments and posted findings start unticked (decision D6). A per-thread Fix and the f key open the list with only that thread ticked.
- Footer: "Propose fixes for K" (primary), Cancel, "Copy for your session" (section 9).
- Each block has visible text under the buttons: busy slot, K = 0, K > 25, not synced, Explain profile, nothing to fix. The button stays focusable with `aria-disabled`.
- "Not in the list: N resolved threads, N deleted comments."
- Group "Review findings that are not posted" shows as planned (phase 2).
- Reviewer PR: no Fix button. f and F show "Fix works only on your own pull requests."

## 3. States

| State | What shows | Prototype scenario |
|---|---|---|
| New PR, reviewer, no comments, no code | Strip "No comments yet · 5 files". No Draft replies, no Fix. Threads "No comments yet." Files with the note. A click on a file gets the code and opens it. | New PR |
| Running review | Record with spinner, counter, Cancel, Log. | Review running |
| Findings | Record with ledger and "Not checked: 2" open. Drafts. Bottom bar after Accept. | Findings |
| Author PR | Draft replies 2, Fix 4, reply drafts, Fix in each footer. | Author PR |
| Reviewer PR | No Fix button. f and F show a toast. | New PR, Findings |
| Nothing to fix | Fix 0 opens the list with the empty reason. Draft replies opens the zero popover. | Nothing to fix |
| Busy slot | Brief and Fix list name the active run. Start and Propose stay focusable with the reason. | Busy slot |
| Full width | Sidebar and list hidden. The diff is wide. | Diff full width |
| Profile from the brief | `/settings/profiles/general`, profile marked. Back returns to the PR. | Review, then "Edit General" |

## 4. Panels

### 4.1 Audit (measured on the app of 2026-10-14)

| Window | Sidebar | List | Detail | Prose column |
|---|---|---|---|---|
| 400 | one pane | one pane | 400 | 368 |
| 1100 | 60 | 320 | 720 | 649 |
| 1279 | 60 | 320 | 899 | 649 |
| 1280 | 228 | 368 | 684 | 636 |
| 1440 | 228 | 368 | 844 | 649 |
| 1920 | 228 | 368 | 1324 | 649 |

- The user reads threads and diffs in the detail for minutes. The list is for picking. The sidebar is for a view change.
- The diff is unified, with two line-number columns. A 100-column line needs about 720 px plus the gutter. At 1280 px the detail has 684 px.

### 4.2 Options
- (a) A splitter between list and detail, remembered per viewer.
- (b) A collapsible sidebar: an icon rail by choice, remembered.
- (c) Full width for reading and diffs: z or a button. Esc or z returns.
- (d) Other structures: a list drawer ("reading pane off"), or tabs per PR. Rejected: they break the three panes and j/k picking (BRIEF:237).

### 4.3 Decision: (a), (b), and (c) together
- Sidebar choice: auto, rail, or full. A "Collapse sidebar" button sits at the sidebar foot. The choice stays in localStorage (try/catch). Auto gives the rail below 1440 px (decision D4; today 1280 px). A 1280 px window then gives 900 px to the detail.
- Splitter: one separator on the right edge of the list. Width 280 to 560 px. Default 368 px with the full sidebar, 320 px with the rail. Drag uses pointer capture.
- Splitter keys, only while it has focus: Left and Right 16 px, Shift for 64 px, Home and End for the limits, Enter resets. Double-click resets. It has `role=separator`, `aria-valuenow`, `aria-valuemin`, `aria-valuemax`, `aria-controls`. The live region says the new width.
- The width stays in localStorage (try/catch). A missing or blocked store gives the default.
- Full width: z or the action bar button (`aria-pressed`). It hides the sidebar and the list.
- Below 760 px: no splitter and no full width. One pane at a time, as today.
- Prose keeps the 86ch measure in all modes. Only diffs and open file rows use the extra width. The column stays left-aligned.

### 4.4 URL and keys
- Widths and the sidebar choice are viewer preferences, not navigation. They go to localStorage only, never to the URL.
- Full width is a view state: `full=1` in the URL. Back leaves full width (decision D5).
- New key: z. Esc order: menu or popover, dialog, panel slot, full width, then the list.

### 4.5 Dependency: none
- A custom splitter is about 70 lines: pointer events and one CSS variable `--list-w` on `.rl-app`.
- shadcn Resizable needs react-resizable-panels, a new dependency. It sizes panes in percent. This layout mixes a fixed rail with px widths and swaps to one pane below 760 px. One splitter does not justify it. Look again if a second splitter comes, for example a side-by-side diff.

## 5. URL map and Back

Facts: the built app serves the page for every GET outside `/api/` (src/server/app.ts:109-114). Vite dev uses the default `appType` "spa" (vite.config.ts sets none). No web code uses the History API today. So the server needs no change.

| Path or query | State |
|---|---|
| `/` | Same as `/needs` |
| `/:view` | View: needs, reviewing, mine, following, archive, runs, post |
| `/:view/:project/:repo/:id` | Selected PR. Project and repo are URI-encoded. A personal repo keeps `~user`. |
| `?thread=<root id>` | Current thread, open and focused |
| `?file=<path>&line=<n>&side=new\|old` | Open file in the diff, optional line |
| `?full=1` | Full width |
| `?repo=<project/repo>` | Repository filter of the list |
| `?q=<text>` | Filter text of the list |
| `/settings`, `/settings/:section` | connection, checks, notifications, posts, appearance, profiles, task-ids, tracker, clones, instructions |
| `/settings/profiles/:profile` | One profile, opened from the brief |

Push or replace:
- Push: a view change, a PR open by click or Enter, Settings open, a settings section link, "Edit <profile>", a file open by click, full width on or off.
- Replace: j and k in the list, thread focus (j, k, o, y, n), filter text, the repository chip, a file close.
- Never in the URL: dialogs, menus, the panel slot, triage state, panel widths.
- Each entry keeps the scrollTop of the detail in `history.state`. Back restores it.

| From | Back goes to |
|---|---|
| PR B, opened by click after PR A | PR A at its scroll position |
| A PR reached with j or k | The entry before the j and k moves |
| A diff file opened by click | The PR without the file, same scroll |
| Full width | The same PR in three panes |
| A settings section | The previous section, then the PR |
| The detail at 400 px | The list. The mobile pane follows the URL. |
| An open dialog or slot | It closes with the location change |

- Text stays safe: Ask drafts and reply drafts persist in localStorage (ask/data.ts, ReplyComposer.tsx:2). The brief note saves at once (Brief.tsx:86). A triage edit must keep its text on unmount; P1 checks this.
- A URL with an unknown PR shows "Cannot find this pull request" (PrDetail.tsx:453). A deep link to a PR outside the current view keeps that PR shown.
- Esc never changes history, except in the narrow layout, where Esc in the detail is Back.
- Verified in the prototype (hash routing, because `file://` allows only fragment changes): click PR 1340, click a file (fetch, then open), z, then Back three times: full width off, file closed, PR 2215. "Edit General" gives `/settings/profiles/general`. A section link gives `/settings/task-ids`. Back twice returns to the PR. j in the list replaces the entry.

## 6. Keyboard changes

| Key | Change |
|---|---|
| f | New. Fix the current thread (own PR). Reviewer PR: toast. |
| F | New. Open the Fix list. |
| z | New. Full width on or off (wide layout). |
| Enter, o on a file row | New. Open the diff. Get the code first when needed. |
| g f | Now focuses the first file row, not the "Get the code" button. |
| j, k in the detail | Also move over draft rows and file rows. |
| r | Unchanged. Opens the brief. The profile menu goes away. |
| Esc | Order: menu or popover, dialog, panel slot, full width, then the list. |

All other keys stay: j, k, Enter, Right, Esc, Left, /, ?, n, N, y, o, g c, g d, 1, 2, 3, c, q, a, e, d, p, Ctrl+Enter. The splitter keys work only while the splitter has focus.

## 7. Accessibility
- Every action is a button or a link with a visible label. Icon-only buttons have `aria-label` and a tooltip: Full width, More, Follow, Archive, Copy.
- Focus order: header links, action bar, strip, slot, sections in reading order, bottom bar.
- One live region per detail, as today. It says: fetch start and end, run start, triage results, "Copied ...", and the list width.
- Status never by color alone: Blocker has an icon and the word, "Not checked" has an icon and words, "Accepted" has an icon and the word, "Your turn" has an icon and words, an unlinked chip has a dashed border and an accessible name.
- Dialogs: `role=dialog`, `aria-modal`, a title, a focus trap, Esc, and the focus goes back to the opener.
- Reduced motion: no spinner turn, no smooth scroll, no slide or zoom. Fades and color changes stay. Jump targets and chevrons never animate.

## 8. Data needs
- N1: none for the key link (`webUrl`), the branch links (`sourceBranchUrl`, `targetBranchUrl`), and the task links (`tasks[].url`). They exist in PrRow.
- N2: the author page link. Source: `author.user.links.self[0].href` (fixtures/bitbucket/pull-request.json has it). Add `authorUrl` to PrRow. Keep it only when its origin is the configured server (provider.ts `own`). Optional: without it the name stays text.
- N3: the last profile used on any PR, for a PR without a brief (decision D2). Today the brief keeps one profile per PR. New: a per-viewer "last profile" in localStorage (try/catch), or a config field.
- N4 (later, decision D1): the repository page link. provider.ts:131 already reads `toRef.repository.links.self[0].href` as `repoUrl`, but PrRow does not carry it.
- No new REST call. The file click uses the existing "Get the code" route (`useGetCode`, diff/data.ts).

## 9. Consult the session that wrote the code (S1 done)
- Places: the More menu of an own PR ("Copy for your session...") and a link in the Fix list footer. In the prototype they show a "Planned" tag and a toast.
- docs/plans/session-consult.md applies: items in groups with IDs (T<thread>, F<finding>) in tags with a random suffix, and a plain "validate and implement" prompt. Nothing posts.
- Package S1 built parts A and B. Package S2 built part C (0bd573c) after gate B16 passed. Part B (paste the answer) was removed on 2026-10-20.

## 10. Implementation packages

Each package ends green on `bun run check` and on the e2e files it touches (`bun run test:e2e`). One implementer per package. Order: P6, P1, P4, P3, P5, P2, P8, P7 (after fix-ux WP1), P9.

- P1 (done, a487304) URL state and Back. Files: new `src/web/lib/route.ts` (pure parse and format, push or replace, popstate), `src/web/App.tsx` (route to view, selected PR, settings), `src/web/keys.ts` (narrow Esc is Back), `src/web/settings/Settings.tsx` (section links push; open at `/settings/:section[/:profile]`), `src/web/pr/PrDetail.tsx` (thread, file, full from the route; scroll in `history.state`). Tests: new `tests/ui/route.test.ts` (round trip, `~user`, slashes in paths, unknown view), `tests/server/guard.test.ts` (GET `/needs/P/r/1` returns the page), new `tests/e2e/back.e2e.ts` (click PR, file, Back; Settings section, Back; narrow Back). Depends on nothing.
- P2 (done, 73e8877) Panels. Files: new `src/web/shell/Splitter.tsx`, new `src/web/shell/layout.ts` (clamp, read and write the preferences with try/catch), `src/web/index.css` (`.rl-app` columns use `--list-w`; rail below 1440 px; full width), `src/web/shell/Sidebar.tsx` (collapse button), `src/web/App.tsx` and `src/web/keys.ts` (z, Esc order). Tests: new `tests/ui/layout.test.ts`, `tests/ui/keys.test.ts` (z, Esc order), new `tests/e2e/panels.e2e.ts` (keyboard resize, reset, rail after reload, z hides panes, Back leaves full width). Depends on P1.
- P3 (done, 29b8889) Header and action bar. Files: `src/web/pr/Header.tsx` (key link, byline, task chip button, visible copy), `src/web/review/RunSplit.tsx` (delete), `src/web/review/Brief.tsx` (plain Review button, "Edit <profile>", "Last used", the D2 preselection), `src/web/review/ReplyDraft.tsx` (plain Draft replies, zero popover), More menu, `src/web/App.tsx` (onProfile goes through the route). Tests: `tests/e2e/header.e2e.ts` (key link, task chip, no profile menu), `tests/e2e/m4.e2e.ts` (profile items move to the brief radios), `tests/ui/names.test.ts` stays green. Depends on P1.
- P4 (done, db42671) Strip, Description, Review record. Files: `src/web/pr/Header.tsx` (strip), `src/web/pr/Sections.tsx` (Description), `src/web/pr/PrDetail.tsx` (the record before the Description once a review exists, D3), `src/web/review/RunLine.tsx` (record, ledger, "Not checked" reveal; the "Coverage gaps" link goes), `src/web/review/useReview.tsx` (summary out of Overview; `onGaps` goes), `src/web/review/model.ts` (gap items: skipped plus unavailable, one plain line each). Tests: `tests/ui/model.test.ts` (gap count and text), `tests/e2e/acceptance.e2e.ts` A11 and A12 (the reveal opens in place, no Log jump), the run line tests in m2 and m3. Depends on nothing.
- P5 (done, 30dd670) Drafts section. Files: `src/web/review/Drafts.tsx` (own section, rows, first one open), `src/web/pr/ThreadList.tsx` (drafts out), `src/web/review/Triage.tsx` (questions in the list). Tests: `tests/e2e/m2.e2e.ts`, `tests/e2e/diff.e2e.ts` (draft count, g d), `tests/ui/keys.test.ts`. Depends on P4.
- P6 (done, 117d936) Files and the click bug. Files: `src/web/pr/Sections.tsx` (ForgeFiles rows are buttons; new row layout), `src/web/diff/FileDiff.tsx` (a row click gets the code with `useGetCode`, then opens the file; note above the list; error in the row; sticky open row), `src/web/diff/data.ts`. Tests: `tests/e2e/diff.e2e.ts` (new: click a file without code, see progress, the diff opens, focus stays; failure path), `tests/e2e/forge.e2e.ts`, `tests/e2e/m1.e2e.ts:484` (button name). Depends on nothing. It fixes a bug, so it goes first.
- P7 (done, 6ce7bf7) Threads and Fix phase 1 UI. This is fix-ux WP2 in this layout: thread footer (reply box, Draft reply, Fix, More), reply draft in one row, "All | Need me", "Fix N" in the bar, FixPicker dialog, f and F, one bottom bar (FixBar and PostBar), the D6 default ticks. Files: per docs/plans/fix-ux.md WP2, plus `src/web/pr/ThreadList.tsx`, `src/web/publish/PostBar.tsx`, `src/web/fix/FixBar.tsx`. Tests: per fix-ux WP2, plus `tests/e2e/replies.e2e.ts` (footer). Depends on fix-ux WP1 (server, in progress in another session) and P3.
- P8 (done, 7bea7ec) Ask in the slot. Files: `src/web/ask/AskPanel.tsx` (slot with the answer list), `src/web/pr/PrDetail.tsx` (one slot state with the brief; the fold goes), the strip ("Answering..."). Tests: `tests/e2e/ask.e2e.ts`. Depends on P3.
- P9 (done) Docs. BRIEF.md:237 (no profile menu, detail layout, URL), smoke steps for Back, panels, and the file click. Owner: the docs session.
- S1 (done) Consult the session, parts A and B, per docs/plans/session-consult.md. Files: new `src/shared/consult.ts`, `src/server/review/consult.ts`, `src/server/review/consult-routes.ts`, migration 024, new `src/web/consult/`, the More menu in `src/web/pr/Header.tsx`, and the Fix list footer. Tests: `tests/review/consult.test.ts`, `tests/e2e/consult.e2e.ts`.

## 11. Known limits

- Back in Settings goes to the section heading. It does not restore the scroll position inside Settings.
- The section in the Settings URL changes only on a section link click. Scrolling Settings does not change it.
- Fix cards show only for findings of the newest review run.

## 12. User decisions (2026-10-15)
- D1: The whole "PROJ/repo #id" opens the PR. A separate repository link comes later (needs N4).
- D2: The brief preselects the profile of this PR's own brief. Else it preselects the last profile used on any PR.
- D3: Once a review exists, the Review record goes before the Description.
- D4: The sidebar becomes a rail below 1440 px.
- D5: Full width is part of the URL, so Back leaves it.
- D6: In the Fix list, your own comments and posted findings start unticked.
- D7: Commit hashes stay copy-only.
