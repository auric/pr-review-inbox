// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Agent workflows of Build a Jira task (docs/plans/review-v2/agent-workflow.md sections 3.1 to 3.6).
import { z } from "zod";
import { EFFORTS, modelName } from "./dto";
import type { StepMode } from "./task";

// Release 2 adds "project" (agent-workflow.md section 3.7).
export const AGENT_SOURCES = ["preset", "user"] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];
export const AGENT_KINDS = ["readOnly", "writes", "commands", "writesCommands"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
// Resolve never uses a workflow (agent-workflow.md section 3.8).
export const WORKFLOW_STEPS = ["tests", "implement", "fix", "instruct"] as const satisfies readonly StepMode[];
export const MAX_WORKFLOWS = 20;
export const MAX_WORKFLOW_AGENTS = 12;

// One row of the agent list. problems: refusals; an agent with a problem cannot be picked. notes: hints that refuse nothing.
// model: the file value; "inherit" means the session model, null means the Claude Code default. tools: the tools after the cap of a
// shell step. ignored: the front matter keys that the app drops.
export const agentInfo = z.object({
  source: z.enum(AGENT_SOURCES),
  name: z.string(),
  file: z.string(),
  description: z.string(),
  model: z.string().nullable(),
  effort: z.enum(EFFORTS).nullable(),
  kind: z.enum(AGENT_KINDS),
  tools: z.array(z.string()),
  ignored: z.array(z.string()),
  problems: z.array(z.string()),
  notes: z.array(z.string()),
});
export type AgentInfo = z.infer<typeof agentInfo>;

// The definition that the app writes into agents.json (section 3.6). strict: no other key can reach the CLI.
export const agentDef = z
  .object({
    description: z.string(),
    prompt: z.string(),
    tools: z.array(z.string()).min(1),
    disallowedTools: z.array(z.string()),
    model: modelName.optional(),
    effort: z.enum(EFFORTS).optional(),
    maxTurns: z.number().int().positive(),
    omitClaudeMd: z.literal(true),
  })
  .strict();
export type AgentDef = z.infer<typeof agentDef>;

export const agentRef = z.object({ source: z.enum(AGENT_SOURCES), name: z.string().min(1).max(64) });
export type AgentRef = z.infer<typeof agentRef>;

// lead: null is the App lead. model, effort: overrides of the agent file values.
export const workflowAgent = agentRef.extend({
  model: modelName.nullable().default(null),
  effort: z.enum(EFFORTS).nullable().default(null),
  readOnly: z.boolean().default(false),
});
export type WorkflowAgent = z.infer<typeof workflowAgent>;

export const workflow = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(100),
  lead: agentRef.nullable().default(null),
  leadModel: modelName.nullable().default(null),
  leadEffort: z.enum(EFFORTS).nullable().default(null),
  leadEdits: z.boolean().default(false),
  agents: z.array(workflowAgent).max(MAX_WORKFLOW_AGENTS),
  steps: z.array(z.enum(WORKFLOW_STEPS)).default([...WORKFLOW_STEPS]),
});
export type Workflow = z.infer<typeof workflow>;
