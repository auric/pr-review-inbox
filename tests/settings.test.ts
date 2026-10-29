// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { dbPath, PROFILES_VERSION, readConfig } from "../src/server/config";
import { createLive } from "../src/server/live";
import { log } from "../src/server/log";
import { EXPLAIN_V2, type Profile, profileRevision, RETIRED_PROFILES, SHIPPED_PROFILES } from "../src/server/review/catalog";
import { createSecrets, type SecretBackend } from "../src/server/secrets";
import { createSettings, type Settings } from "../src/server/settings";
import { profileInput, type SettingsDto } from "../src/shared/dto";
import { FAKE_TOKEN, type FakeBitbucket, fixture, key, startFakeBitbucket, TEST_CA_FILE } from "./support/fake-bitbucket";
import { type FakeJira, JIRA_EMAIL, JIRA_TOKEN, startFakeJira } from "./support/fake-jira";
import { DASHBOARD_PATH } from "./support/scenarios";

const DEFAULT_RULES = (["branch", "title", "description"] as const).map((source) => ({
  source,
  pattern: String.raw`[A-Z][A-Z0-9]+-\d+`,
  timedOut: false,
}));

process.env.REVIEW_LOOP_SECRETS = "memory";
const root = mkdtempSync(join(tmpdir(), "rl-settings-"));
process.env.REVIEW_LOOP_DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PORT = 7317;
const SESSION = "s".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let fake: FakeBitbucket;
let dir: string;
let n = 0;
beforeEach(() => {
  fake = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: fixture("dashboard-pull-requests-page.json") } });
  dir = join(root, `case-${n++}`);
});
const opened: Settings[] = [];
afterEach(() => {
  fake.stop();
  for (const s of opened.splice(0)) s.close();
});

function setup(backend?: SecretBackend) {
  const settings = createSettings({ dir, secrets: backend ? createSecrets(backend) : undefined });
  opened.push(settings);
  const app = createApp({ port: PORT, token: SESSION, live: createLive(), settings });
  const call = (method: string, body?: unknown) =>
    app.request(`${ORIGIN}/api/settings`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    settings,
    get: async () => (await (await call("GET")).json()) as SettingsDto,
    put: (body: unknown) => call("PUT", body),
  };
}

const UNEDITED = { general: { fields: [], newer: [] }, explain: { fields: [], newer: [] } };

describe("settings API", () => {
  test("GET without config gives the not-configured shape", async () => {
    const s = setup();
    expect(await s.get()).toEqual({
      baseUrl: null,
      user: null,
      tokenStored: false,
      tokenStorage: "memory",
      caFile: null,
      notifications: false,
      markAi: true,
      markSeverity: true,
      taskRules: DEFAULT_RULES,
      taskLink: null,
      checkSeconds: 60,
      profiles: SHIPPED_PROFILES,
      shippedProfiles: SHIPPED_PROFILES,
      profileEdits: UNEDITED,
      jira: { baseUrl: null, caFile: null, email: null, tokenStored: false },
      sessions: false,
      askAttachments: true,
      taskBranchPrefixes: ["feature/", "bugfix/", "hotfix/"],
    });
    expect(existsSync(dir)).toBe(false);
  });

  test("valid PUT against the fake server stores the settings", async () => {
    const s = setup();
    const changed: string[] = [];
    s.settings.onSettingsChanged((st) => changed.push(st.config.baseUrl));
    const res = await s.put({ baseUrl: `${fake.url}/`, token: FAKE_TOKEN, notifications: true });
    expect(res.status).toBe(200);
    const expected = {
      baseUrl: fake.url,
      user: "jdoe",
      tokenStored: true,
      tokenStorage: "memory" as const,
      caFile: null,
      notifications: true,
      markAi: true,
      markSeverity: true,
      taskRules: DEFAULT_RULES,
      taskLink: null,
      checkSeconds: 60,
      profiles: SHIPPED_PROFILES,
      shippedProfiles: SHIPPED_PROFILES,
      profileEdits: UNEDITED,
      jira: { baseUrl: null, caFile: null, email: null, tokenStored: false },
      sessions: false,
      askAttachments: true,
      taskBranchPrefixes: ["feature/", "bugfix/", "hotfix/"],
    };
    expect(await res.json()).toEqual(expected);
    expect(await s.get()).toEqual(expected);
    expect(changed).toEqual([fake.url]);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8"))).toEqual({
      baseUrl: fake.url,
      userSlug: "jdoe",
      notifications: true,
      profilesVersion: PROFILES_VERSION,
    });
    expect(s.settings.db()).not.toBeNull();
    expect(await (await s.settings.provider())?.currentUser()).toBe("jdoe");
  });

  test("same origin without token reuses the stored token", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const before = fake.requests.length;
    expect((await s.put({ baseUrl: fake.url, caFile: TEST_CA_FILE })).status).toBe(200);
    expect(fake.requests.length).toBe(before + 1);
    expect((await s.get()).caFile).toBe(TEST_CA_FILE);
  });

  test("overlapping PUTs run one at a time, so the config and the database stay a pair", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    fake.routes[key("GET", DASHBOARD_PATH)] = { ...fixture<object>("dashboard-pull-requests-page.json"), delayMs: 200 };
    const other = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: fixture("dashboard-pull-requests-page.json") } });
    try {
      const toOther = s.put({ baseUrl: other.url, token: FAKE_TOKEN });
      const tokenOnly = s.put({ baseUrl: fake.url, token: FAKE_TOKEN });
      expect((await toOther).status).toBe(200);
      expect((await tokenOnly).status).toBe(200);
    } finally {
      other.stop();
    }
    expect(s.settings.config()?.baseUrl).toBe(fake.url);
    expect(s.settings.db()?.filename).toBe(dbPath(dir, fake.url));
  });

  test("notifications-only PUT saves without a Bitbucket request", async () => {
    const s = setup();
    const changed: boolean[] = [];
    s.settings.onSettingsChanged((st) => changed.push(st.config.notifications));
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const before = fake.requests.length;
    fake.stop();
    const res = await s.put({ baseUrl: `${fake.url}/`, notifications: true });
    expect(res.status).toBe(200);
    expect((await res.json()).notifications).toBe(true);
    expect(fake.requests.length).toBe(before);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).notifications).toBe(true);
    expect(changed).toEqual([false]);
  });

  test("markAi saves without a Bitbucket request and persists across a restart", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    expect((await s.get()).markAi).toBe(true);
    const before = fake.requests.length;
    const res = await s.put({ baseUrl: fake.url, markAi: false });
    expect(res.status).toBe(200);
    expect((await res.json()).markAi).toBe(false);
    expect(fake.requests.length).toBe(before);
    // A PUT without markAi keeps the stored value.
    expect((await s.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).markAi).toBe(false);
    s.settings.close();
    const again = setup();
    expect(await again.get()).toMatchObject({ markAi: false, notifications: true });
    expect(again.settings.config()?.markAi).toBe(false);
  });

  test("AC-B24 (server): the branch prefix list saves in order, persists, and refuses a bad list with its sentence", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const list = ["task/", "feature/", "users/me/"];
    const res = await s.put({ baseUrl: fake.url, taskBranchPrefixes: list });
    expect(res.status).toBe(200);
    expect((await res.json()).taskBranchPrefixes).toEqual(list);
    // A PUT without the list keeps it.
    expect((await s.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
    for (const [bad, error] of [
      [[], "Keep at least one prefix."],
      [["a/", "a/"], "This prefix is already in the list."],
      [Array.from({ length: 11 }, (_, i) => `p${i}/`), "At most 10 prefixes."],
      [["bad.."], "Invalid branch prefix."],
      [[""], "Invalid branch prefix."],
      [[`${"x".repeat(40)}/`], "Invalid branch prefix."],
    ] as const) {
      const r = await s.put({ baseUrl: fake.url, taskBranchPrefixes: bad });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error });
    }
    s.settings.close();
    expect((await setup().get()).taskBranchPrefixes).toEqual(list);
  });

  test("markSeverity saves without a Bitbucket request and persists across a restart", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    expect((await s.get()).markSeverity).toBe(true);
    const before = fake.requests.length;
    const res = await s.put({ baseUrl: fake.url, markSeverity: false });
    expect(res.status).toBe(200);
    expect((await res.json()).markSeverity).toBe(false);
    expect(fake.requests.length).toBe(before);
    // A PUT without markSeverity keeps the stored value.
    expect((await s.put({ baseUrl: fake.url, markAi: false })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).markSeverity).toBe(false);
    expect((await s.put({ baseUrl: fake.url, markSeverity: "no" })).status).toBe(400);
    s.settings.close();
    const again = setup();
    expect(await again.get()).toMatchObject({ markSeverity: false, markAi: false });
    expect(again.settings.config()?.markSeverity).toBe(false);
  });

  test("the session opt-in starts off, saves without a Bitbucket request, and a PUT without it keeps it", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    expect((await s.get()).sessions).toBe(false);
    expect(s.settings.sessions()).toBe(false);
    const before = fake.requests.length;
    expect(await (await s.put({ baseUrl: fake.url, sessions: true })).json()).toMatchObject({ sessions: true });
    expect(fake.requests.length).toBe(before);
    expect(s.settings.sessions()).toBe(true);
    expect((await s.put({ baseUrl: fake.url, markAi: false })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).sessions).toBe(true);
    expect((await s.put({ baseUrl: fake.url, sessions: "yes" })).status).toBe(400);
    // Off removes the key, as for the other default-off switches.
    expect(await (await s.put({ baseUrl: fake.url, sessions: false })).json()).toMatchObject({ sessions: false });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).sessions).toBeUndefined();
  });

  test("the attachment policy question starts on, an old config asks, and off is stored until the user turns it on", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const file = join(dir, "config.json");
    // A config from before the switch has no key, so the first include after the upgrade still asks.
    expect(JSON.parse(readFileSync(file, "utf8")).askAttachments).toBeUndefined();
    expect((await s.get()).askAttachments).toBe(true);
    const before = fake.requests.length;
    expect(await (await s.put({ baseUrl: fake.url, askAttachments: false })).json()).toMatchObject({ askAttachments: false });
    expect(fake.requests.length).toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8")).askAttachments).toBe(false);
    // A PUT without the key keeps the acknowledgement.
    expect((await s.put({ baseUrl: fake.url, markAi: false })).status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).askAttachments).toBe(false);
    expect((await s.put({ baseUrl: fake.url, askAttachments: "no" })).status).toBe(400);
    s.settings.close();
    expect((await setup().get()).askAttachments).toBe(false);
    // On removes the key, so the default applies again.
    const again = setup();
    expect(await (await again.put({ baseUrl: fake.url, askAttachments: true })).json()).toMatchObject({ askAttachments: true });
    expect(JSON.parse(readFileSync(file, "utf8")).askAttachments).toBeUndefined();
    // A broken value reads as absent and asks.
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), askAttachments: "off" }));
    again.settings.close();
    expect((await setup().get()).askAttachments).toBe(true);
  });

  test("GET gives the two shipped profiles with their full prompts", async () => {
    const { profiles } = await setup().get();
    expect(profiles.map((p) => p.id)).toEqual(["general", "explain"]);
    expect(profiles[0]?.prompt).toStartWith("Find problems that this change adds");
    expect(profiles).toEqual(SHIPPED_PROFILES);
  });

  const custom: Profile = {
    id: "perf",
    name: "Performance",
    note: "Hot paths",
    prompt: "Find slow code.",
    explain: false,
    docs: false,
    languageChecks: false,
    maxTurns: 20,
    skills: [],
    alwaysSkills: [],
    mcp: [],
    model: null,
    effort: null,
    reviewer: { model: null, effort: null, mode: "auto" },
    modules: [],
    volume: "balanced",
    verifier: { mode: "on", model: null, effort: null },
    variants: [],
  };

  test("saved profiles and checkSeconds persist offline, with no secret in config.json", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const before = fake.requests.length;
    fake.stop();
    const res = await s.put({ baseUrl: fake.url, profiles: [custom], checkSeconds: 300 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ profiles: [custom], checkSeconds: 300 });
    expect(fake.requests.length).toBe(before);
    const text = readFileSync(join(dir, "config.json"), "utf8");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(text)).toMatchObject({ profiles: [custom], checkSeconds: 300 });
    expect(s.settings.profiles()).toEqual([custom]);
    expect(s.settings.checkMs()).toBe(300_000);
    // A PUT without the fields keeps them.
    expect((await s.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
    s.settings.close();
    const again = setup();
    expect(await again.get()).toMatchObject({ profiles: [custom], checkSeconds: 300 });
  });

  test("invalid profile lists and intervals give 400 and store nothing", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    for (const body of [
      { profiles: [custom, { ...custom, name: "Other" }] },
      { profiles: [{ ...custom, maxTurns: 1 }] },
      { profiles: [{ ...custom, maxTurns: 1001 }] },
      { profiles: [] },
      { profiles: [{ ...custom, id: "Bad ID" }] },
      { checkSeconds: 45 },
    ]) {
      const res = await s.put({ baseUrl: fake.url, ...body });
      expect(res.status).toBe(400);
    }
    expect(readConfig(dir)).not.toHaveProperty("profiles");
    expect(readConfig(dir)).not.toHaveProperty("checkSeconds");
  });

  test("profiles null restores the shipped profiles", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN, profiles: [custom] })).status).toBe(200);
    expect((await s.get()).profiles).toEqual([custom]);
    const res = await s.put({ baseUrl: fake.url, profiles: null });
    expect(res.status).toBe(200);
    expect((await res.json()).profiles).toEqual(SHIPPED_PROFILES);
    expect(readConfig(dir)).not.toHaveProperty("profiles");
  });

  test("a hand-broken profiles block falls back to the shipped profiles and keeps the rest", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN, notifications: true })).status).toBe(200);
    s.settings.close();
    const file = join(dir, "config.json");
    const broken = { ...JSON.parse(readFileSync(file, "utf8")), profiles: [{ id: "x" }], checkSeconds: "fast" };
    writeFileSync(file, JSON.stringify(broken));
    const again = setup();
    expect(await again.get()).toMatchObject({ baseUrl: fake.url, notifications: true, profiles: SHIPPED_PROFILES, checkSeconds: 60 });
  });

  test("an invalid profile goes to config.json.bak before a save drops it; an invalid file keeps its copy too", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    try {
      const s = setup();
      expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
      s.settings.close();
      const file = join(dir, "config.json");
      const mine = { ...SHIPPED_PROFILES[0], id: "mine", name: "Mine" };
      // One custom profile with a field that no longer parses.
      const text = JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), profiles: [{ ...mine, maxTurns: "many" }] });
      writeFileSync(file, text);
      // The settings read config.json at the first use.
      const again = setup();
      expect((await again.get()).profiles).toEqual(SHIPPED_PROFILES);
      expect(lines.join("\n")).toContain("Ignored the invalid profiles in config.json");
      expect((await again.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
      expect(readFileSync(join(dir, "config.json.bak"), "utf8")).toBe(text);
      expect(JSON.parse(readFileSync(join(dir, "config.json.bak"), "utf8")).profiles[0].id).toBe("mine");
      // A second start with the same file makes no second copy.
      for (const x of opened.splice(0)) x.close();
      writeFileSync(file, text);
      await setup().get();
      expect(existsSync(join(dir, "config.json.1.bak"))).toBe(false);
      // A file that is not JSON keeps a copy under the next free name. The first copy stays.
      for (const x of opened.splice(0)) x.close();
      writeFileSync(file, "{ not json");
      await setup().get();
      expect(readFileSync(join(dir, "config.json.1.bak"), "utf8")).toBe("{ not json");
      expect(readFileSync(join(dir, "config.json.bak"), "utf8")).toBe(text);
    } finally {
      spy.mockRestore();
    }
  });

  // The shipped profiles of PROFILES_VERSION 6, and the version 4 Over-engineering and Security profiles that version 5 retires.
  const [general, explain] = SHIPPED_PROFILES as [Profile, Profile];
  const over = RETIRED_PROFILES.over as Profile;
  const security = RETIRED_PROFILES.security as Profile;
  const OLD_GENERAL =
    "Find defects in the change: wrong logic, missed edge cases, races and lock order, resource leaks, error handling, and effects on callers outside the diff.";
  const OLD_OVER =
    "Find code that the change can delete or simplify: abstractions with one use, code that the standard library or the platform already gives, unneeded dependencies, settings for fixed values, and dead code.";
  const V4_GENERAL = `${OLD_GENERAL}\nWhen the change fixes a bug in one place, Grep the other callers of the same code. A caller with the same bug is a finding.`;
  const V4_EXPLAIN =
    "Explain the change for a reviewer: what it does, why, and which parts need attention. Ask a question where the intent is not clear. Report no findings.";
  // A profile as a config stored it before version 5: without modules, volume, and verifier.
  const v4stored = (p: Profile, o: Partial<Profile> = {}) => {
    const { modules: _m, volume: _v, verifier: _r, ...rest } = { ...p, ...o };
    return rest;
  };
  const v4 = {
    general: v4stored(general, {
      name: "General",
      note: "Correctness, concurrency, effects outside the diff",
      prompt: V4_GENERAL,
      effort: null,
      reviewer: { model: null, effort: null, mode: "auto" },
    }),
    explain: v4stored(explain, { note: "Summary and questions only, at lower cost", prompt: V4_EXPLAIN, effort: null, maxTurns: 50 }),
    over: v4stored(over),
    security: v4stored(security),
  };
  // A profile as a config stored it before version 3: also without languageChecks.
  const stored = (p: ReturnType<typeof v4stored>, o: Partial<Profile> = {}) => {
    const { languageChecks: _, ...rest } = { ...p, ...o };
    return rest;
  };
  const v2 = {
    general: stored(v4.general, { prompt: OLD_GENERAL }),
    over: stored(v4.over, { prompt: OLD_OVER }),
    security: stored(v4.security),
  };
  const v1 = { general: { ...v2.general, maxTurns: 40 }, over: { ...v2.over, maxTurns: 40 }, security: { ...v2.security, maxTurns: 40 } };
  // A version 3 config stores every field. The version 3 upgrade skipped each profile with an edit, so it kept its version 2 values.
  const v3 = {
    general: { ...v2.general, languageChecks: false },
    over: { ...v2.over, languageChecks: false },
    security: { ...v2.security, languageChecks: false },
  };
  // Run setup edits. No upgrade changes them.
  const setupEdits = {
    skills: ["test-check", "e2e-plugin:style"],
    alwaysSkills: ["test-check"],
    mcp: [{ server: "fake-docs", tools: ["search", "lookup"] }],
    model: "opus",
    effort: "high" as const,
    reviewer: { model: "sonnet", effort: "low" as const, mode: "always" as const },
  };
  // general after an unedited Over-engineering profile retired: the shipped modules and simplify.
  const withSimplify = { ...general, modules: [...general.modules, "simplify" as const] };
  const oldConfig = async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    s.settings.close();
    const file = join(dir, "config.json");
    const { profilesVersion, ...old } = JSON.parse(readFileSync(file, "utf8"));
    expect(profilesVersion).toBe(PROFILES_VERSION);
    // version undefined: a config from before PROFILES_VERSION.
    const write = (version: number | undefined, profiles: unknown[]) =>
      writeFileSync(file, JSON.stringify({ ...old, ...(version === undefined ? {} : { profilesVersion: version }), profiles }));
    const load = async () => {
      const s = setup();
      const { profiles } = await s.get();
      s.settings.close();
      return profiles;
    };
    return { file, write, load };
  };

  test("a config from before PROFILES_VERSION jumps to the current shipped values field by field and keeps edited fields", async () => {
    const { file, write } = await oldConfig();
    const v1explain = { ...v4.explain, maxTurns: 12 };
    write(undefined, [v1.general, { ...v1.over, note: "My note" }, { ...v1.security, maxTurns: 30 }, v1explain, stored(v4stored(custom))]);
    const upgraded = [general, { ...over, note: "My note" }, { ...security, maxTurns: 30 }, explain, custom];
    const again = setup();
    expect((await again.get()).profiles).toEqual(upgraded);
    // A save stamps the version, so a cap of 40 set after the update stays.
    expect((await again.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
    // The unedited shipped profiles store only their ID. The other profiles store every field.
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      profiles: [{ id: "general" }, upgraded[1], upgraded[2], { id: "explain" }, custom],
      profilesVersion: PROFILES_VERSION,
    });
    expect(readConfig(dir)?.profiles).toEqual(upgraded);
    const oldGeneral = { ...general, maxTurns: 40 };
    expect((await again.put({ baseUrl: fake.url, profiles: [oldGeneral] })).status).toBe(200);
    again.settings.close();
    expect((await setup().get()).profiles).toEqual([oldGeneral]);
  });

  test("a version 2 config gets the new values field by field, and its unedited Security and Over-engineering profiles retire", async () => {
    const { write, load } = await oldConfig();
    write(2, [v2.general, v2.over, v2.security, v4.explain, stored(v4stored(custom))]);
    expect(await load()).toEqual([withSimplify, explain, custom]);
    // Version 2 upgraded the version 1 caps. A cap of 40 in a version 2 config was set back on purpose. The other fields still upgrade.
    write(2, [v1.general, v4.over, { ...v2.security, note: "Mine" }]);
    expect(await load()).toEqual([
      { ...withSimplify, maxTurns: 40 },
      { ...security, note: "Mine" },
    ]);
  });

  test("a profile with run setup edits and the old shipped prompt gets the new prompt and language checks, and keeps its setup", async () => {
    const { write, load } = await oldConfig();
    write(2, [
      { ...v2.general, ...setupEdits },
      { ...v2.over, ...setupEdits },
      { ...v2.security, ...setupEdits },
    ]);
    expect(await load()).toEqual([
      { ...general, ...setupEdits },
      { ...over, ...setupEdits },
      { ...security, ...setupEdits },
    ]);
  });

  test("an edited prompt stays; language checks arrive only when the config predates them", async () => {
    const { write, load } = await oldConfig();
    write(2, [
      { ...v2.general, prompt: "My prompt" },
      { ...v2.over, prompt: "My cuts" },
    ]);
    expect(await load()).toEqual([
      { ...general, prompt: "My prompt" },
      { ...over, prompt: "My cuts" },
    ]);
    // In a version 3 config, an edited prompt does not show whether the user switched the checks off.
    write(3, [{ ...v3.general, prompt: "My prompt" }]);
    expect(await load()).toEqual([{ ...general, prompt: "My prompt", languageChecks: false }]);
  });

  test("a version 3 config upgrades the profiles that the version 3 upgrade skipped", async () => {
    const { write, load } = await oldConfig();
    write(3, [{ ...v3.general, ...setupEdits }, { ...v3.over, ...setupEdits }, { ...v3.security, ...setupEdits }, v4.explain]);
    // The version 2 prompt shows that the version 3 upgrade skipped General and Over-engineering.
    // Security kept its prompt in version 3, so no field tells a skipped profile from one with the checks switched off.
    expect(await load()).toEqual([
      { ...general, ...setupEdits },
      { ...over, ...setupEdits },
      { ...security, ...setupEdits, languageChecks: false },
      explain,
    ]);
    // The version 3 prompt shows that the version 3 upgrade replaced General. The user switched the checks off after it.
    write(3, [{ ...v4.general, languageChecks: false, note: "Mine" }]);
    expect(await load()).toEqual([{ ...general, languageChecks: false, note: "Mine" }]);
  });

  test("custom profiles keep every field, also the prompt and the turn cap of an old shipped profile", async () => {
    const { write, load } = await oldConfig();
    const lookalike = { ...v1.general, id: "mine", name: "Mine" };
    const parsed: Profile = {
      ...lookalike,
      languageChecks: false,
      modules: [],
      volume: "balanced",
      verifier: { mode: "on", model: null, effort: null },
    };
    write(undefined, [stored(v4stored(custom)), lookalike]);
    expect(await load()).toEqual([custom, parsed]);
    write(3, [stored(v4stored(custom)), { ...lookalike, languageChecks: false }]);
    expect(await load()).toEqual([custom, parsed]);
  });

  test("the upgrade runs once: after a save stamps the version, a value set back on purpose stays", async () => {
    const { file, write, load } = await oldConfig();
    write(2, [{ ...v2.general, ...setupEdits }]);
    const upgraded = [{ ...general, ...setupEdits }];
    // Each load before the first save gives the same result.
    expect(await load()).toEqual(upgraded);
    const again = setup();
    expect((await again.get()).profiles).toEqual(upgraded);
    expect((await again.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
    // effort "high" equals the shipped effort, so the file does not keep it.
    const { effort: _, ...stored } = setupEdits;
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      profiles: [{ id: "general", ...stored }],
      profilesVersion: PROFILES_VERSION,
    });
    expect(readConfig(dir)?.profiles).toEqual(upgraded);
    const setBack = { ...general, ...setupEdits, prompt: OLD_GENERAL, languageChecks: false, modules: [] };
    expect((await again.put({ baseUrl: fake.url, profiles: [setBack] })).status).toBe(200);
    again.settings.close();
    expect(await load()).toEqual([setBack]);
  });

  // ---------- PROFILES_VERSION 5 (docs/plans/review-v2/spec.md section 1.2) ----------

  test("AC-R11: a version 4 config with unedited Security and Over-engineering profiles upgrades to two profiles; an edited one stays", async () => {
    expect(PROFILES_VERSION).toBe(7);
    const { write, load } = await oldConfig();
    write(4, [v4.general, v4.over, v4.security, v4.explain]);
    const two = await load();
    expect(two).toEqual([withSimplify, explain]);
    expect(two[0]).toMatchObject({
      name: "Review",
      effort: "high",
      reviewer: { effort: "high" },
      verifier: { mode: "on", effort: "medium" },
    });
    expect(two[0]?.modules).toEqual(["security", "concurrency", "api", "rules", "intent", "simplify"]);
    // An edited Over-engineering profile stays. The unedited Security profile retires, and general already has the security module.
    write(4, [v4.general, { ...v4.over, note: "Mine" }, v4.security, v4.explain]);
    expect(await load()).toEqual([general, { ...over, note: "Mine" }, explain]);
    // A run setup edit counts as an edit.
    write(4, [v4.general, { ...v4.security, reviewer: { model: null, effort: "low", mode: "auto" } }]);
    expect(await load()).toEqual([general, { ...security, reviewer: { model: null, effort: "low", mode: "auto" } }]);
  });

  test("AC-R12: a version 4 general profile with an edited prompt keeps the prompt and gets the modules, the volume, and the efforts", async () => {
    const { write, load } = await oldConfig();
    write(4, [{ ...v4.general, prompt: "My prompt" }, v4.explain]);
    const [mine] = await load();
    expect(mine).toEqual({ ...general, prompt: "My prompt" });
    expect(mine).toMatchObject({ volume: "balanced", effort: "high", reviewer: { effort: "high" }, verifier: { effort: "medium" } });
  });

  // ---------- PROFILES_VERSION 6 (docs/plans/review-v2/spec.md sections 1.2 and 3.4) ----------

  test("AC-X8: a version 4 or 5 Explain profile with an unedited prompt gets the new lens; an edited one keeps it", async () => {
    expect(explain).toMatchObject({ ...EXPLAIN_V2, verifier: { mode: "off" } });
    expect(explain.prompt).toContain("In walkthrough, explain the change by theme.");
    const { write, load } = await oldConfig();
    // Version 5 stored the Explain verifier and the version 4 note, prompt, effort, and turn cap.
    const v5explain = { ...explain, note: "Summary and questions only, at lower cost", prompt: V4_EXPLAIN, effort: null, maxTurns: 50 };
    for (const [version, old] of [
      [4, v4.explain],
      [5, v5explain],
    ] as const) {
      write(version, [v4.general, old]);
      expect((await load())[1]).toEqual(explain);
      // Field by field: an edited prompt stays, and the unedited note, effort, and turn cap upgrade.
      write(version, [v4.general, { ...old, prompt: "My walkthrough" }]);
      expect((await load())[1]).toEqual({ ...explain, prompt: "My walkthrough" });
      write(version, [v4.general, { ...old, maxTurns: 30, effort: "low" }]);
      expect((await load())[1]).toEqual({ ...explain, maxTurns: 30, effort: "low" });
    }
  });

  test("a version 4 config with every profile edited keeps all four", async () => {
    const { write, load } = await oldConfig();
    write(4, [
      { ...v4.general, note: "A" },
      { ...v4.over, note: "B" },
      { ...v4.security, maxTurns: 30 },
      { ...v4.explain, prompt: "C" },
    ]);
    expect(await load()).toEqual([
      { ...general, note: "A" },
      { ...over, note: "B" },
      { ...security, maxTurns: 30 },
      { ...explain, prompt: "C" },
    ]);
  });

  test("a version 5 config keeps every profile but Explain, also a profile with the values of a retired one", async () => {
    const { write, load } = await oldConfig();
    const mine: Profile = { ...general, name: "Mine", modules: [] };
    write(5, [mine, over, security, { ...explain, maxTurns: 50, verifier: { mode: "on" } }]);
    // The turn cap 50 is the version 5 value, so it upgrades. The verifier was edited, so it stays.
    expect(await load()).toEqual([mine, over, security, { ...explain, verifier: { mode: "on", model: null, effort: null } }]);
  });

  test("a version 6 config changes nothing", async () => {
    const { write, load } = await oldConfig();
    const mine: Profile = { ...general, name: "Mine", modules: [] };
    const old = { ...explain, note: "Summary and questions only, at lower cost", prompt: V4_EXPLAIN, effort: null, maxTurns: 50 };
    write(6, [mine, over, security, old]);
    expect(await load()).toEqual([mine, over, security, old]);
  });

  // ---------- PROFILES_VERSION 7: a shipped profile stores only its edits ----------

  // Sets shipped values of general for one test, as a later release would.
  const shipLater = (patch: Partial<Profile>) => {
    const was = { ...general };
    Object.assign(general, patch);
    return () => Object.assign(general, was);
  };

  test("an edited Review prompt converts to the prompt alone, resolves to the same profile, and keeps the edit when the shipped prompt changes", async () => {
    const { file, write } = await oldConfig();
    const mine = { ...general, prompt: "My prompt" };
    write(6, [mine, explain, custom]);
    const s = setup();
    expect((await s.get()).profiles).toEqual([mine, explain, custom]);
    expect((await s.get()).profileEdits).toEqual({ general: { fields: ["prompt"], newer: [] }, explain: { fields: [], newer: [] } });
    expect((await s.put({ baseUrl: fake.url, notifications: true })).status).toBe(200);
    s.settings.close();
    const stored = JSON.parse(readFileSync(file, "utf8")).profiles;
    expect(stored).toEqual([{ id: "general", prompt: "My prompt", edited: { prompt: expect.any(String) } }, { id: "explain" }, custom]);
    expect(readConfig(dir)?.profiles).toEqual([mine, explain, custom]);
    // A later release changes the shipped prompt and the turn cap. The edited prompt stays, and the unedited turn cap follows.
    const restore = shipLater({ prompt: "A newer shipped prompt.", maxTurns: 120 });
    try {
      const later = setup();
      const got = await later.get();
      expect(got.profiles[0]).toEqual({ ...general, prompt: "My prompt", maxTurns: 120 });
      expect(got.profileEdits.general).toEqual({ fields: ["prompt"], newer: ["prompt"] });
      expect(got.shippedProfiles[0]?.prompt).toBe("A newer shipped prompt.");
      // A save of the same prompt keeps the notice. A changed prompt is a new edit against the newer shipped prompt.
      const res = await later.put({ baseUrl: fake.url, profiles: got.profiles });
      expect(((await res.json()) as SettingsDto).profileEdits.general?.newer).toEqual(["prompt"]);
      const changed = await later.put({ baseUrl: fake.url, profiles: [{ ...got.profiles[0], prompt: "My prompt 2" }, explain] });
      expect(((await changed.json()) as SettingsDto).profileEdits.general).toEqual({ fields: ["prompt"], newer: [] });
      // Reset to shipped: the saved value equals the shipped value, so the file keeps only the ID.
      expect((await later.put({ baseUrl: fake.url, profiles: [{ ...general }, explain] })).status).toBe(200);
      expect(JSON.parse(readFileSync(file, "utf8")).profiles).toEqual([{ id: "general" }, { id: "explain" }]);
    } finally {
      restore();
    }
  });

  test("a version 5 Explain profile with an edited prompt keeps it and shows that a newer shipped prompt exists", async () => {
    const { write, load } = await oldConfig();
    const v5explain = {
      ...explain,
      note: "Summary and questions only, at lower cost",
      prompt: "My walkthrough",
      effort: null,
      maxTurns: 50,
    };
    write(5, [general, v5explain]);
    expect(await load()).toEqual([general, { ...explain, prompt: "My walkthrough" }]);
    const s = setup();
    expect((await s.get()).profileEdits.explain).toEqual({ fields: ["prompt"], newer: ["prompt"] });
  });

  test("a stored shipped profile with an invalid edit drops the profile list, as before", async () => {
    const { file } = await oldConfig();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), profiles: [{ id: "general", maxTurns: 1 }] }));
      expect((await setup().get()).profiles).toEqual(SHIPPED_PROFILES);
    } finally {
      spy.mockRestore();
    }
  });

  test("no profile retires without general; an edited general.modules gets no module", async () => {
    const { write, load } = await oldConfig();
    write(4, [v4.over, v4.security, v4.explain]);
    expect(await load()).toEqual([over, security, explain]);
    write(4, [{ ...v4.general, modules: ["tests"] }, v4.over, v4.explain]);
    expect(await load()).toEqual([{ ...general, modules: ["tests"] }, explain]);
  });

  test("the revision of an unchanged version 4 profile stays the same when the new fields hold their defaults", () => {
    // profileRevision of the shipped profiles at commit 510d890 (PROFILES_VERSION 4).
    const before = {
      general: "3a4df4727d3b45ecb2b399e811d6bc1a9d379877122c4137d88e672f6c6789d8",
      over: "99470d18890bea43ecdc96a81c23017594ccd9c19b27927e8a30815acfd8117a",
      security: "2994da6534136157d8a6af436088833bc7c045e349cbdf838efaac0aff6ad13e",
      explain: "ec5819f967fae6d422ce0d2e30632f834d6b76f9b9563a7c81ff7163fecea6aa",
    };
    for (const [id, hash] of Object.entries(before)) expect(profileRevision(profileInput.parse(v4[id as keyof typeof v4]))).toBe(hash);
    const edits = {
      skills: ["a"],
      alwaysSkills: ["a"],
      mcp: [{ server: "s", tools: ["t"] }],
      model: "opus",
      effort: "high",
      reviewer: { model: "sonnet", effort: "low", mode: "always" },
    };
    expect(profileRevision(profileInput.parse({ ...v4.general, ...edits }))).toBe(
      "eff11ed00c2ce5ec5dea8e278425693a9a0d6b0c76784afa8369b4081299ec2f",
    );
    expect(profileRevision(profileInput.parse({ ...v4.general, volume: "quiet" }))).not.toBe(before.general);
  });

  test("401 gives 400 and stores nothing", async () => {
    const s = setup();
    const res = await s.put({ baseUrl: fake.url, token: "wrong-token" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("rejected");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    expect((await s.get()).tokenStored).toBe(false);
    expect(await s.settings.provider()).toBeNull();
  });

  test("GET never holds the token", async () => {
    const s = setup();
    const res = await s.put({ baseUrl: fake.url, token: FAKE_TOKEN });
    expect(await res.text()).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(await s.get())).not.toContain(FAKE_TOKEN);
  });

  test("foreign origin without token gives 400", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const before = fake.requests.length;
    // Same server, other origin.
    const res = await s.put({ baseUrl: fake.url.replace("127.0.0.1", "localhost") });
    expect(res.status).toBe(400);
    expect(fake.requests.length).toBe(before);
    expect((await s.get()).baseUrl).toBe(fake.url);
  });

  test("plain http to a non-loopback host gives 400", async () => {
    const s = setup();
    const res = await s.put({ baseUrl: "http://bitbucket.invalid", token: FAKE_TOKEN });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("https");
    expect(existsSync(join(dir, "config.json"))).toBe(false);
  });

  test("missing CA file gives 400", async () => {
    const s = setup();
    const res = await s.put({ baseUrl: fake.url, token: FAKE_TOKEN, caFile: join(root, "missing-ca.pem") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("CA file");
    expect(fake.requests.length).toBe(0);
  });

  test("bad JSON body and URL with extra parts give 400", async () => {
    const s = setup();
    expect((await s.put({ baseUrl: 5 })).status).toBe(400);
    expect((await s.put({ baseUrl: `${fake.url}/?x=1`, token: FAKE_TOKEN })).status).toBe(400);
    expect((await s.put({ baseUrl: "ftp://host", token: FAKE_TOKEN })).status).toBe(400);
  });

  test("a throwing secrets backend reports memory", async () => {
    const fail = () => Promise.reject(new Error("no keyring"));
    const s = setup({ get: fail, set: fail, delete: fail });
    expect((await s.get()).tokenStorage).toBe("os");
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    const got = await s.get();
    expect(got.tokenStorage).toBe("memory");
    expect(got.tokenStored).toBe(true);
  });
});

test("after a PUT the token is absent from the data dir and the log", async () => {
  const lines: string[] = [];
  const capture = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  const spies = [spyOn(console, "log").mockImplementation(capture), spyOn(console, "error").mockImplementation(capture)];
  try {
    const s = setup();
    expect((await s.put({ baseUrl: fake.url, token: "wrong-token" })).status).toBe(400);
    expect((await s.put({ baseUrl: fake.url, token: FAKE_TOKEN })).status).toBe(200);
    log(`token is ${FAKE_TOKEN}`);
    s.settings.db()?.run("INSERT INTO sync_checkpoint (scope, updated_at) VALUES ('dashboard', 0)");
    const files = readdirSync(dir);
    expect(files).toContain("config.json");
    expect(files.some((f) => f.endsWith(".sqlite"))).toBe(true);
    for (const f of files) expect(readFileSync(join(dir, f)).includes(FAKE_TOKEN)).toBe(false);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(FAKE_TOKEN);
    expect(lines).toContain("token is [redacted]");
  } finally {
    for (const s of spies) s.mockRestore();
  }
});

describe("Jira settings (plan r2 S-JIRA)", () => {
  let jira: FakeJira;
  beforeEach(() => {
    jira = startFakeJira();
  });
  afterEach(() => jira.stop());

  function jiraSetup(backend?: SecretBackend) {
    const settings = createSettings({ dir, secrets: createSecrets(null), jiraSecrets: createSecrets(backend ?? null, "jira-token") });
    opened.push(settings);
    const app = createApp({ port: PORT, token: SESSION, live: createLive(), settings });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`${ORIGIN}/api/settings${path}`, {
        method,
        headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as SettingsDto & { error?: string } };
    };
    const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    return { settings, call, config, bitbucket: () => call("PUT", "", { baseUrl: fake.url, token: FAKE_TOKEN }) };
  }

  test("Jira needs the Bitbucket settings first", async () => {
    const s = jiraSetup();
    expect((await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN })).status).toBe(409);
    expect(jira.requests).toEqual([]);
  });

  test("a Bitbucket PUT keeps the jira block", async () => {
    const s = jiraSetup();
    await s.bitbucket();
    expect((await s.call("PUT", "/jira", { baseUrl: `${jira.url}/`, token: JIRA_TOKEN })).body.jira).toEqual({
      baseUrl: jira.url,
      caFile: null,
      email: null,
      tokenStored: true,
    });
    expect((await s.call("PUT", "", { baseUrl: fake.url, notifications: true })).status).toBe(200);
    expect((await s.call("PUT", "", { baseUrl: fake.url, token: FAKE_TOKEN, markAi: false })).status).toBe(200);
    expect(s.config().jira).toEqual({ baseUrl: jira.url });
    expect((await s.call("GET", "")).body.jira.tokenStored).toBe(true);
  });

  test("same origin reuses the stored token; a new origin needs one", async () => {
    const s = jiraSetup();
    await s.bitbucket();
    await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN });
    const r = await s.call("PUT", "/jira", { baseUrl: `${jira.url}/jira` });
    expect(r.status).toBe(400);
    jira.routes[key("GET", "/jira/rest/api/2/myself")] = { status: 200, body: { name: "jdoe" } };
    expect((await s.call("PUT", "/jira", { baseUrl: `${jira.url}/jira` })).status).toBe(200);
    expect(s.config().jira).toEqual({ baseUrl: `${jira.url}/jira` });
    const other = startFakeJira();
    try {
      expect((await s.call("PUT", "/jira", { baseUrl: other.url })).body.error).toContain("A new Jira URL needs a new token.");
      expect(other.requests).toEqual([]);
    } finally {
      other.stop();
    }
  });

  test("a wrong token, http to a non-loopback host, a redirect, and a missing CA file give 400 and store nothing", async () => {
    const s = jiraSetup();
    await s.bitbucket();
    expect((await s.call("PUT", "/jira", { baseUrl: jira.url, token: "wrong" })).body.error).toBe("Jira rejected the token.");
    expect((await s.call("PUT", "/jira", { baseUrl: "http://jira.example.test", token: JIRA_TOKEN })).body.error).toBe(
      "The Jira URL must use https.",
    );
    expect((await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN, caFile: join(dir, "none.pem") })).status).toBe(400);
    jira.routes[key("GET", "/rest/api/2/myself")] = { status: 302, headers: { Location: "https://sso.example.test/" } };
    expect((await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN })).body.error).toBe(
      "Jira check failed: redirect 302: /rest/api/2/myself",
    );
    expect(s.config().jira).toBeUndefined();
    expect((await s.call("GET", "")).body.jira).toEqual({ baseUrl: null, caFile: null, email: null, tokenStored: false });
  });

  test("an empty baseUrl disconnects Jira and deletes the token from the store", async () => {
    const store = new Map<string, string>();
    const backend: SecretBackend = {
      get: async (o) => store.get(o.name) ?? null,
      set: async (o) => void store.set(o.name, o.value),
      delete: async (o) => store.delete(o.name),
    };
    const s = jiraSetup(backend);
    await s.bitbucket();
    await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN });
    expect([...store.entries()]).toEqual([["jira-token", JIRA_TOKEN]]);
    const r = await s.call("PUT", "/jira", { baseUrl: "" });
    expect(r.status).toBe(200);
    expect(r.body.jira).toEqual({ baseUrl: null, caFile: null, email: null, tokenStored: false });
    expect(store.size).toBe(0);
    expect(s.config().jira).toBeUndefined();
    expect(s.config().baseUrl).toBe(fake.url);
    expect(await s.settings.jira()).toBeNull();
  });

  test("Jira Cloud: the email goes to config.json, the token only to the store; a Bitbucket PUT keeps it; disconnect clears both", async () => {
    const cloud = startFakeJira({ cloud: true });
    try {
      const store = new Map<string, string>();
      const backend: SecretBackend = {
        get: async (o) => store.get(o.name) ?? null,
        set: async (o) => void store.set(o.name, o.value),
        delete: async (o) => store.delete(o.name),
      };
      const s = jiraSetup(backend);
      await s.bitbucket();
      const r = await s.call("PUT", "/jira", { baseUrl: cloud.url, token: JIRA_TOKEN, email: ` ${JIRA_EMAIL} ` });
      expect(r.status).toBe(200);
      expect(r.body.jira).toEqual({ baseUrl: cloud.url, caFile: null, email: JIRA_EMAIL, tokenStored: true });
      expect(s.config().jira).toEqual({ baseUrl: cloud.url, email: JIRA_EMAIL });
      expect(readFileSync(join(dir, "config.json"), "utf8")).not.toContain(JIRA_TOKEN);
      expect([...store.entries()]).toEqual([["jira-token", JIRA_TOKEN]]);
      expect((await s.call("PUT", "", { baseUrl: fake.url, token: FAKE_TOKEN, markAi: false })).status).toBe(200);
      expect(s.config().jira).toEqual({ baseUrl: cloud.url, email: JIRA_EMAIL });
      cloud.requests.length = 0;
      expect(await (await s.settings.jira())?.check()).toBe("Jordan Doe");
      expect(cloud.requests).toEqual(["GET /rest/api/2/serverInfo", "GET /rest/api/2/myself"]);
      const off = await s.call("PUT", "/jira", { baseUrl: "" });
      expect(off.body.jira).toEqual({ baseUrl: null, caFile: null, email: null, tokenStored: false });
      expect(s.config().jira).toBeUndefined();
      expect(store.size).toBe(0);
    } finally {
      cloud.stop();
    }
  });

  test("Jira deployment mismatch and a bad email give 400 and store nothing", async () => {
    const cloud = startFakeJira({ cloud: true });
    try {
      const s = jiraSetup();
      await s.bitbucket();
      expect((await s.call("PUT", "/jira", { baseUrl: cloud.url, token: JIRA_TOKEN })).body.error).toBe(
        "This is Jira Cloud. Enter your Atlassian account email and an API token.",
      );
      expect((await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN, email: JIRA_EMAIL })).body.error).toBe(
        "This Jira is Server or Data Center. Use a personal access token and no email.",
      );
      const bad = await s.call("PUT", "/jira", { baseUrl: cloud.url, token: JIRA_TOKEN, email: "not-an-email" });
      expect([bad.status, bad.body.error]).toEqual([400, "Invalid Jira settings."]);
      expect(s.config().jira).toBeUndefined();
      expect((await s.call("PUT", "/jira", { baseUrl: jira.url, token: JIRA_TOKEN, email: "" })).body.jira.email).toBeNull();
    } finally {
      cloud.stop();
    }
  });
});
