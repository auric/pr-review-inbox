// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The app with the main.ts signal handlers and one review run of a hanging fake CLI. Test code only. No network.
// Usage: bun tests/support/shutdown-app.ts <empty folder>. The fake CLI records its pid and its child pid in <folder>/calls.jsonl.
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { writeConfig } from "../../src/server/config";
import { createLive } from "../../src/server/live";
import { stopOnSignals } from "../../src/server/main";
import { createReviewJobs } from "../../src/server/review/jobs";
import { createSecrets } from "../../src/server/secrets";
import { createSettings } from "../../src/server/settings";
import { FAKE_TOKEN, FAKE_USER, startFakeBitbucket } from "./fake-bitbucket";
import { claudeStream, fakeRunner, REVIEW_RESULT, reviewRemote, stubListTools } from "./review-fixture";

const root = process.argv[2] ?? "";
const remote = await reviewRemote(root, { 2: "source" });
const fake = startFakeBitbucket();
const dataDir = join(root, "data");
writeConfig(dataDir, { baseUrl: fake.url, userSlug: FAKE_USER, notifications: false });
const secrets = createSecrets(null);
await secrets.set(FAKE_TOKEN);
const settings = createSettings({ dir: dataDir, secrets });
const db = settings.db() as Database;
const { id } = db
  .query(
    `INSERT INTO pull_request (project, repo, pr_id, title, author_slug, author_name, my_role, state, source_head, target_head,
      source_branch, target_branch, updated_date, on_dashboard, followed)
    VALUES ('PROJ', 'repo', 2, 'Lock each entry', 'asmith', 'Alex Smith', 'REVIEWER', 'OPEN', $source, $target, 'feature', 'main', 1000, 1, 1)
    RETURNING id`,
  )
  .get({ source: remote.source, target: remote.target }) as { id: number };

const runner = fakeRunner(root);
runner.write({ fixture: claudeStream(root, "tree", "claude-synthetic/review-agent-tree.jsonl", REVIEW_RESULT), hang: true });
const review = createReviewJobs({
  settings,
  live: createLive(),
  dataDir,
  runnerCommand: runner.command,
  listTools: stubListTools,
  gitRemote: remote.gitRemote,
});
stopOnSignals(() => review.stop());
const r = review.review(db, id);
console.log(JSON.stringify("run" in r ? { run: r.run.id } : r));
