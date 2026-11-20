// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// docs/plans/task-builder-v2.md section 6.3 (TB-3, AC-TB10): a check that cannot run on this computer stops the part once per pass with
// the reason red/check_env and starts no fix run. A fix run that names an env cause with a quote that the check output holds stops the
// tries. A quote that the output does not hold gives a Log note, and the tries go on. The fake CLI writes the files, and a bun script
// stands in for the approved test command.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { QUOTE_LOST } from "../../src/server/tasks/loop";
import { taskDto } from "../../src/server/tasks/tasks";
import { rowStatus } from "../../src/shared/task-status";
import { echoImplement } from "../support/fake-claude";
import { cleanupAll, SLOW, type Step, setup } from "./loop-fixture";

for (const m of ["loop", "checks", "tasks"])
  console.log(`check-env.test.ts imported from ${Bun.resolveSync(`../../src/server/tasks/${m}`, import.meta.dir)}`);

afterEach(cleanupAll);

type S = Awaited<ReturnType<typeof setup>>;
const gates = (s: S) => s.steps().filter((x) => x.kind === "check" && x.item === "checks");
const fixes = (s: S) => s.steps().filter((x) => x.kind === "fix");
const command = (s: S, o: { argv?: string[]; timeoutSec?: number }) =>
  s.db.query("UPDATE repo_task_settings SET commands_json = $c").run({
    c: JSON.stringify([
      { id: "t", name: "test", kind: "test", argv: o.argv ?? [process.execPath, join(s.root, "check.ts")], timeoutSec: o.timeoutSec ?? 60 },
    ]),
  });
const resume = async (s: S) => {
  expect(s.loop.resume(s.db, s.task, { version: s.t().version }).status).toBe(200);
  await s.loop.idle(s.task);
};

describe("env or code failure of the checks (task-builder-v2.md section 6.3)", () => {
  test(
    "AC-TB10: a check that is not found waits with check_env and no fix run; Continue runs the checks again; a fixed command goes on to the fix run",
    async () => {
      const s = await setup({ argv: ["rl-no-such-program-tb3"] });
      await s.build();
      expect(fixes(s)).toEqual([]);
      const reason = {
        kind: "red",
        cause: "check_env",
        text: 'Needs you: the check "test" of part 1 cannot run on this computer: Not found: rl-no-such-program-tb3. Change it in Settings, Commands, then run the checks again.',
      } as const;
      expect(s.blocked()).toEqual({ ...reason, step: (gates(s)[0] as Step).id });
      expect(rowStatus(taskDto(s.db, s.t()))).toEqual({ text: "Needs you: a check cannot run on this computer", needsYou: true });
      // "Run the checks again" runs the checks, and the part waits again with no fix run.
      await resume(s);
      expect([gates(s).length, fixes(s).length]).toEqual([2, 0]);
      expect(s.blocked()).toEqual({ ...reason, step: (gates(s)[1] as Step).id });
      // With a command that runs here, the red check is a code failure, so the fix run starts and the part goes on.
      command(s, {});
      await resume(s);
      expect(fixes(s).length).toBe(1);
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );

  test(
    "a check that reaches its time limit on the part base too waits with check_env and no fix run",
    async () => {
      const s = await setup({ mode: "sleep" });
      command(s, { timeoutSec: 1 });
      await s.build();
      const base = s.steps().find((x) => x.kind === "check" && x.item === "base") as Step;
      expect(JSON.parse(base.detail_json).commands[0]).toMatchObject({ id: "t", timedOut: true });
      expect(fixes(s)).toEqual([]);
      expect(s.blocked()).toEqual({
        kind: "red",
        cause: "check_env",
        step: (gates(s)[0] as Step).id,
        text: 'Needs you: the check "test" of part 1 reached the time limit here and on the part base. Raise the limit in Settings, Commands, then run the checks again.',
      });
    },
    SLOW,
  );

  test(
    "AC-TB10: a fix run with checkCause env and a quote that the output holds stops the tries after one run",
    async () => {
      const quote = "FAIL: src/feature.ts does not work yet";
      const s = await setup({ seq: { "implement:fix": [{ implement: { ...echoImplement(), checkCause: { cause: "env", quote } } }] } });
      await s.build();
      const runs = fixes(s);
      expect(runs.length).toBe(1);
      expect(s.blocked()).toEqual({
        kind: "red",
        cause: "check_env",
        step: (runs[0] as Step).id,
        text: `Needs you: Claude says that the checks of part 1 fail outside the code: "${quote}". Fix the computer or the command, then run the checks again.`,
      });
      expect(JSON.parse((runs[0] as Step).detail_json).notes).not.toContain(QUOTE_LOST);
    },
    SLOW,
  );

  test(
    "a fix run with checkCause env and a quote that the output does not hold gets a note, and the tries go on",
    async () => {
      const s = await setup({
        seq: {
          "implement:fix": [
            {
              writes: [{ path: "repo/src/feature.ts", text: "export const feature = 'try';\n" }],
              implement: { ...echoImplement(), checkCause: { cause: "env", quote: "Connection refused" } },
            },
            { writes: [{ path: "repo/src/feature.ts", text: "export const feature = 'works';\n" }] },
          ],
        },
      });
      await s.build();
      const runs = fixes(s);
      expect(runs.length).toBe(2);
      expect(JSON.parse((runs[0] as Step).detail_json).notes).toContain(QUOTE_LOST);
      expect(s.blocked()).toBeNull();
      expect(s.part().state).toBe("self_reviewed");
    },
    SLOW,
  );
});
