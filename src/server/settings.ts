// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { validator } from "hono/validator";
import {
  type ApiError,
  type JiraSettingsInput,
  MAX_TASK_RULES,
  type PrTask,
  type SettingsDto,
  settingsInput,
  type TaskPreviewDto,
  type TaskPreviewError,
  type TaskRule,
  taskPreviewInput,
} from "../shared/dto";
import { DEFAULT_BRANCH_PREFIXES } from "../shared/task";
import type { PullRequest } from "../shared/types";
import { ForgeError } from "./bitbucket/client";
import { createBitbucketProvider, type ForgeProvider } from "./bitbucket/provider";
import { type Config, ConfigWriteError, dataDir, dbPath, PROFILES_VERSION, readConfig, writeConfig } from "./config";
import { createJiraSource } from "./context/jira";
import { ContextError, type ContextSource } from "./context/source";
import { listPrs } from "./inbox/queries";
import { log } from "./log";
import {
  DEFAULT_PROFILE,
  formerEdits,
  nextEdits,
  type Profile,
  profileEditState,
  RETIRED_MODULE,
  RETIRED_PROFILES,
  SHIPPED_PROFILES,
  SPARSE_VERSION,
  sameValue,
  upgradeProfile,
} from "./review/catalog";
import { createSecrets, type Secrets } from "./secrets";
import { openDb } from "./storage/db";
import {
  createTaskRunner,
  DEFAULT_TASK_RULES,
  extractSkipping,
  sameRule,
  type TaskInput,
  type TaskRunner,
  taskHash,
  taskInput,
  taskUrl,
  validTaskLink,
  writeTasks,
} from "./tasks/rules";

export type SettingsState = { config: Config; db: Database };

// config: the settings that produced the plan. A plan of replaced settings is stale.
export type TaskPlan = { config: Config; hash: string; tasks: PrTask[] };

type StoredRule = TaskRule & { timedOut?: boolean };

const rulesOf = (c: Config | null): StoredRule[] => c?.taskRules ?? DEFAULT_TASK_RULES;
const activeRules = (c: Config): TaskRule[] => rulesOf(c).flatMap(({ timedOut, ...r }) => (timedOut ? [] : [r]));

const DEFAULT_CHECK_SECONDS = 60;
const profilesOf = (c: Config | null): Profile[] => c?.profiles ?? SHIPPED_PROFILES;
const upgradeConfig = (c: Config | null): Config | null => {
  if (!c?.profiles || c.profilesVersion === PROFILES_VERSION) return c;
  const version = c.profilesVersion ?? 1;
  const upgraded = c.profiles.map((p) => upgradeProfile(p, version));
  const profiles = version <= 4 ? retire(upgraded) : upgraded;
  // From SPARSE_VERSION the file holds the edit hashes. An older file gets them from its own version (catalog.ts formerEdits).
  return { ...c, profiles, profileEdits: version < SPARSE_VERSION ? formerEdits(profiles, version) : c.profileEdits };
};

// docs/plans/review-v2/spec.md section 1.2, retire rule: a Security or Over-engineering profile with every field at its version 4
// value leaves the list. general gets its module while general.modules holds the shipped value. Without general, no profile retires,
// because the module has no profile to go to.
function retire(list: Profile[]): Profile[] {
  const general = list.find((p) => p.id === DEFAULT_PROFILE);
  const gone = list.filter((p) => sameValue(p, RETIRED_PROFILES[p.id]));
  if (!general || !gone.length) return list;
  const shipped = SHIPPED_PROFILES.find((p) => p.id === DEFAULT_PROFILE) as Profile;
  const add = sameValue(general.modules, shipped.modules) ? gone.flatMap((p) => RETIRED_MODULE[p.id] ?? []) : [];
  return list.filter((p) => !gone.includes(p)).map((p) => (p === general ? { ...p, modules: [...new Set([...p.modules, ...add])] } : p));
}
const checkSecondsOf = (c: Config | null) => c?.checkSeconds ?? DEFAULT_CHECK_SECONDS;
export const branchPrefixesOf = (c: Config | null): string[] => c?.taskBranchPrefixes ?? [...DEFAULT_BRANCH_PREFIXES];

const originOf = (url: string) => new URL(url).origin;

// Accepts only an http(s) base URL without credentials, query, or fragment. Returns it without a trailing slash.
function normalize(raw: string): string | null {
  try {
    const u = new URL(raw);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.search || u.hash) return null;
    return (u.origin + u.pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

// Construction does no disk or secret-store access. The first request loads the state.
export function createSettings(
  opts: { dir?: string; secrets?: Secrets; jiraSecrets?: Secrets; taskBudget?: Parameters<typeof createTaskRunner>[0] } = {},
) {
  const dir = opts.dir ?? dataDir();
  const secrets = opts.secrets ?? createSecrets();
  const jiraSecrets = opts.jiraSecrets ?? createSecrets(undefined, "jira-token");
  const listeners: ((s: SettingsState) => void)[] = [];
  const taskListeners: ((prs: number[]) => void)[] = [];
  let loaded = false;
  let config: Config | null = null;
  let db: Database | null = null;
  let runner: TaskRunner | null = null;
  // Each recompute pass and close() bump it. An older pass stops before its next write.
  let generation = 0;
  const tasks = () => {
    runner ??= createTaskRunner(opts.taskBudget);
    return runner;
  };

  const current = () => {
    if (!loaded) {
      config = upgradeConfig(readConfig(dir));
      loaded = true;
    }
    return config;
  };

  const currentDb = () => {
    const c = current();
    if (c && !db) db = openDb(dbPath(dir, c.baseUrl));
    return db;
  };

  async function dto(): Promise<SettingsDto> {
    const c = current();
    return {
      baseUrl: c?.baseUrl ?? null,
      user: c?.userSlug ?? null,
      tokenStored: c !== null && (await secrets.get()) !== null,
      tokenStorage: secrets.storage(),
      caFile: c?.caFile ?? null,
      notifications: c?.notifications ?? false,
      markAi: c?.markAi ?? true,
      markSeverity: c?.markSeverity ?? true,
      taskRules: rulesOf(c).map(({ timedOut, ...r }) => ({ ...r, timedOut: timedOut === true })),
      taskLink: c?.taskLink ?? null,
      checkSeconds: checkSecondsOf(c),
      profiles: profilesOf(c),
      shippedProfiles: SHIPPED_PROFILES,
      profileEdits: profileEditState(profilesOf(c), c?.profileEdits),
      jira: {
        baseUrl: c?.jira?.baseUrl ?? null,
        caFile: c?.jira?.caFile ?? null,
        tokenStored: c?.jira !== undefined && (await jiraSecrets.get()) !== null,
      },
      sessions: c?.sessions === true,
      askAttachments: c?.askAttachments !== false,
      taskBranchPrefixes: branchPrefixesOf(c),
    };
  }

  // Each PUT reads the config, awaits Bitbucket, then writes. Overlapping PUTs would pair a config with the wrong database.
  let saving: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = saving.then(fn);
    saving = run.catch(() => {});
    return run;
  };

  // The user edits a rule to clear timedOut. A rule saved unchanged keeps it.
  async function markTimedOut(rule: TaskRule) {
    await serial(async () => {
      const c = current();
      const list = rulesOf(c);
      if (!c || !list.some((r) => !r.timedOut && sameRule(r, rule))) return;
      config = { ...c, taskRules: list.map((r) => (sameRule(r, rule) ? { ...r, timedOut: true } : r)) };
      writeConfig(dir, config);
      log(`Task rule ${rule.source} /${rule.pattern}/ ran past the time budget. Sync skips it until the rule changes.`);
    });
  }

  // null: the stored hash is current. A timed-out rule is marked, and the run repeats without it.
  async function planOne(input: TaskInput, stored: string | null): Promise<TaskPlan | null> {
    for (let i = 0; i <= MAX_TASK_RULES; i++) {
      const c = current();
      if (!c) return null;
      const rules = activeRules(c);
      const link = c.taskLink ?? null;
      const hash = taskHash(input, rules, link);
      if (hash === stored) return null;
      const r = await tasks().extract(rules, input);
      if (r.timedOut === null) return { config: c, hash, tasks: r.tasks.map((t) => ({ ...t, url: taskUrl(link, t.key) })) };
      await markTimedOut(rules[r.timedOut] as TaskRule);
    }
    return null;
  }

  // Task IDs never stop a sync. A worker failure keeps the stored IDs.
  async function planTasks(db: Database, prs: PullRequest[]): Promise<(TaskPlan | null)[]> {
    const out: (TaskPlan | null)[] = [];
    try {
      for (const pr of prs) {
        const row = db
          .query("SELECT task_input_hash FROM pull_request WHERE project = $project AND repo = $repo AND pr_id = $pr_id")
          .get({ project: pr.ref.project, repo: pr.ref.repo, pr_id: pr.ref.id }) as { task_input_hash: string | null } | null;
        out.push(await planOne(taskInput(pr.sourceBranch, pr.title, pr.description ?? null), row?.task_input_hash ?? null));
      }
    } catch (e) {
      log(`Task IDs not updated: ${(e as Error).message}`);
      return prs.map(() => null);
    }
    return out;
  }

  // Runs inside the PR transaction.
  function applyTasks(db: Database, pr: number, plan: TaskPlan | null | undefined) {
    if (plan && plan.config === current()) writeTasks(db, pr, plan.hash, plan.tasks);
  }

  // Background pass over every stored PR after a settings save.
  async function recompute() {
    const gen = ++generation;
    const db = currentDb();
    if (!db) return;
    type Row = {
      id: number;
      source_branch: string | null;
      title: string | null;
      description: string | null;
      task_input_hash: string | null;
    };
    const rows = db.query("SELECT id, source_branch, title, description, task_input_hash FROM pull_request ORDER BY id").all() as Row[];
    const changed: number[] = [];
    try {
      for (const r of rows) {
        const plan = await planOne(taskInput(r.source_branch, r.title, r.description), r.task_input_hash);
        if (gen !== generation) return;
        if (!plan || currentDb() !== db) continue;
        // A sync can write the PR during the await. Its write wins.
        const wrote = db.transaction(() => {
          const now = db.query("SELECT task_input_hash FROM pull_request WHERE id = $id").get({ id: r.id }) as {
            task_input_hash: string | null;
          } | null;
          if (!now || now.task_input_hash !== r.task_input_hash || plan.config !== current()) return false;
          writeTasks(db, r.id, plan.hash, plan.tasks);
          return true;
        })();
        if (wrote) changed.push(r.id);
      }
    } catch (e) {
      if (gen !== generation) return;
      log(`Task IDs not recomputed: ${(e as Error).message}`);
    }
    if (changed.length) for (const fn of taskListeners) fn(changed);
  }

  type JiraSaveError = { status: 400 | 409; error: string };

  // PUT /api/settings/jira (src/server/context/routes.ts). Checks the token with GET /rest/api/2/myself before it saves.
  const saveJira = (input: JiraSettingsInput): Promise<SettingsDto | JiraSaveError> =>
    serial<SettingsDto | JiraSaveError>(async () => {
      const bad = (error: string): JiraSaveError => ({ status: 400, error });
      const prev = current();
      if (!prev) return { status: 409, error: "Configure the Bitbucket URL and token first." };
      if (!input.baseUrl) {
        const next: Config = { ...prev, jira: undefined };
        writeConfig(dir, next);
        config = next;
        await jiraSecrets.clear();
        log("Jira disconnected.");
        return dto();
      }
      const baseUrl = normalize(input.baseUrl);
      if (!baseUrl) return bad("Give the Jira base URL only, for example https://host or https://host/context.");
      const caFile = input.caFile || undefined;
      const sameOrigin = prev.jira !== undefined && originOf(prev.jira.baseUrl) === originOf(baseUrl);
      const token = input.token || (sameOrigin ? await jiraSecrets.get() : null);
      if (!token) return bad("Enter the Jira token. A new Jira URL needs a new token.");
      let source: ContextSource;
      try {
        source = createJiraSource({ baseUrl, token, caFile });
      } catch (e) {
        return bad((e as { code?: unknown }).code ? "Cannot read the CA file." : (e as Error).message);
      }
      try {
        await source.check();
      } catch (e) {
        if (!(e instanceof ContextError)) throw e;
        log(`Jira check failed: ${e.message}`);
        return bad(e.kind === "auth" ? "Jira rejected the token." : `Jira check failed: ${e.message}`);
      }
      if (input.token) await jiraSecrets.set(token);
      const next: Config = { ...prev, jira: { baseUrl, caFile } };
      writeConfig(dir, next);
      config = next;
      log(`Jira settings saved for ${originOf(baseUrl)}.`);
      return dto();
    }).catch((e): JiraSaveError => {
      if (e instanceof ConfigWriteError) return { status: 409, error: e.message };
      throw e;
    });

  const routes = new Hono()
    .get("/", async (c) => c.json(await dto()))
    .put(
      "/",
      validator("json", (v, c) => {
        const r = settingsInput.safeParse(v);
        if (r.success) return r.data;
        // The prefix list has its own sentences (spec.md section 6.16.1).
        const prefix = r.error.issues.find((i) => i.path[0] === "taskBranchPrefixes");
        return c.json<ApiError>({ error: prefix?.message ?? "Invalid settings." }, 400);
      }),
      (c) =>
        serial(async () => {
          const input = c.req.valid("json");
          const bad = (error: string) => c.json<ApiError>({ error }, 400);

          const baseUrl = normalize(input.baseUrl);
          if (!baseUrl) return bad("Give the base URL only, for example https://host or https://host/context.");
          if (input.taskLink && !validTaskLink(input.taskLink))
            return bad("The task link must be an https URL with {key}. Plain http works only on localhost or 127.0.0.1.");
          if (input.taskRules) {
            const errors = await tasks().check(input.taskRules.map((r) => r.pattern));
            const i = errors.findIndex((e) => e !== null);
            if (i >= 0) return bad(`Task rule ${i + 1} has a syntax error: ${errors[i]}`);
          }
          const prev = current();
          const old = rulesOf(prev);
          const localFields = {
            taskRules: input.taskRules
              ? input.taskRules.map((r): StoredRule => (old.some((o) => o.timedOut && sameRule(o, r)) ? { ...r, timedOut: true } : r))
              : prev?.taskRules,
            taskLink: input.taskLink === undefined ? prev?.taskLink : input.taskLink || undefined,
            markAi: input.markAi ?? prev?.markAi,
            markSeverity: input.markSeverity ?? prev?.markSeverity,
            checkSeconds: input.checkSeconds ?? prev?.checkSeconds,
            profiles: input.profiles === undefined ? prev?.profiles : (input.profiles ?? undefined),
            profileEdits:
              input.profiles === undefined
                ? prev?.profileEdits
                : input.profiles
                  ? nextEdits(input.profiles, prev?.profiles, prev?.profileEdits)
                  : undefined,
            jira: prev?.jira,
            globalInstructions: prev?.globalInstructions,
            sessions: input.sessions === undefined ? prev?.sessions : input.sessions || undefined,
            askAttachments: input.askAttachments === undefined ? prev?.askAttachments : input.askAttachments ? undefined : false,
            taskBranchPrefixes: input.taskBranchPrefixes ?? prev?.taskBranchPrefixes,
          };
          const caFile = input.caFile || undefined;
          const notifications = input.notifications ?? prev?.notifications ?? false;
          // Same connection settings: save without a Bitbucket request, so the notifications toggle works offline.
          if (prev && prev.baseUrl === baseUrl && prev.caFile === caFile && !input.token) {
            const next: Config = { ...prev, notifications, ...localFields };
            writeConfig(dir, next);
            config = next;
            void recompute();
            return c.json(await dto());
          }
          const sameOrigin = prev !== null && originOf(prev.baseUrl) === originOf(baseUrl);
          const token = input.token || (sameOrigin ? await secrets.get() : null);
          if (!token) return bad("Enter the token. A new Bitbucket URL needs a new token.");

          let provider: ForgeProvider;
          try {
            provider = createBitbucketProvider({ baseUrl, token, caFile });
          } catch (e) {
            // createClient throws a plain Error for the URL scheme, and an fs error with a `code` for the CA file.
            return bad((e as { code?: unknown }).code ? "Cannot read the CA file." : (e as Error).message);
          }
          let userSlug: string;
          try {
            userSlug = await provider.currentUser();
          } catch (e) {
            if (!(e instanceof ForgeError)) throw e;
            log(`Settings check failed: ${e.message}`);
            return bad(e.kind === "auth" ? "Bitbucket rejected the token." : `Bitbucket check failed: ${e.message}`);
          }

          if (input.token) await secrets.set(token);
          const next: Config = { baseUrl, userSlug, caFile, notifications, ...localFields };
          writeConfig(dir, next);
          const oldDb = sameOrigin ? null : db;
          config = next;
          if (oldDb) db = null;
          const state = { config: next, db: currentDb() as Database };
          log(`Settings saved for ${originOf(baseUrl)} as ${userSlug}.`);
          for (const fn of listeners) fn(state);
          oldDb?.close();
          void recompute();
          return c.json(await dto());
        }).catch((e) => {
          if (e instanceof ConfigWriteError) return c.json<ApiError>({ error: e.message }, 409);
          throw e;
        }),
    )
    .post(
      "/task-rules/preview",
      validator("json", (v, c) => {
        const r = taskPreviewInput.safeParse(v);
        return r.success ? r.data : c.json<ApiError>({ error: "Invalid task rules." }, 400);
      }),
      async (c) => {
        const { rules, sample, prs } = c.req.valid("json");
        const errors = await tasks().check(rules.map((r) => r.pattern));
        const report: TaskPreviewDto["rules"] = errors.map((error) => ({ error, timedOut: false }));
        if (errors.some((e) => e !== null))
          return c.json<TaskPreviewError>({ error: "A task rule has a syntax error.", rules: report }, 400);
        // A draft rule that times out is skipped for the rest of this preview.
        const dead = new Set<number>();
        const run = (input: TaskInput) => extractSkipping(tasks(), rules, input, dead);
        const found: TaskPreviewDto = {
          rules: report,
          sample: sample ? await run(taskInput(sample.branch ?? null, sample.title ?? null, sample.description ?? null)) : null,
          prs: [],
        };
        const db = currentDb();
        const cfg = current();
        if (db && cfg) {
          const ids =
            prs ??
            listPrs(db, cfg.userSlug)
              .slice(0, 20)
              .map((p) => p.id);
          type Row = {
            id: number;
            project: string;
            repo: string;
            pr_id: number;
            title: string | null;
            source_branch: string | null;
            description: string | null;
          };
          const rows = db
            .query(
              `SELECT p.id, p.project, p.repo, p.pr_id, p.title, p.source_branch, p.description FROM json_each($ids) j
                JOIN pull_request p ON p.id = j.value WHERE p.archived_at IS NULL AND (p.followed = 1 OR p.on_dashboard = 1) ORDER BY j.key`,
            )
            .all({ ids: JSON.stringify(ids) }) as Row[];
          for (const r of rows) {
            const t = await run(taskInput(r.source_branch, r.title, r.description));
            found.prs.push({ id: r.id, project: r.project, repo: r.repo, prId: r.pr_id, title: r.title, tasks: t });
          }
        }
        for (const i of dead) (report[i] as { timedOut: boolean }).timedOut = true;
        return c.json(found, 200);
      },
    );

  return {
    routes,
    config: current,
    // The configured profiles, else SHIPPED_PROFILES. Never empty.
    profiles: () => profilesOf(current()),
    // The time between sync cycles.
    checkMs: () => checkSecondsOf(current()) * 1000,
    // The database of the configured origin, or null before the first valid PUT.
    db: currentDb,
    // A provider for the current settings, or null without config or token. Throws a plain Error for an unreadable CA file.
    async provider(): Promise<ForgeProvider | null> {
      const c = current();
      const token = c && (await secrets.get());
      return c && token ? createBitbucketProvider({ baseUrl: c.baseUrl, token, caFile: c.caFile }) : null;
    },
    saveJira,
    // The global instruction switch. Off without a config.
    globalInstructions: () => current()?.globalInstructions === true,
    // The opt-in of "Ask your session" (docs/plans/session-consult.md part C). Off without a config.
    sessions: () => current()?.sessions === true,
    // false: no config yet.
    saveGlobalInstructions: (on: boolean) =>
      serial(async () => {
        const prev = current();
        if (!prev) return false;
        config = { ...prev, globalInstructions: on || undefined };
        writeConfig(dir, config);
        return true;
      }),
    // A Jira source for the current settings, or null without Jira config or token. Throws for an unreadable CA file.
    async jira(): Promise<ContextSource | null> {
      const j = current()?.jira;
      const token = j && (await jiraSecrets.get());
      return j && token ? createJiraSource({ baseUrl: j.baseUrl, token, caFile: j.caFile }) : null;
    },
    // Runs after a successful PUT that changes baseUrl, token, or caFile, after the new config is written and its database is open.
    onSettingsChanged(fn: (s: SettingsState) => void) {
      listeners.push(fn);
    },
    // Task plans for forge PRs, in the same order. Await it before the PR transaction, then call applyTasks inside it.
    planTasks,
    applyTasks,
    // Stops the background pass and closes the database. Call it once, at shutdown.
    close() {
      generation++;
      db?.close();
    },
    // Runs after a background pass wrote new task IDs.
    onTasksChanged(fn: (prs: number[]) => void) {
      taskListeners.push(fn);
    },
  };
}

export type Settings = ReturnType<typeof createSettings>;
