# Review v2 plan: design

Status: decided, 2026-10-22. The user answered the questions of section 10 on 2026-10-22. Docs only, no code changed. Code references point to HEAD abae1a2 on branch r2. "Unverified" marks a claim that no code, document, or gate run confirmed. Companion files: spec.md (behavior, data, routes, schemas, prompts, acceptance criteria) and tasks.md (work packages and gates).

Parts: 1 Review quality, 2 Discuss a finding, 3 Explain this PR, 4 Measure quality, 5 Brainstorm, 6 Build a Jira task, 7 Autopilot replies. A UX rule set (section 5.6) applies to every part. Part 7 was added on 2026-10-22 after the user's decisions Q25 to Q27 (section 10.1). Its open questions are in section 10.2. Part 7 is on hold since 2026-10-22, and part 2 gained "PR context and PR notes" on the same day (section 10.3).

## 0. Sources and rules

- Inputs: the subsystem map, the prompt dump of 13 run kinds, and three research notes of 2026-10-22 (session scratchpad). Each code claim below was checked against the files at abae1a2.
- External sources: section 3 lists each one with its link. The Claude Code permission, sandbox, CLI, and headless pages were read on 2026-10-22. The Bitbucket REST rows come from the Bitbucket Server 7.21 reference. The Data Center 9.x behavior of each new Bitbucket call is a Gate-0 item (tasks.md, WP-G0).
- BRIEF hard rules stay unless a decision of section 10 (Q1 to Q5, Q25) changes one: sanitized snapshot for read-only runs, no `--bare`, auth route check, nothing posts without a click, untrusted data rules, token rules, one run slot, writer priority, field-by-field profile upgrades, draft-07 schemas, and "an incomplete run never says no issues".
- The visible app name is "PR Review Inbox" (src/web/App.tsx:369, CLAUDE.md). The UI texts in this plan avoid the name.

## 1. Problem

### 1.1 Review quality today (verified at abae1a2)

| ID | Weak spot | Evidence |
|---|---|---|
| W1 | No verify pass. evidenceStatus and confidence are self-reported. They never gate, sort, or fold a finding. | review.ts:14-27; Drafts.tsx:253 shows them as one text line. |
| W2 | The model merges subagent findings. Auto mode has no check. Only always mode asks the main agent to drop unconfirmed findings. | catalog.ts:275-285 (DELEGATE). |
| W3 | The finder is told to be conservative ("Give no finding to fill the list", "Set confidence to low…"). Opus 5 guidance says such lines lower recall. | catalog.ts:254-265; research-opus55 item 3. |
| W4 | rl-reviewer has no ./context rules: no pr.md, task.md, history.md, or questions.md. It can raise a finding that the user discarded. | catalog.ts:476-493. |
| W5 | "Only what the PR adds" is a prompt line. The validator accepts anchors outside the hunks ("outside"). | catalog.ts:261; validate.ts:190-191. |
| W6 | Severity lives only in the prompt. category is free text. No cap applies. | review.ts:20-21. |
| W7 | Shipped profiles leave model and effort null, so the CLI default applies. Opus 5.5 defaults to medium effort. | catalog.ts:59-138; research-opus55 item 2. |
| W8 | Delegation is the model's choice in auto mode. Opus 5 delegates readily. | catalog.ts:277; research-opus55 item 9. |
| W9 | Explain is a review run with explain true. It returns one summary line and risk strings. The validator drops its findings. | catalog.ts:121-136; validate.ts:202; RunLine.tsx:441-500. |
| W10 | Nothing learns from discards. No stats exist per profile or prompt version. | BRIEF section 9 backlog "Learn from discards". |

### 1.2 Other gaps

- Discuss: the user cannot ask Claude about one finding before posting. Ask is one question per run about the whole PR (AskPanel.tsx, catalog.ts:402). After a post, only reply drafts reach the thread.
- Explain: no narrative, no reading order, no links to the diff, no diagrams. Markdown.tsx exists and is safe, but Explain does not use it.
- Measure: no way to prove that a prompt change finds more real bugs with less noise.
- Build a task: the app reviews and fixes PRs, but it cannot take a Jira task to a reviewed spec and small, reviewed PRs.

## 2. Goals and non-goals

Goals:
- G-R. More real findings and less noise: the finder reports all, a verify phase filters, the app applies caps from structured fields, and the UI shows confirmed points first.
- G-D. A short talk with Claude about one finding. Claude answers with a verdict: upheld, revised, or withdrawn. A revision never overwrites the user's text. Every reply, discuss, review, fix, and ask run sees the whole PR in a short map (all threads with their state, the build, other open PRs on the same files) and the user's PR notes.
- G-X. "Explain this PR" gives a readable walkthrough with a reading order, links into the diff, risks on code, and safe diagrams.
- G-M. Numbers: precision, recall, noise, and cost per profile and prompt version, from synthetic fixtures and from real outcomes in the app.
- G-B. From a Jira task to reviewed PRs: questions, a spec that colleagues review, tests first, own review, small PRs on click.
- G-UX. One primary action per state, plain words, no setup before first use.

Non-goals:
- No automatic review, approval, merge, or thread resolve. Every run still starts from a click, from the approved plan of a task (section 10, Q5), or from a new comment on a PR where the user turned on Autopilot (part 7, Q25; on hold, so today no run starts from a comment).
- No hosted service, no team features, no other code host.
- No post without a click, except Autopilot replies on a PR where the user turned on Autopilot (part 7, Q25; on hold, so today a human posts every reply). The app never pushes to a target branch and never force-pushes without a confirm.
- No result cache that skips a run. A start runs the CLI again, except a start with the key of the running run.

## 3. Research summary

| # | Finding | Source | Consequence here |
|---|---|---|---|
| S1 | Effort is the only thinking control on Opus 5.5. Its default is medium, where Opus 5 had high. | https://platform.claude.com/docs/en/models/opus-5-5/migration-guide | Each agent gets an explicit effort (R11). |
| S2 | "Only report high-severity issues" or "be conservative" makes the model report less. Ask it to report everything and filter in a separate pass. Stated for Opus 5; unverified for 5.5. | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5 | Finder reports all with severity and confidence. Strictness moves to the verify phase (R1). |
| S3 | Drop CRITICAL and MUST emphasis. Say what to do, not what to avoid. Give the reason. | https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices | Plain prompt lines in ASD-STE100, each with its reason in spec.md. |
| S4 | Ground claims in exact quotes. | same page | anchorText and cause quote code. The app checks both (R6). |
| S5 | Opus 5 delegates to subagents more readily. Control spawning. | prompting-claude-opus-5 page | The app decides delegation by diff size. A small change gets no Agent tool (R8). |
| S6 | `--json-schema` gives `structured_output`. A missing field fails the run. `format` is an annotation only. | https://code.claude.com/docs/en/headless | Draft-07 schemas with zod defaults for stored results. |
| S7 | Subagent fields include model, effort, tools, disallowedTools, maxTurns, omitClaudeMd. | https://code.claude.com/docs/en/sub-agents | rl-reviewer and rl-verifier pin effort and read-only tools. |
| S8 | Anthropic /code-review: parallel finders, then one validator subagent per issue; PR title and description go to every agent; CLAUDE.md rules only from files on the changed path, with the exact rule quoted. | https://raw.githubusercontent.com/anthropics/claude-code/main/plugins/code-review/commands/code-review.md | Verify phase (R1), intent to every agent (R12), path-scoped rules with quote check (R13). |
| S9 | qodo: "only issues introduced by this PR", a concrete scenario for lower severity, a reflect pass that rescores with caps ("verify/ensure" capped). | qodo-ai/pr-agent pr_reviewer_prompts.toml, pr_code_suggestions_reflect_prompts.toml | Trigger field, caps (R5), "please verify" becomes a question. |
| S10 | CodeRabbit: profiles quiet, chill, assertive. Quiet moves minor items to the summary. | https://docs.coderabbit.ai/reference/configuration | Three volume steps that change the display, not the finder (R10). |
| S11 | Greptile: about 19% good, 2% incorrect, 79% nits. Prompting alone could not cut nits without cutting real comments. Feedback learning raised the address rate from 19% to 55%+. | https://www.greptile.com/blog/make-llms-shut-up | Do-not-flag list, verify phase, outcome tracking, later "Learn from discards". |
| S12 | Google: target precision about 50%. ByteDance BitsAI-CR: 75% precision with a rule checker and a review filter; "Outdated Rate" as a metric. | https://research.google/blog/resolving-code-review-comments-with-ml ; arXiv 2501.15134 | Metrics in part 4: precision, addressed rate, outdated rate. |
| S13 | Split agents by evidence source (rules or code), not by topic. One strong default with toggles beats many profiles. | research-review-tools summary (inference from the tools above) | One finder prompt with module sections (R7) and one default profile (R9). |
| S14 | Mermaid: render to an SVG string, show it as a data-URL image. securityLevel strict, htmlLabels false, strip `%%{init}`, pin a version after the 11.15/11.16 advisories. | research-mermaid (mermaid docs and advisories; not browser-verified) | Part 3 diagrams with no CSP change (X4). |
| S15 | Claude Code sandbox: "The sandbox runs on macOS, Linux, and WSL2. On native Windows, Claude Code runs commands unsandboxed." Bash rules "aren't a security boundary around the program". In `-p`, a call that needs approval is denied unless an allow rule or a mode approves it. | https://code.claude.com/docs/en/sandboxing ; https://code.claude.com/docs/en/permissions ; https://code.claude.com/docs/en/headless | Part 6 gives Claude no shell. The app runs allowlisted commands. Section 10 Q2 states the Windows limit. |
| S16 | Bitbucket Server: POST /rest/api/1.0/projects/{projectKey}/repos/{repositorySlug}/pull-requests creates a PR (REPO_READ on both repositories). PUT .../pull-requests/{id} changes title, description, reviewers, or the destination branch. GET /rest/build-status/1.0/commits/stats/{commitId} gives successful, inProgress, and failed counts. | https://docs.atlassian.com/bitbucket-server/rest/7.21.0/bitbucket-rest.html ; https://docs.atlassian.com/bitbucket-server/rest/7.21.0/bitbucket-build-rest.html | Part 6 calls. Data Center 9.x behavior is Gate G2 to G5. |
| S17 | git push `--force-with-lease=<ref>:<expect>`: with an empty expect, the ref must not exist yet. | https://git-scm.com/docs/git-push | New branches push with an empty lease. Updates push with the last pushed hash as the lease. A `+` refspec makes git ignore the lease (tests/tasks/push.test.ts), so the app never sends one. An explicit lease allows any matching update, so the app checks the fast-forward itself. |
| S18 | Bitbucket Server DELETE .../pull-requests/{id}/comments/{commentId}?version=N: a user can delete an own comment. A comment with replies cannot be deleted, whatever the permission. Gate 0 on this server: DELETE with the current version returned 204, and the probe deleted replies before their parent (integration-check.md row "Delete call and deleted-comment shape"). | https://docs.atlassian.com/bitbucket-server/rest/7.21.0/bitbucket-rest.html ; integration-check.md | "Delete my last bot reply" only while the reply has no replies. The refusal text on Data Center 9.x is Gate G8. |
| S19 | Bitbucket Server user objects carry `type` NORMAL or SERVICE. Unverified on Data Center 9.x for comment authors. | 7.21 REST reference (user responses) | Loop protection skips SERVICE authors when Gate G10 confirms the field. |
| S20 | GET /rest/api/1.0/projects/{p}/repos/{r}/pull-requests?state=OPEN lists the open PRs of a repository (REPO_READ). | 7.21 REST reference | Part 2 lists other open PRs that change the same files (D9). Autopilot (on hold) resolves references such as "the mac build scripts PR" against this list. Gate G9. |

## 4. Decisions

### 4.1 Part 1: Review quality

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| R1 | Two phases in one review run: the finder reports every candidate with severity and confidence. A verify phase gives each candidate a verdict: confirmed, refuted, unsure, question, or duplicate. | Keep "be conservative" in one pass (today). Let the finder self-check. | S2, S8, S9, S11: finding and judging work better apart. The finder stops self-censoring. |
| R2 | The verify phase is a second CLI process in the same job, the same workspace, the same run row, and the same run slot. | Verifier subagents inside the finder run (model-driven, cannot be enforced, W2). A second run row (two slot grabs, two results). | The app enforces the phase. Cancel stops both. The user sees one run with two phases. |
| R3 | Verify works in batches in one process. Above 12 candidates (VERIFY_SPLIT), the app adds the rl-verifier agent, and the verify main agent gives each call up to 6 candidates. | One subagent per candidate (S8; each one reads the context again). One process for any count (slow for 40 candidates). | Cost against wall time. The eval harness tunes both constants. |
| R4 | Dedupe: the app groups candidates whose anchors overlap on the same path and side. The verifier marks duplicates in a group. | Text similarity in the app (a heuristic). The finder merges (W2). | Overlap is exact. The model judges sameness only inside a group. |
| R5 | Caps use structured fields only: verdict, evidenceStatus, confidence, trigger, and volume. The app never matches words in the text. | Phrase rules such as "please verify" in the app. | No heuristic. The finder writes a question when it has no trigger, and the verifier gives verdict question. |
| R6 | "Only what the PR adds": a finding anchors on a changed line, or it names a cause on a changed line. The app checks the quotes of both. Else it drops the finding with reason "unchanged". | Prompt line only (today, W5). | Deterministic. It removes findings on old code that the change does not touch. |
| R7 | Modules are checklist sections in the one finder prompt. Agents split by evidence source only: code slices by path (rl-reviewer) for size, and the verify phase. Rules and task match stay in the finder, with an app check of the rule quote. | One parallel specialist per topic (security agent, performance agent). | S13: topic agents repeat work and conflict. A second CLI process per topic costs time in the single slot. The eval can revisit. |
| R8 | The app decides delegation from the diff stat. Below 1,200 changed lines and 30 files, the finder gets no Agent tool. | The model decides (today, auto mode). | S5. A fixed agent set with a known shape per run. |
| R9 | One default review profile "Review" with module checkboxes and a three-step volume. The shipped Security and Over-engineering profiles retire when the user never edited them; "Security" and "Simplify" become modules. The Explain profile becomes the setup of "Explain this PR". | Keep four topic profiles. Keep General and Over-engineering as two shipped profiles. | S13 and the UX rules: one choice that most users never change. A pure cut pass stays possible as the user's own profile. Section 10 Q7. |
| R10 | Volume (Only what matters, Balanced, Show everything) changes the display and the nit rule only. The finder always reports the rest. | Volume changes the finder prompt. | S2: the finder must not self-filter. |
| R11 | Explicit effort per agent. Shipped: finder high, rl-reviewer high, verify phase medium, Explain medium. Discuss and Ask use the effort of the profile in the brief. | Leave null (W7). | S1. The profile keeps each field editable. |
| R12 | Author intent goes to every agent: each agent prompt says to read ./context/pr.md and ./context/task.md first. The stdin keeps no PR text. | Put the PR title and description into stdin. | BRIEF prompt rule: stdin never quotes PR or tracker text (prompt.ts:3). |
| R13 | Path-scoped project rules: CLAUDE.md files of the target head on the path of each changed file join the project instructions with a scope header. A rule finding quotes the rule. The app checks that the quote is in a loaded file whose scope covers the path. | Root CLAUDE.md only (today). | S8: only rules that apply to the path, and an exact quote. |
| R14 | Subagent parity: one context block (Tools lines for the existing context files, the intent rule, the history rule, the do-not-flag list, the rubric, modules, language lists, project instructions) goes to every agent of the run. | Per-agent lists (today, W4). | Same facts in every agent. No re-raise of discarded findings. |
| R15 | Explain leaves the review schema. It gets its own run kind and schema (part 3). | Keep explain true on review runs. | W9. |
| R16 | The UI uses the stored verdicts: confirmed points show; unsure points fold under "Low confidence"; refuted and duplicate points stay in the run record and the log, with Restore. | Show everything as today. | S10, S11. Nothing is lost, and the main list is short. |
| R17 | REVIEW_PROMPT_VERSION (a constant in src/shared/review.ts) goes into each run row. | Profile revision only. | Stats and the eval compare prompt versions. |

### 4.2 Part 2: Discuss a finding

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| D1 | One CLI run per user message (kind discuss), in the one run slot. | A chat session with `--resume`. | BRIEF 3.5: app runs never resume and delete their transcripts. Resume loads the whole history, which costs quota. |
| D2 | Each turn rebuilds its context: the finding with its run head, anchor excerpt, verdicts, and the user's current text; the earlier turns; a fresh snapshot at the current heads. | Resume the review run's session. | Deterministic and safe. The same pattern as Ask and fix runs. |
| D3 | No message table. Each turn is a review_run row: question (the user message), answer, discuss_json (verdict and revision), and item (the finding). | A new item_message table. | Run rows already give status, log, cancel, usage, and errors. |
| D4 | Verdict upheld changes nothing. Revised stores a revision item of the finding (payload revises) for Use revision or Keep mine. Withdrawn discards the finding with a mark and Restore. On a posted finding, the answer can make a reply draft through the writer priority. Nothing posts. | Overwrite the finding text. | The thread-outcome revision rule (BRIEF, Revisions): no AI writer overwrites the user's text. |
| D5 | One link "Ask Claude about this" on the finding card opens an inline chat under the card. Key t. | A panel or a dialog. | UX rule 1 and 10: the talk stays next to the code. |

PR context and PR notes (added 2026-10-22, section 10.3; spec.md sections 2.7 to 2.13):

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| D6 | A PR context file context/pr-context.md: the PR text, the linked tasks, the build, every thread (the threads of the run in full text, the others as a digest with the State line), and other open PRs that change the same files. App code builds it again before every run. No memory, no Claude call. | A session per PR with `--resume`. A Claude summary of the threads. pr.md only. | BRIEF 3.5: runs never resume. A summary by Claude costs quota and can be wrong or injected. pr.md has every message but no state and no peers, and a reply run reads only its own thread first. |
| D7 | Reply, discuss, review and re-review (all agents), fix, and ask runs get the file. Explain gets none. Ask gets it, because users ask "what is left on this PR?". | Every run kind. Reply and discuss only. | A decision in another thread changes a review point, a fix, and an answer. Explain explains code and has no thread action. |
| D8 | The State line reuses threadOutcome: it moves from src/web/review/outcome.ts to src/shared/outcome.ts, with its pure helpers. The server builds the same input from the same rows as the routes. | A server-side state list of its own. | One table of words. The file and the UI can never disagree. No second rule set that drifts. |
| D9 | Other open PRs: stored pr_change rows of open inbox PRs in the same repository (no call), plus the open-PR list (S20) and the change list of each listed PR that is not stored, at most 30 per build, cached in memory by PR and updatedDate. Overlap is exact path equality, renames through src_path. Gate G9 and G12 come first. | Stored rows only. A new table of peer PRs. | Stored rows miss a colleague's PR that the user is not on, which is the case that matters most. An in-memory cache keeps the calls low without schema. The gate confirms the shapes and the permission on Data Center 9.x. |
| D10 | The build line reads build stats of the PR head at the run start (S16, Gate G3 PASS). WP-PN adds provider.buildStats, and WP-B1 reuses it. | Wait for part 6. | The call is verified and small. A failed check changes the right answer to "is this ready?". |
| D11 | PR notes: the pr_note table (moved from part 7 A5). The user adds, edits, and deletes notes. A reply or discuss run can propose up to 2 notes. A proposal counts only after the user clicks Keep. Runs see kept notes in context/notes.md, a file without the UNTRUSTED banner, and never see proposals. | Notes in pr-context.md under the banner. Proposals as hints. Notes in localStorage. | Kept notes are the user's decisions, so they need their own trusted file. A comment can steer a proposal, so a proposal is never a fact. Notes must reach every run, so they live in SQLite. |
| D12 | A proposal needs a live message of the user in its thread. A repeat of any note text drops. | Accept any proposal. A similarity rule. | A comment of another person alone cannot plant a note. Exact repeats only, no heuristic. |
| D13 | Reply and discuss results give cites: the threads whose decision the answer relies on. The app checks each number, and the draft card links the threads. | A free-text mention. | The user sees why Claude changed its answer. The eval case scores it. |

Ask follow-ups (added 2026-10-22, section 10.3 Q41; spec.md sections 2.14 to 2.18):

Today each Ask is a fresh run. Earlier answers reach it only through context/history.md (context-files.ts historyFile, HISTORY_ASK_BYTES 40 KB, newest first), and the model reads that file only when it decides to. A question such as "and the second caller?" then gets a guess.

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| D14 | A follow-up is a normal ask run with a parent ask run. The stdin of a follow-up gets a section "# Conversation so far" with the last ASK_TURNS (3) turns of its chain, oldest first: each earlier question cut at 1 KB and each answer cut at 2 KB. Older turns stay in history.md. | `--resume` of the earlier ask session. A context file context/conversation.md. All turns in stdin. | BRIEF 3.5: runs never resume. A file is read only when the model decides to, which is today's problem. Three short turns cost about 10 KB at most and carry the reference that the question makes. |
| D15 | history.md stays as it is for ask runs, with every finished ask in full text. The section names the "## Ask run N" heading of history.md for a cut answer, only when history.md holds that run. | Drop the conversation turns from history.md. Drop the Ask part of history.md for ask runs. | The cut needs a source of the full text, and history.md is the one place. The copy costs at most 3 × 3 KB. Questions of other conversations stay useful as background. |
| D16 | The section is data. Its first line says so: the answers are Claude's own earlier output, the questions are earlier words of the user, and only the text in "Your instructions" is an instruction. Each question and answer is an indented block, so no stored text starts a heading. The section stands before the project instructions, so the question stays the last text of "Your instructions" (prompt.ts common()). | Quote the turns inside "Your instructions". A context file. | One instruction per run, as today. The indent rule is the one of history.md. |
| D17 | Chain data: review_run gains parent_run (INTEGER REFERENCES review_run (id) ON DELETE SET NULL) with a unique partial index, so a chain is a line and never a tree. WP-AF adds it with ALTER TABLE ADD COLUMN in the next free migration, with no rebuild (WP-R1 already built 030). "New question" sends no parent and starts a new chain. | A payload key in a JSON column. A new conversation table. A change to 030. | review_run has no payload column for ask runs. A column gives an exact lookup, and the unique index blocks a fork from two tabs in the database. ADD COLUMN needs no table rebuild, and a built migration never changes. |
| D18 | A follow-up keeps the profile of its parent run. A new question uses the brief profile, as today. When the parent profile no longer exists, the follow-up uses the brief profile, and the hint line says so. | Always the brief profile. | The model and the effort stay the same for one conversation. A brief change for the next review does not change a running talk silently. |
| D19 | The Ask panel shows the newest conversation oldest first, with one "Follow up" box under its newest turn. "New question" switches the same box to a fresh question. Earlier conversations follow below, read only. The q key focuses the box, as today. | One box per conversation. A separate chat page. | UX rules 1 and 10: one box, one primary action, the existing key. |

### 4.3 Part 3: Explain this PR

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| X1 | Run kind explain with its own schema: a one-line summary, a Markdown walkthrough, a reading order, file roles, risks with anchors, a glossary, questions, and coverage. | Keep the review schema. | W9. A narrative needs long Markdown. Structured parts allow links and checks. |
| X2 | "Explain this PR" opens a readable page in the detail pane (URL suffix /explain), with Back. | The panel slot (cramped; it pushes the PR down). A new window. | UX rule: one readable page at reading width. |
| X3 | Links into the diff use `diff:<path>#N<line>` or `#O<line>` hrefs. The server checks each one against the change and turns a bad link into plain text. | Free text paths. | Clickable, checked links. |
| X4 | Mermaid flowchart, sequence, and class diagrams, at most 3. The mermaid module loads lazily. The SVG shows as a data-URL image. securityLevel strict; `%%{` directives stripped; a failure shows the code and the error line. | No diagrams. Server-side render with a headless browser. Inline SVG (needs a CSP change). | S14. No CSP change, because img-src allows data: (app.ts:55-61). |
| X5 | One stored result per run. The page shows the newest one, marks it stale when the heads move, and runs again only on a click. | Auto-run on open. | BRIEF: every run starts from a click. |

### 4.4 Part 4: Measure quality

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| M1 | An eval harness on synthetic fixture PRs with seeded bugs and known non-bugs (traps). Scoring is deterministic: path, side, and line overlap. The user runs it with the real CLI. | An LLM judge for matching. Real company PRs. | No heuristic, no private code. Repeatable. |
| M2 | The harness first records a baseline of the current prompts, before any prompt change. | Compare only v2 variants. | Proof that v2 beats v1. |
| M3 | In-app outcome tracking from existing tables, plus an optional discard reason and the prompt version. A small "Review quality" table in Settings. | A new outcome table. | Most facts exist: status, edits, posts, resolves, orphaned anchors. |
| M4 | "Learn from discards" comes later, after the stats show the main discard reasons. | Build now. | It needs data. A wrong suppression hides real bugs. |

### 4.5 Part 6: Build a Jira task

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| B1 | Three sizes. Small: one PR with a short plan and the code. Medium: a spec PR, then one code PR. Large: a spec PR, an optional contract PR, stacked part PRs, and a cleanup PR. Claude proposes the size. Two app rules raise it: a migration or an API change gives at least medium; an estimate over the line budget gives large. The user confirms before code. | One flow for all tasks. | A one-line fix does not need a spec review. A big feature needs small PRs. |
| B2 | An interview comes first: structured questions with options and a recommended answer, at most 2 rounds. | Spec first, questions inside it. | Unknowns surface before the spec. The answers feed the spec. |
| B3 | The spec lives in the repository at `specs/<KEY>/` (per-repo setting), in the own change plan format (section 5.5, Libraries; spec.md section 6.4). Small uses one file plan.md of about one screen with three sections. Medium and large use short design.md, spec.md, and tasks.md. | Only in the app data folder. | Colleagues review it in Bitbucket, and it stays with the code. |
| B4 | The spec PR is a normal Bitbucket PR that the app creates on a click. Draft replies, Fix, revisions, "Fixed in", and resolve work on it as on any own PR. | A review screen inside the app. | Reuse. Colleagues use the tool they know. |
| B5 | Code goes into separate PRs. Medium: one code PR stacked on the spec branch. Large: each part PR targets the branch of the part before it. | Spec and code in one PR for every size. | Small reviewable PRs. The code does not wait for the spec merge. |
| B6 | Write runs (kind implement) run only in an app-owned worktree of the cache, never in the user's clone. Claude gets Read, Grep, Glob, Edit, Write, and the read-only git tools. It gets no shell. The app runs the allowlisted build and test commands. | Give Claude an allowlisted Bash. | S15: Bash rules are no boundary, and native Windows has no sandbox. The app keeps a full log of each command. |
| B7 | Tests first in each part, from its acceptance criteria. A line budget of 400 changed lines per PR (lock files excluded). A part that grows past it stops and proposes a split. | Tests last. No budget. | Reviewable PRs and proof of behavior. |
| B8 | Own review (the part 1 finder and verify phase) before any PR. The loop fixes confirmed blocker and major points, at most 2 tries. | Open the PR and let colleagues find them. | Colleagues see fewer known defects. |
| B9 | Push and PR only on a click. Only branches the task created. Never the target branch. A force push only after a confirm, with a lease. | Auto-push. | BRIEF: nothing goes to Bitbucket without an explicit action. |
| B10 | At most 2 open code PRs per task. After a lower PR merges, the app proposes to move the next PR to the new target in one click. After a squash merge, it proposes a rebase and a force push with a lease, after a confirm. | Unlimited stack. Auto-retarget. | Reviewer load and review safety. |
| B11 | The next part starts when the PR before it has at least 1 approval, no "Needs work", no open blocker task, and green or no builds on its head. The user can override with one confirm. | Wait for the merge. | Fast flow with a review gate. Section 10 Q19. |
| B12 | The loop shares the one run slot step by step. It takes the slot for each Claude step and frees it between steps. | A second slot for tasks. | Constitution principle 5: one run at a time. A review click waits at most one step. |
| B13 | Living spec: when the code shows the spec is wrong, the loop proposes a commit to the spec files and stops for the user. | Drift silently. | The spec stays the truth. |
| B14 | All Claude runs of a task are review_run rows with a task column. pr becomes nullable for them. | A second run table. | Reuse of slot, log, cancel, usage, and restart recovery. 44 queries need an audit (tasks.md WP-B0). |
| B15 | The plan uses fixed patterns. A prep part holds a refactor that keeps behavior. A feature flag hides new behavior when the repository has flags, and the plan names its removal. Schema and API changes go expand, then migrate, then contract. A spike part explores an unknown. It never merges, and its result changes the spec. Parallel parts in several worktrees come later. | Parallel parts now. | One run slot and the reviewers' load. A stack of 2 open PRs already overlaps review and build. |
| B16 | Branch prefix: one global list of prefixes in Settings > Tasks (default `feature/`, `bugfix/`, `hotfix/`), editable and reorderable. The plan screen shows the list as chips plus "Other…" (a free prefix that git accepts). The first chip starts selected. The pick belongs to the task. The per-repository prefix and "Change the prefix" go away; the stored per-repository value is dropped (section 10.4, Q42). | Map the Jira issue type to a prefix. Keep a per-repository prefix. | No guess from the issue type. One list fits all repositories, and a free prefix covers the rest. Dropping the old value is the simpler migration. |
| B17 | Branch name: `<prefix><KEY>-<slug of the full summary>`. No 40-character cut. Only a safety cap of 100 characters for the whole name, cut at a hyphen (spec.md section 6.16). | Keep the 40-character slug. | The full summary makes the branch readable in Bitbucket. 100 characters stay far below the file name limit of 255 bytes and keep the loose ref path in the cache short on Windows. |
| B18 | Base branch: the repository's default branch from Bitbucket REST (Gate G13), with a searchable branch picker on the plan screen (Gate G14). The last pick per repository starts selected when it still exists. The PR targets the base branch. The New task form loses its "Target branch" field. | Keep the free text field. Use `git ls-remote --symref` only. | The picker shows only branches that exist. The default branch comes from the server setting, not from a guess. |
| B19 | A branch with the task's name that exists on the server: "Continue on <branch>" (the default: build on top of it, push with a lease, never overwrite) or "Start a new branch" (`-2`, `-3`). | Always add a suffix. | A user who restarts a task keeps the commits and the open PR. A lease keeps a colleague's push safe. |
| B20 | Several repositories (small and medium tasks): the user picks one main repository. The task workspace checks out same-server submodules: first level editable, deeper levels read-only, other servers read-only. After the build, the app opens branches and PRs only in the repositories that changed, submodule PRs first, all with one click. Claude may propose another repository with a reason; only an added one gets a worktree, a branch, and a PR. The line budget counts all repositories. Large tasks stay single-repository in v1. | One repository per task. Separate tasks per repository. | One change that spans a library and its user is one task for the user. The review snapshot keeps "No submodules"; only task workspaces change. |
| B21 | Pre-flight before the build: write permission per repository (Gate G15), the base branch exists, and the branch rules that the token can read. It runs before any Claude step and again before each push. | Find out at push time. | Claude spends no tokens on a task that cannot push. |
| B22 | "Tell Claude": every waiting state after the build started shows a free-text box. One send starts exactly one implement step (mode instruct) with the text as the only content of "Your instructions". The step gets the same tools, path check, checks, and own review as any implement step (spec.md section 6.18.1, 6.18.2). | Only fixed buttons. A chat with many turns. | The user can steer the code without a new task, and every change still passes the same guards. |
| B23 | Git stays with the app. The app never parses the text for commands such as "push" or "rebase". Claude never runs git. Claude can only report in its result that the branch needs the newest base (needsBase); the app then shows "Update from <base>". | Map words in the text to git actions. Give Claude git write tools. | No heuristic on free text. Each outward or history-changing action stays an explicit click (BRIEF 3.6). |
| B24 | "Update from <base>" uses the task's own base branch of each repository, the one the user picked (for example a release branch). The label names it. It never uses a fixed develop or master, or the default branch. | Always the default branch. | A task on a release branch must never pull in the main line. |
| B25 | Before the first push of a branch, the update rebases onto the new base head. After the first push, or on "Continue on <branch>", it merges the base into the task branch. The update never needs a force push after the first push. | Always rebase with a force push and a confirm. Always merge. | A clean history while nobody has seen the branch. After that, colleagues' review comments and checkouts stay valid. |
| B26 | Conflicts go to a Claude step that only resolves conflicts: it may change only the unmerged paths. The app then checks for conflict markers and runs the checks. Remaining markers, a failed step, a question, or a stop abort the rebase or merge and reset every repository to its head before the update. The app says so. Gitlink conflicts never go to Claude; the app resolves them. | Let the user resolve in the clone. A free fix step. | The branch is never left half merged, and Claude cannot slip other edits into a conflict fix. |
| B27 | The app suggests the update when the base moved since the branch point (`git ls-remote`), when the Bitbucket PR reports conflicts (properties.mergeResult, Gate G18), or when Claude asks for it. With several repositories, each one updates from its own base, deepest first, and a submodule update also moves the gitlink in the parent. It replaces "Rebase onto it" of spec.md section 6.16.8. | A periodic auto-update. | No new polling loop and no surprise history changes. |

### 4.6 Part 7: Autopilot replies

On hold (2026-10-22): the user paused autopilot; a human posts every reply. Keep for later.

When part 7 resumes, A4 and A5 use the part 2 PR context and PR notes (D6 to D12): the pr_note table, the Notes block, and context/notes.md come from part 2, and Gate G9 runs in part 2.

Background: a colleague's app replies on PRs without approval. In one case a reviewer asked to finish the mac build scripts work first, because of merge conflicts. The bot replied with two sequencing options, a recommendation, and a request for the other PR's link. The answer was useful, but it committed the author to a plan that the author never saw. Part 7 gives the same speed for safe replies and keeps every decision with the user.

| ID | Decision | Alternatives | Why |
|---|---|---|---|
| A1 | Three levels, built in steps (Q26). Level 1: a new comment starts a reply run without a click; the draft waits; one notification; one click posts it. Level 2: a per-PR "Autopilot" switch; safe reply classes post by themselves. Level 3: actions (merge the target in, fix conflicts, push, ask for review again) come with part 6 and only for task PRs. | Level 2 at once. Level 1 only. | Level 1 proves the classes and the prompts at no risk. The eval (A15) and the user smoke gate level 2. Level 3 needs the part 6 worktree, push, and lease rules. |
| A2 | One per-PR setting with three modes: off, draft (level 1), post (level 2). Default off. Only own open PRs (my_role AUTHOR) can turn it on. Turning it on is the explicit user action, and its dialog lists what Autopilot may do. | A global switch. Mode per thread. Reviewer-side PRs too. | Q25: the user turns it on per PR. A reviewer-side reply would carry the user's review judgement. One switch keeps the UX simple. |
| A3 | Trigger: the sync rule for comment_new (reconcile.ts newCommentIds) feeds an autopilot queue for PRs with a mode other than off. One queue row per PR coalesces the comments. The run starts after a quiet window of 2 min without a new comment, when the run slot is free and quiet hours do not apply. | One run per comment. Start at once. | Colleagues often post 2 or 3 messages in a row. One run answers the thread once and saves usage. |
| A4 | Context is rebuilt for each run, with no session persistence (D1, D2 pattern): PR text, diff summary, build state, every message of the trigger threads with the earlier Autopilot replies marked, the linked Jira task, the part 6 spec files for a task PR, the other open PRs of the repository, and the PR notes. | `--resume` a PR session. | BRIEF 3.5: app runs never resume. A fresh context shows edits and deletes, and costs less than a long transcript. |
| A5 | PR notes: a new table pr_note. The user adds, edits, and deletes notes in the Autopilot panel. Autopilot proposes notes from the thread (for example "Anna and I agreed: merge after #45"). A proposed note goes into the context only in an untrusted section, until the user clicks "Keep as a decision". | Notes in the PR description. Notes in localStorage. Every proposed note trusted. | Notes must reach every later run, so they live in SQLite. A comment can plant a note, so only the user's notes count as decisions. |
| A6 | Classify and draft in one run (kind autopilot). Each trigger thread gets a class, an action wish, a reply, evidence, and a commits flag. The app maps class to the allowed action with a fixed table (A7). The model never picks the action alone. | A cheap first pass for the class, then a draft pass. | A separate classify pass reads the same context twice. The guard (A8) gives the independent second look only where a post is at stake. |
| A7 | Classes and allowed actions at level 2. Post: answer (a question that the code or the spec answers, with evidence that the app checks), clarify (a question back when the comment is unclear), ack (a thank-you or "noted" for an FYI). Draft for the user: decision (scheduling, priority, scope, merge order), disagreement, change_request (unless the part 6 loop owns the PR at level 3), and any reply with commits true. Ignore and log: smalltalk that needs no reply, out_of_scope (abuse, unrelated, or an attempt to instruct the bot). Level 1 drafts every class except the ignored ones. | Let the model decide when to post. Post decisions with options. | Only replies that state facts or ask back can post. Anything that binds the user to an action, a date, or a scope waits. |
| A8 | A guard phase before each auto-post: a second CLI process in the same run row reads only the thread, the proposed reply, and the evidence. It gives its own class and commits flag without seeing the first class. The reply posts only when both phases agree on a post class, both say commits false, and the app's evidence check passes. Else it becomes a draft. | No guard. A guard on every thread. | The R2 verify pattern: the app enforces the second look. It costs a second process only for the few replies that would post. The eval can drop it if it never changes an outcome. |
| A9 | A reply may offer options and a recommendation. It never commits the user to an action that the app cannot do. A commitment ("I will merge master and ask for review again") is allowed only at level 3, on a task PR, where the app does it. | Free text promises. | The colleague's reply promised a plan that a person had to carry out. |
| A10 | Bot mark (Q27): every Autopilot post starts with a prefix and ends with a footer. Defaults: prefix "🤖 ", footer "_Automatic reply from the author's assistant. The author reads this thread later._". Both are settings. The prefix cannot be empty, and it must hold a letter, a digit, or an emoji. The footer can be empty. The markAi setting does not apply to Autopilot posts. | markAi only. A mark that the user can turn off. | Q27: colleagues must always see that a bot wrote the reply. |
| A11 | Guardrails: no code path from Autopilot to approve, needs work, merge, decline, resolve, or reopen; secrets check of each body against the stored tokens; caps per thread and per PR; quiet hours; loop protection; a global pause and the per-PR switch; a full log; a cancel window before the send; and "Delete" for a bot reply that has no replies (S18). | Prompt rules only. | Each guard is a deterministic app check with a test and a control mutation. |
| A12 | Loop protection without guesses: Autopilot never answers a comment that starts with any Autopilot prefix, a comment from an account in the "Bot accounts" setting, or a SERVICE user (S19, Gate G10). It stops on a thread after 3 Autopilot posts since the user's last own message. | Text rules that guess a bot ("as an AI…"). | Only facts the app can check. The cap ends any loop that the facts miss. |
| A13 | Auto-posts go through the outbox with a send delay of 60 s (post.not_before). The Autopilot panel shows "Posting in 40 s · Cancel". After the send, "Delete" works while nobody answered. Just before the send, the outbox reads the thread again and sends only when the trigger message is still the newest live message, the thread is open, the PR is open, and the user has no open touched draft there. | Post at once. Post without a fresh check. | The user and colleagues act in the delay. The fresh read prevents an answer to a deleted or already answered comment. |
| A14 | Dependency watch: a PR can wait for another PR ("blocked by #45"). The user sets it, or Autopilot proposes it from the thread with a PR number from the open-PR list. A proposal needs the user's click. When the blocking PR merges, the app notifies. For a task PR at level 3, the part 6 loop merges the target in, fixes conflicts, pushes with a lease, and asks the reviewers to look again. | No watch. Auto-confirm the bot's proposal. | The example thread asked exactly for this. The proposal comes from commenter text, so the user confirms it. |
| A15 | Reply eval: synthetic threads with the expected class and allowed action. The key metric is wrong auto-posts: a post where the case allows only a draft or ignore. Level 2 ships only with 0 wrong auto-posts over 3 repeats. | Ship on smoke tests only. | A wrong post is the expensive failure. Synthetic cases give a repeatable number. |
| A16 | Autopilot shares the one run slot. A user click wins when the slot frees. Autopilot never cancels a user run. A usage limit pauses Autopilot for all PRs until the user resumes it. | A second slot. Retry after a usage limit. | Constitution principle 5. A retry loop burns quota that the user needs. |

## 5. Architecture

### 5.1 Part 1: Review pipeline

```
Start (brief) -> workspace (unchanged) -> finder run (phase "finding")
   -> validate: anchor + cause + rule quote (app) -> dedupe groups (app)
   -> verify run (phase "checking", same workspace) -> caps + groups (app)
   -> items + summary (judge) -> UI groups by verdict and volume
```

| Area | File | Change |
|---|---|---|
| Profile fields | src/shared/dto.ts:118-150 | modules (string[]), volume (quiet, balanced, thorough), verifier {mode on or off, model, effort}. Defaults on parse. |
| Shipped profiles | src/server/review/catalog.ts:59-138, 161-184 | "Review" (id general) with modules and efforts. Explain lens text. FORMER[4]. Former covers name, note, prompt, maxTurns, languageChecks, effort, reviewer, modules, volume, verifier, with a deep compare. |
| Version | src/server/config.ts:50 | PROFILES_VERSION 5. |
| Retire | src/server/settings.ts:56 (upgradeConfig) | Drop shipped security and over when every field equals its v4 value. Else keep them as the user's own profiles. |
| Finder prompt | catalog.ts:241-333 | FINDER_RULES replace SEVERITY_RULES and RESULT_RULES lines for review runs. Module sections. Context block (R14). No DELEGATE when the app gives no Agent tool. |
| rl-reviewer | catalog.ts:476-493 | Same context block, modules, rubric, and do-not-flag list. Pinned effort. |
| Verify agents | catalog.ts (new verifyAgent, verifierAgent) | Verify rules (spec.md section 1.6). |
| Schemas | src/shared/review.ts:14-94 | finding gains title, trigger, cause, rule, module (with defaults). New verifyResult. explainResult and discussResult (parts 2, 3). |
| Delegation | src/server/review/jobs.ts:534-545 | Agent tool only above the size limit, or with reviewer mode always. |
| Validation | src/server/review/validate.ts:146-213 | cause check on changed lines (diffmap.ts newLines "add"), rule quote check, drop reason "unchanged" and "rule". |
| Verify phase | jobs.ts steps (after runner.run, before workspace remove), judge.ts | context/candidates.md, second runner.run, verdict merge, caps. One Ending. |
| Storage | migration 030 | review_run.prompt_version, phase usage in usage_json. Finding payload verify {…}. |
| UI | src/web/review/Brief.tsx, Drafts.tsx, RunLine.tsx | Checkboxes and volume. Groups. Refuted list with Restore. Phase line and cost. |

Phases and time: the run line says "Finding problems" and then "Checking 9 findings". The run log groups the events by phase (run_event gains no column: the verify events carry agent "rl-verify" or "rl-verifier"; migration 028 added run_event.agent).

Estimate for a 500-line change (not measured; WP-M1 measures it): finder 5 to 12 min, verify 2 to 6 min for about 10 candidates, so the run takes 30 to 50% longer and costs 30 to 50% more tokens than today. The verify phase reads only the code around each candidate.

Failure rules: a verify phase that fails (usage limit, auth, max turns, schema) makes the run incomplete. The candidates stay with verdict "unchecked", and the run line says "The check did not finish: 9 findings are not checked." The run never says "no issues".

### 5.2 Part 2: Discuss

- Start: the "Ask Claude about this" link on a finding card, in Drafts or on a diff line. After a post, the thread More menu item "Ask Claude about this comment" starts it. It shows only when the root post holds an AI finding.
- Run: kind discuss. Workspace at the current heads, as Ask. Context files: context/finding.md (the finding at its run head, with the anchor excerpt, verdicts, and the user's current text and state) and context/discussion.md (earlier turns of this finding, newest last, 40 KB cap). The new user message is the only content of "Your instructions" (prompt.ts common(), as Ask).
- Result: answer (Markdown), verdict, reason, revision (severity, title, body) for revised, reply for a posted finding.
- Apply at the run end: upheld changes nothing. Revised stores a revision item (kind finding, status discarded, payload revises <finding>). Withdrawn discards the finding with withdrawn {run, reason, was}. A posted finding gets a reply draft (origin discuss, writer rank of a reply run) when reply has text. Withdrawn on a posted finding also proposes resolve, ticked when the user started the thread.
- Items: items.ts use-revision and keep-mine accept a finding revision. Ready to post, history.md, and the post plan skip a finding with revises set.
- Limits: 20 user messages per finding, 4,000 characters per message, 8,000 per answer, 40 turns per run.

PR context and PR notes (D6 to D13):

```
run start (reply, discuss, review, fix, ask)
   -> loadPrContext: rows (PR, tasks, comments, drafts, fixes, commits, pr_change, notes)
      + Bitbucket reads (build stats, open-PR list, change lists; 15 s cap, cached)
   -> prContextFile (pure) -> context/pr-context.md (UNTRUSTED)
   -> kept notes -> context/notes.md (the user's decisions)
   -> run -> validate cites and note proposals (app) -> drafts + suggestions in one transaction
```

| Area | File | Change |
|---|---|---|
| Outcome | src/shared/outcome.ts (new; moved from src/web/review/outcome.ts with fixState, fixWaiting, WHY, snippet, plural, shortHash, touchedDraft) | One threadOutcome for the server and the UI. The web modules re-export the moved names. |
| Builder | src/server/review/context-files.ts (prContextFile, notesFile); src/server/review/pr-context.ts (new: loadPrContext) | Pure builder with caps and the trim rule. The loader reads rows and the Bitbucket facts. |
| Run wiring | src/server/review/jobs.ts, prompt.ts (Tools lines), catalog.ts (PR_CONTEXT_RULES, NOTES_RULES) | The two files for the run kinds of D7. Focus threads per kind. Counts in the log. |
| Bitbucket | src/server/bitbucket/provider.ts | listOpenPullRequests (S20) and buildStats (S16). listChanges and getPullRequest exist. |
| Schemas | src/shared/review.ts, src/shared/dto.ts | noteProposal, cites, notes; NoteDto and the route inputs. |
| Notes | src/server/review/notes.ts, notes-routes.ts (new) | Validation of proposals and cites, the CRUD routes, PR link states. |
| Storage | migration 031 | pr_note. |
| UI | src/web/pr/Notes.tsx (new), src/web/pr/PrDetail.tsx, src/web/review/ReplyDraft.tsx | The Notes block, the suggestion row and the cites line on the draft card. |

Ask follow-ups (D14 to D19):

```
POST /api/prs/:id/ask {question, parent?}
   -> parent checks (same PR, kind ask, no child yet) -> profile of the parent, else the brief
   -> run (kind ask, parent_run) -> context files as today (history.md, pr-context.md, notes.md)
   -> askConversation (pure over rows): the last 3 turns of the chain, cut -> stdin "# Conversation so far"
   -> answer -> GET asks gives parent -> the panel groups chains
```

| Area | File | Change |
|---|---|---|
| Storage | the next free migration (WP-AF), ALTER TABLE ADD COLUMN | review_run.parent_run and the unique index review_run_parent. |
| Conversation | src/server/review/context-files.ts (askConversation, ASK_TURNS, the two cut constants) | Pure builder over the chain rows. It names a history.md heading only when history.md holds the run. historyFile also gives the ask run IDs it kept. |
| Prompt | src/server/review/prompt.ts (buildAskPrompt, common()), catalog.ts (askAgent with the follow-up rule) | The section before the project instructions. One rule line in askAgent only for a follow-up. |
| Run and route | src/server/review/jobs.ts (ask with parent, key, profile), routes.ts, run-rows.ts (asks with parent_run, chain query), src/shared/dto.ts (askInput parent, AskDto parent) | Parent checks and 409 for a chain that moved on. |
| UI | src/web/ask/{AskPanel.tsx, model.ts, data.ts} | Conversation groups, the Follow up box, "New question". Text uses Markdown.tsx with diagrams, as today. |

### 5.3 Part 3: Explain

- Start: the action bar button "Explain this PR" (key w). The setup comes from the Explain profile (model, effort, turns, prompt lens). With 2 or more explain profiles, the page shows a small picker.
- Run: kind explain. The same workspace and context files as a review, but no history.md and no questions.md.
- Validation: anchors of risks use the finding anchorer. Diff links are checked against the change. A bad link becomes plain text and counts in coverage.skipped. Extra mermaid fences after 3 become code blocks.
- Page: route `/:view/:project/:repo/:id/explain`. Sections in order: summary, "Read in this order", walkthrough, risks, files, glossary. Questions go to Drafts as today. A diff link opens the Files diff at that line and pushes a history entry.
- Mermaid: src/web/explain/mermaid.ts imports mermaid lazily, renders one diagram at a time, and gives an `<img>` with a data URL. Theme variables come from the CSS tokens. A theme change renders again.

### 5.4 Part 4: Measure

- Eval harness: fixtures/eval/cases/<id>/ holds case.json, base/ (files), and head.patch. scripts/eval/run.ts builds a temp git repo per case. It serves the repo through the `gitRemote` option of createReviewJobs (jobs.ts:625) and seeds a temp database with one PR row. Then it starts the review job with the real CLI and scores the shown items. scripts/eval/compare.ts prints the deltas of two result files. The harness refuses to start without `--real`.
- In-app tracking: GET /api/stats/review computes per profile and prompt version: runs, candidates, refuted, unsure, shown, accepted, edited, discarded by reason, posted, addressed, outdated, mean time, and mean cost. Addressed: the thread of a posted finding is resolved, or a "Fixed in" draft exists. Outdated: the anchor turned orphaned after the post (comment.orphaned_at).
- Discard reason: after d or Discard, the card offers chips: Not a bug, Not worth fixing, Duplicate, Intended, Wrong place. One click stores payload discardReason. No chip is required.

### 5.5 Part 6: Build a Jira task

#### Flow by size

```
Small : Questions -> Plan -> Build (tests, code, own review) -> Open PR (plan + code) -> Done
Medium: Questions -> Plan -> Spec PR (colleagues) -> Build -> Open code PR -> Done
Large : Questions -> Plan -> Spec PR -> [contract PR] -> part 1 PR -> part 2 PR (stacked) ... -> cleanup PR -> Done
```

- Sizing: the spec run returns the estimate (parts, changed lines per part, files, modules, flags db, api, unknowns). The app applies the two rules of B1. The plan screen shows the size with one line of meaning, and the user confirms or changes it.
- Re-size: a small task that grows past the budget stops and offers "Make it medium" or "Make it large". It never opens a big PR. A large task whose plan has one part offers "Use one PR".

#### Entities (spec.md section 6.3 has the columns)

| Table | Holds |
|---|---|
| task | One task per Jira key and repository: state, size, branches, spec folder, settings, budgets. |
| task_question | Interview and loop questions with options, recommended answer, and the user's answer. |
| task_part | One row per PR of the task: spec, contract, part, cleanup, or spike. Branch, base branch, PR link, state, size. |
| task_step | One row per loop step: interview, spec, tests, implement, check, fix, review, commit, push, pr, retarget, rebase, replan, question, spec-change, instruct, update, resolve (B22 to B27). Commands with exit codes and output tails, diff stats, run link. |
| task_event | Notifications: needs you, part ready, spec approved. One row per task, kind, and ref. |
| repo_task_settings | Per repository: spec folder, line budget, max open code PRs, approvals needed, commands (argv lists), test path globs, excluded globs, the last picked base branch. The branch prefix list is global (config.json, B16). |
| task_repo | One row per repository of a task: main, submodule (path, depth, parent), or added (proposed by Claude). Access edit, read, or none, with the reason in plain words. Base branch and base commit (B20). |
| task_pr | One row per code part and changed repository other than the main one: branch, base, lease, PR link, state, and the submodule pointer state (B20). The main repository keeps using the task_part columns. |

#### Run kinds

| Kind | Tools | Workspace | Output |
|---|---|---|---|
| interview | Read, Grep, Glob, rl-git | Sanitized snapshot of the target head | questions[] or done |
| spec | Read, Grep, Glob, rl-git | Sanitized snapshot of the target head (or the spec branch for a replan) | docs, tasks, estimate |
| implement | Read, Grep, Glob, Edit, Write, rl-git | The task worktree (writable, app-owned) | summary, done, question, specChange |
| review (task) | as today | Sanitized snapshot of the task commit | findings (part 1 pipeline) |

#### Write runs: what enforces what

| Layer | Enforced by | Rule |
|---|---|---|
| Tools | CLI `--tools Read,Grep,Glob,Edit,Write` and `--allowedTools` with the same names plus the rl-git server | No Bash, PowerShell, WebFetch, WebSearch, or Agent. The init check kills a run that lists another tool (existing rule). |
| Approvals | CLI `-p` manual mode | A call that needs approval and has no allow rule is denied (S15). |
| Settings and hooks | CLI `--restricted`, `--strict-mcp-config` | No hooks, no settings files, only app MCP servers (Gate B8, B9). |
| File tool confinement | CLI `--restricted` | Read stays in the cwd (Gate B8). Edit and Write confinement is unverified: Gate B17. |
| Config files | App: sparse checkout of the worktree | `.claude/`, `.mcp.json`, `.codegraph/`, CLAUDE.md, CLAUDE.local.md, AGENTS.md, `.gitmodules`, and hook sources are absent on disk. Commits keep them unchanged. |
| Changed paths | App: `git status` after each step | A denied path (fix edit rules, BRIEF Denied paths) or a path outside repo/ fails the step and resets the worktree to the last commit. |
| Commands | App | Only the argv lists of repo_task_settings, run by the app, with timeouts and process-tree kill. Claude never starts a process. |
| Secrets | App | Scrubbed env (BRIEF Child environment), no token in the worktree or env, isolated git config without credential helper, optional HOME isolation. |
| Not enforceable | nobody | A test or build command runs code that Claude wrote. It can read the user's files and reach the network. Native Windows has no OS sandbox (S15). Safeguards: the plan approval, the own review, the user's look at each PR before push, the first-use warning (section 10 Q2). |

#### Git and Bitbucket

- Cache: the existing bare cache per repository. Task refs live under `refs/rl/task/<task id>/`. Task branches are local branches of the cache, named like the remote branch.
- Worktree: one per open part under `<dataDir>/tasks/<db stem>/<task id>/part-<n>/repo`, made with `git worktree add` from the cache, with sparse checkout, `core.symlinks=false`, and `core.hooksPath` set to an empty folder. Commits use the user's name and email from Settings or the clone config. No hook runs.
- Push: `git push` from the cache with the token in the GIT_CONFIG env (git.ts:46, as the fetch). A new branch pushes with `--force-with-lease=refs/heads/<b>:` (must not exist). An update pushes with the lease of the last pushed hash. The refspec never has a `+`, because git then ignores the lease. A normal push first checks the fast-forward and else returns "needs force". A confirmed force push skips only that check and keeps the lease. The app refuses any refspec to a branch that the task did not create, and to the target branch.
- Bitbucket calls (src/server/bitbucket/ only): create PR, update PR (destination, title, description, reviewers), build stats of a commit, repository clone links for a task without a PR. Gate G1 to G6 check them on Data Center 9.x. Decisions B18 to B21 add reads only: the default branch (G13), the branch search (G14), the repositories with write permission and the branch restrictions (G15, G16), and the merge commit of a merged PR (G17).
- Default branch: GET .../default-branch (B18, Gate G13). `git ls-remote --symref <url> HEAD` stays as the fallback when that read fails.
- Submodules (B20): the app reads the gitlinks of the base commit (`git ls-tree`) and `.gitmodules` (`git config --blob`). A submodule URL maps to a Bitbucket repository only when that repository's REST clone links hold the same URL. Each mapped submodule gets its own bare cache and a worktree at its path inside the parent worktree. The app never runs `git submodule`.

#### Stack rules (large)

- Each part branch starts from the head of the branch below it. The first part starts from the spec branch (or the contract branch).
- At most 2 open code PRs. The loop builds the next part only when the PR below it passes the gate (B11) and the open count allows it.
- A lower PR gets new commits (colleague fixes, Fix flow): the app proposes "Update part 3", which rebases the upper branch on the new lower head. The rebase changes published commits, so the push needs a confirm and uses a lease.
- A lower PR merges with a merge commit: the app proposes to move the next PR to the lower PR's target (PUT destination). The diff stays clean.
- A lower PR merges with a squash: the app proposes the move plus a rebase onto the target (`git rebase --onto <target> <old lower head> <branch>`) and a force push with a lease, after a confirm.
- A lower branch deleted at merge: Bitbucket can decline the PRs that target it (unverified, Gate G5). The part PR text asks the merger to keep the branch until the next PR moves. If Bitbucket declined the next PR, the app offers "Open the PR again" and says that its comments stay on the declined PR.
- After each merge, a replan run reads the target branch and the remaining tasks. A changed plan needs the user's approval and goes in as a commit to tasks.md.

#### Loop of one part

```
tests step (implement, mode tests) -> checks must fail (new tests red)
for each task of the part:
    implement step -> checks -> red: fix step (at most 3) -> green: commit (tick the task in tasks.md)
    size check -> over budget: stop, propose a split
own review (finder + verify on part base..head) -> blocker or major: fix step (at most 2) -> checks -> verify again
ready -> "Open PR for part 2 of 4" (click) -> push + create PR -> wait for review and builds
```

Stop points (each one says why and offers one button): red after 3 fixes; a check that times out twice; a blocker after 2 fixes; a question from Claude; a spec change proposal; a denied path; over the line budget; over the time, turn, or cost budget; usage limit or auth problem; Cancel. Resume restarts the stopped step from the last commit. The app keeps the discarded changes as a patch file in the task folder.

#### Run slot and notifications

- Each Claude step takes the slot. Checks, git, and Bitbucket calls do not. A user start during a step gets 409 with "Pause building after this step". The loop waits for a free slot and says "Waiting for your review of PR #12 to finish."
- task_event notifies only for: needs you, a part ready to open, and spec approved. One tab claims each event. The notifications setting applies.

#### Libraries (decided 2026-10-22)

| Library | Decision | Why |
|---|---|---|
| Claude Agent SDK | Rejected for now. The app keeps running the user's installed Claude Code (`claude -p`, `--restricted`, the user's own login). Revisit only when Anthropic allows subscription login for SDK apps. | The Agent SDK overview (code.claude.com/docs/en/agent-sdk/overview, read 2026-10-22) says: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." The same page puts the SDK under Anthropic's Commercial Terms of Service, so it is not open source. Unverified here: it bundles its own CLI of about 230 MB per platform, and `bun build --compile` needs a bunfs workaround for it. |
| canUseTool and PreToolUse hooks | Not used. | `--restricted` (Gate B17) and the `git status` path check after each step stay the write guard. A hook adds a second guard that the CLI, not the app, enforces. |
| spec-kit (github/spec-kit) | Rejected, also as a file format (user decision, 2026-10-22). The app uses its own lean "change plan" format for existing projects (spec.md section 6.4). | spec-kit targets new projects. It needs a constitution and many documents, which is too heavy for a small feature or a bug fix in an existing project. The goal is a short, well-defined change to an existing repository at a low token cost. |
| Change plan format (own) | Size-scaled: small is one plan.md of about one screen; medium and large are design.md, spec.md, and tasks.md, each short. An integration map comes first, with file:line references from the repository (CodeGraph when the run has it, else Grep): the files and functions to change, the pattern to copy ("the same way as X in Y"), the tests to extend, the affected callers, and the migration or API touch points. Acceptance criteria are testable lines, each mapped to a test. Each task lists its files, the existing tests to run, and a done check. No constitution and no boilerplate sections: the repository's own CLAUDE.md, AGENTS.md, and conventions are the standing rules, read through the sanitized context as today. | Each loop step reads only its task, its files, and its tests, so a step costs few tokens. The map grounds the plan in code that exists, and the app can check each reference. The task-by-task pattern stays: work one task at a time and tick `[x]` in the commit that finishes it. |
| XState v5 | Adopted as a pure transition function only (user decision, 2026-10-22). src/server/tasks/machine.ts declares the task and part states and events with `setup({...}).createMachine({...})`. The app builds a snapshot from the state in SQLite with `machine.resolveState({ value, context })`, checks an event with `snapshot.can(event)`, and computes the next state with the pure `transition(machine, snapshot, event)` (xstate 5.19.0 and later). No actor runs (no `createActor`), the machine has no actions with effects, and no XState snapshot is stored. The task and task_step rows stay the single source of truth. A restart resumes from the last committed step. | Guarded transitions in one declared place, a diagram of the loop for docs and review, and a table test over every state and event. MIT (npm registry, 5.33.3). bundlephobia: 46.8 KB minified, 14.5 KB gzip, no dependencies; it is server code inside the compiled binary. Unverified: Bun support (no statement in the XState docs; the WP-B0 tests under `bun test` and tests/build/compiled.test.ts prove it). |
| Temporal, Inngest, Restate, Trigger.dev, LangGraph.js, Mastra | Rejected. Each step is a fresh run that reads tasks.md and the worktree. | One process, one run slot, and the state already lives in SQLite. An engine adds a service or a runtime that the app does not need. |
| simple-git, isomorphic-git, p-queue, diff libraries | Rejected. | The app uses the git CLI with an isolated config, one run slot, and `git diff --numstat` for the line budget. |

Risk note (unverified wording): the usage terms speak of "ordinary, individual usage". Bounded runs that the user starts with a click fit it. Long unattended loops are a grey zone, which is one reason why Autopilot is on hold. Re-read the terms before a release (Q5).

### 5.6 UX rules for every part

1. One primary action per state, with a short step strip.
2. Plain words in the UI ("part 2 of 4", not slice or stack).
3. Say what happens now, what the app waits for, and who must act.
4. Good defaults and no setup before the first use.
5. Questions as a simple form with the recommended option preselected.
6. Few approvals: the plan and each PR. One confirm only for destructive or outward actions.
7. Errors name the cause and the next step, with one button.
8. Notifications only when the user must act or a part is ready.
9. Progress visible in the inbox row.
10. Reuse components, the prototype look, the keyboard model, and the accessibility rules.

Parts 1 to 3 follow the same rules: one "Review" setup with a few named checkboxes and a three-step volume; one "Ask Claude about this" link; one "Explain this PR" button; one "Notes" block with "Add a note" and Keep or Dismiss on each suggestion; one "Follow up" box under the newest Ask answer, with "New question". Part 7 (on hold) has one switch "Autopilot" with one status sentence. spec.md section 7 checks each screen against each rule.

### 5.7 Part 7: Autopilot replies

On hold (2026-10-22): the user paused autopilot; a human posts every reply. Keep for later.

```
sync (comment_new on an own PR, mode draft or post)
   -> autopilot_queue (one row per PR, due after the 2 min quiet window, quiet hours, caps)
   -> run slot free -> autopilot run (kind autopilot, phase "reading")
   -> validate (threads requested, evidence quotes, PR numbers, secrets) -> class-to-action table (app)
   -> mode post and a post class: guard phase (phase "checking", same run row)
   -> post: outbox row (auto, not_before now + 60 s) -> fresh thread read -> POST with the mark
   -> draft: reply item (origin autopilot) -> one event, one notification
   -> ignore: autopilot_turn row only
```

| Area | File | Change |
|---|---|---|
| Trigger | src/server/sync/engine.ts (syncPr, the events transaction) | Next to comment_new, upsert autopilot_queue for a PR whose pr_autopilot.mode is not off, with the new comment IDs that pass the scope and loop rules. |
| Queue and scheduler | src/server/autopilot/queue.ts (new) | Due time, quiet hours, caps, global pause, slot wait. It starts runs through the jobs API. |
| Context | src/server/autopilot/context.ts (new); src/server/review/context-files.ts | context/threads.md, context/notes.md, context/open-prs.md, context/builds.md, plus pr.md, task.md, and context/spec/ for a task PR. |
| Run | src/server/review/jobs.ts (kind autopilot, guard phase), catalog.ts (autopilotAgent, guardAgent), prompt.ts (buildAutopilotPrompt) | Same runner rules as a reply run: read-only tools, no Agent tool, sanitized snapshot. |
| Judge | src/server/autopilot/judge.ts (new) | Validation, the class-to-action table, items, turns, outbox rows, events. Writer priority and revisions as for a reply run. |
| Outbox | src/server/publish/outbox.ts | Rows with auto 1 and not_before. Fresh thread read before the send. Mark from the Autopilot settings. Cancel and delete. |
| Bitbucket | src/server/bitbucket/provider.ts | deleteComment (S18), listOpenPullRequests (S20), user type on comment authors (S19). |
| Dependencies | src/server/autopilot/deps.ts (new); sync | A cheap GET of each blocking PR per cycle. Event dependency_merged. Level 3 hands the merge to the part 6 loop. |
| Storage | the next free migration number (031 and 032 went to part 2) | pr_autopilot, autopilot_queue, autopilot_turn, pr_dependency (pr_note comes from part 2); review_run kind autopilot; post auto, not_before, deleted_at; event kinds. |
| UI | src/web/autopilot/ (new), PR header, src/web/settings/, inbox PrRow, src/web/notify.ts | Switch, status sentence, activity list, notes, dependency line, Settings section, row badge. |

Run state: the queue row, the run row, and the turn rows hold all state. A restart keeps the queue and marks a running autopilot run failed (kind restart). The next scheduler pass runs it again when the comments are still unanswered.

Cost: one autopilot run per burst of comments, about one reply-run cost. A guard phase adds a short run only for replies that would post. The caps bound the worst case (spec.md section 11.8).

## 6. Migration

- Profiles: PROFILES_VERSION 5. FORMER[4] holds the version 4 values of every changed shipped field. upgradeProfile compares arrays and objects by their JSON. An unedited field gets the new value; an edited field stays (BRIEF Profile upgrades).
- New fields parse with defaults: modules [] (a user profile keeps today's checks), volume balanced, verifier {mode on, model null, effort null}. A user profile therefore gets the verify phase. The changelog says so.
- Retire: a shipped security or over profile whose every field equals its version 4 value leaves the list. An edited one stays as the user's own profile and gets no later upgrades. pr_brief.profile with a removed ID falls back to the default (profileOf, catalog.ts:141). Old runs keep profile_name.
- Explain: the explain profile stays as the setup of "Explain this PR". Its prompt and effort upgrade field by field. Old explain runs (kind review, explain 1) keep their old run line.
- Results: new keys of finding, verify, and summary parse with defaults. A finding without verify shows as "Not checked", in the main list as today.
- Database: 030 rebuilds review_run for kinds explain and discuss and adds prompt_version, item, and discuss_json. 031 adds pr_note (part 2, spec.md section 2.9) with no rebuild. 032 adds review_run.parent_run for Ask follow-ups with no rebuild. Part 6 rebuilds review_run again for kinds interview, spec, and implement, makes pr nullable, adds task, and adds the task tables (spec.md section 8). db.ts sets the version by list order, so WP-B0 takes the next free number when it merges: 033 unless WP-D2 takes it. The part 7 migration (on hold) takes the next free number after that and no longer creates pr_note.
- PR notes: existing PRs have no notes. Old reply drafts and discuss turns read cites and notes as empty.
- Ask follow-ups: WP-AF adds review_run.parent_run and the unique index review_run_parent with ALTER TABLE ADD COLUMN and CREATE UNIQUE INDEX in migration 032 (the next free number at merge), with no rebuild. 030 stays as WP-R1 built it. db.ts sets the version by list order, so the file takes the number after the newest merged migration (after WP-PN's pr_note file, because WP-AF merges after WP-PN). If WP-PN's migration is still unmerged when WP-AF merges, the two statements join that file instead. Old ask runs read parent_run NULL, so each one shows as a conversation of one question.
- Autopilot (on hold): every existing PR reads as mode off. No old data changes meaning. The AI mark setting keeps its meaning for manual confirms.

## 7. Risks

| Risk | Mitigation |
|---|---|
| The verify phase refutes real bugs. | Refuted points stay visible with Restore. The eval reports candidate recall and shown recall apart. |
| Cost and time grow. | Verify reads only around each candidate, at medium effort. The run line shows time and cost per phase. The eval measures. |
| The model ignores the cause rule. | The app drops the finding with reason "unchanged". The dropped list shows it. |
| Retiring profiles surprises a user. | Only fully unedited profiles retire. The changelog names the Security and Simplify checkboxes. |
| Mermaid CSP noise or layout breaks. | Fallback to the code block. WP-X2 checks the console in e2e. |
| Nullable review_run.pr breaks a query. | WP-B0 audits the 44 queries and adds a test per file. |
| A write run escapes the worktree. | Gate B17 before WP-B4. Path check after each step. No shell. |
| Test commands run hostile code from a hostile Jira text. | Plan approval before code. The user sees each PR before push. First-use warning. WSL2 sandbox later. |
| Bitbucket declines a stacked PR when its target branch is deleted. | Gate G5. PR text asks to keep the branch. "Open the PR again". |
| A loop holds the slot for long. | Per-step time caps (20 min default) and "Pause building after this step". |
| Terms: many runs after one click. | Each part waits for colleagues anyway. Per-part budgets. Section 10 Q5. |
| A comment steers a run through pr-context.md, or plants a note. | pr-context.md has the UNTRUSTED banner. stdin holds no comment or note text (canary test). A proposal needs a message of the user in its thread and counts only after Keep. |
| The State line disagrees with the UI. | One shared threadOutcome (D8) and a parity test over the outcome.test.ts cases. |
| The open-PR reads slow the run start or fail. | One 15 s budget, an in-memory cache, at most 30 change lists, Cancel stops them, and a failure falls back to stored rows with a line in the file. |
| A huge PR fills the context. | 48 KB cap with a fixed trim order. pr.md keeps every message. |
| An earlier Ask answer quotes a comment, and the follow-up stdin then carries that text. | The answers are Claude's own output, which the user already saw. The section says it is data, the blocks are indented, the caps keep it small, and only "Your instructions" holds an instruction. A canary test checks that no comment text reaches stdin through any other path. |
| Autopilot posts a wrong answer or a commitment. | Class table, commits flag, guard phase, evidence check, 60 s cancel window, Delete, eval gate with 0 wrong auto-posts. |
| A comment injects instructions into Autopilot. | Comment text only in untrusted context files, numeric IDs in stdin, read-only tools, no write calls in the Autopilot code path, proposed notes untrusted until the user keeps them. |
| Two bots answer each other without end. | Prefix check, Bot accounts setting, SERVICE users (Gate G10), 3 posts per thread since the user's last message, per-PR daily cap. |
| Colleagues dislike bot replies. | Off by default, per PR, the mark cannot be turned off, quiet hours, Delete. |
| Autopilot uses quota without a click. | Only on PRs where the user turned it on. Daily run caps. A usage limit pauses Autopilot. Re-read the usage terms before a release (as Q5). |

## 8. Brainstorm (part 5)

| Idea | Verdict | Reason |
|---|---|---|
| Time and cost per run and phase in the run line | Now | usage_json exists. Users need it to trust the verify phase. |
| Summary ledger in plain words ("2 must fix, 3 worth fixing, 4 low confidence") | Now | Part of WP-R4. |
| Two passes, cheap then deep (a fast triage marks risky files, a deep pass reads them) | Later | The verify phase comes first. The eval shows if recall needs it. |
| CodeGraph for the finder by default when the user has it | Later | Index time up to 120 s per run. Measure with an eval case that has a caller bug first. |
| Re-anchor dropped findings (post as a general comment) | Later | BRIEF: invalid references become coverage problems. Needs a user decision. |
| Per-repo learned rules ("Learn from discards") | Later | Needs the discard reasons of part 4 first (M4). |
| Topic specialist agents for "Show everything" | Later | S13. The eval can show a gain. |
| A suggested fix block in reviewer findings | Later | Useful only when small and complete (S12). Fix covers own PRs. |
| Incremental Explain ("what changed since my last look") | Later | Needs the base explain result. |
| Risk score per PR in the inbox | Later | BRIEF backlog. |
| "Fix all" plan handed to the user's session as design, spec, and tasks | Reject | Part 6 and "Copy for your session" cover it. |
| Auto-review on push, pre-review queue | Reject | BRIEF: every run starts from a click; usage terms. |
| A second model as verifier by default | Reject | The verify model is a profile field. The eval can compare. |

## 9. Comparison with the colleague's app (placeholder)

Fill this in when the sources arrive. Compare each row on the same eval cases where possible.

| Area | Questions |
|---|---|
| Prompts | Structure, emphasis words, severity rubric, do-not-flag list, intent input. |
| Agents | Split, delegation control, effort and model per agent. |
| Verify | Separate pass or not, per finding or per batch, caps. |
| Anchoring | Line checks, quote checks, "only what the PR adds". |
| Noise | Volume levels, folds, dedupe, learning from discards. |
| Discussion | Per-finding talk, verdicts, revision safety. |
| Explain | Narrative, links, diagrams, safety of rendering. |
| Measurement | Eval data, metrics, outcome tracking. |
| Cost and time | Per 500-line PR on the same cases. |
| Safety | Read-only runs, sandbox, token handling, post gate. |
| Build a task | Interview, spec review, tests first, PR size, stack handling. |
| UX | Steps to a posted review, keyboard, plain words. |
| Replies without approval | Which classes post, what marks a bot reply, loop and rate limits, how it resolves references to other PRs, what it promises. Part 7 answers each one for this app. |

## 10. Decisions (2026-10-22)

The user answered every question on 2026-10-22. Q1 to Q5 change BRIEF hard rules; WP-D6 writes them into BRIEF.md and CLAUDE.md. Q4 and Q6 to Q24 take the recommended defaults.

1. Q1 Write runs: yes, after Gate B17 passes. Kind implement gets Edit and Write only in an app-owned worktree of the cache, never in the user's clone. Review runs stay read-only.
2. Q2 App-run commands: yes, with one first-use warning and "I understand". Claude gets no shell. The app runs only the approved argv commands, with timeouts. Native Windows has no OS sandbox (S15); a WSL2 or sandbox runner comes later.
3. Q3 Push and PR: yes, push and PR create or update only on a click. Only task branches, never the target branch, always with a lease. A force push needs a confirm. The token needs Repository write.
4. Q4 Jira keys without a PR: yes. The app fetches the key that the user types in "Build a Jira task".
5. Q5 Many runs after one approval: yes. After one plan approval, the loop runs several Claude runs until it needs the user. Each part stops at its PR click and at the colleagues' review. Re-read the usage terms before a release.
6. Q6 Spec files in the repository: yes, in `specs/<KEY>/` by default, as a per-repository setting.
7. Q7 Retire profiles: yes. Unedited Security and Over-engineering profiles retire, and the Security and Simplify checkboxes replace them.
8. Q8 Verify phase effort: medium. The eval can raise it.
9. Q9 Revised verdict on an untouched finding: it stores a revision, as on every finding.
10. Q10 Withdrawn verdict on an accepted finding: it discards the finding at once, with Restore and the mark.
11. Q11 Size limits: no Agent tool below 1,200 changed lines and 30 files; rl-verifier above 12 candidates. The eval tunes both.
12. Q12 Default volume: Balanced.
13. Q13 Explain: a page in the detail pane, not in the panel slot.
14. Q14 Discard reason chips: yes, optional, after a discard.
15. Q15 Small tasks: one combined plan.md.
16. Q16 Medium and large code: it stacks on the spec branch and does not wait for the spec merge.
17. Q17 Line budget per PR: 400 changed lines, lock files excluded, per repository setting.
18. Q18 Open code PRs per task at once: 2.
19. Q19 Gate for the next part: 1 approval, no Needs work, no open blocker task, builds green or none. One confirm overrides it.
20. Q20 Open part PRs without a click: off. A per-task switch "Open part PRs for me" sits under More.
21. Q21 Minor points of the own review: listed in the Task view, not fixed by the loop. "Fix these too" is one click.
22. Q22 Attachments of tasks started outside a PR: later. v1 lists them by name only.
23. Q23 Retarget after a merge: one click with one confirm, because it changes a colleague's view.
24. Q24 Nullable review_run.pr for task runs (B14): yes, with the query audit.

### 10.1 Part 7 decisions (2026-10-22)

On hold (2026-10-22): the user paused autopilot; a human posts every reply. Keep for later. WP-DA does not write Q25 into BRIEF.md or CLAUDE.md until part 7 resumes.

The user decided Q25 to Q27 on 2026-10-22. Q25 changes a BRIEF hard rule and constitution principles 1 and 4. WP-DA writes them into BRIEF.md and CLAUDE.md.

25. Q25 Human gate: "Nothing goes to Bitbucket without an explicit user action" becomes "Nothing goes to Bitbucket without an explicit user action, unless the user turned on Autopilot for that PR." Turning on Autopilot post mode for one PR is the explicit action. Safeguards that come with the change: off by default; own open PRs only; reply comments only, never approve, needs work, merge, decline, resolve, or reopen; the bot mark that cannot be turned off; the class table with the commits flag; the guard phase; the evidence check; the secrets check; caps per thread and per PR; quiet hours; loop protection; the global pause and the per-PR switch; the 60 s cancel window; Delete; the full log; the eval gate before level 2. Principle 4 ("polling never calls an LLM") gets the same exception for draft and post modes.
26. Q26 Levels: level 2 built in steps. Level 1 (auto-draft and notify) ships first. Level 2 (Autopilot per PR for safe reply classes) follows after the eval gate and the user smoke. Level 3 actions come with part 6.
27. Q27 Bot mark: configurable prefix and footer. The default prefix is the robot emoji "🤖 ". The mark can never be fully turned off: the prefix is required.

### 10.2 Part 7 open questions (recommended defaults, not answered yet; on hold with part 7)

28. Q28 Task PRs (part 6): start in draft mode when the task opens the PR? Recommended: yes, draft mode only. Post mode always needs the user's switch.
29. Q29 Notify on each auto-post? Recommended: yes, one note per PR and sync ("Autopilot answered Anna on PR 12."), with a setting "Tell me when Autopilot posts" (on).
30. Q30 Quiet hours default. Recommended: on, 19:00 to 09:00 local time, plus Saturday and Sunday. Comments wait in the queue and run at the end.
31. Q31 Cancel window. Recommended: 60 s.
32. Q32 Guard phase on every auto-post. Recommended: yes, until the eval shows that it never changes an outcome.
33. Q33 Thread scope on own PRs. Recommended: every thread on the PR. The setting "Only threads that I started or replied in" exists, off.
34. Q34 Old comments (the app was closed). Recommended: a comment older than 24 h at run time is drafted, never posted.
35. Q35 SERVICE users. Recommended: skip them when Gate G10 shows the field. Else rely on the Bot accounts setting.
36. Q36 Footer text. Recommended: "_Automatic reply from the author's assistant. The author reads this thread later._"
37. Q37 Level 3 "ask for review again": Bitbucket 7.21 has no re-request call (unverified for 9.x, Gate G11 INFO). Recommended: a marked comment that names the reviewers, posted only by the level 3 loop.

### 10.3 Decisions of 2026-10-22 (later the same day)

38. Q38 Part 7 Autopilot: on hold. The user paused autopilot; a human posts every reply. Keep the part 7 text for later. Its waves leave the active order (tasks.md section 1). Its migration takes the next free number when it resumes. Gate G9 and the pr_note table move to part 2.
39. Q39 PR context and PR notes join part 2 (D6 to D13, spec.md sections 2.7 to 2.13). No memory: the app rebuilds the files before every run, with no Claude call. A proposed note counts only after the user clicks Keep.
40. Q40 Choices made in the plan, with reasons in D7, D9, and D11 (the user can change them): Ask gets the PR context and Explain does not; other open PRs come from stored rows plus new Bitbucket reads behind Gate G9 and G12; kept notes go into their own file without the UNTRUSTED banner; migration 032 is reserved for pr_note (it merged as 031).
41. Q41 Ask follow-ups join part 2 (decided by the user, 2026-10-22; D14 to D19, spec.md sections 2.14 to 2.18). The last 3 Ask turns of a conversation go into the Ask stdin as data. "New question" starts without them. Choices made in the plan, with reasons in D15, D17, and D18: history.md stays unchanged; parent_run comes with ALTER TABLE in the next free migration (030 is built); a follow-up keeps the profile of its parent.

### 10.4 Decisions of 2026-10-23: branches, base branch, and several repositories

The user decided Q42 to Q46 on 2026-10-23 (B16 to B21, spec.md section 6.16, tasks.md WP-GB, WP-BR, WP-MR1, WP-MR2). No hard rule changes: every push and PR still needs a click, part 7 stays on hold, and the review snapshot keeps "No submodules".

42. Q42 Branch prefix: no heuristics, no mapping from the Jira issue type. One global list of prefixes for all repositories in Settings > Tasks, default `feature/`, `bugfix/`, `hotfix/`, editable and reorderable. The plan screen shows the list as chips plus "Other…" (a free prefix, checked as a git ref part). The first chip starts selected. This replaces the per-repository prefix and the "Change the prefix" control. Choice made in the plan: the old per-repository value is dropped, not kept as a remembered choice. Reason: a remembered value would fight the rule "the first chip starts selected", and dropping needs no data migration. The column stays in the table unused.
43. Q43 Branch name: `<prefix><KEY>-<slug of the full summary>`, with no 40-character cut. Example: "[server][linux] M3: Crash capture and dump generation on Linux" gives `feature/ABC-123-server-linux-m3-crash-capture-and-dump-generation-on-linux`. Only a safety cap applies: 100 characters for the whole name, cut at a hyphen. Choice made in the plan: the value 100 (spec.md section 6.16 gives the limits behind it).
44. Q44 Base branch: Bitbucket's configured default branch of the repository starts selected (REST, Gate G13). A searchable branch picker on the plan screen lists the repository's branches from Bitbucket (Gate G14). The app remembers the last pick per repository. The PR targets the base branch. Choices made in the plan: the last pick starts selected when it still exists on the server, else the default branch; the origin PR's target no longer sets it; the New task form drops its "Target branch" field; a base change after the plan exists writes the plan again after one confirm.
45. Q45 A branch with the task's name exists on the server: the app offers "Continue on <branch>" (the default: build on top of it, push with a lease, never overwrite) or "Start a new branch" (`-2`, `-3`).
46. Q46 Several repositories: the user picks one main repository. The task workspace checks out same-server submodules: the first level is editable; deeper levels are read-only; submodules of other servers are read-only, and an edit there stops with the reason. After the build, the app finds the repositories that changed and creates the branch (the same name) and the PR only there. "Open the PRs" shows one row per repository and one button "Push and open N PRs". Submodule PRs open first. Each PR links the others. The main PR first points the submodule at the task branch commit. After a submodule PR merges, a status sentence offers one button to point the parent at the merged commit. Claude may propose an unrelated repository from the Bitbucket repository list with a reason; the plan screen shows it with Add and Skip; only an added repository gets a worktree, a branch, and a PR. The line budget counts all repositories. Human in the loop everywhere. Choices made in the plan: v1 supports several repositories for small and medium tasks only; a large task stays in one repository and stops with a reason when it needs another one. Submodules of other servers, and URLs that map to no Bitbucket repository, stay empty folders in v1, because the app has no token for them and BRIEF section 3.6 allows no other origin (Q47).

### 10.5 Open questions of 2026-10-23 (recommended defaults; the plan uses them until the user answers)

47. Q47 Submodules of other servers: the user said "read-only". v1 leaves them as empty folders: the app sends no request to another origin and has no token for it. Alternative: an anonymous https fetch after a one-time consent per URL, which changes BRIEF section 3.6. Recommended: empty folders in v1.
48. Q48 Branch rules: the restriction search needs REPO_ADMIN (DC 9.6 REST). For a plain token, the pre-flight checks only the write permission, and Bitbucket can still refuse the push after the build. Alternative: a probe push of the task branch at the base commit before the build, on a click. Recommended: no probe; a refused push keeps the commits and shows Bitbucket's reason.
49. Q49 Base preselection: the last pick of the repository, when it still exists, wins over the default branch. Alternative: always the default branch, with the last pick first in the list. Recommended: the last pick.
50. Q50 A task that only moves a submodule pointer, with no file change: v1 has no step for it. Claude cannot move a gitlink, and the app moves it only after commits in the submodule. Recommended: later.
51. Q51 Large tasks across repositories: v1 refuses them with a reason. A stack per repository with linked parts comes later, if needed.

### 10.6 Decisions of 2026-10-26: Tell Claude and Update from the base branch

The user decided Q52 and Q53 on 2026-10-26 (B22 to B27, spec.md section 6.18, tasks.md WP-TU1 and WP-TU2). No hard rule changes: every push still needs a click, the update needs no force push after the first push, and Claude gets no git write tool.

52. Q52 "Tell Claude": every waiting state of a task shows a free-text box. A send starts exactly one implement step with the text as "Your instructions", under the trust rules of other user text, with the same path check, checks, and own review as any implement step. Git actions stay app buttons. The app never parses the text for commands. Claude may say in its result that the branch needs the newest base; the app then shows "Update from <base>". Claude never runs git. Choices made in the plan: the place of the box, its empty and busy states, Stop, and the Log row (spec.md section 6.18.1).
53. Q53 "Update from <base>": it always uses the task's own base branch of each repository, the one the user picked, and the label shows it. Before the first push it rebases onto the base; after the first push it merges the base into the task branch; never a force push after the first push. Conflicts go to a Claude step that only resolves conflicts. The app then checks that no conflict marker remains and runs the checks. When markers remain or the step fails, the app aborts the merge or rebase, leaves the branch as it was, and says so. The app suggests the button when the base moved since the branch point, or when Bitbucket reports that the PR has conflicts. With several repositories, each one updates from its own base, and a submodule update also moves the gitlink in the parent repository. It replaces "Rebase onto it". Choices made in the plan: the allowed set of the resolve step is the unmerged paths of each stop; "Continue on <branch>" counts as published; gitlink conflicts are resolved by the app, not by Claude.

### 10.7 Open questions of 2026-10-26 (recommended defaults; the plan uses them until the user answers)

54. Q54 The box before the build (interview, plan, spec PR states): an implement step needs a worktree, which does not exist yet. Recommended: no box there. The Questions form, "Edit", and "Ask Claude again" stay. Alternative: a box that starts the spec run again with the text.
55. Q55 The box in stopped and failed states. Recommended: hidden, because Resume continues the stopped step from the last commit. Alternative: a send skips the stopped step and runs the instruct step after the Resume reset.
56. Q56 Red checks after an update. Recommended: keep the update in the worktree (nothing is pushed), block with "the tests fail after the update", and offer "Undo the update" and the Tell Claude box. No automatic fix step, because the base itself can be red. Alternative: abort at once, as for a conflict.
57. Q57 Own review after a resolve step. Recommended: yes, because Claude wrote code. Alternative: checks only.
58. Q58 Many conflict stops in one rebase (one per task commit). Recommended: RESOLVE_STOPS = 10 per repository, then abort. Alternative: squash the local commits into one before the rebase, so there is at most one stop.
59. Q59 Stacked branches: the medium code branch targets the spec branch, and large parts target the part below. Recommended: the medium update runs on the spec branch from the base, then on the code branch from the spec branch, with the same rebase-or-merge rule. Large parts keep the stack rules of B10 and spec.md section 6.8 until WP-B8; their squash-merge rebase still force-pushes after a confirm. Decide before WP-B8 whether a merge replaces it.
60. Q60 Label with different bases in one update. Recommended: "Update from 2 base branches" with one line per repository. Alternative: one button per repository.
61. Q61 Stop of an instruct step. Recommended: back to the waiting state before the send, with the text back in the box, not the stopped state. Alternative: the stopped state with Resume, as for other steps.
62. Q62 Commit message of an instruct step. Recommended: `<KEY>: <first line of the user's text, cut at 72 characters>`. Alternative: Claude's summary.
63. Q63 Marker check. Recommended: start, base, and end markers only; a lone `=======` line is valid text in Markdown and reStructuredText. Alternative: also refuse a lone separator line in the unmerged paths.
