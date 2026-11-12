// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The CI server card of Settings (part-session.md section 2.15, package C2; spec.md section 6.31).
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/server/app";
import { createLive } from "../../src/server/live";
import { log } from "../../src/server/log";
import { createSecrets, type SecretBackend } from "../../src/server/secrets";
import { createSettings, type Settings } from "../../src/server/settings";
import type { SettingsDto } from "../../src/shared/dto";
import { FAKE_TOKEN, type FakeBitbucket, fixture, key, startFakeBitbucket } from "../support/fake-bitbucket";
import { type FakeJenkins, JENKINS_TOKEN, JENKINS_USER, startFakeJenkins } from "../support/fake-jenkins";
import { DASHBOARD_PATH } from "../support/scenarios";

const root = mkdtempSync(join(tmpdir(), "rl-ci-settings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PORT = 7317;
const SESSION = "s".repeat(64);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const NONE = { baseUrl: null, user: null, caFile: null, tokenStored: false };

let bitbucket: FakeBitbucket;
let jenkins: FakeJenkins;
let dir: string;
let n = 0;
const opened: Settings[] = [];
beforeEach(() => {
  bitbucket = startFakeBitbucket({ routes: { [key("GET", DASHBOARD_PATH)]: fixture("dashboard-pull-requests-page.json") } });
  jenkins = startFakeJenkins();
  dir = join(root, `case-${n++}`);
});
afterEach(() => {
  bitbucket.stop();
  jenkins.stop();
  for (const s of opened.splice(0)) s.close();
});

function memoryStore() {
  const store = new Map<string, string>();
  const backend: SecretBackend = {
    get: async (o) => store.get(o.name) ?? null,
    set: async (o) => void store.set(o.name, o.value),
    delete: async (o) => store.delete(o.name),
  };
  return { store, backend };
}

function setup(backend?: SecretBackend) {
  const settings = createSettings({
    dir,
    secrets: createSecrets(null),
    jiraSecrets: createSecrets(null, "jira-token"),
    jenkinsSecrets: createSecrets(backend ?? null, "jenkins-token"),
  });
  opened.push(settings);
  const app = createApp({ port: PORT, token: SESSION, live: createLive(), settings });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`${ORIGIN}/api/settings${path}`, {
      method,
      headers: { host: `127.0.0.1:${PORT}`, origin: ORIGIN, "x-rl-session": SESSION, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as SettingsDto & { error?: string; user?: string } };
  };
  const config = () => JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const good = { baseUrl: `${jenkins.url}/`, user: JENKINS_USER, token: JENKINS_TOKEN };
  return { settings, call, config, good, connect: () => call("PUT", "", { baseUrl: bitbucket.url, token: FAKE_TOKEN }) };
}

describe("CI server settings", () => {
  test("Save and Test need the Bitbucket settings first", async () => {
    const s = setup();
    expect((await s.call("PUT", "/jenkins", s.good)).status).toBe(409);
    expect((await s.call("POST", "/jenkins/test", s.good)).status).toBe(409);
    expect(jenkins.requests).toEqual([]);
  });

  test("Save checks whoAmI, stores the token only in the secret store, and a Bitbucket PUT keeps the block", async () => {
    const { store, backend } = memoryStore();
    const s = setup(backend);
    await s.connect();
    const r = await s.call("PUT", "/jenkins", s.good);
    expect(r.status).toBe(200);
    expect(r.body.jenkins).toEqual({ baseUrl: jenkins.url, user: JENKINS_USER, caFile: null, tokenStored: true });
    expect(jenkins.requests).toEqual(["GET /jenkins/whoAmI/api/json"]);
    expect([...store.entries()]).toEqual([["jenkins-token", JENKINS_TOKEN]]);
    expect(s.config().jenkins).toEqual({ baseUrl: jenkins.url, user: JENKINS_USER });
    expect((await s.call("PUT", "", { baseUrl: bitbucket.url, notifications: true })).status).toBe(200);
    expect((await s.call("PUT", "", { baseUrl: bitbucket.url, token: FAKE_TOKEN, markAi: false })).status).toBe(200);
    expect(s.config().jenkins).toEqual({ baseUrl: jenkins.url, user: JENKINS_USER });
    expect((await s.call("GET", "")).body.jenkins.tokenStored).toBe(true);
    // No file of the data folder (config.json, the SQLite database and its journal) holds the token.
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" });
    expect(files.length).toBeGreaterThan(1);
    for (const f of files) {
      const path = join(dir, f);
      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }
      expect(bytes.includes(JENKINS_TOKEN)).toBe(false);
    }
    const client = await s.settings.jenkins();
    expect(await client?.whoAmI()).toEqual({ name: JENKINS_USER });
    // The stored token is redacted in every later log line.
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      log(`token is ${JENKINS_TOKEN}`);
      expect(spy.mock.calls).toEqual([["token is [redacted]"]]);
    } finally {
      spy.mockRestore();
    }
  });

  test("Test checks the form values and writes nothing", async () => {
    const s = setup();
    await s.connect();
    const r = await s.call("POST", "/jenkins/test", s.good);
    expect(r).toEqual({ status: 200, body: { user: JENKINS_USER } as never });
    expect(s.config().jenkins).toBeUndefined();
    expect((await s.call("GET", "")).body.jenkins).toEqual(NONE);
    expect((await s.call("POST", "/jenkins/test", { ...s.good, token: "wrong-token" })).body.error).toBe(
      "Jenkins rejected the user name or API token. Make a new token in Jenkins and save it again.",
    );
  });

  test("401 and 403 give their own texts, the log keeps only kind and status, and nothing is stored", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
    try {
      const s = setup();
      await s.connect();
      const wrong = await s.call("PUT", "/jenkins", { ...s.good, token: "wrong-token-0123456789" });
      expect(wrong).toEqual({
        status: 400,
        body: { error: "Jenkins rejected the user name or API token. Make a new token in Jenkins and save it again." } as never,
      });
      jenkins.stop();
      jenkins = startFakeJenkins({ whoAmIStatus: 403 });
      const denied = await s.call("PUT", "/jenkins", { ...s.good, baseUrl: jenkins.url });
      expect(denied.body.error).toBe(
        `Jenkins accepted the login, but user ${JENKINS_USER} may not read /jenkins/whoAmI/api/json. Ask a Jenkins admin for Overall/Read and Job/Read.`,
      );
      expect(s.config().jenkins).toBeUndefined();
      expect(lines).toContain("CI server check failed: auth 401.");
      expect(lines).toContain("CI server check failed: forbidden 403.");
      for (const l of lines) {
        expect(l).not.toContain(JENKINS_TOKEN);
        expect(l).not.toContain("wrong-token-0123456789");
      }
    } finally {
      spy.mockRestore();
    }
  });

  test("http to a non-loopback host, a bad URL, a missing user or token, and a missing CA file give 400 with no request", async () => {
    const s = setup();
    await s.connect();
    const err = async (body: unknown) => (await s.call("PUT", "/jenkins", body)).body.error;
    expect(await err({ ...s.good, baseUrl: "http://ci.example.test" })).toBe("The CI server URL must use https.");
    expect(await err({ ...s.good, baseUrl: "https://ci.example.test/?a=1" })).toStartWith("Give the CI server base URL only");
    expect(await err({ ...s.good, user: "" })).toBe("Enter the CI server user name.");
    expect(await err({ ...s.good, token: "" })).toBe("Enter the API token. A new CI server URL needs a new token.");
    expect(await err({ ...s.good, caFile: join(dir, "none.pem") })).toBe("Cannot read the CA file.");
    expect(jenkins.requests).toEqual([]);
  });

  test("the same origin reuses the stored token, a new origin needs one, and an empty URL disconnects", async () => {
    const { store, backend } = memoryStore();
    const s = setup(backend);
    await s.connect();
    await s.call("PUT", "/jenkins", s.good);
    expect((await s.call("PUT", "/jenkins", { baseUrl: jenkins.url, user: JENKINS_USER })).status).toBe(200);
    const other = startFakeJenkins();
    try {
      expect((await s.call("PUT", "/jenkins", { baseUrl: other.url, user: JENKINS_USER })).body.error).toBe(
        "Enter the API token. A new CI server URL needs a new token.",
      );
      expect(other.requests).toEqual([]);
    } finally {
      other.stop();
    }
    const off = await s.call("PUT", "/jenkins", { baseUrl: "" });
    expect(off.body.jenkins).toEqual(NONE);
    expect(store.size).toBe(0);
    expect(s.config().jenkins).toBeUndefined();
    expect(await s.settings.jenkins()).toBeNull();
  });
});
