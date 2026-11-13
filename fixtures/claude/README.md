# Claude Code stream-json samples

This folder holds no transcripts. Real gate transcripts never go into the repo tree.

- `scripts/gate/sanitize-claude.ts` writes the sanitized gate streams to `.gate0/claude/` (git-ignored). It refuses an output folder in `fixtures/`.
- The tests read the hand-written streams in `fixtures/claude-synthetic/`. Its README lists each file and what it is for.
- integration-check.md records the facts of each gate run.
