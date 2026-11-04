# M4 manual smoke test: the compiled binary, settings, and profiles

This test checks the compiled binary, the check interval, the profile editor, and the 🤖 setting against a real Bitbucket Server and the real `claude` CLI. The user runs it. The automated suites use fixtures and the fake CLI only.

## Rules

- Run this test only with explicit authorization from the user. You also need the company approval to send source code to Claude (BRIEF section 10, item 8).
- Use only the designated test pull request. Do not touch other pull requests.
- Use a new, empty data folder. Never use the data folder of your daily instance.
- Do not copy the token, host names, code, or pull request data into files, issues, or chat.
- The Explain run uses your Claude subscription quota. Expect one run.
- In this document, `<BITBUCKET_URL>` is the base URL of the server and `<TEST_PR_URL>` is the URL of the test pull request.

## Preparation

1. Run `bun install`, then `bun run compile`. Expect "Built dist/bin/pr-review-inbox-<os>-<arch> (<commit>)." Record the commit.
2. Run `claude --version`. Expect 2.1.302 or later. Run `claude auth status`. Expect `"authMethod": "claude.ai"`.
3. Remove `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the terminal. PowerShell: `Remove-Item Env:ANTHROPIC_API_KEY, Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue`.
4. Make a new, empty folder outside the repository. Copy the binary into it and go to it in the terminal.
5. Set a new data folder. PowerShell: `$env:REVIEW_LOOP_DATA_DIR = Join-Path $env:TEMP "review-loop-smoke-$(Get-Random)"`. Bash: `export REVIEW_LOOP_DATA_DIR="$(mktemp -d)"`.
6. Start the binary from that folder. Expect the startup line "PR Review Inbox (<commit>): http://127.0.0.1:7317/". The commit must equal the commit of step 1. "source" or a different commit fails the test.
7. Open the URL. Enter `<BITBUCKET_URL>` and your access token. Click Save. Click "Check now". If the test pull request is not in the list, paste `<TEST_PR_URL>` into the filter and click "Follow this pull request".

## A. Check interval

1. Open Settings. Set "Check for new activity" to a different value.
2. Stop the binary and start it again. Open Settings. Expect the new value.

## B. Edit a profile and run Explain

1. In Settings, find the Explain profile. Change its name, for example to "Explain v2". Add one sentence to its prompt. Click "Save profiles". Expect "Saved. New reviews use these profiles."
2. Close Settings. Open the test pull request. Press Shift+R. Select "Explain v2". Press Ctrl+Enter.
3. Wait for the end of the run. Expect the Review row of the run list to show "Explained the change" and the question count. Expect questions and a summary, and no findings.
4. Press 3. Expect "Explain v2 profile" in the run log. Press Esc.
5. In Settings, clear "Explain only" of that profile and rename it again. Save. Expect the Review row still to show "Explained the change". Expect the run log still to name "Explain v2".

## C. The 🤖 setting

1. In Settings, expect "Mark Claude-drafted comments with 🤖" to be on.
2. Accept one question from the Explain run. Press p. Expect the confirm to show a body that starts with "🤖 ". Cancel. Do not post.
3. Turn the setting off. Press p again. Expect no "🤖 " in the confirm. Cancel. Turn the setting on again.

## D. Record

- The build commit from the startup line.
- The OS, the Bun version, and the `claude` version.
- The result of each step: pass or fail, with a short reason for a fail.

## WSL or Linux

1. Install Bun 1.4.4: `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"`. Run `bun --version`. Expect 1.4.4.
2. Clone the repository into the Linux file system, not under `/mnt/c`. Run `bun install`.
3. Run `bun test`. Expect no fails.
4. Run `bun run compile`. Expect `dist/bin/pr-review-inbox-linux-x64` (or `-arm64`).
5. Run `bun test tests/build/compiled.test.ts`. Expect no fails and no skips.
6. Record the distribution, the kernel version (`uname -r`), and the results.

## Linux binary under WSL

This check runs the cross-compiled linux-x64 binary from Windows in WSL. It needs no Bun in WSL.

1. On Windows, run `bun run compile:all` or `bun run release`. Note the path of the linux-x64 binary.
2. In WSL, copy the binary into the Linux file system, not under `/mnt/c`: `mkdir -p ~/rl-smoke && cp /mnt/d/<repo>/dist/bin/pr-review-inbox-linux-x64 ~/rl-smoke/ && cd ~/rl-smoke`.
3. Run `chmod +x pr-review-inbox-linux-x64`.
4. Run `REVIEW_LOOP_SECRETS=memory REVIEW_LOOP_DATA_DIR="$(mktemp -d)" ./pr-review-inbox-linux-x64`. Expect "PR Review Inbox (<commit>): http://127.0.0.1:7317/" with the commit of step 1.
5. On Windows, open the printed URL in the browser. Expect the inbox page. WSL forwards localhost to Windows by default. If the page does not open, record the WSL networking mode (`wsl --version` and `.wslconfig`).
6. Press Ctrl+C in WSL. Expect the process to stop. Record the distribution, `uname -r`, and the results.
