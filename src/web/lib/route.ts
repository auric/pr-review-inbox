// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// URL state of the shell (plan pr-view-v4 section 5). parseRoute, formatRoute, and navMode are pure.
// The history helpers keep the entry depth and the scrollTop of the detail in history.state.

// "runs" and "post": the Review runs and Ready to post views of the AI review group (prototype/v3 AIVIEWS).
// "archive": the PRs that no other view shows (views.ts archived). "tasks": the Tasks view (docs/plans/review-v2/spec.md section 6.12).
export const LIST_VIEWS = ["needs", "reviewing", "mine", "following", "archive", "runs", "post", "tasks"] as const;
export type ListView = (typeof LIST_VIEWS)[number];

export const SETTINGS_SECTIONS = [
  "connection",
  "checks",
  "notifications",
  "posts",
  "appearance",
  "profiles",
  "quality",
  "task-ids",
  "tracker",
  "ci",
  "tasks",
  "commands",
  "clones",
  "instructions",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

// id: the PR number on the forge, not the local row id.
export type PrRef = { project: string; repo: string; id: number };
export type FileRef = { path: string; line: number | null; side: "new" | "old" };

export type ListRoute = {
  kind: "list";
  view: ListView;
  pr: PrRef | null;
  // thread, file, full, and explain need a PR. explain: the Explain page of the PR (docs/plans/review-v2/spec.md section 3.1).
  // The Explain page URL has no thread and no file.
  thread: number | null;
  file: FileRef | null;
  full: boolean;
  explain: boolean;
  // "project/repo": the repository filter.
  repo: string | null;
  q: string;
  // The task of the Tasks view: /tasks/:id. Only view "tasks" has one.
  task: number | null;
};
export type SettingsRoute = { kind: "settings"; section: SettingsSection | null; profile: string | null };
export type Route = ListRoute | SettingsRoute;

export const listRoute = (view: ListView = "needs"): ListRoute => ({
  kind: "list",
  view,
  pr: null,
  thread: null,
  file: null,
  full: false,
  explain: false,
  repo: null,
  q: "",
  task: null,
});

export const prKeyOf = (r: PrRef) => `${encodeURIComponent(r.project)}/${encodeURIComponent(r.repo)}/${r.id}`;

const has = <T extends string>(list: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (list as readonly string[]).includes(v);
const count = (v: string | null | undefined) => (v && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : null);

// pathname: the encoded path, as location.pathname gives it. search: with or without the "?".
export function parseRoute(pathname: string, search: string): Route {
  let seg: string[];
  try {
    seg = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return listRoute();
  }
  const q = new URLSearchParams(search);
  if (seg[0] === "settings") {
    const section = has(SETTINGS_SECTIONS, seg[1]) ? seg[1] : null;
    return { kind: "settings", section, profile: section === "profiles" && seg[2] ? seg[2] : null };
  }
  // An unknown view drops the rest of the path.
  if (seg.length && !has(LIST_VIEWS, seg[0])) return listRoute();
  const out = listRoute(has(LIST_VIEWS, seg[0]) ? seg[0] : "needs");
  if (out.view === "tasks") {
    out.task = seg.length === 2 ? count(seg[1]) : null;
    return out;
  }
  out.repo = q.get("repo") || null;
  out.q = q.get("q") ?? "";
  const [, project, repo, num, page] = seg;
  const id = count(num);
  const explain = seg.length === 5 && page === "explain";
  if ((seg.length !== 4 && !explain) || !project || !repo || id === null) return out;
  out.pr = { project, repo, id };
  out.full = q.get("full") === "1";
  if (explain) {
    out.explain = true;
    return out;
  }
  out.thread = count(q.get("thread"));
  const path = q.get("file");
  if (path) {
    const line = count(q.get("line"));
    out.file = { path, line, side: line !== null && q.get("side") === "old" ? "old" : "new" };
  }
  return out;
}

// A query value keeps "/" readable. encodeURIComponent keeps "~".
const enc = (v: string) => encodeURIComponent(v).replace(/%2F/g, "/");

export function formatRoute(r: Route): string {
  if (r.kind === "settings") {
    const tail = r.section === "profiles" && r.profile ? `/${encodeURIComponent(r.profile)}` : "";
    return `/settings${r.section ? `/${r.section}` : ""}${tail}`;
  }
  if (r.view === "tasks") return r.task === null ? "/tasks" : `/tasks/${r.task}`;
  const path = r.pr
    ? `/${r.view}/${encodeURIComponent(r.pr.project)}/${encodeURIComponent(r.pr.repo)}/${r.pr.id}${r.explain ? "/explain" : ""}`
    : `/${r.view}`;
  const q: [string, string][] = [];
  if (r.pr) {
    if (r.thread !== null && !r.explain) q.push(["thread", String(r.thread)]);
    if (r.file && !r.explain) {
      q.push(["file", r.file.path]);
      if (r.file.line !== null) {
        q.push(["line", String(r.file.line)]);
        if (r.file.side === "old") q.push(["side", "old"]);
      }
    }
    if (r.full) q.push(["full", "1"]);
  }
  if (r.repo) q.push(["repo", r.repo]);
  if (r.q) q.push(["q", r.q]);
  return q.length ? `${path}?${q.map(([k, v]) => `${k}=${enc(v)}`).join("&")}` : path;
}

// Plan pr-view-v4 section 5. Push: a view change, a PR open by click or Enter (opened), Settings open, a settings section or
// profile, a file open, full width on or off, the Explain page open, and a step from it to the PR by a link (opened).
// Everything else replaces: j and k, thread focus, filter text, the repository chip, a file close, Settings close, and Back from
// an Explain page that has no earlier entry.
export function navMode(from: Route, to: Route, opened: boolean): "push" | "replace" {
  if (to.kind === "settings")
    return from.kind !== "settings" || from.section !== to.section || from.profile !== to.profile ? "push" : "replace";
  if (from.kind === "settings") return "replace";
  if (from.view !== to.view || (to.repo !== null && from.repo !== to.repo)) return "push";
  if (to.view === "tasks") return from.task !== to.task && opened && to.task !== null ? "push" : "replace";
  const samePr = (from.pr && prKeyOf(from.pr)) === (to.pr && prKeyOf(to.pr));
  if (!samePr) return opened && to.pr ? "push" : "replace";
  if (from.explain !== to.explain) return to.explain || opened ? "push" : "replace";
  if (from.full !== to.full) return "push";
  if (to.file && from.file?.path !== to.file.path) return "push";
  return "replace";
}

// ---------- History ----------

type Entry = { idx: number; scroll: number | null };

function entry(): Entry {
  const s = history.state as Partial<Entry> | null;
  return { idx: typeof s?.idx === "number" ? s.idx : 0, scroll: typeof s?.scroll === "number" ? s.scroll : null };
}

// The latest scrollTop of the detail. A timer copies it into the current entry, so a reload and Forward find it too.
let top = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const SAVE_MS = 150;

// Browsers limit history calls, for example to 100 in 30 s. Over the limit a call throws or does nothing.
function save(scroll: number) {
  try {
    history.replaceState({ ...history.state, ...entry(), scroll }, "");
  } catch {
    // The next save or write tries again.
  }
}

export function noteScroll(y: number) {
  top = y;
  clearTimeout(timer);
  timer = setTimeout(() => save(top), SAVE_MS);
}

export const here = () => location.pathname + location.search;
// The browser form of a URL. The browser escapes some characters of a query, such as "'".
const norm = (url: string) => {
  const u = new URL(url, location.href);
  return u.pathname + u.search;
};

// A write that the browser drops tries again. A newer write replaces it.
let retry: ReturnType<typeof setTimeout> | undefined;
const RETRY_MS = 1000;
const RETRIES = 10;

export function writeUrl(url: string, mode: "push" | "replace", tries = RETRIES) {
  clearTimeout(retry);
  const want = norm(url);
  if (want === here()) return;
  clearTimeout(timer);
  const e = entry();
  try {
    if (mode === "push") {
      history.replaceState({ ...history.state, ...e, scroll: top }, "");
      history.pushState({ idx: e.idx + 1, scroll: null }, "", url);
    } else history.replaceState({ ...history.state, ...e }, "", url);
  } catch {
    // The check below tries again.
  }
  if (here() === want) {
    if (mode === "push") top = 0;
  } else if (tries > 0) retry = setTimeout(() => writeUrl(url, mode, tries - 1), RETRY_MS);
}

// After a popstate or at start: the saved scrollTop of the current entry, or null.
export function enterEntry(): number | null {
  clearTimeout(timer);
  const s = entry().scroll;
  top = s ?? 0;
  return s;
}

// False for the first entry of the app, for example a link opened in a new tab.
export const canGoBack = () => entry().idx > 0;

// The Explain page entry that the entry of its PR pushed. A replace, for example a Settings close, gives an entry without the mark.
export function markBack() {
  try {
    history.replaceState({ ...history.state, back: true }, "");
  } catch {
    // Back then goes to the PR without a history step.
  }
}
export const backIsPr = () => (history.state as { back?: unknown } | null)?.back === true;

const USER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
const RESTORE_MS = 2000;

// Sets scrollTop on each frame until it holds and the content height stays the same for one frame, user input comes, or
// RESTORE_MS ends. Content that renders after the call can move the position, so one set is not enough. Returns the stop function.
export function restoreScroll(box: HTMLElement, y: number): () => void {
  const end = performance.now() + RESTORE_MS;
  let frame = 0;
  let height = -1;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const t of USER_INPUT) window.removeEventListener(t, stop, { capture: true });
  };
  const step = () => {
    box.scrollTop = y;
    const held = Math.abs(box.scrollTop - y) < 1 && box.scrollHeight === height;
    height = box.scrollHeight;
    if (held || performance.now() > end) stop();
    else frame = requestAnimationFrame(step);
  };
  for (const t of USER_INPUT) window.addEventListener(t, stop, { capture: true, passive: true });
  step();
  return stop;
}
