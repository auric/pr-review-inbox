# Release 2 manual smoke test: re-review, Ask, Jira context, and the diff viewer

This test checks the Release 2 features against a real Bitbucket Server, a real Jira server, and the real `claude` CLI. The user runs it. The automated suites use fixtures, the fake CLI, and the fake Jira only. The results fill the "Release 2 (not run)" rows in integration-check.md.

## Rules

- Run this test only with explicit authorization from the user. You also need the company approval to send source code to Claude (BRIEF section 10, item 8). Part C also sends Jira issue text to Claude. Confirm that the approval covers it before part C.
- Use only the designated test pull request. Part D also uses two other pull requests that you may read, one of them large. Do not post on them.
- You need push access to the source branch of the test pull request for part A.
- Use a new, empty data folder. Never use the data folder of your daily instance.
- Do not copy tokens, host names, code, issue text, or pull request data into files, issues, or chat. Record payload shapes (key names and types) only.
- Parts A, B, and C each start one run on your Claude subscription quota. Expect four runs in total.
- In this document, `<BITBUCKET_URL>` is the base URL of the Bitbucket server, `<JIRA_URL>` is the base URL of the Jira server, and `<TEST_PR_URL>` is the URL of the test pull request.

## Preparation

1. Run `bun install`, then `bun run compile`. Expect "Built dist/bin/pr-review-inbox-<os>-<arch> (<commit>)." Record the commit.
2. Run `claude --version`. Expect 2.1.302 or later. Run `claude auth status`. Expect `"authMethod": "claude.ai"`.
3. Run `git --version`. Record it. Expect 2.38 or later, because the re-review range needs `git merge-tree --write-tree`.
4. Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the terminal. PowerShell: `Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue`.
5. Set a new data folder. PowerShell: `$env:REVIEW_LOOP_DATA_DIR = Join-Path $env:TEMP "review-loop-smoke-$(Get-Random)"`. Bash: `export REVIEW_LOOP_DATA_DIR="$(mktemp -d)"`.
6. Start the binary. Expect the startup line "PR Review Inbox (<commit>): http://127.0.0.1:7317/" with the commit of step 1.
7. Open the URL. Enter `<BITBUCKET_URL>` and your access token. Click Save. Click "Check now". If the test pull request is not in the list, paste `<TEST_PR_URL>` into the filter and click "Follow this pull request".

## A. Re-review after a push

1. Open the test pull request. Press r and start a review with the Review profile. Wait for the end of the run. Expect "Claude reviewed <hash>" and at least one finding. If it has no finding, add a small defect in step 3 instead.
2. Accept one finding. Leave one finding new. Discard one, if the run has three. Expect the "Accepted" mark on the first and one muted line with Restore for the discarded one.
3. Push one commit to the source branch. Let it fix the code of the new finding and leave the accepted finding untouched. Expect no change in the app before the next check.
4. Click "Check now". Expect the run line to show the review as stale on the source side. Expect the button "Review changes since <hash>".
5. Press c. Expect the brief to open. Press Ctrl+Enter or click "Review changes" in the brief to start the run. While the run runs, open the Files fold and click "Get the code from Bitbucket". Expect the git file list, not an error. Wait for the end of the run. Expect the Review row to show "N new, M carried, K fixed or outdated" and the range `<a>→<b>`. Expect `<a>` to be the old head and `<b>` the new head.
6. Open the Review tab. Expect the accepted finding as a carried row with "Still open after the new commits." and its accepted state. Expect the fixed finding as a closed row "Fixed in the new commits: …". Expect no row for the discarded finding.
7. Press 3. Expect a `git_diff` call with `stat_only` and a Read of `context/findings.md`. Expect no `context/changes.patch` and no `context/files.txt`.
8. Press p. Expect the confirm to show each accepted item once, on the new heads. Cancel. Do not post.

## B. Ask the PR

1. Press q. Expect the "Ask <runner>" fold to open with the focus in the box.
2. Type a question about the pull request, for example "Which callers of the changed function are not updated?". Press Ctrl+Enter. Expect the box to clear when the run starts.
3. Expect a running answer with a Cancel button. Wait for the end. Expect a Markdown answer with status, time, and tokens.
4. Click Log. Expect the run log sheet of that ask run. Expect no Agent tool in the init line and no write tool call. Close the sheet.
5. Expect no new item in the Review tab and no change in the Ready to post view. Check the pull request in Bitbucket. Expect no new comment.
6. Type a second question. Start a review from another tab at the same time. Expect a 409 message in one of them. Expect the typed question to stay in the box.

## C. Jira context

1. Open Settings. Enter `<JIRA_URL>` and a Jira personal access token. Click Save. Expect a success message. A failure must show a fixed message, without a response body. Record the message.
2. Open Settings again. Expect the token field to be empty, with a "stored" note. Open the config file in the data folder. Expect `jira.baseUrl` and no token.
3. Open the test pull request. Expect a chip for each Jira key that the pull request names. Click Fetch on one key. Expect the summary and the fetch time. Open the imported fold. Expect plain text, closed by default.
4. Click Fetch on a key that does not exist or that you may not view, if the pull request names one. Expect the fixed "not found" text and no stored row.
5. Start a review with the Review profile. Wait for the end. Press 3. Expect a Read of `context/task.md`. Expect the AI summary Context row to list the fetched task and its fetch time.
6. Record the payload shapes: the keys and types of the `myself` response, the issue `fields.summary`, `fields.description`, `fields.status`, and the comment page (`startAt`, `maxResults`, `total`, `comments[]` and each comment's `author`, `created`, `body`). Record whether `description` was null, plain text, or wiki markup. Record any redirect, with its status only. Expect no token, host name, or issue text in the record.
7. Click Remove on the chip. Expect the chip to return to Fetch.

## D. Diff viewer

1. Follow a second pull request that has no review run in this data folder. Open it and open the Files fold. Expect the forge file list and the button "Get the code from Bitbucket".
2. Click the button. Expect the git file list with added and removed counts, renames, and binary marks.
3. Open each file. Expect two number columns and a gap row between hunks.
4. Expect each inline thread as a compact card on its line. Expect a thread on a removed or context line on the old side. Expect orphaned threads and threads off the shown lines in the "Not on the lines shown" list at the file top.
5. Open a draft in the Review tab. Click "Show in diff". Expect the file to open and the row to get the focus with a static inner ring. Expect no flash, and expect the row to keep its added or removed color. Press Esc or ←. Expect the previous view and the same unread state as before.
6. In a thread, press g then d. Expect the same jump. Click "Go to thread" on a card. Expect the thread in the Activity tab.
7. Open a large pull request (more than 1,000 rows in one file, or more than 100 files). Get the code. Expect the file to load in pages and the page to scroll without a freeze. Record the file count, the largest file row count, and the load time.

## E. Record

- The build commit from the startup line.
- The OS, the Bun version, the `git` version, the `claude` version, and the Jira version from the page footer.
- The result of each step: pass or fail, with a short reason for a fail.
- The payload shapes from C6. Update the "Release 2 (not run)" rows in integration-check.md.
