// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The Jenkins client (part-session.md section 2.15, package C2; spec.md section 6.31).
import { afterEach, describe, expect, test } from "bun:test";
import { createJenkinsClient, JenkinsError } from "../../src/server/ci/jenkins";
import { type FakeJenkinsOptions, JENKINS_LOG, JENKINS_TOKEN, JENKINS_USER, startFakeJenkins } from "../support/fake-jenkins";

const started: { stop: () => void }[] = [];
afterEach(() => {
  for (const s of started.splice(0)) s.stop();
});

function fake(o: FakeJenkinsOptions = {}) {
  const f = startFakeJenkins(o);
  started.push(f);
  const client = (extra: { token?: string; maxLogBytes?: number } = {}) =>
    createJenkinsClient({ baseUrl: f.url, user: JENKINS_USER, token: extra.token ?? JENKINS_TOKEN, maxLogBytes: extra.maxLogBytes });
  return { f, client, build: `${f.url}/job/team/job/sample-ci/job/main/1/` };
}

async function failure(p: Promise<unknown>): Promise<JenkinsError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof JenkinsError) return e;
    throw e;
  }
  throw new Error("no error");
}

describe("whoAmI", () => {
  test("a valid login gives the user name with one GET", async () => {
    const { f, client } = fake();
    expect(await client().whoAmI()).toEqual({ name: JENKINS_USER });
    expect(f.requests).toEqual(["GET /jenkins/whoAmI/api/json"]);
  });

  test("401, 403, 404, 5xx, a redirect, and an anonymous login each give their own sentence without the token", async () => {
    const wrong = await failure(fake().client({ token: "wrong-token" }).whoAmI());
    expect([wrong.kind, wrong.message]).toEqual([
      "auth",
      "Jenkins rejected the user name or API token. Make a new token in Jenkins and save it again.",
    ]);
    const denied = await failure(fake({ whoAmIStatus: 403 }).client().whoAmI());
    expect([denied.kind, denied.message]).toEqual([
      "forbidden",
      `Jenkins accepted the login, but user ${JENKINS_USER} may not read /jenkins/whoAmI/api/json. Ask a Jenkins admin for Overall/Read and Job/Read.`,
    ]);
    expect((await failure(fake({ whoAmIStatus: 404 }).client().whoAmI())).message).toBe(
      "Jenkins has no page at /jenkins/whoAmI/api/json. Check the Jenkins URL.",
    );
    expect((await failure(fake({ whoAmIStatus: 503 }).client().whoAmI())).message).toBe("Jenkins failed to answer (HTTP 503).");
    expect((await failure(fake({ whoAmIStatus: 302 }).client().whoAmI())).kind).toBe("redirect");
    expect((await failure(fake({ anonymous: true }).client().whoAmI())).kind).toBe("login");
    for (const e of [wrong, denied]) expect(e.message).not.toContain(JENKINS_TOKEN);
  });

  test("plain http works only on loopback, and an unreadable CA file throws an fs error", () => {
    expect(() => createJenkinsClient({ baseUrl: "http://ci.example.test", user: "u", token: "t" })).toThrow(
      "The CI server URL must use https.",
    );
    expect(() => createJenkinsClient({ baseUrl: "ftp://ci.example.test", user: "u", token: "t" })).toThrow();
    expect(() => createJenkinsClient({ baseUrl: "http://localhost:1/jenkins", user: "u", token: "t" })).not.toThrow();
    expect(() => createJenkinsClient({ baseUrl: "https://ci.example.test", user: "u", token: "t", caFile: "/none/ca.pem" })).toThrow(
      expect.objectContaining({ code: "ENOENT" }),
    );
  });
});

describe("readLog", () => {
  test("a log within the cap takes one GET from start 0", async () => {
    const { f, client, build } = fake();
    const size = new TextEncoder().encode(JENKINS_LOG).length;
    expect(await client().readLog(build)).toEqual({ text: JENKINS_LOG, size, start: 0 });
    expect(f.requests).toEqual(["GET /jenkins/job/team/job/sample-ci/job/main/1/logText/progressiveText?start=0"]);
  });

  test("a log over the cap reads the last cap bytes with start = X-Text-Size - cap", async () => {
    const log = `${"a".repeat(100)}TAIL-0123456789`;
    const { f, client, build } = fake({ log });
    const r = await client({ maxLogBytes: 15 }).readLog(build.replace(/\/$/, ""));
    expect(r).toEqual({ text: "TAIL-0123456789", size: 115, start: 100 });
    expect(f.requests).toEqual([
      "GET /jenkins/job/team/job/sample-ci/job/main/1/logText/progressiveText?start=0",
      "GET /jenkins/job/team/job/sample-ci/job/main/1/logText/progressiveText?start=100",
    ]);
  });

  test("a server that ignores start and sends more than the cap gives an error, not the head of the log", async () => {
    const { client, build } = fake({ log: "x".repeat(100), ignoreStart: true });
    expect((await failure(client({ maxLogBytes: 10 }).readLog(build))).message).toBe(
      "Jenkins sent more log text than asked for. The app cannot read this build log.",
    );
  });

  test("a build URL of another origin, outside the base path, or with a login gets no request", async () => {
    const { f, client } = fake();
    const other = startFakeJenkins();
    started.push(other);
    const origin = new URL(f.url).origin;
    for (const url of [
      `${other.url}/job/team/job/sample-ci/job/main/1/`,
      `https://ci.example.test/jenkins/job/team/job/sample-ci/job/main/1/`,
      `${origin}/other/job/x/1/`,
      `${origin}/jenkinsx/job/x/1/`,
      `${f.url.replace("://", "://user:pw@")}/job/x/1/`,
      "not a url",
    ])
      expect((await failure(client().readLog(url))).kind).toBe("origin");
    expect(f.requests).toEqual([]);
    expect(other.requests).toEqual([]);
  });

  test("a redirect is not followed", async () => {
    const target = startFakeJenkins();
    started.push(target);
    const { f, client, build } = fake({ logRedirect: `${target.url}/job/team/job/sample-ci/job/main/1/logText/progressiveText` });
    const e = await failure(client().readLog(build));
    expect([e.kind, e.status]).toEqual(["redirect", 302]);
    expect(f.requests).toHaveLength(1);
    expect(target.requests).toEqual([]);
  });

  test("401, 404, and an answer without X-Text-Size give their own errors", async () => {
    const { client, build } = fake();
    expect((await failure(client({ token: "wrong-token" }).readLog(build))).kind).toBe("auth");
    expect((await failure(client().readLog(build.replace("/main/", "/none/")))).kind).toBe("not_found");
    const bare = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("log text") });
    started.push({ stop: () => bare.stop(true) });
    const base = `http://127.0.0.1:${bare.port}`;
    const e = await failure(createJenkinsClient({ baseUrl: base, user: "u", token: "t" }).readLog(`${base}/job/x/1/`));
    expect(e.message).toBe("Jenkins sent the log without its size. The app cannot read this build log.");
  });
});
