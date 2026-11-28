# Security policy

## Report a vulnerability

Report vulnerabilities privately. Do not open a public issue.

1. Open the private reporting page: https://github.com/auric/pr-review-inbox/security/advisories/new
2. Alternatively, open https://github.com/auric/pr-review-inbox, click the Security tab, then click Report a vulnerability.
3. Describe the problem, the affected version or commit, and the steps to reproduce it.

The report stays private between you and the maintainer until a fix is published.

## Supported versions

| Version | Supported |
|---|---|
| The latest release | Yes |
| `main` | Yes |
| Older releases | No |

## Scope

These parts of the safety model are in scope:

- The local server listens on 127.0.0.1 only. It checks the Host and Origin of each request, and each change needs a session token.
- The Bitbucket and Jira tokens go into the OS secret store. They must never go into the database, logs, URLs, or prompts.
- Reviews and the other pull request runs use read-only tools in a sanitized snapshot of the pull request. The implement runs of Build a Jira task edit files only in an app-owned worktree of the cache, and they run only the commands that you allow. The `claude` CLI must never run in your clone.
- Nothing goes to Bitbucket without an explicit user action. PR Review Inbox pushes only on your click. It pushes only to a branch that it created for a Jira task, or to a branch that you picked with "Continue on <branch>". It never pushes to the target branch or to the branch of a pull request that it did not create.

A report that breaks one of these rules is in scope. Examples: a web page that makes the local server act, a token that leaks into a log, or a pull request that makes the CLI write outside the snapshot.

## Out of scope

- Attacks that need a malicious local user who already runs code as your OS account. That user can read your files and your secret store directly.
- Problems in Bitbucket Server, Jira, the `claude` CLI, or Bun themselves. Report them to their vendors.
- Findings that a review run reports or misses. Review quality is not a security boundary.
