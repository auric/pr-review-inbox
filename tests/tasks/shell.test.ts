// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPatterns,
  hostsOf,
  rulePath,
  type ShellSpec,
  shellEnv,
  shellSettings,
  writeShellSettings,
} from "../../src/server/tasks/shell";
import { allowPattern, allowProblem, allowWarning, programOf, type TaskCommand } from "../../src/shared/task";

console.log(`shell.test.ts imported from ${Bun.resolveSync("../../src/server/tasks/shell", import.meta.dir)}`);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const WIN_DATA = "C:\\Users\\someone\\AppData\\Local\\review-loop";
const ORIGINS = ["https://bitbucket.example.test:7990/stash", "https://JIRA.example.test"];
const spec = (s: Partial<ShellSpec> = {}): ShellSpec => ({
  mode: "allowlist",
  rules: ["ssh build1 *", "tar -C repo -czf - ."],
  bashTimeoutSec: 600,
  dataDir: WIN_DATA,
  origins: ORIGINS,
  ...s,
});

const NETWORK = ["curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "tftp", "sftp", "scp", "ssh", "rsync"];
const denyFor = (data: string, network: string[], xargs = false) => [
  "Bash(git *)",
  "Bash(*/git *)",
  "Bash(git.exe *)",
  "Bash(*/git.exe *)",
  "Bash(*\\git.exe *)",
  "Bash(*bitbucket.example.test*)",
  "Bash(*jira.example.test*)",
  ...network.map((n) => `Bash(${n} *)`),
  ...(xargs ? ["Bash(xargs *)"] : []),
  "Bash(secret-tool *)",
  "Bash(security *)",
  "Bash(cmdkey *)",
  "Bash(kwallet-query *)",
  "Bash(keyring *)",
  "Bash(powershell*)",
  "Bash(pwsh*)",
  `Read(${data}/config.json*)`,
  `Read(${data}/*.sqlite*)`,
  `Read(${data}/runs/**)`,
  "Read(~/.ssh/**)",
  "Read(~/.git-credentials)",
  "Read(~/.netrc)",
  "Read(~/_netrc)",
  "Read(~/.claude/.credentials.json)",
];

describe("shell.json", () => {
  test("allowlist: one Bash rule per pattern, the fixed deny list, and an entry for ssh keeps ssh off the deny list", () => {
    const data = "//c/Users/someone/AppData/Local/review-loop";
    expect(shellSettings(spec(), "win32")).toEqual({
      permissions: {
        allow: ["Bash(ssh build1 *)", "Bash(tar -C repo -czf - .)"],
        deny: denyFor(
          data,
          NETWORK.filter((n) => n !== "ssh"),
          true,
        ),
        blockReadsOutsideWorkingDirectories: true,
        disableBypassPermissionsMode: "disable",
      },
    });
  });

  test("Any command: Bash allows every command, and the full deny list stays", () => {
    const s = shellSettings(spec({ mode: "any", rules: [] }), "win32");
    expect(s.permissions.allow).toEqual(["Bash"]);
    expect(s.permissions.deny).toEqual(denyFor("//c/Users/someone/AppData/Local/review-loop", NETWORK));
  });

  test("a network program stays denied unless an entry has it as its program", () => {
    const deny = (rules: string[]) => shellSettings(spec({ rules }), "win32").permissions.deny;
    expect(deny(["make test *"])).toContain("Bash(ssh *)");
    // An entry that only names ssh in its arguments keeps the deny rule.
    expect(deny(["echo ssh *"])).toContain("Bash(ssh *)");
    expect(deny(["/usr/bin/SSH.exe build1 *"])).not.toContain("Bash(ssh *)");
    const two = deny(["scp -r repo build1:*", "rsync -a repo build1:*"]);
    expect(two).not.toContain("Bash(scp *)");
    expect(two).not.toContain("Bash(rsync *)");
    expect(two).toContain("Bash(ssh *)");
  });

  test("allowlist mode denies xargs unless an entry has it as its program; Any command does not", () => {
    const deny = (rules: string[], mode: ShellSpec["mode"] = "allowlist") => shellSettings(spec({ mode, rules }), "win32").permissions.deny;
    expect(deny(["make test *"])).toContain("Bash(xargs *)");
    expect(deny(["echo xargs *"])).toContain("Bash(xargs *)");
    expect(deny(["/usr/bin/XARGS.exe -n1 *"])).not.toContain("Bash(xargs *)");
    expect(deny([], "any")).not.toContain("Bash(xargs *)");
  });

  test("Read deny rules name the data folder in the //c/... form on Windows and the //... form on POSIX", () => {
    expect(rulePath(WIN_DATA, "win32")).toBe("//c/Users/someone/AppData/Local/review-loop");
    expect(rulePath("D:/data/rl/", "win32")).toBe("//d/data/rl");
    expect(rulePath("/home/someone/.local/share/review-loop", "linux")).toBe("//home/someone/.local/share/review-loop");
    expect(() => rulePath("\\\\server\\share\\rl", "win32")).toThrow("not an absolute path");
    expect(() => rulePath("data/rl", "linux")).toThrow("not an absolute path");
    expect(() => rulePath("C:\\Users\\a (b)\\rl", "win32")).toThrow("cannot hold");
    expect(() => rulePath("/home/a[1]/rl", "linux")).toThrow("cannot hold");
  });

  test("the data folder goes into the rules in its long form", () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-shell-"));
    dirs.push(dir);
    const long = realpathSync.native(dir);
    const read = shellSettings(spec({ dataDir: dir })).permissions.deny.filter((r) => r.startsWith("Read(//"));
    expect(read[0]).toBe(`Read(${rulePath(long)}/config.json*)`);
    if (dir.includes("~")) expect(read[0]).not.toContain("~");
  });

  test("bad input is refused before a file is written", () => {
    for (const bashTimeoutSec of [0, 3601, 1.5]) expect(() => shellSettings(spec({ bashTimeoutSec }), "win32")).toThrow("time limit");
    expect(() => shellSettings(spec({ rules: [] }), "win32")).toThrow("at least one pattern");
    for (const r of ["make test)", "a\nb", " "])
      expect(() => shellSettings(spec({ rules: [r] }), "win32")).toThrow("Invalid allowlist pattern");
    expect(() => shellSettings(spec({ origins: ["not a url"] }), "win32")).toThrow();
  });

  test("writeShellSettings writes shell.json into the app folder", () => {
    const base = mkdtempSync(join(tmpdir(), "rl-shell-"));
    dirs.push(base);
    const app = join(base, "runs", "1", "app");
    const file = writeShellSettings(app, spec({ dataDir: base }));
    expect(file).toBe(join(app, "shell.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(shellSettings(spec({ dataDir: base })));
  });

  test("hostsOf: the host names of the origins, lower case, once each", () => {
    expect(hostsOf([...ORIGINS, "https://bitbucket.example.test"])).toEqual(["bitbucket.example.test", "jira.example.test"]);
  });
});

describe("approved checks as allow rules", () => {
  const cmd = (kind: TaskCommand["kind"], argv: string[]): TaskCommand => ({ id: argv.join("-"), name: "x", kind, argv, timeoutSec: 60 });
  test("each build, test, or lint argv of plain words becomes one pattern; setup and other argv lists do not", () => {
    expect(
      checkPatterns([
        cmd("setup", ["bun", "install"]),
        cmd("test", ["bun", "test"]),
        cmd("lint", ["npx", "biome", "check", "--max-diagnostics=50", "src/a_b.ts", "@scope/x", "50%", "a+b,c"]),
        cmd("build", ["make", "a b"]),
        cmd("build", ["make", "x;y"]),
        cmd("build", ["make", "$(id)"]),
        cmd("test", ["bun", "test"]),
      ]),
    ).toEqual(["bun test *", "npx biome check --max-diagnostics=50 src/a_b.ts @scope/x 50% a+b,c *"]);
  });
});

describe("child env of a shell step", () => {
  test("real HOME and the ssh agent stay; GIT_*, askpass, and the set names go; the fixed values and the time limits are set", () => {
    const env = shellEnv(
      {
        HOME: "/home/someone",
        USERPROFILE: "C:\\Users\\someone",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        PATH: "/usr/bin",
        GIT_DIR: "/elsewhere",
        git_askpass: "/bin/askpass",
        SSH_ASKPASS: "/bin/askpass",
        gcm_interactive: "always",
        BASH_MAX_TIMEOUT_MS: "1",
      },
      600,
    );
    expect(env).toEqual({
      HOME: "/home/someone",
      USERPROFILE: "C:\\Users\\someone",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
      BASH_DEFAULT_TIMEOUT_MS: "600000",
      BASH_MAX_TIMEOUT_MS: "600000",
    });
  });
});

describe("allowPattern", () => {
  const hosts = ["bitbucket.example.test", "jira.example.test"];
  const check = (p: string) => {
    const r = allowPattern(hosts).safeParse(p);
    return r.success ? r.data : r.error.issues.map((i) => i.message).join(" | ");
  };

  test("narrow patterns pass, trimmed", () => {
    for (const p of ["ssh build1 *", "scp -r repo build1:*", "tar -C repo -czf - .", "./gradlew build *", "cargo test *", "ls"])
      expect(check(` ${p} `)).toBe(p);
  });

  test("each refusal has its message", () => {
    const cases: [string, string][] = [
      ["", "Enter a pattern."],
      ["a".repeat(201), "A pattern can have at most 200 characters."],
      ["make\ntest", "Write the pattern on one line."],
      ["make test && curl x", "A pattern cannot contain ( ) ` ; & | < or >. Add one pattern for each command."],
      ["echo $(id)", "A pattern cannot contain ( ) ` ; & | < or >. Add one pattern for each command."],
      ["echo `id`", "A pattern cannot contain ( ) ` ; & | < or >. Add one pattern for each command."],
      ["make; id", "A pattern cannot contain ( ) ` ; & | < or >. Add one pattern for each command."],
      ["cat x | sh", "A pattern cannot contain ( ) ` ; & | < or >. Add one pattern for each command."],
      ["make > out", "A pattern cannot contain ( ) ` ; & | < or >. Add one pattern for each command."],
      ["*", "Start the pattern with a program name. The first word cannot contain *."],
      ["ma* test", "Start the pattern with a program name. The first word cannot contain *."],
      ["git status", "Claude cannot run git commands."],
      ["/usr/bin/git status", "Claude cannot run git commands."],
      ["C:\\Git\\bin\\GIT.exe log", "Claude cannot run git commands."],
      ["secret-tool lookup x", "This program reads stored passwords and keys. Claude cannot run it."],
      ["security find-generic-password", "This program reads stored passwords and keys. Claude cannot run it."],
      ["ssh bitbucket.example.test *", "A pattern cannot name the Bitbucket or Jira host."],
      ["wget https://JIRA.example.test/x", "A pattern cannot name the Bitbucket or Jira host."],
    ];
    for (const [p, message] of cases) expect([p, check(p)]).toEqual([p, message]);
  });

  test("a shell or a command runner asks for Any command", () => {
    const shells = ["bash", "sh", "zsh", "dash", "fish", "cmd", "powershell", "pwsh", "wsl", "env", "eval", "exec", "xargs"];
    for (const s of [...shells, "sudo", "su", "doas", "runas", "watch", "setsid", "flock", "cmd.exe", "pwsh-preview", "/bin/bash"])
      expect([s, check(`${s} x *`)]).toEqual([s, "A shell or a command runner can run any command. Use Any command instead."]);
  });

  test("an interpreter pattern passes with a warning; other patterns have none", () => {
    for (const p of ["python x.py", "python3 -m pytest *", "node a.js", "bun test *", "deno run *", "perl x", "ruby x", "npx x", "uvx x"])
      expect([p, allowProblem(p, hosts), allowWarning(p)]).toEqual([p, null, "This pattern lets Claude run any code."]);
    expect(allowWarning("make test *")).toBe("This pattern lets Claude run any code.");
    expect(allowWarning("ssh build1 *")).toBeNull();
  });

  test("programOf: the first word without folder, .exe, or case", () => {
    expect(programOf("  /usr/bin/SSH.exe build1 *")).toBe("ssh");
    expect(programOf("C:\\tools\\Make.EXE all")).toBe("make");
    expect(programOf("")).toBe("");
  });
});
