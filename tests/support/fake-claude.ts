// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fake `claude` CLI for tests. It replays a stream-json fixture and never calls a model.
// Usage: bun tests/support/fake-claude.ts <scenario.json> <claude arguments>
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type FakeScenario = {
  // Each call appends one JSON line: { argv, env, cwd, stdin, pid, context }. A hang run adds { childPid }.
  record: string;
  version?: string;
  // The `auth status` JSON. projectsDirectory also receives the per-cwd session folder.
  auth: Record<string, unknown>;
  authExit?: number;
  fixture?: string;
  delayMs?: number;
  exitCode?: number;
  stderr?: string;
  // Start a child that ignores stdin EOF, stop before the first result event, and wait forever.
  hang?: boolean;
  // Start a detached child that outlives the CLI, as a command that Claude starts with `&`, and record { orphanPid }.
  orphan?: boolean;
  // The structured_output of the result, by the --json-schema shape. Absent: the echo of the stdin.
  // replies: a reply run (properties.replies). rereview: a re-review (properties.earlier). answer: an ask run (properties.answer).
  // fix: a fix run (properties.edits); its notes can carry why and reply. improve: a prompt proposal (properties.reasons). consult: a session run (properties.answers),
  // with properties.fix when the run also asks for fixes (session-consult.md part D).
  replies?: unknown;
  rereview?: unknown;
  // The answered list of a review or re-review result (docs/plans/thread-outcome.md section 9). It replaces the answered key when the
  // schema has one. Absent: the result keeps its own answered key, or none.
  answered?: unknown;
  answer?: unknown;
  fix?: unknown;
  improve?: unknown;
  consult?: unknown;
  // Review v2 (docs/plans/review-v2/spec.md): verify (properties.verdicts), explain (properties.walkthrough), and discuss
  // (properties.verdict and properties.answer) results. Absent: the echo.
  verify?: unknown;
  explain?: unknown;
  discuss?: unknown;
  // Part 6 (spec.md section 6.5): interview (properties.done and properties.questions) and spec (properties.map) results. Absent: the
  // echo.
  interview?: unknown;
  spec?: unknown;
  // spec.md section 6.22.5: the plan check result (properties.problems). Absent: a check with no problem.
  planCheck?: unknown;
  // Part 6 (spec.md section 6.7): the implement result (properties.specChange). Absent: the echo. writes: the files that the run
  // writes before its stream, by path relative to the cwd. A path outside the cwd is refused, as --restricted refuses it (Gate B17), and
  // the record gets { refused: path }. junction: a folder link to that target in place of a file.
  implement?: unknown;
  // pushback.md section 6.23.2: the verdicts of a judging run, one per "## Point <id>:" heading of ./context/failure.md in order. The
  // last entry repeats, and null gives that point no entry. They follow the points of the implement result.
  pointVerdicts?: ({ verdict: "fixed" | "pushback"; why?: string | null; reason?: string; cite?: string } | null)[];
  writes?: { path: string; text?: string; junction?: string }[];
  // part-session.md section 2.3: after writes, an Edit of the plan file at path that ticks each task heading `### [ ] <id> `.
  ticks?: { path: string; ids: string[] };
  // The init of an implement run lists no Bash, as Claude Code on Windows without Git Bash (spec.md section 6.21, V12).
  noBash?: boolean;
  // spec.md section 6.21: the Bash calls of an implement run, after init. refused: what refuses the call, with the permission_denied
  // fields of integration-check.md SU3; check is a CLI safety check with no type, as the B22 redirect. files: what the command writes, by
  // path relative to the cwd, with no Write call, as a build does. output: the tool_result text of a call that runs. run: argv lists that
  // the call runs in the cwd with the env of the CLI, as `bash -c 'git ...'` runs past the git deny (Gate B34). Each record gets { ran }.
  // waitMs: the time between the tool_use and the tool_result, as a long command (part-session.md section 2.10).
  bash?: {
    command: string;
    refused?: "allowlist" | "deny" | "check";
    files?: { path: string; text?: string; link?: string }[];
    output?: string;
    run?: string[][];
    waitMs?: number;
  }[];
  // part-session.md section 2.10: start and send no stream line, and wait forever.
  silent?: boolean;
  // Tools that the init of a resume or an implement run lists beyond --tools (the init check).
  initExtra?: string[];
  // docs/plans/review-v2/spec.md section 2.9: the notes of the echo reply result, and the cites of its first reply. Absent: none.
  notes?: unknown;
  cites?: unknown;
  // Fields that replace the scenario fields for a run with that schema, for example a usage limit or a hang in the verify phase only.
  bySchema?: Partial<Record<SchemaKind, Partial<Omit<FakeScenario, "record" | "auth" | "bySchema">>>>;
  // docs/plans/review-v2/spec.md section 6.7, own review: the structured output of a review run. Absent: the fixture result.
  review?: unknown;
  // The structured output of the own review of a task part only: a review run whose stdin says "- Pull request: none yet.". Absent:
  // review. The demo keeps the fixture result for its PR reviews this way.
  taskReview?: unknown;
  // part-session.md section 2.7: the structured output of a critic run (call key critic). Absent: a result with no findings.
  critic?: unknown;
  // docs/plans/review-v2/review-quality-2026.md E3, E4 (scripts/eval/label.ts): the matcher result (properties.candidates) and the judge
  // result (properties.labels). Absent: the fixture result.
  matcher?: unknown;
  judge?: unknown;
  // Fields for the Nth run of one call key (callKey), after bySchema. The last entry repeats. The record file counts the earlier runs.
  seq?: Record<string, Partial<Omit<FakeScenario, "record" | "auth" | "bySchema" | "seq">>[]>;
  // Fields for a run whose ./context Markdown files hold the text when, after seq. The first entry that matches wins. Its seq counts only
  // the earlier runs of the same call key that matched it, so runs that start at the same time (spec.md section 6.20.6) get their own
  // entries.
  match?: { when: string; seq: Record<string, Partial<Omit<FakeScenario, "record" | "auth" | "bySchema" | "seq" | "match">>[]> }[];
  // seeded-truth.md WP-SG1: the record of a run gets { files }, the text of every file under the cwd at the start, by path under it.
  files?: boolean;
};

export type SchemaKind =
  | "verify"
  | "explain"
  | "discuss"
  | "interview"
  | "spec"
  | "planCheck"
  | "implement"
  | "review"
  | "matcher"
  | "judge";
// The review v2 run kind that a --json-schema shape names, else null. A re-review has its own key (earlier), so it is no review.
export const schemaKind = (props: Record<string, unknown>): SchemaKind | null =>
  props.verdicts !== undefined
    ? "verify"
    : props.walkthrough !== undefined
      ? "explain"
      : props.verdict !== undefined && props.answer !== undefined
        ? "discuss"
        : props.done !== undefined && props.questions !== undefined
          ? "interview"
          : props.map !== undefined && props.estimate !== undefined
            ? "spec"
            : props.done !== undefined && props.specChange !== undefined
              ? "implement"
              : props.findings !== undefined && props.earlier === undefined
                ? "review"
                : props.candidates !== undefined
                  ? "matcher"
                  : props.labels !== undefined
                    ? "judge"
                    : props.problems !== undefined
                      ? "planCheck"
                      : null;

// AC-B333: a critic run is a review run whose stdin holds the critic task line. This is a copy of CRITIC_TASK of
// src/server/review/prompt.ts, so a run does not load the prompt modules. tests/review/fake-claude.test.ts checks that both are equal.
export const CRITIC_LINE = "This is a quick first review. Report only problems in the lines that this change adds.";

// The key of a run for seq: the schema kind, "critic" for a critic run, and for an implement run "implement:<mode>" from the "- Mode:"
// line of its stdin.
export function callKey(argv: string[], stdin: string): string | null {
  const at = argv.indexOf("--json-schema");
  if (!argv.includes("-p") || at < 0) return null;
  const kind = schemaKind(JSON.parse(argv[at + 1] ?? "null")?.properties ?? {});
  if (kind === "review" && stdin.includes(CRITIC_LINE)) return "critic";
  if (kind !== "implement") return kind;
  return `implement:${/^- Mode: (\w+)$/m.exec(stdin)?.[1] ?? "?"}`;
}

// Each complete record ends with "\n". The last part can be a record that the fake still writes, so it is dropped.
export function readRecords<T = Record<string, unknown>>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .slice(0, -1)
    .map((l) => JSON.parse(l) as T);
}

const CHILD = "process.stdin.on('end', () => {}); process.stdin.resume(); setInterval(() => {}, 1000);";
const NO_COVERAGE = { read: [], skipped: [], unavailable: [], notChecked: [] };
const JUDGEMENTS = ["valid", "partly", "invalid", "question", null] as const;

// A reply result for each thread of the stdin "Threads:" line. Every third thread gets action none.
// The judgements cycle valid, partly, invalid, question, null. extra: the notes of the result and the cites of the first reply.
export function echoReplies(stdin: string, extra: { notes?: unknown; cites?: unknown } = {}) {
  const line = /^Threads: (.*)$/m.exec(stdin)?.[1] ?? "";
  const threads = [...line.matchAll(/(\d+) \(answer message (\d+)[^)]*\)/g)].map((m) => ({ thread: Number(m[1]), replyTo: Number(m[2]) }));
  return {
    summary: `Drafted replies for ${threads.length} threads.`,
    ...(extra.notes !== undefined && { notes: extra.notes }),
    replies: threads.map(({ thread, replyTo }, i) => ({
      ...(i === 0 && extra.cites !== undefined && { cites: extra.cites }),
      ...(i % 3 === 2
        ? { thread, action: "none", body: "", reason: "The thread needs no answer from you.", evidenceStatus: "unverified" }
        : {
            thread,
            action: "reply",
            body: `Thanks. I checked message ${replyTo} against \`flush()\` and will change it.`,
            reason: "The comment asks for a change.",
            evidenceStatus: "code",
          }),
      judgement: JUDGEMENTS[i % JUDGEMENTS.length],
      // Per round of JUDGEMENTS: valid and partly share one group, invalid and question get one each, null gets none.
      group: i % 5 === 4 ? null : 3 * Math.floor(i / 5) + ([1, 1, 2, 3][i % 5] as number),
    })),
    coverage: { read: ["src/cache/flush.ts"], skipped: [], unavailable: [], notChecked: [] },
  };
}

// A fix result with one note per thread of the stdin "Fix threads:" line and per ID of the "Fix findings:" line, no fix, and no edit.
// why null and an empty reply: the app makes no nofix draft (docs/plans/thread-outcome.md). A scenario fix result can set both.
export function echoFix(stdin: string) {
  const line = /^Fix threads: (.*)$/m.exec(stdin)?.[1] ?? "";
  const threads = [...line.matchAll(/(\d+)(?: \([^)]*\))?/g)].map((m) => Number(m[1]));
  const findings = [...(/^Fix findings: (.*)$/m.exec(stdin)?.[1] ?? "").matchAll(/\d+/g)].map((m) => Number(m[0]));
  const none = { fixed: false, reason: "Echo", why: null, reply: "" };
  return {
    summary: findings.length ? `Checked ${threads.length} threads and ${findings.length} findings.` : `Checked ${threads.length} threads.`,
    threads: [...threads.map((thread) => ({ thread, ...none })), ...findings.map((finding) => ({ finding, ...none }))],
    edits: [],
    coverage: NO_COVERAGE,
  };
}

const VERDICTS = ["open", "fixed", "outdated"] as const;

// A re-review result: the fixture result with no findings, and one verdict per ID of the stdin "Earlier findings:" line.
// The verdicts cycle open, fixed, outdated.
export function echoRereview(stdin: string, fixture: unknown) {
  const line = /^Earlier findings: (.*)$/m.exec(stdin)?.[1] ?? "";
  const ids = [...line.matchAll(/\d+/g)].map((m) => Number(m[0]));
  return {
    ...(fixture && typeof fixture === "object" ? fixture : {}),
    findings: [],
    earlier: ids.map((id, i) => {
      const status = VERDICTS[i % VERDICTS.length];
      return { id, status, reason: `The echo marks finding ${id} ${status}.`, path: null, line: null };
    }),
  };
}

// A prompt proposal: the fenced current prompt of the stdin with one added line, or a new prompt when the stdin has none.
export function echoImprove(stdin: string) {
  const fence = /^# Current prompt$[^#]*?^(`{3,})$\n([\s\S]*?)\n^\1$/m.exec(stdin);
  const current = fence?.[2] ?? "Find defects in the change.";
  return { prompt: `${current}\nEcho: report each finding with its trigger.`, reasons: ["Echo: added the trigger rule."] };
}

// The last line with text in the "# Your instructions" section of the stdin.
function lastInstruction(stdin: string) {
  const lines = stdin.split(/\r?\n/);
  const start = lines.indexOf("# Your instructions");
  const end = lines.findIndex((l, i) => i > start && l.startsWith("# "));
  const section = start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end);
  return section.filter((l) => l.trim()).at(-1) ?? "";
}

// An ask result. The question line is the last line with text in the "# Your instructions" section of the stdin.
export function echoAnswer(stdin: string) {
  return { answer: `Echo: ${lastInstruction(stdin)}`, coverage: NO_COVERAGE };
}

// A verify result: one confirmed verdict per "## Candidate N" heading of candidates (the text of ./context/candidates.md), with the
// severity of its "- Severity: <s>." line and the path:line of its "- Place: <path>:<line>" line.
export function echoVerify(candidates: string) {
  const blocks = candidates.split(/^## Candidate (?=\d+\s*$)/m).slice(1);
  return {
    verdicts: blocks.map((b) => {
      const candidate = Number(/^\d+/.exec(b)?.[0]);
      const place = /^- Place: (\S+?):(\d+)/m.exec(b);
      return {
        candidate,
        verdict: "confirmed",
        severity: /^- Severity: (blocker|major|minor|nit)\./m.exec(b)?.[1] ?? "minor",
        reason: `Echo: the code shows candidate ${candidate}.`,
        evidence: place ? `${place[1]}:${place[2]}` : "",
        duplicateOf: null,
        question: "",
      };
    }),
    coverage: NO_COVERAGE,
  };
}

// An explain result with no files, no risks, and no questions.
export const echoExplain = () => ({
  summary: "Echo: the change in one line.",
  walkthrough: "## Echo\n\nThe echo walkthrough.",
  order: [],
  files: [],
  risks: [],
  glossary: [],
  questions: [],
  coverage: NO_COVERAGE,
});

// A discuss result that keeps the finding. The message is the last line with text in the "# Your instructions" section.
export const echoDiscuss = (stdin: string) => ({
  answer: `Echo: ${lastInstruction(stdin)}`,
  verdict: "upheld",
  reason: "Echo: the code still shows the problem.",
  revision: null,
  reply: "",
  coverage: NO_COVERAGE,
});

// An interview result. The "- Round: N" line of the stdin picks it: round 1 asks a choice and a text question, a later round is done.
export function echoInterview(stdin: string) {
  const round = Number(/^- Round: (\d+)$/m.exec(stdin)?.[1] ?? 1);
  if (round > 1) return { done: true, summary: "Echo: the answers settle the plan.", questions: [], unknowns: [], coverage: NO_COVERAGE };
  return {
    done: true,
    summary: "Echo: the task asks for a small change.",
    questions: [
      {
        id: "q1",
        text: "Echo: keep the old behavior?",
        why: "Echo: it changes the tests.",
        kind: "choice",
        options: [
          { label: "Keep it", detail: "No change for callers." },
          { label: "Drop it", detail: "Simpler code." },
        ],
        recommended: 0,
      },
      { id: "q2", text: "Echo: anything else?", why: "Echo: the scope.", kind: "text", options: [], recommended: null },
    ],
    unknowns: [],
    coverage: NO_COVERAGE,
  };
}

// A small plan with one part, one task, and a map entry on README.md line 1, which the test remotes hold.
export const echoSpec = () => ({
  title: "Echo plan",
  size: "small",
  estimate: { parts: 1, lines: 20, files: 1, modules: ["docs"], db: false, api: false, unknowns: [] },
  map: [{ path: "README.md", line: 1, symbol: "", kind: "change", what: "Echo: the title line." }],
  change: "Echo: change the title line.",
  design: null,
  spec: null,
  parts: [
    {
      n: 1,
      kind: "part",
      title: "Echo part",
      goal: "Echo: the title says more.",
      lines: 20,
      acceptance: [{ id: "A1", text: "Echo: the title line names the app." }],
      tests: [{ test: "tests/readme.test.ts", proves: ["A1"] }],
      // task-builder-v2.md section 5.1: the proof names the planned test command.
      tasks: [
        {
          id: "T1",
          title: "Echo task",
          files: ["README.md"],
          run: ["tests/readme.test.ts"],
          done: "Echo: the test passes.",
          proof: { command: "test", test: "" },
          where: "local",
        },
      ],
    },
  ],
  testing: { commands: [{ name: "test", kind: "test", argv: ["bun", "test"] }], services: [], notes: "" },
  flag: null,
  questions: [],
  coverage: NO_COVERAGE,
});

// An implement result of a complete step with no question and no plan change.
export const echoImplement = () => ({
  summary: "Echo: the step is done.",
  done: true,
  tests: [],
  question: null,
  specChange: "",
  notes: [],
  coverage: NO_COVERAGE,
});

// A critic result with no findings.
export const echoCritic = () => ({
  summary: "Echo: no critic points.",
  risks: [],
  questions: [],
  findings: [],
  answered: [],
  coverage: NO_COVERAGE,
});

// A session answer (docs/plans/session-consult.md part C): one reject per item tag with status open in the stdin.
// fix: the schema asks for fixes too (part D). A reject needs no fix, so the fix has no note and no edit.
export function echoConsult(stdin: string, fix = false) {
  const answers: { id: string; verdict: string; reason: string }[] = [];
  for (const l of stdin.split(/\r?\n/)) {
    const id = /^<item-[0-9a-f]+ id="([TF]\d+)" status="open">$/.exec(l)?.[1];
    if (id) answers.push({ id, verdict: "reject", reason: `Echo: the session rejects ${id}.` });
  }
  return fix ? { answers, fix: { summary: "Echo: no fix.", threads: [], edits: [], coverage: NO_COVERAGE } } : { answers };
}

// The lines of stdin as they come.
async function* stdinLines() {
  const r = Bun.stdin.stream().getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (let c = await r.read(); !c.done; c = await r.read()) {
    buf += dec.decode(c.value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

// The text of one stream-json user message (scripts/gate/session.ts userLine).
function messageText(line: string) {
  const c = (JSON.parse(line) as { message?: { content?: unknown } }).message?.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

const LIVE_WAIT_MS = 30_000;

async function main() {
  const [scenarioPath = "", ...args] = process.argv.slice(2);
  const base: FakeScenario = JSON.parse(readFileSync(scenarioPath, "utf8"));
  // The --json-schema shape picks the result. A review run keeps the fixture result.
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const props = JSON.parse(flag("--json-schema") ?? "null")?.properties ?? {};
  const kind = schemaKind(props);
  const run = args.includes("-p");
  // part-session.md section 2.9: with stream-json input, the first message is the prompt, and later messages come during the run.
  const live = run && flag("--input-format") === "stream-json";
  const input = live ? stdinLines() : null;
  const first = input ? await input.next() : null;
  const stdin = first ? (first.done ? "" : messageText(first.value)) : run ? await Bun.stdin.text() : "";
  const key = callKey(args, stdin);
  const list = key ? base.seq?.[key] : undefined;
  type Rec = { argv?: string[]; stdin?: string; context?: Record<string, string> };
  const same = (r: Rec) => Array.isArray(r.argv) && callKey(r.argv, r.stdin ?? "") === key;
  const earlier = list ? readRecords<Rec>(base.record).filter(same).length : 0;
  // The Markdown files of ./context at the start, by path under it, and the names in ./context/attachments/. A run folder goes away
  // after its run.
  const context: Record<string, string> = {};
  const ctx = join(process.cwd(), "context");
  if (run && existsSync(ctx))
    for (const f of readdirSync(ctx, { recursive: true, encoding: "utf8" }))
      if (f.endsWith(".md") && statSync(join(ctx, f)).isFile()) context[f.replaceAll("\\", "/")] = readFileSync(join(ctx, f), "utf8");
  const holds = (c: Record<string, string> | undefined, text: string) => Object.values(c ?? {}).some((t) => t.includes(text));
  const hit = key ? base.match?.find((m) => holds(context, m.when)) : undefined;
  const mine = hit && key ? hit.seq[key] : undefined;
  const before = mine ? readRecords<Rec>(base.record).filter((r) => same(r) && holds(r.context, hit?.when ?? "")).length : 0;
  const s: FakeScenario = {
    ...base,
    ...(kind ? base.bySchema?.[kind] : undefined),
    ...(list?.length ? list[Math.min(earlier, list.length - 1)] : undefined),
    ...(mine?.length ? mine[Math.min(before, mine.length - 1)] : undefined),
  };
  const record = (x: Record<string, unknown>) => appendFileSync(s.record, `${JSON.stringify(x)}\n`);
  const att = join(ctx, "attachments");
  const attachments = run && existsSync(att) ? readdirSync(att).sort() : [];
  // The files of ./skills, and the servers of --mcp-config. The run folder and the MCP file go away after the run.
  const sk = join(process.cwd(), "skills");
  const skills =
    run && existsSync(sk)
      ? readdirSync(sk, { recursive: true, encoding: "utf8" })
          .map((f) => f.replaceAll("\\", "/"))
          .sort()
      : [];
  const mcpFile = run ? flag("--mcp-config") : undefined;
  const mcp = mcpFile ? (JSON.parse(readFileSync(mcpFile, "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers : null;
  const agentsFile = run ? flag("--agents") : undefined;
  const agents = agentsFile ? (JSON.parse(readFileSync(agentsFile, "utf8")) as Record<string, { prompt: string }>) : null;
  const workspace: Record<string, string> = {};
  if (run && s.files)
    for (const f of readdirSync(process.cwd(), { recursive: true, encoding: "utf8" }))
      if (lstatSync(join(process.cwd(), f)).isFile()) workspace[f.replaceAll("\\", "/")] = readFileSync(join(process.cwd(), f), "utf8");
  record({
    argv: args,
    env: process.env,
    cwd: process.cwd(),
    stdin,
    pid: process.pid,
    context,
    attachments,
    skills,
    mcp,
    agents,
    ...(s.files && { files: workspace }),
  });

  if (args[0] === "--version") {
    console.log(s.version ?? "2.1.302 (Claude Code)");
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    console.log(JSON.stringify(s.auth, null, 2));
    process.exitCode = s.authExit ?? 0;
    return;
  }
  // An open stdin read of live input keeps the process alive.
  const fail = (code: number, text: string) => {
    console.error(text);
    if (live) process.exit(code);
    process.exitCode = code;
  };
  if (!run || !s.fixture) return fail(2, `fake-claude: no answer for ${args.join(" ")}`);
  // docs/plans/session-consult.md section 1: a resume without --fork-session attaches to a running session or exits with code 1.
  const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
  if (resume !== undefined && (!args.includes("--fork-session") || !existsSync(resume)))
    return fail(1, args.includes("--fork-session") ? `No conversation found at ${resume}` : "fake-claude: --resume needs --fork-session");

  // Gate B4: 2.1.295 writes these per-cwd folders also with --no-session-persistence.
  const name = process.cwd().replace(/[^a-zA-Z0-9]/g, "-");
  const session = "00000000-0000-4000-8000-000000000001";
  const files = [join(tmpdir(), "claude", name, session, "tasks", "agent.output")];
  if (typeof s.auth.projectsDirectory === "string")
    files.push(join(s.auth.projectsDirectory, name, session, "subagents", "agent-a.meta.json"));
  for (const f of files) {
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, "{}");
  }

  // Integration-check.md line 190 and U59: without --no-session-persistence the run writes <projects>/<encoded cwd>/<session id>.jsonl.
  // A fork gets a new ID and starts with the lines of the resumed file, which stays unchanged (U47). Its init names the new ID.
  const persist = !args.includes("--no-session-persistence") && typeof s.auth.projectsDirectory === "string";
  const sid = persist && resume !== undefined ? crypto.randomUUID() : session;
  const transcript = persist ? join(s.auth.projectsDirectory as string, name, `${sid}.jsonl`) : null;
  const keepLine = (l: string) => {
    if (transcript) appendFileSync(transcript, `${l}\n`);
  };
  if (transcript) {
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, resume !== undefined ? readFileSync(resume, "utf8") : "");
    keepLine(JSON.stringify({ type: "user", message: { role: "user", content: stdin } }));
  }

  // Each later stream-json message gets a record { input } and one more result event.
  const inbox: string[] = [];
  let eof = !input;
  if (input)
    void (async () => {
      for await (const l of input) {
        if (!l.trim()) continue;
        const text = messageText(l);
        record({ input: text });
        keepLine(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
        inbox.push(text);
      }
      eof = true;
    })();

  if (s.silent) {
    setInterval(() => {}, 1000);
    return;
  }
  if (s.hang) {
    const child = Bun.spawn([process.execPath, "-e", CHILD], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    child.stdin.end();
    record({ childPid: child.pid });
  }
  if (s.orphan) {
    const orphan = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000);"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
    orphan.unref();
    record({ orphanPid: orphan.pid });
  }

  // The real CLI streams a Write call and its result for each file that it writes. A junction has no Write call. A number is a pause.
  const writeEvents: (string | number)[] = [];
  for (const w of s.writes ?? []) {
    const p = resolve(process.cwd(), w.path);
    const r = relative(process.cwd(), p);
    if (!r || r.startsWith("..") || isAbsolute(r)) {
      record({ refused: w.path });
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    if (w.junction !== undefined) symlinkSync(w.junction, p, "junction");
    else {
      writeFileSync(p, w.text ?? "");
      const id = `toolu_fake_write_${writeEvents.length / 2}`;
      writeEvents.push(
        JSON.stringify({
          type: "assistant",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_use", id, name: "Write", input: { file_path: p, content: w.text ?? "" } }] },
        }),
        JSON.stringify({
          type: "user",
          parent_tool_use_id: null,
          message: { content: [{ type: "tool_result", tool_use_id: id, content: `File created at: ${p}` }] },
        }),
      );
    }
  }

  if (s.ticks) {
    // path "*": the tasks file that the prompt names ("Tick tasks only in <file>."), as Claude reads it, else the first plan.md or
    // tasks.md under repo/specs/<folder>/. ids ["*"]: every open task heading.
    const named = /Tick tasks only in (\.\/repo\/\S+?\.md)/.exec(stdin)?.[1];
    const plans = () => {
      if (named) return resolve(process.cwd(), named);
      const root = join(process.cwd(), "repo", "specs");
      const dirs = existsSync(root) ? readdirSync(root) : [];
      return dirs.flatMap((d) => ["tasks.md", "plan.md"].map((n) => join(root, d, n))).find((f) => existsSync(f)) ?? join(root, "none.md");
    };
    const p = s.ticks.path === "*" ? plans() : resolve(process.cwd(), s.ticks.path);
    let text = readFileSync(p, "utf8");
    if (s.ticks.ids.includes("*")) text = text.replace(/^### \[ \] /gm, "### [x] ");
    for (const id of s.ticks.ids) text = text.replace(`### [ ] ${id} `, `### [x] ${id} `);
    writeFileSync(p, text);
    const id = "toolu_fake_tick";
    writeEvents.push(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          content: [{ type: "tool_use", id, name: "Edit", input: { file_path: p, old_string: "### [ ]", new_string: "### [x]" } }],
        },
      }),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: id, content: `The file ${p} has been updated.` }] },
      }),
    );
  }

  // The Bash calls: the tool_use, then for a refused call the permission_denied event before the error tool_result (Gate B17 order).
  for (const [k, b] of (s.bash ?? []).entries()) {
    const id = `toolu_fake_bash_${k}`;
    if (!b.refused)
      for (const f of b.files ?? []) {
        const p = resolve(process.cwd(), f.path);
        mkdirSync(dirname(p), { recursive: true });
        if (f.link !== undefined) symlinkSync(f.link, p, "junction");
        else writeFileSync(p, f.text ?? "");
      }
    if (!b.refused)
      for (const argv of b.run ?? []) {
        const r = Bun.spawnSync(argv, { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe" });
        record({ ran: argv, exit: r.exitCode, stderr: r.stderr.toString().slice(-500) });
      }
    const text = b.refused
      ? b.refused === "deny"
        ? `Permission to use Bash with command ${b.command} has been denied.`
        : b.refused === "check"
          ? "Output redirection to '../outside.txt' needs approval. The path is outside the working directories for this session."
          : "This command requires approval"
      : (b.output ?? "");
    writeEvents.push(
      JSON.stringify({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: b.command } }] },
      }),
      ...(b.waitMs ? [b.waitMs] : []),
      ...(b.refused
        ? [
            JSON.stringify({
              type: "system",
              subtype: "permission_denied",
              tool_name: "Bash",
              tool_use_id: id,
              ...(b.refused !== "check" && { decision_reason_type: b.refused === "deny" ? "rule" : "other" }),
              message: text,
            }),
          ]
        : []),
      JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: id, content: text, ...(b.refused && { is_error: true }) }] },
      }),
    );
  }

  const agentTool = (flag("--tools") ?? "").split(",").includes("Agent");
  // code.claude.com/docs/en/cli-reference: --tools "" disables every built-in tool. No MCP server stays, so init keeps StructuredOutput only.
  const noTools = flag("--tools") === "";
  const result = (fixture: unknown) => {
    if (kind === "verify") {
      const file = join(process.cwd(), "context", "candidates.md");
      return s.verify ?? echoVerify(existsSync(file) ? readFileSync(file, "utf8") : "");
    }
    if (kind === "explain") return s.explain ?? echoExplain();
    if (kind === "discuss") return s.discuss ?? echoDiscuss(stdin);
    if (kind === "interview") return s.interview ?? echoInterview(stdin);
    if (kind === "spec") return s.spec ?? echoSpec();
    if (kind === "planCheck") return s.planCheck ?? { summary: "Echo: the plan fits the code.", problems: [], coverage: NO_COVERAGE };
    if (kind === "implement") {
      const r = (s.implement ?? echoImplement()) as { points?: unknown[] };
      const judge = s.pointVerdicts ?? [];
      if (!judge.length) return r;
      const ids = [...(context["failure.md"] ?? "").matchAll(/^## Point (\d+):/gm)].map((m) => Number(m[1]));
      const entries = ids.flatMap((id, i) => {
        const j = judge[Math.min(i, judge.length - 1)];
        return j ? [{ id, why: null, reason: "Echo reason.", cite: "", ...j }] : [];
      });
      return { ...r, points: [...(r.points ?? []), ...entries] };
    }
    if (key === "critic") return s.critic ?? echoCritic();
    if (kind === "review") return s.taskReview !== undefined && stdin.includes("- Pull request: none yet.") ? s.taskReview : s.review;
    if (kind === "matcher") return s.matcher;
    if (kind === "judge") return s.judge;
    if (props.replies !== undefined) return s.replies ?? echoReplies(stdin, { notes: s.notes, cites: s.cites });
    if (props.earlier !== undefined) return s.rereview ?? echoRereview(stdin, fixture);
    if (props.answer !== undefined) return s.answer ?? echoAnswer(stdin);
    if (props.edits !== undefined) return s.fix ?? echoFix(stdin);
    if (props.reasons !== undefined) return s.improve ?? echoImprove(stdin);
    if (props.answers !== undefined) return s.consult ?? echoConsult(stdin, props.fix !== undefined);
    return undefined;
  };
  const rewrite = (l: string) => {
    const e = JSON.parse(l);
    // A resume or an implement run with --tools and --strict-mcp-config: init lists those tools and StructuredOutput. Gates B16 and B17
    // check the real CLI. An implement run with --mcp-config lists each server of that file as connected.
    if (e.type === "system" && e.subtype === "init" && (resume !== undefined || kind === "implement")) {
      const servers = kind === "implement" && mcp ? Object.keys(mcp) : [];
      return JSON.stringify({
        ...e,
        // Gate B8: init names the agent tool Task.
        tools: [
          ...(flag("--tools") ?? "")
            .split(",")
            .filter((t) => t && !(s.noBash && t === "Bash"))
            .map((t) => (t === "Agent" ? "Task" : t)),
          "StructuredOutput",
          ...(s.initExtra ?? []),
        ],
        mcp_servers: servers.map((name) => ({ name, status: "connected" })),
        ...(persist && { session_id: sid }),
      });
    }
    // Gate B8: init lists the agent tool as Task. The real CLI lists it only when --tools names Agent.
    if (e.type === "system" && e.subtype === "init" && Array.isArray(e.tools) && noTools)
      return JSON.stringify({ ...e, tools: e.tools.filter((t: unknown) => t === "StructuredOutput"), mcp_servers: [] });
    if (e.type === "system" && e.subtype === "init" && Array.isArray(e.tools) && !agentTool)
      return JSON.stringify({ ...e, tools: e.tools.filter((t: unknown) => t !== "Task") });
    const found = e.type === "result" ? result(e.structured_output) : undefined;
    const r =
      e.type === "result" && s.answered !== undefined && props.answered !== undefined
        ? { ...(found ?? e.structured_output), answered: s.answered }
        : found;
    return r === undefined ? l : JSON.stringify({ ...e, structured_output: r });
  };

  // The fixture paths name the Windows cwd of init. Replace it and its separator with the real cwd and separator.
  const lines = readFileSync(s.fixture, "utf8").split("\n").filter(Boolean).map(rewrite);
  const init = lines.map((l) => JSON.parse(l)).find((e) => e.type === "system" && e.subtype === "init");
  const esc = (p: string) => JSON.stringify(p).slice(1, -1);
  const initAt = lines.findIndex((l) => {
    const e = JSON.parse(l);
    return e.type === "system" && e.subtype === "init";
  });
  const out = async (l: string) => {
    keepLine(l);
    await Bun.write(Bun.stdout, `${l}\n`);
  };
  const emit = async () => {
    for (const w of writeEvents) await (typeof w === "number" ? Bun.sleep(w) : out(w));
  };
  const placed = (l: string) =>
    typeof init?.cwd === "string"
      ? l.replaceAll(esc(`${init.cwd}\\`), esc(process.cwd() + sep)).replaceAll(esc(init.cwd), esc(process.cwd()))
      : l;
  if (initAt < 0) await emit();
  for (const [k, l] of lines.entries()) {
    if (s.hang && JSON.parse(l).type === "result") break;
    await out(placed(l));
    if (k === initAt) await emit();
    await Bun.sleep(s.delayMs ?? 2);
  }
  if (s.stderr) await Bun.write(Bun.stderr, s.stderr);
  if (s.hang) {
    setInterval(() => {}, 1000);
    return;
  }
  // Live input: one more result for each later message, until stdin closes. A stream with no result ended before a result, as a crash.
  const last = lines.findLast((l) => JSON.parse(l).type === "result");
  const until = Date.now() + LIVE_WAIT_MS;
  while (last !== undefined && (!eof || inbox.length) && Date.now() < until) {
    const text = inbox.shift();
    if (text !== undefined && last) await out(placed(last));
    else await Bun.sleep(10);
  }
  // An open stdin read keeps the process alive.
  if (live) process.exit(s.exitCode ?? 0);
  process.exitCode = s.exitCode ?? 0;
}

if (import.meta.main) await main();
