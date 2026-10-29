// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Fake Jenkins for tests and the CI gate dry run. It listens on 127.0.0.1 only, under the context path /jenkins.
// It holds one folder with one multibranch project. Job names use the NameEncoder form: "feature/x" is the job "feature%2Fx".
export const JENKINS_USER = "jdoe";
export const JENKINS_TOKEN = "fake-jenkins-token-0123456789";
export const JENKINS_VERSION = "2.479.3";
const CTX = "/jenkins";
const CRUMB = "fake-crumb-0123456789abcdef";
const COOKIE = "JSESSIONID.fake=node0fakesession";
const MULTIBRANCH = "org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject";

type Job = { inQueue: boolean; queueItem: number | null; lastBuild: number | null };
// jobs: the job names at start. onScan: the job names that a scan adds after scanDelayMs.
// autoBuildOnScan: a job that a scan adds starts with a queued build. requireCrumb: false turns CSRF protection off.
export type FakeJenkinsOptions = {
  folder?: string;
  project?: string;
  jobs?: string[];
  onScan?: string[];
  autoBuildOnScan?: boolean;
  scanDelayMs?: number;
  requireCrumb?: boolean;
  params?: string[];
};

export function startFakeJenkins(o: FakeJenkinsOptions = {}) {
  const folder = o.folder ?? "team";
  const project = o.project ?? "sample-ci";
  const params = o.params ?? [];
  const requireCrumb = o.requireCrumb ?? true;
  const jobs = new Map<string, Job>((o.jobs ?? ["main"]).map((n) => [n, { inQueue: false, queueItem: null, lastBuild: null }]));
  const queue = new Map<number, { job: string; polls: number }>();
  let nextItem = 100;
  let nextBuild = 1;
  const auth = `Basic ${btoa(`${JENKINS_USER}:${JENKINS_TOKEN}`)}`;
  // requests: "METHOD /path?query" of each request. builds: the job names of each build POST.
  const state = { requests: [] as string[], builds: [] as string[], scans: 0 };

  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "X-Jenkins": JENKINS_VERSION, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    });
  const enqueue = (name: string, job: Job) => {
    const id = nextItem++;
    queue.set(id, { job: name, polls: 0 });
    Object.assign(job, { inQueue: true, queueItem: id });
    return id;
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`${req.method} ${url.pathname}${url.search}`);
      if (!url.pathname.startsWith(`${CTX}/`)) return reply(404);
      if (req.headers.get("authorization") !== auth) return reply(401);
      if (
        req.method === "POST" &&
        requireCrumb &&
        (req.headers.get("Jenkins-Crumb") !== CRUMB || !(req.headers.get("cookie") ?? "").includes(COOKIE))
      )
        return reply(403);
      const p = url.pathname.slice(CTX.length);
      if (req.method === "GET" && p === "/whoAmI/api/json")
        return reply(200, {
          _class: "hudson.security.WhoAmI",
          name: JENKINS_USER,
          anonymous: false,
          authenticated: true,
          authorities: ["authenticated"],
        });
      if (req.method === "GET" && p === "/crumbIssuer/api/json")
        return requireCrumb
          ? reply(
              200,
              { _class: "hudson.security.csrf.DefaultCrumbIssuer", crumb: CRUMB, crumbRequestField: "Jenkins-Crumb" },
              { "Set-Cookie": `${COOKIE}; Path=/jenkins; HttpOnly` },
            )
          : reply(404);
      const qm = p.match(/^\/queue\/item\/(\d+)\/api\/json$/);
      if (req.method === "GET" && qm) {
        const item = queue.get(Number(qm[1]));
        const job = item && jobs.get(item.job);
        if (!item || !job) return reply(404);
        if (item.polls++ < 1)
          return reply(200, { _class: "hudson.model.Queue$WaitingItem", why: "In the quiet period.", cancelled: false });
        if (job.inQueue) Object.assign(job, { inQueue: false, queueItem: null, lastBuild: nextBuild++ });
        return reply(200, {
          _class: "hudson.model.Queue$LeftItem",
          cancelled: false,
          executable: { _class: "org.jenkinsci.plugins.workflow.job.WorkflowRun", number: job.lastBuild },
        });
      }
      // /job/<a>/job/<b>/.../<rest>: each <a> is a job name, encoded once more in the URL.
      const parts = p.split("/").slice(1);
      const names: string[] = [];
      while (parts[0] === "job" && parts[1] !== undefined) {
        names.push(decodeURIComponent(parts[1]));
        parts.splice(0, 2);
      }
      const rest = parts.join("/");
      if (names.length === 1 && names[0] === folder && rest === "api/json" && req.method === "GET")
        return reply(200, { _class: "com.cloudbees.hudson.plugins.folder.Folder", jobs: [{ name: project }] });
      if (names[0] !== folder || names[1] !== project) return reply(404);
      if (names.length === 2) {
        if (rest === "api/json")
          return reply(200, { _class: MULTIBRANCH, buildable: true, jobs: [...jobs.keys()].map((name) => ({ name })) });
        if (rest === "indexing/api/json" && req.method === "GET")
          return reply(200, { _class: "jenkins.branch.MultiBranchProject$BranchIndexing" });
        if (rest === "build" && req.method === "POST") {
          state.scans++;
          setTimeout(() => {
            for (const n of o.onScan ?? []) {
              if (jobs.has(n)) continue;
              const job: Job = { inQueue: false, queueItem: null, lastBuild: null };
              jobs.set(n, job);
              if (o.autoBuildOnScan) enqueue(n, job);
            }
          }, o.scanDelayMs ?? 0);
          return reply(302, undefined, { Location: `${url.origin}${CTX}/job/${folder}/job/${project}/` });
        }
        return reply(404);
      }
      const name = names[2] ?? "";
      const job = names.length === 3 ? jobs.get(name) : undefined;
      if (!job) return reply(404);
      if (rest === "api/json" && req.method === "GET")
        return reply(200, {
          _class: "org.jenkinsci.plugins.workflow.job.WorkflowJob",
          name,
          buildable: true,
          inQueue: job.inQueue,
          queueItem: job.queueItem === null ? null : { id: job.queueItem },
          lastBuild: job.lastBuild === null ? null : { number: job.lastBuild },
          property: params.length
            ? [{ _class: "hudson.model.ParametersDefinitionProperty", parameterDefinitions: params.map((n) => ({ name: n })) }]
            : [],
        });
      // A parameterized job refuses "build" without a form, and a plain job refuses "buildWithParameters".
      if (req.method === "POST" && (rest === "build" || rest === "buildWithParameters")) {
        if ((rest === "buildWithParameters") !== params.length > 0) return reply(400);
        state.builds.push(name);
        const id = job.inQueue && job.queueItem !== null ? job.queueItem : enqueue(name, job);
        return reply(201, undefined, { Location: `${url.origin}${CTX}/queue/item/${id}/` });
      }
      return reply(404);
    },
  });

  return Object.assign(state, {
    url: `http://127.0.0.1:${server.port}${CTX}`,
    folder,
    project,
    stop: () => server.stop(true),
  });
}

export type FakeJenkins = ReturnType<typeof startFakeJenkins>;
