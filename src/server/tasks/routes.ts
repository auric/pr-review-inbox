// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The task API of docs/plans/review-v2/spec.md sections 6.11 and 6.20.12: create, list, read, answers, docs, plan, size, the build
// actions, the PR, the push, and the move of a part, close, and the repository task settings. Every input passes its zod schema. Every mutation checks task.version and gives 409
// with the current task on a mismatch.
import { type Context, Hono } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import {
  type ApiError,
  ATT_ID,
  attachmentInput,
  type BranchCheckDto,
  type BranchSearchDto,
  branchCheckInput,
  branchName,
  branchSearchInput,
  JIRA_KEY,
  type RepoTaskSettingsDto,
  type RunConflict,
  repoTaskSettingsInput,
  specChangeInput,
  type TaskConflict,
  type TaskDto,
  type TaskIssueDto,
  type TaskJiraMoveDto,
  type TaskProfileDto,
  type TaskRepoListDto,
  type TaskTransitionsDto,
  taskAnswersInput,
  taskBaseInput,
  taskCreateInput,
  taskDocInput,
  taskInstructionsInput,
  taskIssueInput,
  taskLimitInput,
  taskListInput,
  taskMoveInput,
  taskPlanAgainInput,
  taskPlanInput,
  taskPointerInput,
  taskProfileInput,
  taskPrsInput,
  taskRepoChoiceInput,
  taskReviewersInput,
  taskSizeInput,
  taskStartInput,
  taskTransitionInput,
  taskVersionInput,
} from "../../shared/dto";
import { MAX_INSTRUCTION } from "../../shared/task";
import type { Live } from "../live";
import { log } from "../log";
import type { ReviewJobs } from "../review/jobs";
import { noUrl } from "../review/workspace";
import type { Settings } from "../settings";
import { lowerUnread, startable, syncParts } from "./gates";
import { createLoop } from "./loop";
import { createPrOpener, partDiff } from "./pr";
import { createTaskService, preselectProfile, repoSettings, saveRepoSettings, type TaskResult, taskRow } from "./tasks";

const unconfigured = { error: "Configure the Bitbucket URL and token first." } satisfies ApiError;
const NAME = /^[A-Za-z0-9~_][A-Za-z0-9._~-]{0,254}$/;
const positive = (v: string | undefined) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

const idParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  return id ? { id } : c.json<ApiError>({ error: "Invalid task ID." }, 400);
});
const stepParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  const step = positive(v.step);
  return id && step ? { id, step } : c.json<ApiError>({ error: "Invalid task or step ID." }, 400);
});
const partParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  const part = positive(v.part);
  return id && part ? { id, part } : c.json<ApiError>({ error: "Invalid task or part ID." }, 400);
});
const fileParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  return id && ATT_ID.test(v.att ?? "") ? { id, att: v.att as string } : c.json<ApiError>({ error: "Invalid task or attachment ID." }, 400);
});
const taskRepoParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  const taskRepo = positive(v.taskRepo);
  return id && taskRepo ? { id, taskRepo } : c.json<ApiError>({ error: "Invalid task or repository ID." }, 400);
});
const taskPrParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  const taskPr = positive(v.taskPr);
  return id && taskPr ? { id, taskPr } : c.json<ApiError>({ error: "Invalid task or PR ID." }, 400);
});
const runParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  const run = positive(v.run);
  return id && run ? { id, run } : c.json<ApiError>({ error: "Invalid task or run ID." }, 400);
});
const jiraKeyParam = validator("param", (v: Record<string, string>, c) => {
  const id = positive(v.id);
  return id && JIRA_KEY.test(v.key ?? "") ? { id, key: v.key as string } : c.json<ApiError>({ error: "Invalid task ID or Jira key." }, 400);
});
const repoParam = validator("param", (v: Record<string, string>, c) =>
  NAME.test(v.project ?? "") && NAME.test(v.repo ?? "")
    ? { project: v.project as string, repo: v.repo as string }
    : c.json<ApiError>({ error: "Invalid repository." }, 400),
);
const body = <T extends z.ZodType>(schema: T, error: string) =>
  validator("json", (v, c) => {
    const r = schema.safeParse(v);
    return r.success ? (r.data as z.infer<T>) : c.json<ApiError>({ error }, 400);
  });

export function createTaskRoutes(opts: {
  review: ReviewJobs;
  settings: Settings;
  live: Live;
  sync?: { syncNow: () => Promise<unknown>; onTaskPrs?: (fn: (prs: number[]) => Promise<void>) => void };
}) {
  const { review } = opts;
  const tasks = createTaskService({ review, settings: opts.settings, live: opts.live });
  const loop = createLoop({ review, settings: opts.settings, live: opts.live });
  review.onStop(() => loop.shutdown());
  const prs = createPrOpener({
    review,
    settings: opts.settings,
    live: opts.live,
    working: loop.running,
    syncNow: () => void opts.sync?.syncNow().catch((e) => log(`The sync after a task PR failed: ${noUrl((e as Error).message)}`)),
  });
  review.onStop(() => prs.shutdown());
  // TaskDto.working comes from the loop, which only this layer knows. The Tell Claude box waits while the loop works.
  const live = (t: TaskDto): TaskDto => {
    const working = loop.running(t.id);
    return { ...t, working, canInstruct: t.canInstruct && !working };
  };
  // spec.md section 6.18.4, Restart: the first open of a database resets the updates that a restart stopped.
  const recovered = new WeakSet<object>();
  const openDb = () => {
    const db = review.open();
    if (db && !recovered.has(db)) {
      recovered.add(db);
      loop.recover(db);
    }
    return db;
  };

  // spec.md section 6.20.11: after each sync cycle, the part gates, the loop start, and the Jira status read. Nothing here writes to
  // Bitbucket or Jira. A kick starts only Claude steps of the plan that the user approved.
  const kick = (db: NonNullable<ReturnType<typeof openDb>>, id: number) => {
    if (startable(db, id)) loop.build(db, id);
  };
  opts.sync?.onTaskPrs?.(async (prs) => {
    const db = openDb();
    if (!db) return;
    const moved = syncParts(db, prs);
    if (moved.length) opts.live.broadcast("changed", { tasks: moved });
    for (const id of moved) {
      kick(db, id);
      // spec.md section 6.20.10: the base check after the merge of a lower part tells how it merged (TaskPartDto.lower).
      if (lowerUnread(db, id))
        void loop.checkBases(db, id).catch((e) => log(`Task ${id}: the base check after a merge failed: ${noUrl((e as Error).message)}`));
    }
    for (const id of await tasks.syncStatuses(db)) kick(db, id);
  });

  function answer(c: Context, r: TaskResult) {
    if ("task" in r && r.status !== 409) return c.json(live(r.task), r.status);
    if (r.status === 409)
      return r.running
        ? c.json<RunConflict>({ error: r.error, running: r.running }, 409)
        : r.task
          ? c.json<TaskConflict>({ error: r.error, task: live(r.task) }, 409)
          : c.json<ApiError>({ error: r.error }, 409);
    if (r.status === 422) return c.json({ error: r.error, line: r.line }, 422);
    return c.json<ApiError>({ error: r.error }, r.status);
  }

  return (
    new Hono()
      .post("/tasks", body(taskCreateInput, "Give a project, a repository, and a Jira key such as ABC-12."), async (c) =>
        answer(c, await tasks.create(c.req.valid("json"))),
      )
      // spec.md section 6.17: the attachments of a key for the form, before the task exists.
      .post("/tasks/issue", body(taskIssueInput, "Give a Jira key such as ABC-12."), async (c) => {
        const r = await tasks.issue(c.req.valid("json").key);
        return "attachments" in r ? c.json<TaskIssueDto>(r, 200) : answer(c, r);
      })
      // spec.md section 6.17: a tick or an untick of one attachment of the task.
      .put("/tasks/:id/files/:att", fileParam, body(attachmentInput, "Give include true or false."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, att } = c.req.valid("param");
        return answer(c, await tasks.file(db, id, att, c.req.valid("json").include));
      })
      .get(
        "/tasks",
        validator("query", (v, c) => {
          const r = taskListInput.safeParse(v);
          return r.success ? r.data : c.json<ApiError>({ error: "Use state open or all." }, 400);
        }),
        (c) => {
          const db = openDb();
          return c.json(db ? tasks.list(db, c.req.valid("query").state) : [], 200);
        },
      )
      // spec.md section 6.2: the profile that the Build form preselects for a repository. It comes before /tasks/:id.
      .get(
        "/tasks/profile",
        validator("query", (v, c) => {
          const r = taskProfileInput.safeParse(v);
          return r.success ? r.data : c.json<ApiError>({ error: "Invalid repository." }, 400);
        }),
        (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const { project, repo } = c.req.valid("query");
          return c.json<TaskProfileDto>({ profile: preselectProfile(db, opts.settings.profiles(), project, repo) }, 200);
        },
      )
      // spec.md section 6.12: the Build form lists the repositories that the token can push to. It comes before /tasks/:id.
      .get("/tasks/repos", async (c) => {
        const r = await tasks.writableList();
        if ("error" in r) return c.json<ApiError>({ error: r.error }, 502);
        c.header("Cache-Control", "no-store");
        return c.json<TaskRepoListDto>({ repos: r.repos.map((x) => ({ project: x.project, repo: x.slug })), complete: r.complete }, 200);
      })
      .get("/tasks/:id", idParam, (c) => {
        const db = openDb();
        const t = db && tasks.get(db, c.req.valid("param").id);
        // spec.md section 6.18.5: the Task view opens, so a base check runs in the background at most once per BASE_CHECK_AGE.
        if (db && t) loop.baseCheck(db, t.id);
        return t ? c.json(live(t), 200) : c.json<ApiError>({ error: "Task not found." }, 404);
      })
      .post("/tasks/:id/answers", idParam, body(taskAnswersInput, "Invalid answers."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id } = c.req.valid("param");
        // A question of a build step or an instruct step waits in state implementing or ready. The interview asks in state interview.
        const state = taskRow(db, id)?.state;
        const building = state === "implementing" || state === "ready";
        if (building) await loop.settle(id);
        return answer(c, building ? loop.answer(db, id, c.req.valid("json")) : tasks.answers(db, id, c.req.valid("json")));
      })
      .put("/tasks/:id/docs", idParam, body(taskDocInput, "Invalid plan file."), (c) => {
        const db = openDb();
        return db ? answer(c, tasks.docs(db, c.req.valid("param").id, c.req.valid("json"))) : c.json(unconfigured, 409);
      })
      .post("/tasks/:id/plan", idParam, body(taskPlanInput, "Invalid plan approval."), (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id } = c.req.valid("param");
        const r = tasks.plan(db, id, c.req.valid("json"));
        // spec.md section 6.2: a small plan approval starts part 1.
        if (r.status === 200 && "task" in r && r.task.state === "implementing") loop.build(db, id);
        return answer(c, r);
      })
      // spec.md section 6.20.12: "Ask Claude again" starts the spec run again (202).
      .post("/tasks/:id/plan-again", idParam, body(taskPlanAgainInput, "Invalid plan request."), (c) => {
        const db = openDb();
        return db ? answer(c, tasks.planAgain(db, c.req.valid("param").id, c.req.valid("json"))) : c.json(unconfigured, 409);
      })
      .post("/tasks/:id/pause", idParam, body(taskVersionInput, "Give the task version."), (c) => {
        const db = openDb();
        return db ? answer(c, loop.pause(db, c.req.valid("param").id, c.req.valid("json"))) : c.json(unconfigured, 409);
      })
      .post("/tasks/:id/stop", idParam, body(taskVersionInput, "Give the task version."), (c) => {
        const db = openDb();
        return db ? answer(c, loop.stop(db, c.req.valid("param").id, c.req.valid("json"))) : c.json(unconfigured, 409);
      })
      .post("/tasks/:id/resume", idParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id } = c.req.valid("param");
        await loop.settle(id);
        const t = taskRow(db, id);
        const before = t?.state === "stopped" && t.stopped_from !== "implementing";
        return answer(c, before ? tasks.resume(db, id, c.req.valid("json")) : loop.resume(db, id, c.req.valid("json")));
      })
      .post("/tasks/:id/close", idParam, body(taskVersionInput, "Give the task version."), (c) => {
        const db = openDb();
        return db ? answer(c, tasks.close(db, c.req.valid("param").id, c.req.valid("json"))) : c.json(unconfigured, 409);
      })
      .post("/tasks/:id/limit", idParam, body(taskLimitInput, "Give the task version, and keep true or a line limit."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, loop.limit(db, id, c.req.valid("json")));
      })
      .post(
        "/tasks/:id/spec-change/:step",
        stepParam,
        body(specChangeInput, "Give the task version and accept true or false."),
        async (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const { id, step } = c.req.valid("param");
          await loop.settle(id);
          return answer(c, await loop.specChange(db, id, step, c.req.valid("json")));
        },
      )
      .post("/tasks/:id/size", idParam, body(taskSizeInput, "Pick small, medium, or large."), (c) => {
        const db = openDb();
        return db ? answer(c, tasks.size(db, c.req.valid("param").id, c.req.valid("json"))) : c.json(unconfigured, 409);
      })
      // spec.md section 6.12, "Open the PR": the push of the part branch and one PR create, only on this click.
      .post("/tasks/:id/parts/:part/pr", partParam, body(taskReviewersInput, "Give the task version and the reviewers."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, await prs.open(db, id, part, c.req.valid("json")));
      })
      // spec.md section 6.16.8: "Push and open N PRs" and "Try again" of one row. The pushes and the creates run after the 202.
      .post(
        "/tasks/:id/parts/:part/prs",
        partParam,
        body(taskPrsInput, "Give the task version and the rows with their reviewers."),
        async (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const { id, part } = c.req.valid("param");
          await loop.settle(id);
          return answer(c, await prs.openRows(db, id, part, c.req.valid("json")));
        },
      )
      // spec.md section 6.20.10: "Push to <branch>", a fast-forward push with the lease, only on this click.
      .post("/tasks/:id/parts/:part/push", partParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, await prs.pushNow(db, id, part, c.req.valid("json")));
      })
      // spec.md section 6.20.10: "Move <key> to <base>" and "Push and move" after the lower part merged, only on this click.
      .post(
        "/tasks/:id/parts/:part/move",
        partParam,
        body(taskMoveInput, "Give the task version, and push true or nothing."),
        async (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const { id, part } = c.req.valid("param");
          await loop.settle(id);
          return answer(c, await prs.move(db, id, part, c.req.valid("json")));
        },
      )
      // spec.md section 6.20.6: "Start <key> now" and "Wait for the merge". section 6.20.7: "Drop this sub-task".
      .post("/tasks/:id/parts/:part/start", partParam, body(taskStartInput, "Give the task version and override true."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, loop.startNow(db, id, part, c.req.valid("json")));
      })
      .post("/tasks/:id/parts/:part/wait-merge", partParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, loop.waitMerge(db, id, part, c.req.valid("json")));
      })
      .post("/tasks/:id/parts/:part/drop", partParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, loop.drop(db, id, part, c.req.valid("json")));
      })
      // spec.md section 6.20.12: the status read of the Task view, at most once per JIRA_VIEW_AGE_MS.
      .post("/tasks/:id/jira-check", idParam, async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id } = c.req.valid("param");
        const r = await tasks.jiraCheck(db, id);
        if (r.status === 200) kick(db, id);
        return answer(c, r);
      })
      // spec.md section 6.20.12: "Read Jira again". Only reads go to Jira.
      .post("/tasks/:id/jira-read", idParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id } = c.req.valid("param");
        const r = await tasks.jiraRead(db, id, c.req.valid("json"));
        if (r.status === 200) kick(db, id);
        return answer(c, r);
      })
      // spec.md section 6.20.9: the "Move in Jira" click lists the transitions. The POST below is the only Jira write, and only the
      // confirm of the dialog calls it.
      .get("/tasks/:id/jira/:key/transitions", jiraKeyParam, async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, key } = c.req.valid("param");
        const r = await tasks.jiraTransitions(db, id, key);
        return "transitions" in r ? c.json<TaskTransitionsDto>(r, 200) : answer(c, r);
      })
      .post("/tasks/:id/jira/:key/transitions", jiraKeyParam, body(taskTransitionInput, "Give a transition ID."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, key } = c.req.valid("param");
        const r = await tasks.jiraMove(db, id, key, c.req.valid("json").id);
        if (!("to" in r)) return answer(c, r);
        kick(db, id);
        return c.json<TaskJiraMoveDto>({ status: r.to, task: live(r.task) }, 200);
      })
      // spec.md section 6.16.8: "Point <parent> at the merged commit". The commit and the push run after the 202.
      .post("/tasks/:id/prs/:taskPr/pointer", taskPrParam, body(taskPointerInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, taskPr } = c.req.valid("param");
        return answer(c, await prs.pointer(db, id, taskPr, c.req.valid("json")));
      })
      // spec.md section 6.16.5: Add or Skip of a proposed repository. Add writes the plan again (202).
      .post(
        "/tasks/:id/repos/:taskRepo",
        taskRepoParam,
        body(taskRepoChoiceInput, "Give the task version and add true or false."),
        async (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const { id, taskRepo } = c.req.valid("param");
          return answer(c, await tasks.repoChoice(db, id, taskRepo, c.req.valid("json")));
        },
      )
      // spec.md section 6.18.5: the base check before the PR dialog. It reads the remote only.
      .post("/tasks/:id/base-check", idParam, async (c) => {
        const db = openDb();
        return db ? answer(c, await loop.checkBases(db, c.req.valid("param").id)) : c.json(unconfigured, 409);
      })
      // spec.md section 6.18.6: "Tell Claude". The text goes to Claude only; the app never reads it for commands.
      .post(
        "/tasks/:id/instructions",
        idParam,
        body(taskInstructionsInput, `Give the task version and 1 to ${MAX_INSTRUCTION} characters of text.`),
        async (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const { id } = c.req.valid("param");
          await loop.settle(id);
          return answer(c, loop.instruct(db, id, c.req.valid("json")));
        },
      )
      // spec.md section 6.18.6: "Update from <base>" and "Undo the update". Neither pushes.
      .post("/tasks/:id/parts/:part/update", partParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, await loop.update(db, id, part, c.req.valid("json")));
      })
      .post("/tasks/:id/parts/:part/update/undo", partParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, await loop.undoUpdate(db, id, part, c.req.valid("json")));
      })
      .post("/tasks/:id/parts/:part/fix", partParam, body(taskVersionInput, "Give the task version."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        await loop.settle(id);
        return answer(c, loop.fixPoints(db, id, part, c.req.valid("json")));
      })
      .get("/tasks/:id/parts/:part/diff", partParam, async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { id, part } = c.req.valid("param");
        const t = taskRow(db, id);
        // spec.md section 6.20.6: a part with its own base commit diffs from it.
        const p = db.query("SELECT head, base_commit FROM task_part WHERE id = $part AND task = $id").get({ part, id }) as {
          head: string | null;
          base_commit: string | null;
        } | null;
        if (!t || !p) return c.json<ApiError>({ error: "Part not found." }, 404);
        try {
          const d = await partDiff(review.dataDir, t, p.head, p.base_commit ?? t.base_commit);
          return d ? c.json(d, 200) : c.json<ApiError>({ error: "This part has no commit yet." }, 409);
        } catch (e) {
          return c.json<ApiError>({ error: `Cannot read the diff: ${noUrl((e as Error).message)}` }, 502);
        }
      })
      // The run log of a task run (RunLog.tsx). GET /api/runs/:id gives 404 for it.
      .get("/tasks/:id/runs/:run", runParam, (c) => {
        const db = openDb();
        const { id, run } = c.req.valid("param");
        const d = db && review.taskRunLog(db, id, run);
        return d ? c.json(d, 200) : c.json<ApiError>({ error: "Run not found." }, 404);
      })
      // spec.md section 6.16.4: the branch check of the plan screen.
      .get(
        "/tasks/:id/branch",
        idParam,
        validator("query", (v, c) => {
          const r = branchCheckInput.extend({ base: branchName.optional() }).safeParse(v);
          return r.success ? r.data : c.json<ApiError>({ error: "Invalid branch prefix." }, 400);
        }),
        async (c) => {
          const db = openDb();
          if (!db) return c.json(unconfigured, 409);
          const r = await tasks.branch(db, c.req.valid("param").id, c.req.valid("query"));
          return "name" in r ? c.json<BranchCheckDto>(r, 200) : answer(c, r);
        },
      )
      // spec.md section 6.16.3: a base change. 202 when the plan runs again.
      .put("/tasks/:id/base", idParam, body(taskBaseInput, "Give the task version and a branch name."), async (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const id = c.req.valid("param").id;
        // spec.md section 6.16.7: after the build started, only "Pick a base branch" of the pre-flight changes a base.
        const state = tasks.get(db, id)?.state;
        const built = state === "implementing" || state === "ready";
        if (built) await loop.settle(id);
        return answer(c, await (built ? loop.base(db, id, c.req.valid("json")) : tasks.base(db, id, c.req.valid("json"))));
      })
      // spec.md section 6.16.3: the base picker. One page of the branch search and the default branch.
      .get(
        "/repos/:project/:repo/branches",
        repoParam,
        validator("query", (v, c) => {
          const r = branchSearchInput.safeParse(v);
          return r.success ? r.data : c.json<ApiError>({ error: "The filter has at most 255 characters." }, 400);
        }),
        async (c) => {
          const { project, repo } = c.req.valid("param");
          let provider: Awaited<ReturnType<Settings["provider"]>>;
          try {
            provider = await opts.settings.provider();
          } catch (e) {
            return c.json<ApiError>({ error: (e as Error).message }, 502);
          }
          if (!provider) return c.json(unconfigured, 409);
          try {
            const [page, defaultBranch] = await Promise.all([
              provider.listBranches(project, repo, c.req.valid("query").filter),
              provider.defaultBranch(project, repo).catch(() => null),
            ]);
            return c.json<BranchSearchDto>({ defaultBranch, ...page }, 200);
          } catch (e) {
            return c.json<ApiError>({ error: `Cannot read the branches of ${project}/${repo}. ${noUrl((e as Error).message)}` }, 502);
          }
        },
      )
      .get("/repos/:project/:repo/task-settings", repoParam, (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { project, repo } = c.req.valid("param");
        return c.json<RepoTaskSettingsDto>(repoSettings(db, project, repo), 200);
      })
      .put("/repos/:project/:repo/task-settings", repoParam, body(repoTaskSettingsInput, "Invalid task settings."), (c) => {
        const db = openDb();
        if (!db) return c.json(unconfigured, 409);
        const { project, repo } = c.req.valid("param");
        const s = c.req.valid("json");
        if (new Set(s.commands.map((x) => x.id)).size !== s.commands.length)
          return c.json<ApiError>({ error: "Each command needs its own ID." }, 400);
        saveRepoSettings(db, project, repo, s);
        return c.json<RepoTaskSettingsDto>(repoSettings(db, project, repo), 200);
      })
  );
}
