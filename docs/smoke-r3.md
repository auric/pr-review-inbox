# Release 3 manual smoke test: Fix it, Jira Markdown, and Jira attachments

This test checks the Release 3 features against a real Bitbucket Server, a real Jira server, your own git clone, and the real `claude` CLI. The user runs it. The automated suites use fixtures, the fake CLI, the fake Bitbucket, the fake Jira, and temp clones only. The results fill the "Release 3 (not run)" rows in integration-check.md: U21 to U29, B11, B12, B15, and B16. Part I checks the prompt features that came after Release 3. Part L checks thread resolve and fills U62 to U67. Part M checks answered questions, out-of-date reply drafts, revisions, the session steps, and MCP redirects.

## Rules

- Run this test only with explicit authorization from the user. You also need the company approval to send source code to Claude (BRIEF section 10, item 8). Parts E and F also send Jira issue text and attachments to Claude. Confirm that the approval covers them before part E.
- Use only the designated test pull request. You must be its author, because Fix works only on your own pull requests. You need push access to its source branch.
- A second user writes the review comments of the test pull request. Do not post on other pull requests.
- Use a new clone of the test repository for this test. Never use a clone that holds your daily work. The app commits in it.
- Use a new, empty data folder. Never use the data folder of your daily instance.
- The app never pushes. Each push in this test is your own `git push`.
- Do not copy tokens, host names, code, comment text, issue text, or file names into files, issues, or chat. Record payload shapes (key names and types), counts, and tag names only.
- Expect about twenty-nine runs on your Claude subscription quota: eight in the gate, two in part A, one in part B, one interactive session in part D, one in part E, one in part F, one in part I, two in part J, in part K one interactive session and two session runs, two in part L, and ten in part M. A session run loads the full history of the session, so it can cost more than a review.
- Part I sends your project instructions to Claude. Turn on the global CLAUDE.md only when it holds nothing that the approval does not cover.
- In this document, `<BITBUCKET_URL>` is the base URL of the Bitbucket server, `<JIRA_URL>` is the base URL of the Jira server, `<TEST_PR_URL>` is the URL of the test pull request, `<KEY>` is a Jira issue key that the test pull request names, and `<CLONE>` is the absolute path of your test clone.

## Preparation

1. Run `bun install`, then `bun run compile`. Expect "Built dist/bin/pr-review-inbox-<os>-<arch> (<commit>)." Record the commit.
2. Run `claude --version`. Expect 2.1.295 or later. Run `claude auth status`. Expect `"authMethod": "claude.ai"`.
3. Run `git --version`. Record it. Expect 2.38 or later.
4. Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the terminal. PowerShell: `Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue`.
5. Set a new data folder. PowerShell: `$env:REVIEW_LOOP_DATA_DIR = Join-Path $env:TEMP "review-loop-smoke-$(Get-Random)"`. Bash: `export REVIEW_LOOP_DATA_DIR="$(mktemp -d)"`.
6. Ask the second user to write seven comments on the test pull request. T1 to T4 each ask for one small change in a text source file, for example a missing null check. T5 asks for a change that the code already has. T6 asks a question about the code. T7 says "Thanks, looks good." and asks for nothing.
7. Make a new clone outside the data folder: `git clone <repository URL> <CLONE>`, then `git -C <CLONE> switch <source branch>`. Run `git -C <CLONE> config user.name` and `git -C <CLONE> config user.email`. Expect your own identity. If your commits use a signing prompt, record it. The app waits 120 s for a commit.
8. Start the binary. Expect the startup line "PR Review Inbox (<commit>): http://127.0.0.1:7317/" with the commit of step 1.
9. Open the URL. Enter `<BITBUCKET_URL>` and your access token. Click Save. Click "Check now". If the test pull request is not in the list, paste `<TEST_PR_URL>` into the filter and click "Follow this pull request".
10. Open Settings. Enter `<JIRA_URL>` and a Jira personal access token. Click "Save Jira settings". Expect "Saved. Jira accepted the token."

## Gate B11, B12, B15, and B16

1. Run `bun scripts/gate/claude-checks.ts --only B11,B12`. Expect PASS for B11 and B12 in the output and in `.gate0/v3-local/results*.json`. B11 checks U21 with a null judgement and a 2 KB `new` string. B12 checks U23 with a PNG under `--restricted`. The color answer of B12 is INFO only.
2. Run `bun scripts/gate/sanitize-claude.ts`. Expect exit code 0 and counts only.
3. Record each result. A B12 FAIL means that runs list images in task.md only. Record it and go on.
4. Run `bun scripts/gate/claude-checks.ts --only B15`. B15 checks whether the CLI loads `work/CLAUDE.md` by itself. Expect FAIL. Since e217a62, runs do not rely on it: the prompt holds the project instructions (part I). The FAIL records the CLI behaviour. A PASS means that the CLI now loads the file, so the main agent gets the text twice. Record a PASS and report it.
5. Run `bun scripts/gate/claude-checks.ts --only B16 --dry-run`. Expect "DRY-RUN B16 calls=3" and no model call. Then run `bun scripts/gate/claude-checks.ts --only B16`. It makes a throwaway session in a temp folder and forks it twice. It never opens one of your sessions. Expect PASS: (a) the original file keeps its hash, (b) init lists only Read, Grep, Glob, and StructuredOutput and no MCP server, (c) the structured word, and (e) the origin word from another folder. Record the INFO parts: (d) the new transcripts with `--no-session-persistence`, the folder of the fork transcript, `init.permissionMode`, `init.model`, the hook events, and the history replay. A FAIL blocks part K steps 12 to 19. Record it and report it.

## A. Fix one comment and commit it in your clone

1. Open the test pull request. Click "Draft replies". Wait for the end of the run. Open each thread.
2. Expect a judgement chip on each reply draft: Valid, Partly valid, Not valid, or Question. Expect no chip on T7, because its draft has no judgement ("no action"). Expect Fix in the footer of each open thread, whatever its chip. Expect "Copy prompt for Claude Code" in the More menu of each open thread. Record the chip of each thread.
3. On T1, click Fix in the thread footer. Expect the Fix list with only T1 ticked. Click "Propose fixes for 1". Expect "Proposing a fix." and "Fix: checking 1 point" in the bottom bar. Wait for the end of the run. Expect a fix card under T1 with the note and each edit as a diff with a checkbox. Read every edit.
4. Click Log on the fix card. Expect no Edit, Write, or Agent tool in the init line. Count the proposed edits and the edits that the coverage lists as skipped. Close the log.
5. Add a pre-commit hook in the clone. Write `<CLONE>/.git/hooks/pre-commit` with the two lines `#!/bin/sh` and `echo pre-commit >> "$HOME/rl-smoke-hook.txt"`. On Linux, run `chmod +x` on it.
6. Click the fix bar button "Apply 1 edit from 1 comment". Expect the Apply dialog with "No folder set". Click "Set the folder". Enter `<CLONE>`. Click "Save folder". Expect the folder path, "On <source branch> at <short hash>", and no clone problem.
7. Change one tracked file in the clone and do not stage it. Close the dialog and open it again. Expect "The clone has changes to tracked files. Commit or stash them first." and a disabled "Apply and commit". Expect "Commit to an app branch" to stay available. Run `git -C <CLONE> restore .`. Open the dialog again. Expect no clone problem.
8. Expect the default message "Fix review comment <id> on PR <n>" with one body line for T1. Click "Apply and commit". Expect "Committed <short> on <source branch> in your clone. Push it when you are ready." on the fix card.
9. In the clone, run `git log -1 --format="%an <%ae>%n%s"`. Expect your identity from step 7 of the preparation and the message. Run `git show --stat HEAD`. Expect only the edited files. Run `git status --porcelain --untracked-files=no`. Expect no output. Expect one line in `$HOME/rl-smoke-hook.txt`.
10. Expect a "Fixed in <short>." reply draft on T1 in place of its earlier draft. Expect "Waiting for <short> on the PR branch. Push it. The next sync finds it."
11. Click Undo on the fix card. Expect "You undid the fix commit <short>." In the clone, expect HEAD at the old commit and a clean status. Expect the "Fixed in" draft to be gone and the reply draft from before the commit back under the thread.
12. Click Apply and commit again with the same edit. Expect a new commit and a second line in the marker file.
13. Accept the "Fixed in" draft. Expect "1 draft cannot post now" in the bottom bar. Press p. Expect the draft under "Cannot post now" with "Commit <short> is not on the PR source branch yet. Push it. The next sync finds it." Expect Post off. Press Esc. Expect no new comment in Bitbucket.
14. Run `git -C <CLONE> push`. Click "Check now". Expect the waiting text to go. Press p and confirm. Expect exactly one reply "Fixed in <short>." under T1 in Bitbucket.
15. Delete `<CLONE>/.git/hooks/pre-commit` and `$HOME/rl-smoke-hook.txt`.

## B. Fix the default ticks, untick one edit, and a failing hook

1. On Windows only: make a second clone with `git clone -c core.autocrlf=true <repository URL> <CLONE2>` on the source branch. In the Apply dialog of part B, click Change and set `<CLONE2>`. Use `<CLONE2>` as `<CLONE>` in this part. On Linux, keep the first clone.
2. Click "Fix" next to "Draft replies". Its badge counts the open threads with a live message. Expect the Fix list with ticks on each thread whose draft is Valid or Partly valid and not posted. Expect T1 unticked with "Fixed in <short>", because a fix commit holds its edit. Click "Propose fixes for <k>". Wait for the end of the run.
3. Untick one edit. Expect the fix bar to count the remaining edits and comments. Open the Apply dialog. Expect the default message "Fix <k> review comments on PR <n>" with one body line per thread.
4. Write `<CLONE>/.git/hooks/commit-msg` with the two lines `#!/bin/sh` and `echo "smoke: commit-msg refused" >&2; exit 1`. On Linux, run `chmod +x` on it.
5. Click "Apply and commit". Expect "The commit failed. The edits stay staged. Fix the problem, then commit in your clone, or Undo." with "smoke: commit-msg refused" in the dialog. Close the dialog. Expect the same staged text on the fix card. Run `git -C <CLONE> diff --cached --stat`. Expect only the files of the ticked edits.
6. Click Undo. Expect a clean status in the clone.
7. Delete the commit-msg hook. Click "Apply and commit" again. Expect one commit. Run `git show HEAD`. Expect the ticked edits and not the unticked edit.
8. On Windows: run `git -C <CLONE> ls-files --eol` for the edited files. Expect `i/lf w/crlf` for files that use LF in the repository. Run `git show --stat HEAD`. Expect only the changed lines, not whole files. Run `git status --porcelain --untracked-files=no`. Expect no output.
9. Do not push. Click Undo. Expect HEAD back at the commit before step 7.

## C. Commit to an app branch

1. Open the Apply dialog of the part B fix. Click Change. Click "Clear the folder". Expect "No folder set".
2. Click "Commit to an app branch". Expect "Committed <short> to an app branch. Run these commands in your clone:" with a `git fetch` command and `git merge --ff-only FETCH_HEAD`. Expect the cherry-pick warning.
3. Copy both commands. Run them in `<CLONE>`. Expect a fast-forward to the same hash `<short>`. Run `git -C <CLONE> log -1 --format=%h`. Expect `<short>`.
4. Run `git -C <CLONE> reset --keep HEAD~1` to drop the commit. Click Undo on the fix card. Expect "You undid the fix commit <short>." and no fetch commands.

## D. Copy the prompt for Claude Code

1. On an open thread, open the More menu in the thread footer and click "Copy prompt for Claude Code". Expect "Copied the prompt." and "Open a terminal in <CLONE>, run claude, and paste."
2. Paste the prompt into a text editor. Expect the PR identity, the branch, the path and line, the rule ("Judge whether the review point is valid. Fix it only if it is valid. Do not commit or push."), and the comment text as an indented block. Expect no shell command.
3. Open a terminal in `<CLONE>`. Run `claude`. Paste the prompt. Expect a judgement first. If Claude proposes an edit, expect a permission prompt for each file change.
4. Exit Claude Code. Expect no new commit and no push: `git log -1` is unchanged. Run `git -C <CLONE> restore .` to drop the edits.

## E. Jira Markdown and tasks per run

1. Pick `<KEY>` with a description that has a table, a code block, a user mention, and an embedded image attachment. If the test pull request names no such issue, add its key to the pull request description and click "Check now".
2. Next to "Draft replies", expect the chip "<KEY> · not fetched". Click its Fetch button. Expect "<KEY> · fetched today".
3. Press Shift+R. Open the task fold. Expect Markdown: headings, lists, the table, and the code block. Expect the mention as a plain name. Expect the image as its alt text, because it is not downloaded. Expect each link to open in a new tab only on a click.
4. Open the browser network tab and reload. Open the task fold again. Expect no request to the Jira host. Expect requests to 127.0.0.1 only.
5. In a browser where you are logged in to Jira, open `<JIRA_URL>/rest/api/2/issue/<KEY>?fields=description&expand=renderedFields`. Record whether `renderedFields.description` exists. Record its tag names only, for example `p h3 ul li table tr th td pre a img`. Open `<JIRA_URL>/rest/api/2/issue/<KEY>/comment?expand=renderedBody`. Record whether `renderedBody` exists (U25).
6. Click "Draft replies". Wait for the end of the run. Expect the run line to show `<KEY>`. Its tooltip says "Task text that this run read: <KEY>".
7. Click Remove on the chip next to Draft replies. Expect the chip "<KEY> · not fetched". Expect the run line to keep `<KEY>`. Fetch the task again.
8. Press q. Expect the same task chip in Ask, in the panel slot. Press Esc.

## F. Jira attachments

1. Open the task fold. Open "Attachments (N)". Expect the name, size, type, and "Not downloaded." for each file. In the Jira browser tab, open `<JIRA_URL>/rest/api/2/issue/<KEY>?fields=attachment`. Record the key names and types of one entry of `fields.attachment` (U26). Expect no download request at the fetch.
2. Download an image (PNG or JPEG), a text log, and a binary file such as a dump or an archive. Use Download on each row, or "Download all". Expect "Downloaded." on each. A failure shows a fixed text. Record it. The terminal shows "Jira download failed: …". Record its kind and status only (U27, U28). A downloaded file proves that the byte count equals the listed size (U29).
3. Expect the downloaded image inline in the description.
4. Click "Save <name>" on the log. Expect a browser download with that file name.
5. Click "Open folder". Expect the file manager to open the task folder, not a file. Without a file manager, expect the path with "Copy the folder path".
6. Turn on "Include <name> in runs" for the image. Expect a dialog that names the company AI policy. Expect "Include in runs" disabled until you tick "My company AI policy allows sending this file to an AI service." Press Esc. Expect the switch to stay off. Turn it on again, tick the box, and click "Include in runs". Expect "Included in runs." Include the log the same way.
7. Expect no include switch for the binary file and "Downloaded. Runs list it by name only."
8. Press Shift+R and start a review with the Review profile. Wait for the end. Press 3. Expect a Read of `context/task.md`, a Read of `context/attachments/<id>.png` or `.jpg` without an error (U23, U24), and a Read of `context/attachments/<id>.txt`. Expect no file for the binary file in `context/attachments/`. Press Esc.
9. Open the AI summary. Expect the Context row to name `<KEY>` with the fetch time of this run.
10. Click Delete on each file. Expect "Not downloaded." again. Click Remove on the task chip. Expect the task folder to be gone from the data folder.

## G. Linux binary under WSL

1. Run the "Linux binary under WSL" check of docs/smoke-m4.md with the binary of this build. Record the result here.

## Capture U2 and U12 (Gate A)

This part records the range comment (U2) and the orphaned comment after a push (U12) of integration-check.md, Gate v3. The script sends GET requests only. It uses the token from `bun scripts/gate0/set-token.ts`.

1. Step a: in the Bitbucket web UI, open the test pull request diff. Select two or more lines and add one comment on that range.
2. Run `bun scripts/gate0/capture-a.ts --pr <TEST_PR_URL> --step a`.
3. Step b: push one commit to the source branch that changes the line of an existing inline comment. Do not delete that comment.
4. Run `bun scripts/gate0/capture-a.ts --pr <TEST_PR_URL> --step b`. If you did both steps before the first run, use `--step both` once.
5. Expect `hits=0 structure diffs=0` in the sanitizer line. Raw responses go to `.gate0/a-capture/raw/` (gitignored). Sanitized copies go to `fixtures/bitbucket/real-u2-*.json` and `real-u12-*.json`.
6. Open each `real-u2-*` and `real-u12-*` file. Search for names, e-mail addresses, the host, project and repository keys, file paths, code, hunk headers (`context`), and comment text. If you find one, delete the file and report the field name only. Do not commit it.
7. Send back the full console output of each run. It holds key names, enum values, line numbers, flags, and counts only.
8. Delete your range comment by hand. Revert the step b commit if the test branch needs it.

`bun scripts/gate0/capture-a.ts --dry-run` runs the sanitizer and the summary on existing fixtures. It sends no request.

The capture of 2026-10-12 recorded U2 and U12. Tests use `activities-u2-range.json`, `activities-u12-orphaned-range.json`, and `pull-request-commits-u12.json`. A new capture writes `real-*` files again. Rename only the files that tests need, and delete the others.

## I. Review prompts, skills, and project instructions

Use a test pull request that changes C++, C, or Python files for step 4. If it has none, record step 4 as not run.

1. Press r on the test pull request. Expect the brief, not a run. Expect the run setup of the default profile, with "Language checks" for Review. Open the Review menu and pick Explain. Expect the brief with Explain. Press Esc. Open Settings > Review profiles. Expect Review as the default, unchanged.
2. In Settings > Review profiles > Review, open the skills dialog. Tick one skill and mark it "Always use". Expect the chip "<skill> · Always". Save.
3. In Settings > Project instructions, open the test repository. Put "In the summary, give the word KIWI-SMOKE." into "Extra text (optional)". Expect the preview line "A run gets <size> from <n> sources". Open "Show the text". Expect the trust line first and the heading "## From PR Review Inbox settings". Turn on "Use your global CLAUDE.md" only under the rule above. Expect the global file as the first source. A file that does not load shows as "Not loaded: <file>".
4. Press r and click "Start review". Wait for the end of the run. Expect the server terminal to show "Review run <id> language checks:" with the languages of the change. Expect the run row and the run log to list the skill with "(always)" and the instruction sources with sizes.
5. Press 3. Expect a Read of `skills/<folder>/SKILL.md` among the first tool calls of rl-main. If coverage says "Skill <id> (always use): the model did not read SKILL.md.", record it.
6. Expect the word KIWI-SMOKE in the summary. Expect no finding with severity nit, because the note asks for none. Count the findings per severity and record the counts. Expect no finding for style, naming, or formatting.
7. Disable the plugin of the marked skill, or rename its folder in your Claude config. Press r. Expect the brief to show "Skill <id> is marked Always use, but it is not found." with the fix hint, and Start to be disabled. Expect the skills dialog to show "Not found in <runner>. Runs do not start while it is marked Always use." Restore the skill. Expect Start to be enabled again.
8. Remove the Always use mark and the extra text. Turn off the global switch.
9. After the run of step 4, expect the line "Subagents: rl-reviewer ×N (<model>)" under the run row when the run used subagents. Press 3. Expect each rl-reviewer row with its model, tokens, and duration, and its tool calls nested under it. Press Tab to an agent row, then Enter. Expect it to fold and unfold. A call of an agent that the app did not define shows "built-in".

## J. Fix on your own comments and on threads without a reply draft

Fix for threads and for review findings ships with docs/plans/fix-ux.md WP2 to WP4.

1. As the PR author, write two comments on the test pull request. T8 asks for one small change in a text source file. T9 asks for a change that the code already has. Click "Check now".
2. Expect no reply draft for T8 and T9, because your message is the newest in each. If no thread waits for you, expect the Draft replies hint "Your message is the newest in each open thread. They wait for the other person."
3. Expect the action bar button "Fix N" to be enabled. Click it. Expect the picker with one checkbox per open, unresolved thread with a live message. Expect T8 and T9 in the list and unticked. Expect ticks only on threads with a Valid or Partly valid draft.
4. Tick only T8 and T9. Click "Propose fixes for 2". Wait for the end of the run. Expect edits for T8. Expect T9 with no edit and a reason that says the code is already right. Do not apply.
5. Click Log on the fix card. Expect no Edit, Write, or Agent tool in the init line. Close the log.
6. Focus T8 and press f. Expect the Fix list with only T8 ticked. Press Enter on "Propose fixes for 1". Expect a fix run for T8 only. Wait for the end of the run. Do not apply.
7. Resolve T9 in Bitbucket. Click "Check now". Press F. Expect T9 absent from the picker and the count of resolved threads in the picker text. Close the picker.
8. Ask the second user for a test pull request where you are a reviewer. Open it. Do not post on it. If none exists, record this step as not run. Expect no Fix button in the action bar. Focus a thread and press f. Expect the toast "Fix works only on your own pull requests."
9. Delete T8 and T9 in Bitbucket by hand.
10. Run a review on the test pull request. Accept one finding that names a real change. Do not post it. Click Fix in the draft row of the finding. Expect the Fix list with only that finding ticked, in the group "Review findings that you did not post". Click "Propose fixes for 1". Expect a fix card under the finding.
11. Apply the edit and commit in your clone. Expect the finding to show "Fixed in <short>" and to leave Ready to post. Expect p to post nothing for it.
12. Click Restore on the finding. Expect "Accepted", the note "Fixed in <short>. You restored it.", and the finding back in Ready to post. Press F. Expect the finding ticked in the Fix list. Close the list. Click Undo on the fix card. Expect "Accepted" and no "Fixed in". Discard the finding.

## K. Consult the session that wrote the code

Part A (package S1, changed 2026-10-20), part C (package S2), and part D (package S3) of docs/plans/session-consult.md. Part B (paste the answer) was removed on 2026-10-20. Run steps 12 to 27 only after a B16 PASS.

1. Use the test pull request after part J. Keep at least one open reviewer thread, one thread of your own, one resolved thread, and one review finding that is not posted. If Files offers "Get the code", click it.
2. Open More (…) in the action bar. Click "Copy for your session…". Expect four groups, all ticked, each with its count, and the line "N items, X KB."
3. Untick "Resolved threads". Reload the page. Open the dialog again. Expect "Resolved threads" unticked. Tick it again.
4. Click "Copy N items". Paste the clipboard into an empty editor window. Expect the PR key, both branches, the head commit, the task keys, and no changed-file list. Expect the section "What to do" with six numbered steps, and step 6 "Ask me before you push, post a comment, or resolve a thread." Expect the items between `<suggestions-XXXX>` and `</suggestions-XXXX>`, each in `<item-XXXX id="T<id>" status="open">` or `status="resolved"`, with the same suffix XXXX in every tag. Expect for each inline item an "Outdated" line and one "Anchor line N …" line, and no code block around it. Expect each full conversation and the label "PR Review Inbox's AI view (may be wrong)". Expect no JSON answer format. Do not save the text.
5. Open a terminal in `<CLONE>`. Run `claude` and resume the session that wrote the code, or start a new one. Paste the text. Expect the session to check the branch and the head commit first. Expect a result per open item (valid, partly valid, not valid, question, or already done) with file and line, before any edit. Expect edits only for the valid parts, a test run, a reply per open item, and one commit that lists the item IDs. Expect the session to show the replies and the commit, and to ask before a push, a post, or a resolve. Answer no. Expect no edit for a resolved item.
6. Run `git -C <CLONE> status` and `git -C <CLONE> log -1`. Expect a clean tree and the commit of the session. Expect no push and nothing new on the pull request in Bitbucket.
7. In the text of step 4, find a comment with several lines. Expect each line of the comment text indented by 4 spaces, so no comment line starts a tag.
8. Open the dialog again and copy again. Expect a new suffix in every tag.
9. Open More. Expect no "Paste the answer…". Press F. Expect the Fix list footer with "Copy for your session" and no paste link. Close the list.
10. Optional: push the commit of the session yourself. Click "Check now". Click "Review changes since", then Draft replies. Expect the results to come back as resolve proposals and reply drafts.
11. If you do not keep the commit, reset `<CLONE>` to the earlier head yourself.
12. Open Settings, Clones. Expect the switch "Let PR Review Inbox find and consult your Claude Code sessions" off, and its text about the folder, branch, time, and title lines and the plan quota. Open the test pull request and open More. Expect no "Ask your session…".
13. List the files in the projects folder of the session of step 5 (`~/.claude/projects/<folder>`). Record the count of `.jsonl` files only.
14. Turn the switch on. Open More and click "Ask your session…". Expect the four groups and, under "Session on branch <source branch>", the sessions of that branch. Expect a session in `<CLONE>` first, with "In your clone". Each row shows a title, the folder name, the last use, the size, and a token estimate. Expect the cost line. Expect no message text of a transcript anywhere in the dialog.
15. Pick the session of step 5. Click "Ask the session". Expect "Your session is answering…" and a "Session" row under the review with a tool call count. Run `git -C <CLONE> status` meanwhile. Expect no change.
16. Wait for the end. Expect the dialog "Answer of your session" with one preview row per entry, and no change before Apply. Click "Apply N changes". Expect the result line, and nothing new on the pull request in Bitbucket. Click Close. Click "Show the answer" in the Session row. Expect the preview again. Close it.
17. List the projects folder of step 13 again. Expect no new `.jsonl` file: the run passes `--no-session-persistence` (gate B16 (d)). Record the count. Resume the session of step 5 in a terminal. Expect no message of the session run in its history. Exit without a prompt.
18. Start a second session run, then click "Cancel the run". Expect "The session run was cancelled." and the Session row "Cancelled". Click "Ask again". Expect the list. Click Cancel.
19. Turn the switch off. Expect no "Ask your session…" in More. Discard the remaining session drafts.

Part D (package S3): steps 20 to 27. Run them after step 19 and a B16 PASS. The real CLI has not shown the edit volume of this mode yet (integration-check.md U61).

20. Turn the switch on again. Keep one open reviewer thread that asks for a small code change. Open More and click "Ask your session…". Expect "Your session" with "Judge only" picked, and the cost line without a turn count.
21. Pick "Judge and propose fixes". Expect the cost line to add "Judge and propose fixes allows up to 62 turns instead of 12." Close the dialog and open it again. Expect "Judge and propose fixes" still picked.
22. Pick the session of step 5. Click "Ask the session". Expect "Your session is answering and proposing fixes…". Run `git -C <CLONE> status` meanwhile. Expect no change.
23. Wait for the end. Expect the Session row "N answers, M edits". Expect the preview row of each accepted item with an edit to say "Adds K proposed edits from your session." Expect no fix card and no Fix bar before Apply. Record N, M, the turn count from the log, and the run time.
24. Click "Apply N changes". Expect the result line with "Added the fix of your session". Expect no "Open the Fix list" button. Click Close. Expect a fix card "from your session" under each accepted thread or finding with an edit, and the bar "Fix from your session: M edits proposed". Expect nothing new on the pull request in Bitbucket.
25. Click Log on a fix card. Expect the log of the Session run. Click "Review edits". Expect the focus on the first card. Read each edit. Untick one edit if it is wrong.
26. Click "Apply …" in the bar. Commit in your clone. Expect one new commit with only the ticked edits, and a "Fixed in <short>" draft under each fixed thread. Do not push. Click Undo on the card. Expect the clone back at its earlier head.
27. Open "Show the answer" in the Session row and click Apply again, then Undo in the result view. Expect the announcement "Removed the fix of your session." and no fix card from that run. Discard the remaining session drafts. Turn the switch off.

## L. Resolve threads

Part L writes to the test pull request: it resolves and reopens threads. Use only the test pull request.

Gate run: steps 1 and 2 ran on 2026-10-20 against Bitbucket Data Center 9.x. integration-check.md U62 to U67 hold the result. Step 4 (U66) did not run. Run steps 1 and 2 again only after a Bitbucket upgrade.

1. Run `bun scripts/gate0/resolve-thread.ts --dry-run`. Expect "dry run: PASS". It sends no request.
2. Write a new general comment "Resolve gate." on the test pull request. Copy its comment ID from its link. Run `bun scripts/gate0/resolve-thread.ts --pr <TEST_PR_URL> --thread <ID>`. Expect the lines "resolve PUT", "after resolve", "activities", "reply to resolved", "stale PUT", "reopen PUT", and "after reopen". "reply to resolved" shows whether Bitbucket refused one reply in the resolved thread. If it shows "taken=true", the script deleted that reply again. Expect "threadResolved=false" in the last line, so the thread is open again. Send back the full console output. It holds status codes, versions, and booleans only.
3. If a line says "text unchanged=false", stop part L and report it. The PUT then changes the comment text, and Resolve must not ship.
4. Optional: the second user runs step 2 with `--forbidden <ID>` and the ID of a thread that you started. They need their own token from `bun scripts/gate0/set-token.ts`. Record the status of the "forbidden PUT" line.
5. Ask the second user to reply "Done?" in your "Resolve gate." thread. Click "Check now". Click Draft replies. Expect a draft card in that thread with the box "Resolve after posting". If Claude proposes the resolve, expect the box ticked and a line "Claude proposes it:" with its proof. Else tick the box yourself.
6. Untick the box, then tick it again. Expect the live text "The thread resolves after the post." Accept the draft. Press p. Expect the line "Then resolves the thread." or, for a draft without text, "Resolves the thread. No reply is posted." Click Post.
7. Expect "Posted and resolved." or "Resolved.", then the thread under "Resolved" with "Resolved by you". In Bitbucket, expect the reply first and the thread resolved.
8. Open the thread. Click "Reopen" in its footer. Expect the thread open in the app and in Bitbucket. Press x. Expect it resolved again with no question.
9. Open an open thread of the second user. Click "Resolve" in its footer. Expect the question "<name> started this thread. Resolve it on Bitbucket?". Click Cancel. Expect no change in Bitbucket. Press x, then click Resolve. As the PR author, expect the thread resolved. Reopen it.
10. Ask questions in a general comment and as a reply in a thread of the second user. Ask the second user to answer all questions in your thread and only one question in the other. Click "Check now", then Draft replies. Expect a "Settled" chip with "Resolve after posting" ticked on your thread, with the quoted answer as proof and no text that announces the resolve. In the thread of the second user, expect a "Not settled" or "Follow-up question" chip, a reply that asks the open question, and the box not ticked.
11. Optional, one run: post one finding of a review run as an inline comment. Push a commit that fixes it. Click "Check now", then "Review changes since". If the run finds the finding fixed, expect a "Resolve proposal" under its thread with the box ticked.
12. Delete the "Resolve gate." comment by hand if the test branch needs it.

## M. Answered questions, out-of-date drafts, revisions, session steps, and MCP redirects

Part M checks commits b7013d1, 4a0c12f, 3398e26, 2b89d52, and e4f671a. "(real CLI)" marks a step that runs `claude`. The other steps need no run. Tick one box per step: `[x] pass` or `[x] fail`, with a short reason for a fail. Use only the test pull request. Part M posts review comments there, and the second user answers them.

Preparation for steps 1 to 12:

1. (real CLI) Press r on the test pull request and start a review with the Review profile. Wait for the end. Accept two questions and three findings. If the run gave fewer, edit other drafts into questions or findings with your own text. Press p and post them. Expect one general comment with both questions and one inline comment for each finding. [ ] pass [ ] fail
2. Ask the second user to answer as follows. General comment: answer question 1 fully, answer question 2 only in part. Finding F1: "Yes, this is on purpose." with a reason. Finding F2: an answer that shows a real defect, for example "Right, this also leaks when the call throws." Finding F3: no answer. Click "Check now". [ ] pass [ ] fail

Answered questions in a review (b7013d1):

3. (real CLI) Press r and start a review with the Review profile. Wait for the end. Expect the run line to end with "N answered threads", with N = 3 (the general comment, F1, and F2). Expect no schema error in the run row. [ ] pass [ ] fail
4. Press 3. Click "Show raw output". Expect the key `answered` in the structured output, with one entry per answered question. Expect each entry to have `thread`, `question`, `outcome`, `evidence`, `reply`, and `finding`. Record the count of entries and the outcome of each. Record no text. [ ] pass [ ] fail
5. Open the F1 thread. Expect a reply draft "from the review" with the chip "Settled", a short thanks, and "Resolve after posting" ticked, because you started the thread. Expect "Claude proposes it:" with a quote of the answer as proof. [ ] pass [ ] fail
6. Open the general comment thread. Expect one reply draft for both questions, with the chip "Follow-up question". Expect the reply to ask the open part of question 2. Expect "Resolve after posting" not ticked. [ ] pass [ ] fail
7. Open the F2 thread. Expect a new finding in Drafts for the defect, and a reply draft in the F2 thread that points to it. Expect the box not ticked. [ ] pass [ ] fail
8. Open the F3 thread. Expect no reply draft. [ ] pass [ ] fail
9. (real CLI) Edit the F1 draft and change one word. Start one more review with the Review profile. Expect your edited F1 draft to stay unchanged. Expect no second draft in the F1 thread. [ ] pass [ ] fail
10. (real CLI) Open the Review menu and pick Explain. Start it and wait for the end. Expect no "answered threads" in its run line and no new reply draft. Press 3. Expect no Read of `context/questions.md` in the log. [ ] pass [ ] fail
11. (real CLI) Push one small commit to the source branch yourself. Ask the second user to answer F3 fully. Click "Check now", then "Review changes since". Wait for the end. Expect the run line to count 1 answered thread, and a "Settled" draft with the box ticked in the F3 thread. [ ] pass [ ] fail
12. Accept the F1 draft. Press p. Expect the line "Then resolves the thread." Click Post. Expect the reply first and the thread resolved in Bitbucket. Discard the other answer drafts and the new finding. [ ] pass [ ] fail

No Accept and no Edit on an out-of-date reply draft (4a0c12f):

13. (real CLI) Ask the second user for a new comment that asks for a change. Click "Check now", then "Draft replies". Wait for the end. Do not touch the draft. Ask the second user to add one more message in that thread. Click "Check now". [ ] pass [ ] fail
14. Expect the draft card to show "New messages since this draft." with "Draft again" and "Reply to the newest as is". Expect no Accept button and no Edit button. Expect Discard. [ ] pass [ ] fail
15. Focus the draft. Press a, then e. Expect the hint "New messages arrived after this draft. Draft it again, or reply to the newest as is." for each key. Expect no change to the draft. [ ] pass [ ] fail
16. Open the browser developer tools on the network tab. Reload the page. Find the response of `reply-drafts` for the test pull request. Note the `id` and the `revision` of the out-of-date draft. In the console, run `fetch("/api/items/<id>", { method: "POST", headers: { "Content-Type": "application/json", "X-RL-Session": document.querySelector('meta[name="rl-session"]').content }, body: JSON.stringify({ action: "accept", revision: <revision> }) }).then(async (r) => console.log(r.status, await r.text()))`. Expect status 409 and the text "New messages arrived after this draft. Draft it again, or reply to the newest as is." Run it again with `action: "edit"` and `body: "x"`. Expect 409 again. Do not copy the session token anywhere. [ ] pass [ ] fail
17. Accept a current draft in another thread. Ask the second user to add one more message in that thread. Click "Check now". Expect the card with "Undo accept" and no Edit. Click "Undo accept". Expect the draft back as not accepted, still with no Accept and no Edit. [ ] pass [ ] fail

Reply to the newest as is, and revise instead of replace (3398e26):

18. On the out-of-date draft of step 14, click "Reply to the newest as is". Expect no new run in the run line. Expect the same text, now as a reply to the newest message, and Accept and Edit back. [ ] pass [ ] fail
19. Edit that draft. Ask the second user to add one more message. Click "Check now". Expect "New messages since this draft." and the button "Revise my reply" instead of "Draft again". [ ] pass [ ] fail
20. (real CLI) Click "Revise my reply". Wait for the end. Expect your draft unchanged and a revision under it as a word diff: struck text leaves, underlined text comes in. Expect your points and tone to stay. Expect "Use revision" and "Keep mine". [ ] pass [ ] fail
21. (real CLI) Click "Keep mine". Expect the revision gone and your exact text. Accept the draft. Repeat steps 19 and 20. Click "Keep mine". Expect your text still accepted. [ ] pass [ ] fail
22. (real CLI) Repeat steps 19 and 20 once more. Click "Use revision". Expect the revised text as the draft, not accepted. [ ] pass [ ] fail
23. (real CLI) Edit the draft again. Ask the second user to add one more message. Click "Check now", then the bulk "Draft replies". Wait for the end. Expect your edited text unchanged, with the revision under it. Expect no draft that replaces your text. Discard the drafts of steps 13 to 23. [ ] pass [ ] fail

Copy for your session (2b89d52):

24. Run part K steps 4 and 5 with a build that has commit 2b89d52. Record their result here. Expect the six steps under "What to do", one anchor line per inline item and no code quote, and the label "PR Review Inbox's AI view (may be wrong)". Expect the session to ask before a push, a post, or a resolve. [ ] pass [ ] fail

MCP redirect of a user-added server (e4f671a):

25. Use an MCP server that needs no secret header, of type `http` or `sse`. Add it to your Claude config (`.claude.json`, key `mcpServers`) as `smoke-direct` with its own URL. Open Settings > Review profiles > Review > MCP servers > Choose. Open the tools of `smoke-direct`. Expect its tool list. [ ] pass [ ] fail
26. Start a redirector on this machine: `bun -e "Bun.serve({ hostname: '127.0.0.1', port: 7601, fetch: () => Response.redirect('<URL of the server of step 25>', 307) })"`. Add a second entry `smoke-redirect` of the same type with the URL `http://127.0.0.1:7601/mcp`. Reload Settings. Open the tools of `smoke-redirect`. Expect "Could not list the tools of smoke-redirect: <reason>." and no tool list. Record the reason. [ ] pass [ ] fail
27. Stop the redirector with Ctrl+C. Remove both entries from your Claude config. Reload Settings. Expect neither server in the list. [ ] pass [ ] fail

## N. Jira Cloud

Run this part only with a Jira Cloud test site and an issue with an attached image. `<CLOUD_URL>` is the site URL, for example https://example.atlassian.net. Make an API token without scopes for your Atlassian account. Do not record the site, the email, or the token.

1. Open Settings, Jira. Enter `<CLOUD_URL>` and the API token, and leave the email empty. Click "Save Jira settings". Expect "This is Jira Cloud. Enter your Atlassian account email and an API token." [ ] pass [ ] fail
2. Enter your Atlassian account email. Click "Save Jira settings". Expect "Saved. Jira accepted the token." Reload. Expect the email in the field and the token field empty with "Stored. Leave empty to keep it." (U75, U77) [ ] pass [ ] fail
3. Open a test pull request that names `<KEY>`. Press Shift+R. Click "Fetch `<KEY>` from Jira". Expect the summary, the description, and the comments as text (U81). [ ] pass [ ] fail
4. In the Jira browser tab, open `<CLOUD_URL>/rest/api/2/issue/<KEY>?fields=attachment&expand=renderedFields`. Find the `img` tag of the attached image in `renderedFields.description`. Record the path form of its `src` with the ids replaced by `<id>`, for example `/rest/api/2/attachment/content/<id>` (U79). [ ] pass [ ] fail
5. Download the image with Download on its row. Expect "Downloaded." If step 4 shows a `/secure/attachment/` or `/secure/thumbnail/` path, expect the image inline in the description. Else expect its alt text. A failure shows a fixed text. Record it, and the kind and status of "Jira download failed: …" in the terminal (U78). [ ] pass [ ] fail
6. Click Disconnect, then "Disconnect Jira". Expect the URL and the email fields empty. [ ] pass [ ] fail

## H. Record

- The build commit from the startup line.
- The OS, the Bun version, the `git` version, the `claude` version, and the Jira version from the page footer.
- The result of each step: pass or fail, with a short reason for a fail.
- The judgement chip of each thread T1 to T7.
- For each fix run: the proposed edits and the skipped edits. This gives the rate of dropped edits.
- From part J: the reason that the fix run gave for T9 in step 4.
- From part K: the item count and the size of the copy, the count of entries per verdict, and the count of skipped rows. From steps 14 to 17: the count of listed sessions, the size and the token estimate of the picked session, the token count of the session run (hint of its time), and the count of new transcripts. Record no text and no path.
- From part L: the gate lines of steps 2 and 4. Update U62 to U67 in integration-check.md.
- From part N: the result of each step and the `src` path form of step 4. Update U75 to U81 in integration-check.md.
- From part M: the count and the outcomes of the `answered` entries of step 4, the answered-thread counts of steps 3 and 11, and the redirect reason of step 26. Record no text.
- B11, B12, B15, and B16, the tag names from E5, and the shapes from F1. From part I: the languages of step 4, the severity counts of step 6, and any coverage line from step 5. Update the "Release 3 (not run)" rows in integration-check.md.
