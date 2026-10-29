# PR Review Inbox

PR Review Inbox is a local-first inbox for Bitbucket Server pull requests (PRs). It runs the user's own Claude Code CLI (`claude -p`) for reviews. The app runs on localhost and keeps all data on the user's machine. Its old names were Review Loop, Revido, and Kierto. Only the visible name changed: code identifiers, the `REVIEW_LOOP_*` environment variables, the data folder, the credential store service, and the `rl-` prefixes keep the old name, so existing user data keeps working.

Status: Releases 1, 2, and 3 are code complete. Project instructions, always-use skills, language checks, the severity rubric, field-by-field profile upgrades, and "Copy to all profiles" are code complete after Release 3. The PR view v4 redesign (docs/plans/pr-view-v4.md) and the Fix redesign (docs/plans/fix-ux.md) are code complete. Session consult parts A, C, and D (docs/plans/session-consult.md) are code complete; part D adds "Judge and propose fixes". Part B was removed on 2026-10-20. The thread outcome plan (docs/plans/thread-outcome.md) is code complete, including P14 (thread history) and P16 (out-of-date draft alerts). Review v2 (docs/plans/review-v2/) parts 1 to 4 are code complete, including the finding discussion. BRIEF.md holds the part 6 (Build a Jira task) docs. Part 6 is code complete for small tasks (WP-B0 to WP-B5). Medium and large tasks (WP-B6 to WP-B10) are not started. The sub-task design (one branch and one PR per Jira sub-task) is documented in spec 6.20; code packages ST-G and ST1 to ST7 are next. Part 7 (Autopilot replies) is on hold. Jira Cloud is supported with an email and an API token; its facts stay unverified in integration-check.md. Layer A (build status from Bitbucket) of docs/plans/ci-builds.md is code complete; Layers B and C (Jenkins) are on hold. Review v3 (docs/plans/review-v3.md: a local eval set from real decisions, prompt variants, default CodeGraph, pre-existing findings, review checks) is planned. The app is named PR Review Inbox and is licensed AGPL-3.0-or-later. README.md, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, and .github/workflows/ci.yml prepare the public GitHub repository. The user runs docs/smoke-m1.md, smoke-v3.md (with part H for the PR view), smoke-m4.md, smoke-r2.md, and smoke-r3.md (with Gate B11, B12, and B15, part I for the prompt features, part J for Fix, and part K for session consult); see docs/plans/r2.md and r3.md. Do not assume that a file in the planned layout exists. Check first.

## Document map

| File | Role |
|---|---|
| `BRIEF.md` | The spec and the source of truth. If another file disagrees, BRIEF.md wins. |
| `README.md` | User documentation. Its images in `docs/screenshots/` come from `bun run screenshots`. |
| `LICENSE`, `NOTICE.md`, `THIRD_PARTY_NOTICES.md` | AGPL-3.0-or-later text, the copyright and section 7 terms, and the generated third-party notices. `third-party-licenses/` holds texts that no package ships. The app shows all three in the Settings footer. |
| `prototype/index.html` | Visual spec for the UI: three panes, color tokens, keyboard model. Sample data only. It is also a published artifact. |
| `docs/plans/` | Milestone plans: m1.md, v3.md (M2, M3), replies.md, m4.md, r2.md (Release 2), r3.md (Release 3), pr-view-v4.md (PR detail layout, URL, panels), fix-ux.md (Fix list, Fix for findings), session-consult.md (consult the implementation session), thread-outcome.md (one outcome per thread, thread history, out-of-date draft alerts). |
| `docs/plans/review-v2/` | Review v2 plan: design.md (decisions; section 10 holds the user's answers of 2026-10-22), spec.md (behavior, schemas, acceptance criteria), tasks.md (work packages, waves, gates). Parts 1 to 4 (review quality, discuss a finding, Explain this PR, measure quality) come first. Part 6 (Build a Jira task) follows. |
| `docs/plans/review-v3.md` | Review v3 plan (planned): decisions D1 to D3, a local eval set from the user's posted and discarded findings, waves, work packages, gates, the BRIEF 3.5 wording draft, and open questions. |
| `docs/plans/ci-builds.md` | CI builds plan: Layer A (build status from Bitbucket, code complete), Layer B (start a Jenkins build, on hold), Layer C (why a build failed, on hold), the CI probe, and its facts. |
| `docs/smoke-m1.md`, `docs/smoke-v3.md`, `docs/smoke-m4.md`, `docs/smoke-r2.md`, `docs/smoke-r3.md`, `docs/smoke-task.md` | Manual smoke tests with the real server and CLI. The user runs them. The smoke-v3.md last table maps A1 to A17 to their tests. smoke-task.md part S is Gate US (small task). |
| `PROJECT_BRIEF_GPT_ASTRA_6.md` | Reference for edge cases and acceptance scenarios. |
| `IMPLEMENTATION_PROMPTS_GPT_ASTRA_6.md` | Alternative spec-kit prompt set. Prompt 0 drives Gate 0. Its two-pane and general-comments-only rules do not apply. |
| `skills-lock.json` | Pins the installed project skills. Commit it with every skill change. |
| `.claude/skills/` | Installed project skills (see Skills). |

## Stack (BRIEF section 7)

```
Runtime: Bun 1.x, strict TypeScript. Fallback: Node + @hono/node-server if Bun fails a Gate 0 Windows check.
Server:  Hono on 127.0.0.1 only. csrf(), streamSSE, zValidator, typed client hc<AppType>(). One process serves API and built UI.
UI:      Vite, React, Tailwind CSS, shadcn/ui (Vite setup), TanStack Query. No global state library.
Storage: bun:sqlite, prepared SQL, checked-in migrations, no ORM.
Schema:  zod for AI output, used REST responses, and every API input. One shared AI-result schema module (src/shared/review.ts).
Git/AI:  git CLI through Bun.spawn with argument arrays and an isolated config. The system `claude` CLI.
Secrets: Bun.secrets (experimental, verify in Gate 0). Fallback: memory only.
Tests:   bun test for logic and integration. Playwright for browser acceptance.
Ship:    bun build --compile, one executable per OS with the UI embedded.
```

Layout: `src/web/` (with `ask/`, `diff/`, and `fix/`), `src/server/{bitbucket,sync,inbox,storage,tasks,review,publish,context}/`, `src/shared/`, `fixtures/`, `tests/`, `scripts/` exist. BRIEF section 7 defines each folder. All Bitbucket calls stay in `src/server/bitbucket/`.

Commands:
- `bun install`: install the pinned dependencies.
- `bun run dev`: start Hono with `--watch` on 127.0.0.1:7317 and Vite with HMR on 127.0.0.1:5173. Open the Vite URL.
- `bun run build`: build the UI into `dist/web`.
- `bun run start`: serve the API and the built UI on 127.0.0.1:7317. `REVIEW_LOOP_PORT` overrides the port. `REVIEW_LOOP_DATA_DIR` sets the data folder. `REVIEW_LOOP_SECRETS=memory` keeps the token out of the OS store.
- `bun run compile`: build the UI, then one self-contained executable for this host into `dist/bin/pr-review-inbox-<os>-<arch>`. `bun run compile:all` adds windows-x64, linux-x64, and linux-arm64. Release builds cover Windows and Linux only. `tests/build/compiled.test.ts` checks the host binary. It skips when the binary is absent and fails when a source is newer.
- `bun run typecheck`: run strict `tsc --noEmit`. `bun run typecheck:5` runs it with TypeScript 5.
- `bun run lint`: run Biome lint and format checks. `bun run format` applies the fixes.
- `bun run demo`: serve the built UI on 127.0.0.1:7399 against a fake Bitbucket and a fake Jira with synthetic data. It uses a temp data folder, memory secrets, and a temp clone for Fix it.
- `bun test`: run the tests under `tests/`. Each group ends green on typecheck, lint, and test.
- `bun run check`: run typecheck, typecheck:5, lint, and `bun test` in sequence. It stops at the first failure.
- `bun run release`: make a tested release in `dist/release/<version>-<commit>/`. It runs check, e2e, compile for all targets, and the compiled-binary test, then writes SHA256SUMS. It refuses a dirty tree unless `--allow-dirty`. `--skip-e2e` skips the e2e tests.
- `bun run notices`: regenerate `THIRD_PARTY_NOTICES.md` from the Vite source maps, the Bun metafile of the server, the CSS imports, the Bun runtime, and `skills-lock.json`. It fails on a license that is not GPL-compatible. `bun run release` runs it with `--check`. Run it after each dependency or skill change.
- `bun run screenshots`: build the UI, start the demo on `SHOTS_PORT` (default 7419) in its own temp folder, and write the README images to `docs/screenshots/`. Check each image for real names, hosts, and paths.
- `bun run test:e2e`: build the UI, then run the Playwright suite `tests/e2e/*.e2e.ts` with Node. `tests/e2e/serve.ts` starts the fake Bitbucket on `E2E_FAKE_PORT` (default 7398), the fake Jira on `E2E_JIRA_PORT` (default 7397), and the app on `E2E_APP_PORT` (default 7399). Stop `bun run demo` first, because it uses port 7399.

## Skills

Load the skill before you start the task. Read its SKILL.md for details.

| Task | Skill to load | Rule |
|---|---|---|
| Add, style, or compose UI components. Port the prototype color tokens to the shadcn theme. | `shadcn` | Keep the prototype's three panes and keyboard model. |
| Write or review React components, data fetching, TanStack Query use, bundle size. | `vercel-react-best-practices` | This is a Vite SPA. Ignore the Next.js-only rules (RSC, server actions, next/*). |
| Review UI code for accessibility and UX. | `web-design-guidelines` | Run it before a milestone ends. |
| Server routes, middleware (`csrf`, validator), SSE streaming, typed client. | `hono` | Keep BRIEF 3.6 server safety rules. |
| Build or change an MCP server. | `anthropic-skills:mcp-builder` | TypeScript MCP SDK over stdio. Tools are read-only with zod inputs. |
| Browser acceptance tests. | none | Use TypeScript `@playwright/test` with files named `*.e2e.ts`, run by Node. Point tests only at fixture data. See Testing notes. |
| Ad-hoc browser checks and screenshots of the running app. | `webapp-testing` | Its helper scripts need Python. Point it only at fixture data. |
| Add or change motion: transitions, enter and exit, feedback. | `animate` | Prefer CSS, then the Web Animations API. Add no motion library for simple effects. Respect `prefers-reduced-motion`. |
| Review a diff that adds or changes animation code. | `review-animations` | Invoke it explicitly. It does not load by itself. |
| Find the right name for a motion effect. | `animation-vocabulary` | A glossary only. |
| Look for places where the UI lacks feedback motion. | `find-animation-opportunities` | Read-only. It proposes values and changes no code. |
| Visual direction for new screens. | `frontend-design:frontend-design` (plugin) | Stay consistent with `prototype/index.html`. |
| Maintain this file. | `claude-md-management:claude-md-improver` | Keep it compact and current. |

Add or update a project skill:
- Read the skill's SKILL.md at its source before you install it.
- Run `npx -y skills@latest add <owner/repo> -s <skill> -a claude-code --copy -y` at project scope. Record the resolved CLI version in the commit message.
- Use `--copy`, because symlinks are unreliable on Windows.
- The skills CLI needs Node 22.20 or later.
- Commit `skills-lock.json` together with the skill files.

## Testing notes

- The `bunfig.toml` preload `tests/support/no-real-claude.ts` fails any test that looks up the real `claude` on PATH. Pass the fake CLI as `runnerCommand`.
- Run e2e only through `bun run test:e2e`. A plain `npx playwright` can resolve a global Playwright of another version.
- A parallel worktree runs e2e on its own ports, for example `E2E_FAKE_PORT=7458 E2E_APP_PORT=7459 E2E_JIRA_PORT=7457`. The `E2E code:` line of `serve.ts` shows which checkout the run serves.
- The e2e control routes (`/__control/*`) live on the fake Bitbucket in `tests/e2e/serve.ts`, never in the app.
- The detail pane shows the first row and acknowledges its visible messages after about 1 s. A test that needs a message to stay unread selects another PR first.
- Headless Chromium denies notifications. The e2e tests grant the permission and replace `window.Notification` with a recorder.

## Hard rules

- Never run `claude -p` in a raw PR checkout. Use the sanitized snapshot only (BRIEF 3.5).
- Never use `--bare`. It breaks the subscription login (BRIEF 3.5).
- Before each run, check `claude auth status`. Run only when `authMethod` is `claude.ai`. Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the child environment.
- Follow the local server safety rules: 127.0.0.1 only, Host and Origin checks, session token, no wildcard CORS, no disabled TLS (BRIEF 3.6).
- Tests never touch the live Bitbucket server. Use sanitized fixtures and a fake `claude` executable. Real-server tests need separate authorization.
- The Bitbucket token never goes into SQLite, localStorage, logs, URLs, or prompts.
- Nothing goes to Bitbucket or Jira without an explicit user action. The app posts, not the AI.
- The app never runs claude in the user's clone and pushes nothing, with one exception for Build a Jira task (BRIEF 3.5, 3.6). Its implement runs edit files only in an app-owned worktree of the cache, never in the user's clone. A push and a PR create or update go to Bitbucket only on the user's click. A push goes only to a branch that the task created, or to a branch with the Jira key of its part that the user picked with "Continue on <branch>". The app never pushes to the branch of a PR that it tracks but did not create, and never to the target branch. Each push has an explicit `--force-with-lease` and no `+` refspec. After a squash merge, the update merges the base in three steps instead of a rebase and a force push. The app never force-pushes after the first push.
- No company names, hosts, or secrets in code, docs, or fixtures. The project may become open source.
- Build a boundary (ForgeProvider, ReviewRunner, ContextSource) only when its milestone needs it.

## Workflow

- Work on one milestone at a time, in the order M0, M1, M2, M3, M4 (BRIEF section 2).
- Run one spec-kit cycle per milestone (BRIEF section 0). Never specify the whole product in one cycle.
- Gate 0 writes `integration-check.md`. Record each Gate 0 fact there before code depends on it.
- Items that BRIEF marks "verify in Gate 0" or "not verified" are assumptions. Do not hard-code them until Gate 0 confirms them.
- End each session with a handoff: completed task IDs, changed files, tests run with results, known limits, next task group.

## Documentation style

- Use ASD-STE100 Simple Technical English: sentences of 20 words or fewer, active voice, no narration.
- No hard line wrapping. One paragraph or one bullet is one physical line.
- Code comments state only constraints that the code cannot show.
- The changelog lists only changes that a user of the tool sees.
- Each own source file in `src/`, `scripts/`, and `tests/` starts with `// SPDX-License-Identifier: AGPL-3.0-or-later` and `// Copyright (c) 2026 Ihor Lifanov`. The shadcn files in `src/web/components/ui/` and the SQL migrations have no header.
