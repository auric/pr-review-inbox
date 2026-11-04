# M2 and M3 manual smoke test with the real Claude Code CLI

This test checks reviews, triage, posts, replies, and reply drafts against the real `claude` CLI and a real Bitbucket Server. The user runs it. The automated suites use the fake CLI and fixtures only.

## Rules

- Run this test only with explicit authorization from the user. You also need the company approval to send source code to Claude (BRIEF section 10, item 8).
- Use only the designated test pull request. Do not touch other pull requests.
- Use a new, empty data folder. Never use the data folder of your daily instance.
- Do not copy the token, host names, code, or pull request data into files, issues, or chat.
- Each run uses your Claude subscription quota. Expect two review runs and two reply-draft runs.
- In this document, `<BITBUCKET_URL>` is the base URL of the server and `<TEST_PR_URL>` is the URL of the test pull request.

## Preparation

1. Run `bun install` and `bun run build`.
2. Run `claude --version`. Expect 2.1.302 or later.
3. Run `claude auth status`. Expect `"authMethod": "claude.ai"`. If the value is different, run `claude auth login --claudeai` first.
4. Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the terminal. PowerShell: `Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue`.
5. Make a new temp folder. PowerShell: `$env:REVIEW_LOOP_DATA_DIR = Join-Path $env:TEMP "review-loop-smoke-$(Get-Random)"`. Bash: `export REVIEW_LOOP_DATA_DIR="$(mktemp -d)"`.
6. Run `bun run start` in the same terminal. Open `http://127.0.0.1:7317/`.
7. Enter `<BITBUCKET_URL>` and your access token. Click Save. Click "Check now". If the test pull request is not in the list, paste `<TEST_PR_URL>` into the filter and click "Follow this pull request".
8. Open the test pull request. Expect no warning next to the Review button. If you see "Review needs the subscription login" or "Claude Code is not available", stop and fix the CLI.

## A. Review, triage, and post

1. Press Shift+R. Expect the review brief with the focus in "Your note".
2. Type a short note, for example "Check the error handling first." Keep the profile Review. Press Ctrl+Enter.
3. Expect "Reviewing…" in the run line, with a count of tool calls that goes up. Press 3. Expect the run log. Each subagent has its own fold. Press Esc.
4. Wait for the end of the run. Expect the review record above the Description, with the summary and a count per severity. If the record shows "Not checked: N", click it. Expect one plain line per item in place, and no jump to the run log. Record the items.
5. Accept one finding. Expect "Accepted" on it and the focus on the next draft. Discard one finding. Expect "Discarded:" and a Restore button. Edit one finding, change one word, and press Ctrl+Enter. Expect "edited by you" and "Accepted".
6. Press p. Expect a confirm with the destination and the exact text of each comment. Expect no discarded text in it.
7. Click Post. Expect "Posted." on each row, with an "Open in Bitbucket" link.
8. Click each link. Expect the comment in Bitbucket on the same file and line as in the app, with the same text.
9. Click "Check now". Expect the posted comments as threads in the app, with "Posted from a Claude Code review". Expect no unread mark on them.

## B. A finding on a context line lands on the right line

1. Start a second review, or use a finding that you did not post in part A.
2. Open the finding. Click Move. Enter the number of an unchanged line in the excerpt. Use a line with no + or − sign, near a changed line of the same hunk. Press Enter.
3. Expect "You moved it from line <old>." Expect no "Outside the diff" note. If the note shows, choose a line nearer to a changed line.
4. Accept the finding. Press p. Expect "Inline comment" and `<file>:<line>` with your line in the confirm. Click Post. Expect "Posted.".
5. If you see "Failed." with an HTTP 400, record the reason. Click "Move to general comment" and post again.
6. In Bitbucket, open the Diff tab of the test pull request and select the file. Find your line number in the right line-number column, which counts the new file. Expect the comment directly under that line. Expect the code of that line to match the excerpt line in the app.
7. In the Overview tab of Bitbucket, expect the code snippet of the comment to end on the same line. Expect no "outdated" label on the comment.

## C. The 🤖 mark on and off

1. Open Settings. Expect the switch "Mark Claude-drafted comments with 🤖" on.
2. In part A, expect each posted comment to start with 🤖 in the confirm and in Bitbucket. An edited finding also keeps the mark.
3. Turn the switch off. Accept one more draft, press p, and post it. If no draft is left, restore a discarded one first. Expect no 🤖 in the confirm and in Bitbucket.
4. Turn the switch on again.

## D. A manual reply

1. Open a thread. Click "Write a reply". Type `Thanks. **Fixed** in the next commit.`
2. Click Preview. Expect "Fixed" in bold. Click Preview again.
3. Press Ctrl+Enter. Expect the confirm "Post this reply to <name>?" with "Reply to <name> in <place>" and the exact text.
4. Click Post. Expect "Posted.".
5. In Bitbucket, expect the reply under the correct parent message, with no 🤖.
6. Click "Check now". Expect your reply in the thread, with no unread mark and no notification.

## E. Draft replies, accept one, and post (A16, U20)

1. You need a thread where it is your turn: another user wrote the newest message. If you have none, use "Draft reply" in an open thread. Then skip to step 3.
2. Click "Draft replies" in the action bar. Expect "Claude is drafting a reply…" in each requested thread and "Drafting replies…" in the run line.
3. Expect the Reply drafts row to show the number of reply drafts at the end. This confirms U20: the real CLI accepts the reply schema. If the Reply drafts row shows "Reply drafts failed.", click "Show raw output". Click Copy and keep the text locally for the record.
4. Expect a dashed card "Reply draft to <name>" in each thread, or "No reply needed: <reason>". Expect no card in a thread that you did not request.
5. Accept one draft. Expect "Accepted" and a solid border. Press p. Expect one reply, "Reply to <name> in <place>", and the text with 🤖.
6. Click Post. Expect "Posted.". In Bitbucket, expect exactly one new reply, under the message that the draft answered.

## F. The copy button

1. Find a message that has Markdown, for example your reply from part D. Click its copy icon ("Copy Markdown").
2. Expect a check icon for about 1.5 seconds. Expect no toast.
3. Paste into a text editor. Expect the raw Markdown, for example `**Fixed**` with the asterisks.
4. Click the copy icon on an AI reply draft card. Paste. Expect the raw draft text.

## G. Safety checks

1. Search the data folder for the token. PowerShell: `Select-String -Path "$env:REVIEW_LOOP_DATA_DIR\*" -Pattern "<first 8 characters of the token>"`. Expect no hit.
2. Search the terminal output and the browser console for the same text. Expect no hit.
3. Expect that your own checkout of the repository has no change. The app reviews its own cache clone only.

## H. PR view: Back, deep links, panels, and the file click

Run steps 1 to 3 right after Preparation, before part A, because they need an empty code cache. Run the other steps at any time.

1. Open the test pull request. Expect the note "Select a file to see its diff." above the Files list.
2. Click a file row. Expect a spinner and "Getting the code" in the row. Expect the diff of that file to open when the fetch ends. Expect the focus to stay on the row.
3. Click another file row. Expect its diff at once, with no second fetch.
4. Open a second pull request from the list by a click. Press the browser Back button. Expect the test pull request at its scroll position. Press Forward. Expect the second pull request.
5. Open a file of the test pull request. Copy the URL from the address bar. Open it in a new tab. Expect the same view, pull request, and open file. Close the tab.
6. Open Settings. Click a section link. Press Back. Expect the previous section, then the pull request on the next Back.
7. Change the URL to a pull request ID that does not exist. Expect "Cannot find this pull request".
8. At a window of 1440 px or wider, drag the splitter on the list edge. Expect the list width to follow, from 280 to 560 px. Focus the splitter and press the arrow keys, then Enter. Expect the default width again. Reload. Expect the width to stay.
9. Make the window narrower than 1440 px. Expect the sidebar as an icon rail. Click "Expand sidebar". Reload. Expect the full sidebar to stay.
10. Press z. Expect the sidebar and the list to hide, and "full=1" in the URL. Press Back. Expect three panes. Press z, then Esc. Expect three panes.
11. Make the window narrower than 760 px. Expect one pane at a time. Open a pull request. Press Back. Expect the list.
12. In Bitbucket, resolve an inline thread of the test pull request. In the app, press Check now. Click "Show N resolved" if it shows. Expect "Resolved by you · <time> ago" with a check icon in the thread head. If it shows only "Resolved", record U56 as refuted for 9.4. Open the file of the thread. Expect a dashed one-line card with the same mark. Press Enter on it. Expect the newest message and "Go to thread". Reopen the thread in Bitbucket, then press Check now. Expect no mark.

## Cleanup

1. Stop the app with Ctrl+C.
2. Delete the folder in `REVIEW_LOOP_DATA_DIR`.
3. Delete the test comments and replies in Bitbucket. Delete replies before their parent comments.
4. Record the result of each step, the date, the operating system, the `claude` version, and the app commit. Do not record company data.

## Acceptance map (BRIEF section 6)

Browser tests run with `bun run test:e2e` against `tests/e2e/serve.ts`, the fake Bitbucket, and the fake CLI. "Monday" names the part of this script that repeats the scenario with the real CLI.

| # | Browser test (`tests/e2e/`) | Server or logic test (`tests/`) | Monday |
|---|---|---|---|
| A1 | m1: "A1: a reply is one unread event in the right thread and stays unread after a restart" | sync/engine: "first sync and restart (A1)" | none |
| A2 | m1: "A2: a message below the viewport stays unread…", "A2: a visible message edited before its ack is read at the new version" | inbox/inbox: "POST /api/read (A2)" | none |
| A3 | m1: "A3, A4, A5: duplicates, edit, delete after the 404, multi-page data, and a visible gap" | sync/engine: "duplicates, order, and edits (A3, A4)" | none |
| A4 | m1: "A3, A4, A5: …" | sync/engine: "deletes (A4)" | none |
| A5 | m1: "A3, A4, A5: …" | sync/engine: "partial data (A5, A6)"; web/threads: "replies under a deleted parent stay under the placeholder (A5)" | none |
| A6 | m1: "A6: Bitbucket goes down mid-page: offline state, nothing deleted, then recovery" | sync/engine: "partial data (A5, A6)" | none |
| A7 | acceptance: "A7: a push after the review marks it stale, and the post stays blocked with the reason" | review/jobs: "A7: a head change marks the run stale"; publish/outbox: "a new source head blocks the post; a moved target head warns (D2)" | none |
| A8 | m3: "A8: two of the drafts are accepted, and exactly those two texts post after the confirm" | publish/plan: "A8: 2 of 6 accepted items give exactly 2 comments" | A |
| A9 | m3: "A9: the connection drops after Bitbucket accepts; the outcome is unknown, and Post again finds it with no second post" | publish/outbox: three "A9: …" tests | none |
| A10 | m2: "a usage limit is one line with the CLI message, and the inbox keeps working", "Esc closes the brief; cancel stops a running review, and nothing from it stays"; acceptance: "A10: a wrong login stops the review before it starts, …" | review/jobs: three "A10: …" tests | Preparation 3 and 8. The usage-limit shape stays synthetic (U9). |
| A11 | m2: "a failed run shows its raw output, read-only, with Copy"; acceptance: "A11: an unreadable result shows no clean result, and nothing from it can post", "A11, A12: a cut read and a documentation server that did not connect are coverage gaps, never 'no issues'" | review/jobs: "A11: a schema failure keeps the raw output and stores no items"; review/runner: the schema-failure tests | A4, E3 |
| A12 | acceptance: "A11, A12: …" | review/jobs: "an unreachable documentation server is a coverage gap, not a failure", "coverage gaps and an MCP server that did not connect make the run incomplete" | A4 |
| A13 | none: no part of it shows in the UI | review/jobs: "A13: hostile files have no effect"; review/workspace: "a hostile tree loses links and config files", "a global filter and hooksPath never run" | Gate B6 passed with the real CLI (integration-check.md). |
| A14 | m1: "A14: two pages get one notification; …"; m2: "two pages share one run: …"; m3: "two pages confirm the same items, and only one post goes out (A14)" | review/jobs: "A14: two starts give one run; …"; publish/outbox: "posts the plan once: … A14 two confirms give one POST each" | none |
| A15 | m1: "A15: a merge leaves Reviewing, stays in Needs you on my turn, and stays followed" | inbox/inbox, inbox/views, sync/engine: the A15 tests | none |
| A16 | replies: "Draft replies: three your-turn threads get inline drafts, one needs no reply; Accept and p post one reply under its parent" | review/replies: "none gives an empty discarded item; accept needs a body; the post plan gives replies, never a general comment"; publish/outbox: "a reply sends one POST with text and parent; …" | E |
| A17 | acceptance: "A17: a comment that tells the AI to answer another thread is data; no draft reaches a thread you did not select" | review/replies: "comment text never reaches stdin, the note only in its section, and an answer for an unrequested thread drops" | E4 |
