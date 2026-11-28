# Contributing to PR Review Inbox

Thank you for your help. This file tells you how to set up, run, and test PR Review Inbox, and which rules a change must follow.

Report bugs and ideas in the issues: https://github.com/auric/pr-review-inbox/issues. Send changes as pull requests: https://github.com/auric/pr-review-inbox/pulls. Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) tells you.

## Set up

1. Install Bun 1.x, Node 20 or later, and `git`.
2. Clone https://github.com/auric/pr-review-inbox and run `bun install`.
3. Run `bun run dev`. Open the Vite URL, http://127.0.0.1:5173.

You do not need a Bitbucket server or the `claude` CLI for development. `bun run demo` serves the built UI on 127.0.0.1:7399 with a fake Bitbucket, a fake Jira, a fake CLI, and synthetic data. Run `bun run build` first.

## Test

| Command | Effect |
|---|---|
| `bun run check` | Typecheck with TypeScript 7 and 5, Biome lint, and `bun test` with 8 parallel workers. Each change must pass it. `bun run test:serial` runs the tests in one process. |
| `bun run test:e2e` | Build the UI and run the Playwright suite against the fakes. Stop `bun run demo` first, because both use port 7399. |
| `bun run lint` | Biome lint and format checks. `bun run format` applies the fixes. |
| `bun run screenshots` | Regenerate `docs/screenshots/` from the demo. Run it after a visible UI change. |
| `bun run notices` | Regenerate `THIRD_PARTY_NOTICES.md`. Run it after a dependency change. |

Run e2e only through `bun run test:e2e`. A plain `npx playwright` can use a global Playwright of another version. Install the browser once with `node node_modules/@playwright/test/cli.js install chromium`.

## Rules

- No company names, hosts, tokens, or other secrets in code, docs, or fixtures. Use synthetic data.
- Tests never touch a real Bitbucket server, a real Jira server, the real `claude` CLI, or your data folder. Use the fakes in `tests/support/`. The test preload fails a test that looks up the real `claude` on the PATH.
- Keep the safety model: 127.0.0.1 only, Host and Origin checks, the session token, no wildcard CORS, and no disabled TLS. The CLI runs only in the sanitized snapshot. The app posts only after a user action and never pushes.
- Each new source file in `src/`, `scripts/`, and `tests/` starts with these two lines:

  ```ts
  // SPDX-License-Identifier: AGPL-3.0-or-later
  // Copyright (c) 2026 Ihor Lifanov
  ```

- Write docs, comments, and commit messages in ASD-STE100 Simple Technical English: short sentences, active voice, no narration. Do not hard-wrap lines. One paragraph or one bullet is one line.
- Code comments state only constraints that the code cannot show.
- `CHANGELOG.md` lists only changes that a user of the app sees.
- After a dependency change, commit `bun.lock` and the new `THIRD_PARTY_NOTICES.md` together.

`BRIEF.md` is the spec. `CLAUDE.md` holds the full project rules.

## License of contributions

PR Review Inbox is under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`), with the additional terms in [NOTICE.md](NOTICE.md). You submit your contribution under the same license and terms.

Sign off each commit with `git commit -s`. The sign-off states that you agree to the Developer Certificate of Origin: https://developercertificate.org/
