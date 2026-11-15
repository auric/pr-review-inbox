// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The model and effort that Claude Code uses for a run without --model or --effort.
// Sources: code.claude.com/docs/en/model-config ("Setting your model", "Model aliases", "Adjust effort level").
// Every app run sends --restricted, which ignores the user settings file (integration-check.md B39). So only the run env counts.
// A managed or organization value can override the defaults (integration-check.md U37).
import type { Effort, RunnerDefaults } from "../../shared/dto";
import { RUNNER } from "./catalog";

// model-config "Model aliases", Anthropic API column. The app runs only with claude.ai auth. "best" depends on the account, so it has no entry.
const ALIASES: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
  fable: "claude-fable-5-1",
};
// model-config "Adjust effort level", item 3: the default effort of each model that supports effort.
const MODEL_EFFORT: Record<string, Effort> = {
  "claude-opus-5-5": "medium",
  "claude-sonnet-5-5": "medium",
  "claude-haiku-5-5": "medium",
  "claude-opus-4-7": "xhigh",
  "claude-fable-5-1": "high",
  "claude-fable-5": "high",
  "claude-opus-5": "high",
  "claude-sonnet-5": "high",
  "claude-opus-4-8": "high",
  "claude-opus-4-6": "high",
  "claude-sonnet-4-6": "high",
};

type Env = Record<string, string | undefined>;
// Windows env names ignore case.
function envGet(env: Env, name: string) {
  if (process.platform !== "win32") return env[name] || undefined;
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === name && v) return v;
  return undefined;
}

// The model ID of a model text. null: an unknown alias.
function canonical(model: string, env: Env): string | null {
  const base = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "");
  if (base in ALIASES) {
    const pinned = envGet(env, `ANTHROPIC_DEFAULT_${base.toUpperCase()}_MODEL`);
    return pinned ? canonical(pinned, {}) : (ALIASES[base] ?? null);
  }
  if (base === "default" || base === "best" || base === "opusplan" || base === "inherit") return null;
  return base.replace(/-\d{8}$/, "");
}

// childEnv keeps ANTHROPIC_MODEL and removes CLAUDE_CODE_*, so CLAUDE_CODE_EFFORT_LEVEL never reaches a run.
const envModel = (env: Env) => envGet(env, "ANTHROPIC_MODEL") ?? null;

function defaultEffort(env: Env, model: string | null): Effort | null {
  const id = model ? canonical(model, env) : null;
  return (id && MODEL_EFFORT[id]) || null;
}

// GET /api/meta: the default model, and the default effort per model choice. Key "": no --model.
// models: more model texts, such as the model of each profile. The key is the text as given, so the client finds it.
export function runnerDefaults(env: Env = process.env, models: readonly string[] = []): RunnerDefaults {
  const model = envModel(env);
  const effort: Record<string, Effort> = {};
  for (const key of new Set(["", ...RUNNER.models, ...models])) {
    const e = defaultEffort(env, key || model);
    if (e) effort[key] = e;
  }
  return { model, effort };
}

// The effort of a run without --effort. model: the init model, else the --model value, else null. null: unknown.
export function runEffort(model: string | null, env: Env = process.env): Effort | null {
  return defaultEffort(env, model ?? envModel(env));
}
