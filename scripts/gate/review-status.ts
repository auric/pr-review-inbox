// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Gate G-RS (integration-check.md "Review status", U112 to U117): the Bitbucket calls of Approve and Needs work.
// It WRITES the review status of the token user on the PR: approve, remove the approval, needs work, clear. At the end it sets the status
// from before the run again. Run it only on a test PR where the token user is a reviewer and where a status change is harmless.
// Usage: bun scripts/gate/review-status.ts --pr <PR URL> --authorize-writes [--own-pr <PR URL of the token user>]
// --own-pr: one approve POST on a PR that the token user wrote, to see the status that Bitbucket gives the author.
// Token: GATE_BITBUCKET_TOKEN only. The token goes only to the origin of the PR URL, in the Authorization header.
// The console holds only status codes, enum-like strings, booleans, and key names. No names, texts, or URLs.
import { z } from "zod";
import { pullRequest } from "../../src/server/bitbucket/schemas";
import { foldCase } from "../../src/shared/me";

const TIMEOUT_MS = 30_000;
const USAGE = "usage: bun scripts/gate/review-status.ts --pr <PR URL> --authorize-writes [--own-pr <PR URL of the token user>]";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prUrl = arg("--pr");
const ownUrl = arg("--own-pr");
if (!prUrl || !argv.includes("--authorize-writes")) {
  console.error(USAGE);
  process.exit(2);
}
const token = process.env.GATE_BITBUCKET_TOKEN;
if (!token) {
  console.error("No token. Set GATE_BITBUCKET_TOKEN.");
  process.exit(2);
}

// The REST path of a PR web URL, with the context path of the server.
function restPath(input: string): { origin: string; path: string } {
  const u = new URL(input);
  if (u.protocol !== "https:") throw new Error("The PR URL must use https.");
  const m = u.pathname.match(/^(.*?)\/(projects|users)\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)(?:\/|$)/);
  if (!m?.[3] || !m[4] || !m[5]) throw new Error("Not a pull request URL.");
  const project = m[2] === "users" ? `~${decodeURIComponent(m[3]).toUpperCase()}` : decodeURIComponent(m[3]);
  const repo = decodeURIComponent(m[4]);
  return {
    origin: u.origin,
    path: `${m[1]}/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/pull-requests/${m[5]}`,
  };
}

const target = restPath(prUrl);
const own = ownUrl ? restPath(ownUrl) : null;
if (own && own.origin !== target.origin) throw new Error("Both PR URLs must have the same origin.");

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(target.origin + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, user: res.headers.get("x-ausername") };
}

const keys = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().join(",") : String(v === null ? "empty" : typeof v);
const ENUM = /^[A-Z_]{1,40}$/;
const safe = (s: string | undefined) => (s && ENUM.test(s) ? s : "other");

// The reviewer entry of the token user in a fresh GET.
async function mine() {
  const r = await call("GET", target.path);
  if (r.status !== 200 || !r.user) throw new Error(`PR GET: HTTP ${r.status}`);
  const pr = pullRequest
    .extend({
      reviewers: z.array(
        z.object({
          user: z.object({ name: z.string(), slug: z.string() }),
          status: z.string(),
          approved: z.boolean().optional(),
          lastReviewedCommit: z.string().optional(),
        }),
      ),
    })
    .parse(r.json);
  const me = foldCase(r.user);
  const entry = pr.reviewers.find((x) => foldCase(x.user.name) === me || foldCase(x.user.slug) === me);
  return { pr, entry, author: foldCase(pr.author.user.name) === me, me: r.user };
}

const before = await mine();
console.log(
  `token user is author=${before.author} reviewer=${Boolean(before.entry)} slugEqualsUsername=${before.entry ? before.entry.user.slug === before.entry.user.name : "n/a"}`,
);
if (!before.entry) {
  console.error("Refused: the token user is not a reviewer of the PR.");
  process.exit(1);
}
const { slug, name } = before.entry.user;
const initial = before.entry.status;
console.log(`before: status=${safe(initial)} approved=${before.entry.approved}`);

const approve = `${target.path}/approve`;
const participant = (status: string, who = slug) =>
  call("PUT", `${target.path}/participants/${encodeURIComponent(who)}`, { user: { name }, approved: false, status });

const steps: [string, () => ReturnType<typeof call>][] = [
  ["approve POST", () => call("POST", approve)],
  ["approve DELETE", () => call("DELETE", approve)],
  ["participants PUT NEEDS_WORK", () => participant("NEEDS_WORK")],
  ["participants PUT UNAPPROVED", () => participant("UNAPPROVED")],
];
// U115: the path with the username, only when it differs from the slug.
if (slug !== name) steps.push(["participants PUT NEEDS_WORK with the username in the path", () => participant("NEEDS_WORK", name)]);

try {
  for (const [label, run] of steps) {
    const r = await run();
    const after = await mine();
    console.log(
      `${label}: HTTP ${r.status} body=${keys(r.json)} status=${safe((r.json as { status?: string } | null)?.status)} after: status=${safe(after.entry?.status)} approved=${after.entry?.approved} lastReviewedCommit=${Boolean(after.entry?.lastReviewedCommit)}`,
    );
  }
} finally {
  // The status from before the run, also after a failed step.
  const restore =
    initial === "APPROVED" ? await call("POST", approve) : await participant(initial === "NEEDS_WORK" ? "NEEDS_WORK" : "UNAPPROVED");
  console.log(`restore ${safe(initial)}: HTTP ${restore.status} now: status=${safe((await mine()).entry?.status)}`);
}

if (own) {
  const r = await call("POST", `${own.path}/approve`);
  const e = (r.json as { errors?: { exceptionName?: string }[] } | null)?.errors?.[0]?.exceptionName;
  console.log(`author approve POST: HTTP ${r.status} exception=${e ? e.slice(e.lastIndexOf(".") + 1).replace(/[^A-Za-z]/g, "") : "none"}`);
  if (r.status === 200) console.log("author approve was accepted. Remove the approval on Bitbucket by hand.");
}
