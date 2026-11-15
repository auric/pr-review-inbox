// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { runEffort, runnerDefaults } from "../../src/server/review/defaults";

// integration-check.md B39: every app run sends --restricted, which ignores the user settings file. The resolver reads only the env.
describe("runner defaults", () => {
  test("without ANTHROPIC_MODEL the default model is unknown, and each alias gets the documented effort", () => {
    expect(runnerDefaults({})).toEqual({ model: null, effort: { opus: "medium", sonnet: "medium", haiku: "medium" } });
    expect(runEffort(null, {})).toBeNull();
  });

  test("ANTHROPIC_MODEL is the default model, and its effort is the key of no --model", () => {
    const d = runnerDefaults({ ANTHROPIC_MODEL: "claude-opus-4-7" });
    expect(d.model).toBe("claude-opus-4-7");
    expect(d.effort[""]).toBe("xhigh");
    expect(runEffort(null, { ANTHROPIC_MODEL: "claude-opus-4-7" })).toBe("xhigh");
  });

  test("the documented effort of each model, by ID, alias, [1m], and date suffix", () => {
    expect(runEffort("claude-opus-5-5", {})).toBe("medium");
    expect(runEffort("claude-opus-4-7", {})).toBe("xhigh");
    expect(runEffort("claude-fable-5-1", {})).toBe("high");
    expect(runEffort("claude-opus-4-6", {})).toBe("high");
    expect(runEffort("opus[1m]", {})).toBe("medium");
    expect(runEffort("claude-sonnet-5-20260101", {})).toBe("high");
  });

  test("an unknown model or a special alias has no default effort", () => {
    expect(runEffort("claude-next-1", {})).toBeNull();
    expect(runEffort("opusplan", {})).toBeNull();
    expect(runEffort("default", {})).toBeNull();
  });

  test("an ANTHROPIC_DEFAULT_<FAMILY>_MODEL pin moves the alias to the pinned model", () => {
    expect(runEffort("opus", { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7" })).toBe("xhigh");
    expect(runnerDefaults({ ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7" }, ["opus[1m]"]).effort["opus[1m]"]).toBe("xhigh");
  });

  test("CLAUDE_CODE_EFFORT_LEVEL does not count, because childEnv removes it from the run", () => {
    expect(runEffort("claude-opus-5-5", { CLAUDE_CODE_EFFORT_LEVEL: "low" })).toBe("medium");
  });
});
