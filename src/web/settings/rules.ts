// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure model of the task-rule editor (plan v3 WP3, prototype/v3 Settings). No DOM access, so bun test runs it.
import type { TaskRule, TaskRuleDto, TaskSource } from "../../shared/dto";
import { secureUrl } from "../../shared/links";

// Limits of taskRuleInput and settingsInput in src/shared/dto.ts. tests/ui/rules.test.ts pins them. A value import of dto.ts would put zod into the page.
export const LIMITS = { rules: 20, pattern: 200, keys: 50, key: 64 } as const;

// WP2 DEFAULT_TASK_RULES pattern (src/server/tasks/rules.ts).
export const DEFAULT_PATTERN = String.raw`[A-Z][A-Z0-9]+-\d+`;

export const SOURCE_NAME: Record<TaskSource, string> = { branch: "Branch", title: "Title", description: "Description" };

// id: a stable React key, so a moved rule keeps its DOM nodes. keys: the text of the field.
// timedOut: the stored rule ran past the time budget. An edit clears it, as the server does.
export type Draft = { id: number; source: TaskSource; pattern: string; keys: string; timedOut: boolean };

let lastId = 0;
const draft = (r: TaskRule, timedOut: boolean): Draft => ({
  id: ++lastId,
  source: r.source,
  pattern: r.pattern,
  keys: (r.keys ?? []).join(", "),
  timedOut,
});

export const toDrafts = (rules: TaskRuleDto[]): Draft[] => rules.map((r) => draft(r, r.timedOut));

export function parseKeys(text: string): string[] | undefined {
  const keys = text.split(/[\s,]+/).filter(Boolean);
  return keys.length ? keys : undefined;
}

export const toRules = (list: Draft[]): TaskRule[] =>
  list.map((r) => {
    const keys = parseKeys(r.keys);
    return keys ? { source: r.source, pattern: r.pattern, keys } : { source: r.source, pattern: r.pattern };
  });

export const sameRules = (a: TaskRule[], b: TaskRule[]) =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i];
    return !!o && r.source === o.source && r.pattern === o.pattern && (r.keys ?? []).join(",") === (o.keys ?? []).join(",");
  });

export type Change =
  | { act: "add" }
  | { act: "remove"; i: number }
  | { act: "move"; i: number; d: -1 | 1 }
  | { act: "edit"; i: number; patch: Partial<Pick<Draft, "source" | "pattern" | "keys">> };

export function change(list: Draft[], c: Change): Draft[] {
  switch (c.act) {
    case "add":
      return list.length >= LIMITS.rules ? list : [...list, draft({ source: "title", pattern: DEFAULT_PATTERN }, false)];
    case "remove":
      return list.filter((_, i) => i !== c.i);
    case "move": {
      const j = c.i + c.d;
      const r = list[c.i];
      if (!r || j < 0 || j >= list.length) return list;
      const out = list.filter((_, i) => i !== c.i);
      out.splice(j, 0, r);
      return out;
    }
    case "edit":
      return list.map((r, i) => (i === c.i ? { ...r, ...c.patch, timedOut: false } : r));
  }
}

// DOM ids of the editor controls.
export const ruleId = (i: number, part: "source" | "pattern" | "keys" | "up" | "down" | "remove" | "error") => `rule-${i}-${part}`;
export const ADD_ID = "rule-add";

// prototype/v3 changeRules(): the control that keeps the place after a change. n: the rule count after it.
export function focusAfter(c: Change, n: number): string | null {
  switch (c.act) {
    case "add":
      return ruleId(n - 1, "pattern");
    case "remove":
      return n ? ruleId(Math.min(c.i, n - 1), "remove") : ADD_ID;
    case "move": {
      const j = c.i + c.d;
      // The button in the same direction is disabled at the end of the list.
      const end = c.d < 0 ? j === 0 : j === n - 1;
      return ruleId(j, c.d < 0 !== end ? "up" : "down");
    }
    default:
      return null;
  }
}

// A problem that the client finds before the server runs the pattern.
export function ruleProblem(r: Draft): string | null {
  if (!r.pattern) return "Enter a pattern.";
  if (r.pattern.length > LIMITS.pattern) return `Use ${LIMITS.pattern} characters or fewer.`;
  const keys = parseKeys(r.keys) ?? [];
  if (keys.length > LIMITS.keys) return `Use ${LIMITS.keys} keys or fewer.`;
  if (keys.some((k) => k.length > LIMITS.key)) return `Use keys of ${LIMITS.key} characters or fewer.`;
  return null;
}

export const LINK_TEXT = "The task link must be an https URL with {key}. Plain http works only on localhost or 127.0.0.1.";

// The validTaskLink rule of src/server/tasks/rules.ts: https, or http on loopback, with {key} outside the origin and no credentials.
export function linkProblem(raw: string): string | null {
  if (!raw) return null;
  if (!raw.includes("{key}")) return LINK_TEXT;
  try {
    const a = new URL(raw.replaceAll("{key}", "A"));
    const b = new URL(raw.replaceAll("{key}", "B"));
    if (a.origin !== b.origin || a.username || a.password) return LINK_TEXT;
    if (secureUrl(a)) return null;
  } catch {}
  return LINK_TEXT;
}

// The worker error is "Invalid regular expression: /x/: <reason>". The user needs only the reason.
export const syntaxText = (error: string) => `This is not a valid regular expression: ${error.split(": ").at(-1)}.`;

export const TIMEOUT_TEXT = "This rule ran past the time limit. The inbox skips it until you change it.";
