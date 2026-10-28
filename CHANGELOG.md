# Changelog

## Unreleased

- The app is now named PR Review Inbox. Its old name was Kierto. The repository is now github.com/auric/pr-review-inbox. Your data, settings, and stored tokens stay.
- An Ask answer now shows Mermaid flowchart, sequence, and class diagrams as pictures, with "Show code" and "Copy code". A diagram that does not render shows its code and the first error line. Other diagram types show as code.
- Ask now keeps a conversation. The "Follow up" box under the newest answer sends the last three questions and answers with your question, so Claude knows what "it" means. "New question" starts fresh. Earlier conversations show under "Earlier questions".
- The app now builds and runs on Bun 1.4.4. The third-party notices in Settings show the Bun 1.4.4 license. A database upgrade step that fails now stops the upgrade and keeps all data.
- "Include in runs" on a Jira attachment asks about your company AI policy only the first time. The new switch "Ask before Claude reads a Jira attachment" in Settings, Jira, brings the question back.
- The review brief shows the profile picker only when you have two or more review profiles. Explain has its own page.
- "Keep" and "Dismiss" of a note suggestion on a reply draft now stay together on one line.
- A review no longer shows "incomplete" only because the app could not read the build status.
- A finding that cites a project rule from another folder now stays in the list. Only a quoted rule that no instruction file holds drops the finding.

### Build a Jira task

- A new Tasks view in the sidebar lists your tasks with their status, such as "Building part 1 of 1" or "Needs you: tests stay red". "Build a Jira task" there starts a task from a key and a repository. "Build" on a task chip of a pull request starts it in one click. A second click opens the same task.
- The Build form has a "Profile" select. It starts on the profile of your last task in that repository, else your default profile. Every step of the task uses that profile: its model, its skills, and its MCP tools. The task page shows the profile name in its header. "Build" on a task chip uses the same profile choice.
- The steps that write code now get the read-only git tools, the skills of the profile, and the MCP tools that you ticked in the profile. A CodeGraph server in the profile indexes the task worktree before each step. They still get no shell and no web tools.
- Each task has its own page with the steps "Questions › Plan › Build › Done", one sentence that says who must act now, and one main button. The tabs Questions, Spec, Plan, Log, and Diff hold the details. Each step with a run links to its run log.
- Claude first reads the task and the code, then asks up to 8 questions as a form. Each question says why it matters, and the recommended option starts selected. "Use the recommended answers" sends them all. Claude asks a second round at most once.
- Claude then writes a short change plan into `specs/<KEY>/plan.md`: the code to change with file and line, the pattern to copy, the tests, and the tasks. A map line that names code that does not exist is marked. You can edit the plan files before the approval. A line of the tasks list that does not parse is named, and the old text stays.
- The plan screen shows the size with its meaning. A database or API change makes the plan at least medium, and an estimate over your line limit makes it large. You pick the commands that the app may run. The first build in a repository asks you to confirm a warning about the code that these commands run.
- The plan screen also shows the branch that the task will use, such as `feature/<KEY>-<title>`. The "Branch type" chips pick its prefix, and "Other…" takes your own prefix, such as `task/`. The name changes as you pick. The app refuses a prefix that git does not accept.
- A click right after a task shows that it waits for you no longer gets "The build still ends its step." The app finishes its base check, then runs the click.
- A base branch that is deleted on the server no longer leaves only "Try again". "Pick a base branch" changes it until the first push or PR of that repository. When the task has commits already, "Update from <base>" moves only your commits onto the new branch before the PR, also when the new branch is behind the old one.
- "Main repository" in the Build form is now a search field. It lists the repositories of your pull requests and tasks, and every repository that your token can push to, also one with no pull request in the inbox.
- The plan no longer marks a map line in a submodule or in an added repository as code that does not exist. The app checks each line in the repository that the line names.
- Settings has a new section "Tasks" with your list of branch prefixes (default `feature/`, `bugfix/`, `hotfix/`). Add, remove, and reorder up to 10. The first one starts selected on the plan screen.
- Branch names use the full Jira summary. A name over 100 characters is cut at a word boundary.
- The base branch of a new task is the repository's default branch on Bitbucket, or your last pick in that repository while it still exists. The New task form no longer asks for a target branch.
- "Base branch" on the plan screen searches the branches of the repository as you type and marks the default branch. A new base after the plan exists asks once, then writes the plan again and keeps your answers.
- When the task branch already exists on the server, the plan screen offers "Continue on" it (the default) or "Start a new branch" with the next free name. Continue builds on its commits, and the first push uses the fetched commit as its lease. An open PR from that branch stays the PR of the task.
- The build writes the failing tests first, then the code of each task. After each step, the app runs your approved commands as argument lists without a shell and keeps each exit code and output. A task first runs only its own tests, and the end of the build runs all approved commands. Each finished task is one commit with your name and email, and the plan ticks the task.
- The Log tab says "Red as expected" for the checks after the tests step, because the new tests must fail before the code exists. A real failure still says "Failed".
- Claude then reviews its own change with the check step. Red checks get at most 3 fixes, and confirmed blocker and major points of the review get at most 2. "Fix the small points too" fixes the other points.
- The build stops with one sentence and one button when it needs you: red tests, review points that stay, a question, a change to the plan, a file that the app does not commit, a time limit ("Continue with 60 more minutes"), or a change over your line limit ("Keep one PR" or "Change the limit"). "Pause after this step", Stop, and Resume work at any step. Resume starts the stopped step again from the last commit and keeps the dropped changes as a patch file.
- Stop now ends the running Claude step at once.
- Claude edits files only in a worktree that the app owns, with no shell, no web access, and no agents. The worktree hides the .claude folders, .mcp.json, CLAUDE.md, AGENTS.md, and git hook folders. A step that writes such a file is undone and stops the task.
- "Open the PR" shows the branch, the target, the reviewers, and the line count. Nothing goes to Bitbucket before "Push and open PR". The app pushes only the task branch, never the target branch, and always with a lease, so it never overwrites the push of someone else. It opens one pull request, says which reviewers Bitbucket did not add, and follows the pull request in the inbox.
- "Close the task" ends a task. Its branch and pull request stay.
- This version builds small tasks: one pull request with the plan and the code. A medium or large plan waits after its approval.
- Before the build and before each push, the app checks that the token can push to the repository, that the base branch still exists, and that no branch rule it can read forbids the task branch. A failed check stops the task with one sentence that says what to fix, and Claude starts no step.
- Claude now gets the Jira attachments of the task, also for a task without a pull request. "Build a Jira task" first shows "Read the task": it lists the attachments of the issue with a box each, before Claude starts. With "Ask before Claude reads a Jira attachment" off, every box starts ticked. Else the company AI policy question comes once at the first tick.
- The new Attachments tab of a task has the same boxes and "Include all". A change applies from the next step. A tick downloads the file from Jira once.
- Every Claude step of a task gets the ticked files: the questions, the plan, the tests, the code, the fixes, and its own review.
- PDFs now go to Claude as files, up to 5 MB each and 20 MB per run, also with "Include in runs" in the review brief. Office files and archives stay listed by name only.
- Each wait after the build started has the box "Tell Claude" under the main button. One send starts one change step with the checks, one commit, and the own review, then the task waits for you again. Ctrl+Enter sends. A question gets an answer and changes no file. The box keeps your text and waits while a step runs. Stop puts the files back at the last commit and puts your text back in the box. The app never reads the text for commands: pushes and other git actions stay buttons.
- The Log tab shows each send as one group "Your instructions" with your text, the result, and its steps. "Show the diff" on its commit opens the Diff tab. A send that you stop before Claude starts says "Stopped before Claude started."
- "Update from <base>" brings the new commits of the base branch that you picked, for example release/2.1, into the task branch. It rebases before the first push and merges after it, so no push needs force. The view offers it when the base has new commits, when Bitbucket reports conflicts in the pull request, or when Claude says that a change needs the newest base. The app checks the base when a build or a send ends and when you click "Open the PR". When the base moved, "Open the PR" shows the update first, and "Open the PR as is" in More still opens the dialog. With several repositories, each one updates from its own base, and the view lists one line per repository.
- Claude resolves the conflicts of an update in a step that may change only the files with conflicts. A remaining conflict marker, a question, or another changed file stops the update and puts every repository back: "The branch is as it was." with "Try again". Red tests after an update offer "Undo the update". The update pushes nothing.
- A commit after the pull request opened stays local for now. The view says "Your change has new commits that are not on the server yet.", and this version has no button to push them.
- Every Claude step of a build now follows your project instructions from Settings: the CLAUDE.md files of the target branch, your clone files, and your extra text. With submodules, each repository adds its own instructions for its folder.
- Settings, Project instructions now lists the repositories of your tasks, also without a pull request in the inbox.
- The plan now takes its commands from your project instructions first. It knows your operating system, so on Windows it proposes `.venv/Scripts/python.exe` and a setup command that creates the venv.
- You can now edit the commands on the plan screen: change the name, the kind, or the command line, remove one, or add one. Settings, Tasks, Commands edits the saved commands of each repository.
- The Log tab now says why a command did not start, such as "Not found: .venv/bin/python", instead of "stopped".
- A task can now change a repository and its submodules. The plan screen lists each repository of the task with "Can change", "Read only", or "Not available" and the reason, and a "Base branch" for each one that can change.
- When the plan needs another repository that your token can push to, the plan screen says "Claude proposes another repository: <name>." with the reason. "Add" takes it into the task and writes the plan again. "Skip" keeps it out.
- When the build changes several repositories, "Open 2 PRs" opens one dialog with a row per repository, the submodules first. Each row has its branch, base, size, and reviewers. "Push and open 2 PRs" pushes all branches first, then opens the pull requests. Each description links the others. Each row shows its state. A failed row has its own "Try again", and the status names the failed repository, such as "1 of 2 PRs are open. The PR for PROJ/lib failed."
- When a submodule pull request merges, "Point <repository> at the merged commit" commits the new submodule pointer in the main repository and pushes it with a lease.
- A check before the build that fails now offers "Try again" instead of "Resume".

### Ask Claude about a finding

- Each finding card has "Ask Claude about this". The key `t` opens the same talk under the card, with the focus in its box. Ask why, push back, or add context. Each message is one run, and Claude reads the code again before it answers.
- Each answer says "Claude keeps this point", "Claude changed this point", or "Claude withdrew this point", with the reason. It can suggest a note and name the threads that it relies on, as reply drafts do.
- A changed point never replaces your text. The card shows the new text as a word diff, with "Use the new text" and "Keep mine".
- A withdrawn point moves to the discarded drafts with "Withdrawn after your talk" and its reason. Restore brings back its earlier state and keeps the mark.
- On a posted finding, the More menu of its thread has "Ask Claude about this comment". The answer can draft a reply in the thread, marked "from your talk with Claude". Nothing posts.
- A talk takes up to 20 messages. When the finding changes while Claude works, the answer applies nothing and says so. While another run works, the talk names it and offers "Open it".
- The new text of a finding is not a finding of its own. Ready to post, the post, the draft counts, and the review history leave it out.

### Explain this PR

- An Explain run now writes a walkthrough of the change: a one-line summary, the files in reading order, the role of each file, the risks with their code, a glossary, and questions for the author. It gives no findings.
- The shipped Explain profile has the new walkthrough prompt, runs at medium effort, and stops after 60 turns. An Explain profile keeps each field that you edited. The other fields get the new values.
- The app checks each link of the walkthrough into the diff. A link to a file or a line that the diff does not show becomes plain text, and the run says how many links did not match. The same check removes paths outside the change from the reading order and the file list.
- A walkthrough keeps at most 3 Mermaid diagrams. Other diagram blocks show as code. Diagram lines with a `%%{` directive are removed.
- An Explain run reads no notes, no PR context, no earlier review, and no posted questions, and it uses no reviewer agents. A second start for the same head and profile gives the stored walkthrough and starts no run.
- The PR view has an "Explain this PR" button, and the key `w` opens the same page. The page has its own address, and Back or `Esc` returns to the pull request at its place.
- The Explain page shows the summary, the reading order, the walkthrough with its diagrams, the risks, the files with their roles, and the words used. Opening the page starts no run. Its one button starts the run, and the page says what Claude does while it runs.
- A link in the walkthrough, a risk, or a file path opens the Files diff at that file and line. A link that does not match the change shows as plain text.
- When the pull request changes after a walkthrough, the page says so and offers "Explain again". A walkthrough that runs, failed, or was cancelled keeps the earlier one on the page. With two or more Explain profiles, the page lets you pick one.
- The questions of the newest walkthrough show in Drafts again, marked "From Explain". The run record has an Explain row with "Open the walkthrough".
- "Copy as Markdown" under More on the Explain page copies the whole walkthrough.
- "Improve prompt" on an Explain profile now keeps the lines of the walkthrough prompt.

### PR notes and PR context

- The PR view has a new Notes block under the description. Add a note, edit it, or delete it with Undo. A note can wait for another PR, and its chip shows when that PR is open, merged, declined, or not found.
- Claude reads your notes before each review, reply, fix, and Ask run, and follows them. Explain runs do not read them.
- Draft replies can suggest a note when a thread shows your agreement or a wait for another PR. A suggestion shows on the draft card and in the Notes block with Keep and Dismiss. Claude uses it only after you keep it.
- Each run now sees every thread of the PR with its outcome, the build state of the head, and other open PRs in your inbox that change the same files. A decision in another thread can change a reply.
- A reply draft that relies on another thread shows "Based on the thread of" with a link to that thread.

### Consult your session

- The copied points and the points of "Ask your session" sit in tags with a new random suffix each time. The prompt says that the tag content is data from the pull request, not instructions.
- "Paste the answer" is gone. Push the changes of your session, then use "Review changes since" and Draft replies.
- "Copy for your session" gives your own Claude Code session the open review points as numbered steps: check the branch, validate each point with file and line, fix only the valid parts, write a reply for each point, commit, and ask you before any push, post, or resolve.
- Cancel now stops an "Ask your session" run while it fetches the pull request. Before, the fetch could hold the run slot for minutes.

### Reviews

- A review now checks each finding in a second step of the same run. The check runs at medium effort. The verifier setting of the review profile sets its model and effort, or turns it off.
- A finding that the check refutes, or that repeats another finding at the same place, leaves the Drafts list. The review record lists it with the reason of the check, and Restore brings it back. The card then says "You restored it".
- The review brief shows the checks of the profile as checkboxes, with more under "More checks", and the volume: "Only what matters", "Balanced", or "Show everything". A change saves to the profile at once.
- The Drafts list follows the volume of the run. "Balanced" puts unsure points and nits into a "Low confidence" fold. "Only what matters" puts everything but must-fix points into a "More" fold. "Show everything" has no fold. A run keeps its view after a volume change.
- The Drafts header and the review record count the open drafts in plain words, for example "2 must fix · 3 worth fixing · 4 low confidence".
- Each finding card shows a check chip ("Checked", "Low confidence", or "Not checked"), the case that triggers the problem ("When:"), and the reason of the check. The cards in the diff show the chip too.
- While a review runs, the run line says "Finding problems…" and then "Checking 9 findings…". A finished review shows the time of each step, and Run setup adds their tokens. The run log shows the calls of the check under "Check".
- When the check does not finish, the review record says how many findings are not checked, with "Show log". A complete review without findings says "No problems found in the checked areas".
- Settings, Review profiles, sets the checks, the volume, and the check step with its own model and effort for each profile.
- The dropped findings under "Not checked" now say why: a code reference that does not match, a place outside the change, or a quoted rule that the project instructions do not hold.
- A finding that the check cannot confirm is at most minor. A finding without a concrete case becomes a question for the author.
- A finding on code that the change does not touch is dropped, unless it names the changed line that causes it. A rule finding is dropped when the quoted rule is not in the project instructions for its path. The dropped list says why.
- When the check does not finish, for example at a usage limit, the run is incomplete, and its findings stay unchecked.
- "Review changes since" also checks the open findings that it carries over. A finding that you accepted or edited keeps its state.
- After you discard a finding, its card offers the optional reasons "Not a bug", "Not worth fixing", "Duplicate", "Intended", and "Wrong place".
- Settings has a new "Review quality" table for the last 30 days. Each row shows one profile and prompt version: runs, shown findings per run, check results, accepted of shown, discarded by reason, posted, addressed, outdated, median time, and cost per run. Accepts from a fold count apart, so the accepted share never exceeds 100%.
- The "General" profile is now named "Review". It has a new prompt and runs at high effort. Its reviewer agents also run at high effort.
- A review now reports each problem with a title, a concrete case, a severity, and a confidence. It reports only what the change adds, and it skips style, linter output, and behavior that the pull request or the task asks for.
- "Review" checks security, threads and races, compatibility, the project rules, and the task goal. Each finding names the check that found it.
- Reviewer agents with "Auto" now join only a large change: 1,200 changed lines or 30 changed files. "Always" uses them on every change.
- Reviewer agents now read the pull request text, the task, and the earlier findings, as the main review does. They do not raise a finding that you discarded again.
- A CLAUDE.md in a folder of a changed file on the target branch now joins the project instructions. It applies only to the files in its folder.
- Improve prompt now knows the review checks and the new review rules, so the proposal does not repeat them.
- An update removes the shipped Security and Over-engineering profiles only when you never edited them. An edited one stays as your own profile.
- A review and "Review changes since" now read the answers to the questions that you posted. Each answered question gets one outcome.
- An answer that settles the question gets a reply draft, such as "Thanks, clear.", with "Resolve after posting" proposed. The box is ticked on threads that you started.
- A partial or unclear answer gets a reply draft with the next question. An answer that shows a real problem gets a new finding and a reply draft that points to it.
- The general comment with several questions gets one reply. It proposes the resolve only when every question is settled. Else the reply names the open questions.
- Unanswered questions get no draft. Every draft waits for your Accept. A draft that you edited, accepted, or discarded stays. When new messages came after your edited or accepted draft, the new reply waits under it as a revision.
- The run line counts the answered threads. Explain does not read the answers.
- An answered question about a finding counts as settled only when the head commit fixes the finding or the answer proves it wrong. A promise to fix it later gets a follow-up draft.

### Replies

- A reply that you posted from a reply draft now shows "Posted from a reply draft". "Posted from a Claude Code review" stays on posted review findings and questions.
- Draft replies checks each thread against the new code and the answer in the thread. When the point is settled, it proposes to resolve the thread and shows its proof.
- "Resolve after posting" on each reply draft. The reply posts first, then the thread resolves. A draft without text only resolves the thread. Claude ticks the box only on threads that you started.
- "Review changes since" proposes to resolve the threads of your posted findings that the new commits fix. A Fix commit proposes it on its "Fixed in" reply.
- Resolve or reopen any thread with the "Resolve" or "Reopen" button in its footer, or with the key x. A thread that another person started asks first.
- A reply that Bitbucket refuses because the thread is resolved again says "This thread is resolved. Reopen it first."
- A resolve that fails after the reply keeps the reply and offers "Resolve again". It never posts the reply twice.
- On threads where you made the point or asked the question, reply drafts show "Settled", "Not settled", or "Follow-up question". Only a settled thread gets a resolve proposal, with the answer quoted as proof.
- A partly answered question gets a reply that asks the open part again. A thread with several questions resolves only when each one has an answer.
- Draft replies can propose to resolve a thread of another person where you replied. The box stays unticked there.
- A reply to a resolved thread reopens the thread first, because Bitbucket takes no reply there. The post confirm and Ready to post say "Reopen thread, post reply". A ticked draft resolves the thread again after the reply.
- A reply draft says "Resolved since the draft" when someone resolved its thread after Claude drafted it. The post leaves that reply out until you reopen the thread.
- The post confirm lists the drafts that cannot post now, with the thread and the reason: new messages after the draft, a thread resolved since the draft, or a "Fixed in" commit that is not on the pull request yet. Post sends the other drafts. Before, one such draft stopped the whole post.
- An out-of-date reply draft no longer shows Accept or Edit, because it cannot post. The key a says why.
- A "Fixed in" draft whose commit left your branch, for example after a rebase or a squash, offers "Post as plain reply" in the post confirm.
- The post confirm groups the drafts that cannot post by reason. Each group says what to do. Each draft links to its thread and has its action: "Reply to the newest as is", "Reopen thread", or "Post as plain reply". Your accepted draft is never discarded there.
- The post confirm updates its lists when the drafts change while it is open. When the list to post changes, it asks you to read it again before you post.
- The post bar counts the out-of-date drafts. Ready to post also lists pull requests with only drafts that cannot post, with "N cannot post". Screen readers announce count changes.
- If the reply fails after the reopen, the post says so. Retry posts the reply without a second reopen.
- Claude never replaces a reply draft that you edited, accepted, or discarded. The run says "kept your draft" for that thread. Draft reply in that one thread replaces a discarded draft.
- "Draft again" on a draft that you edited or accepted is now "Revise my reply". Claude gets your text, keeps your points and tone, and changes only what the new messages need. The revision shows under your draft as a word diff against your text. "Use revision" makes it the draft, not accepted, and keeps your resolve tick. "Keep mine" drops it, and your exact text stays.
- Draft replies revises your out-of-date drafts the same way. Your current drafts stay as they are. The outcome line says "Revision waiting".
- "Reply to the newest as is" on an out-of-date draft answers the newest message with the same text. It runs no AI and keeps your accept. A thread resolved after the draft must open again first.
- A "No reply needed" draft of a reply run no longer counts as your decline. Draft replies now writes a new draft there when new messages arrive.
- A Fix commit keeps a reply draft that you edited or accepted. Its "Fixed in" text waits under your draft as a revision. Undo of a Fix commit brings back the draft that its "Fixed in" draft replaced.
- A "Fixed in" draft of an undone commit can no longer come back with Restore.
- Post again of a reply no longer fails when the pull request got new commits.
- When a fix run gives no fix for a thread, it drafts your answer to the commenter with the reason: already done, not valid, out of scope, or unclear. The draft says "from the fix run" and posts only after your Accept.
- An "already done" draft names the code that does it and proposes to resolve the thread. A choice that only you can make, or a risky fix, gets no draft.
- A fix run never replaces a reply draft that you edited, accepted, or discarded, or a "Fixed in" draft. Draft replies keeps a "Fixed in" draft and a draft of a fix run too. Draft reply in that one thread replaces them.
- A "Fixed in" draft keeps the answer that Claude drafted in the thread and adds "Fixed in X: <what the commit changes>".
- A Fix commit with only a part of the edits of a thread drafts "Partly fixed in X" and proposes no resolve.
- Draft replies sees the fix note, the fix commit, and the current draft of each thread. It no longer claims a fix without a commit.
- Each thread with a reply draft or a fix card shows one outcome line on top: Open, Answered, To fix, Fix proposed, Fixed in X, Partly fixed in X, Already done, Won't fix, Needs your decision, Follow-up asked, Settled, Waiting on them, or Resolved. Marks say "Out of date", "Resolved since the draft", "Waiting for push", or "Revision waiting".
- When the reply draft and the fix disagree, a note says so, for example a "Not valid" reply next to a ticked edit, or a valid reply next to "Already done". "Keep the reply" and "Keep the fix" settle it with one click.
- A session accept without a reply now says "To fix", not "No reply needed".
- Each reply draft names where it came from: the review, the reply run, your fix commit, the fix run, the re-review, or you.
- The Draft replies button counts only the threads that still need a reply: no draft yet, or a draft that is out of date and has no revision for the newest message.
- A "Fixed in" draft whose commit left your branch offers "Post as plain reply" on its card too.
- The inbox row says "N reply drafts out of date" when new messages or a resolve after the draft keep your reply drafts from posting. Groups and sort stay the same.
- A reply draft that you accepted or edited gives one notification, "1 reply draft out of date", when another person's message or resolve does that. It joins the new comments of the same check.
- A reply draft says "The code at this comment changed after this draft." when a push outdated the comment later. The outcome line says "Code changed". An untouched draft offers "Draft again". A draft that you accepted or edited offers "Show in diff". It never blocks the post.
- A reply draft in a thread whose messages are all deleted now says "Out of date".
- "Show history" in the More menu of a thread lists the thread in time order: the messages, the drafts of each writer, your changes to a draft with "Show changes", the revisions, the fix results and commits, the posts that did not finish, and the current resolve. Each line from Claude links to its run log. "Hide history" or Esc closes it.

### Fix

- When a fix run gives no fix, its card names the reason: Already done, Not valid, Out of scope, Unclear, Needs your decision, or Risky. When the fix run drafted your answer, the card says "Reply drafted" and takes you to the draft.
- "Needs your decision" shows the options of the fix run, with "Fix anyway" and "Don't fix…".
- When PR Review Inbox cannot apply any edit of a proposed fix, the card says "Edits could not be applied" with the reasons, and offers "Fix again" and "Copy prompt". It drafts no reply.
- "Don't fix…" on a proposed fix asks for your reason. It drafts a "Won't fix" reply and folds the proposal, also after a reload. Undo brings the proposal and the earlier reply draft back until the reply posts.
- The Fix list shows the fix outcome of each row: Fix proposed, Fixed in, Partly fixed in, Already done, Won't fix, Follow-up asked, Needs your decision, or Declined. A row without a fix or with a declined fix starts unticked.
- "Fix anyway" tells the fix run that you chose the fix, so it proposes edits despite the decision or risk note.
- A finding that your session rejected, with its fix edits still ticked, gets a note with "Keep the reject" and "Keep the fix".
- A fix run and an "Ask your session" fix change only the lines that the fix needs. They do not reformat or refactor other code.
- Commit refuses an edit that another fix commit of the same run already holds. Undo that commit first.

### Fixes

- After you resolve or reopen a thread, an edit of its first comment from before the resolve still arrives and shows as new.
- The next pull request opens at the top. A key press after a scroll no longer keeps the old position or marks messages below the fold as read.
- Cancel stops a review while it fetches the repository. A fetch can now take up to the 60-minute run limit, and a stopped fetch does not start a second one.
- A comment can no longer pose as another message in the pull request text that Claude reads.
- An invalid profile or rule in config.json no longer gets lost silently on the next save. PR Review Inbox keeps a copy in config.json.bak and logs what it ignored.
- A key that you press right after a dialog opens no longer acts on the page behind the dialog.
- Keyboard and screen reader fixes. When a sync puts a reply draft out of date, the focus moves from Accept or Edit to "Draft again", and the change is read out once. The "drafting a reply" line takes the focus from the button that started it. Small text buttons have a 24 px target. A discarded reply draft shows its full line on hover. A blocked clipboard shows the runner prompt in a field, selected for Ctrl+C. Failure messages name the next step. The post confirm says why Post is off.
- More small text buttons and links have a 24 px target, such as Restore, Move, the quote above a reply, "Go to the draft", Log, and the jumps under the pull request title. The layout does not move. More failure messages name the next step, such as a review or a question that did not start.
- Many open tabs no longer block each other. All tabs share one live connection, so a seventh tab loads and actions stay fast. When the tab with the connection closes, another tab takes it over.
- Slow actions no longer fail after 30 seconds with a lost connection. Examples are a Jira fetch, an attachment download, a settings save, Post, and Post again.
- When Bitbucket answers "too many requests" or "unavailable", the sync stops for this round and shows "The last check failed: Bitbucket asks to slow down." The next sync waits as long as Bitbucket asks. The check time stays at the last full sync.
- A followed pull request that was deleted on Bitbucket moves to the archive with its messages. The app no longer checks it each round.
- Merged and declined pull requests get a check for new messages at most once per hour.

### Runs

- The run row and the run log name the subagents of a run, with counts and models, for example "Subagents: rl-reviewer ×3 (claude-sonnet-5-5)".
- In the run log, each subagent row shows its model, tokens, and duration, with its tool calls nested under it. An agent that PR Review Inbox did not define shows "built-in".

### Safety

- A user-added MCP server that redirects to another host or port no longer connects. Give its final URL in Settings.

## 0.2.0

The first public version. Kierto is a local-first inbox for Bitbucket Server and Data Center pull requests, with AI reviews by your own Claude Code CLI.

### Inbox

- One inbox for every open pull request that needs you, with unread marks and a reason per row.
- Per-message tracking of new comments, edits, replies, and deletions. Read state survives restarts.
- One notification when someone replies to you or pushes new commits.
- Follow any pull request: paste its URL into the filter.
- Full keyboard control. Press `?` for the list. Below 760 px, one pane shows at a time.

### Reviews

- Claude Code reviews a sanitized snapshot of the pull request and reads the whole repository, not only the diff.
- The review brief holds the task, your note, the profile, and the run setup. A review starts only from the brief.
- Review profiles set the prompt, model, effort, reviewer agents, skills, and MCP servers. General, Over-engineering, Security, and Explain ship with the app. "Improve prompt" shows its changes before you apply them.
- Each run can read the CLAUDE.md files of your clone, extra text from Settings, and your global CLAUDE.md. Settings shows the full text a run gets.
- The review record counts findings per severity and lists what was not checked. The run log shows each tool call of the review and its subagents.
- Review only the commits since the last review.

### Drafts and posting

- Each finding becomes a draft with its code, severity, and evidence. Accept, edit, or discard each one.
- Post the accepted drafts as inline comments after a confirm. Only you see drafts until you post them.

### Replies

- Draft replies judges each thread where it is your turn: valid, partly valid, not valid, or a question. You edit each reply and post it.

### Fix

- On your own pull request, the Fix list holds the open threads and the review findings.
- A read-only run proposes exact edits for the ticked points. You review each edit. Apply commits the edits into your clone. You push.

### Ask and sessions

- Ask a question about a pull request. The answer stays in Kierto.
- Consult the Claude Code session that wrote the code. Kierto resumes a forked, read-only copy of it on your own pull request.
- "Judge and propose fixes": your session judges each item and proposes edits for the ones it accepts. Kierto checks the edits and shows them as fix cards marked "from your session".
- "Copy for your session" gives the same review points as text.

### Settings

- Bitbucket URL and token, with a connection test before save.
- Optional Jira connection, so the review brief can fetch the task text.
- Clones, review profiles, project instructions, and the session switch.
- About shows the version, the license, and the third-party notices.

### Safety

- The server listens on 127.0.0.1 only. It checks Host and Origin, and each change needs a session token.
- Tokens go into the OS secret store, never into the database, logs, URLs, or prompts. `REVIEW_LOOP_SECRETS=memory` keeps them in memory only.
- Reviews use your claude.ai login. Kierto removes `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child process.
- Claude never runs in your clone and never posts. Nothing goes to Bitbucket until you click. Kierto never pushes.
