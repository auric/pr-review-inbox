// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Archive, ArrowLeft, Send, Terminal } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Group, PrRow, TaskCreateInput } from "../shared/dto";
import { GROUPS, VIEW_LABEL, VIEWS, type View } from "../shared/views";
import { type Effect, type KeyState, type Layer, reduceKey } from "./keys";
import {
  backIsPr,
  canGoBack,
  enterEntry,
  type FileRef,
  formatRoute,
  type ListView,
  markBack,
  navMode,
  noteScroll,
  type PrRef,
  parseRoute,
  prKeyOf,
  type Route,
  type SettingsSection,
  writeUrl,
} from "./lib/route";
import { useLive } from "./live";
import { useMeta } from "./meta";
import { useClaims } from "./notify";
import { type DetailApi, type DetailAt, type DetailPatch, PrDetail } from "./pr/PrDetail";
import { useReadyToPost } from "./publish/data";
import { readyLine } from "./publish/model";
import { useRuns } from "./review/data";
import { latestByPr, runRows } from "./review/model";
import { trackerOf } from "./review/tasks";
import { Settings, type SettingsAt } from "./settings/Settings";
import {
  claimEvents,
  isStale,
  isStopped,
  retry,
  type Status,
  useArchived,
  useCheckNow,
  useFollowUrl,
  usePrs,
  useRestore,
  useSettings,
  useStatus,
} from "./shell/data";
import { HelpSheet } from "./shell/HelpSheet";
import { ListPane } from "./shell/ListPane";
import { fitList, listCap, listDefault, railOn, readListWidth, readSide, type SidePref, writeListWidth, writeSide } from "./shell/layout";
import {
  filterRows,
  followCandidate,
  freezeOrder,
  groupRows,
  incompleteText,
  type ListGroup,
  matches,
  movedCount,
  navIds,
  repoTree,
  type Slot,
  statusInfo,
  unreadTotal,
  viewCounts,
} from "./shell/model";
import { Sidebar, useNow } from "./shell/Sidebar";
import { Splitter } from "./shell/Splitter";
import { Calm } from "./states";
import { createTask, useTasks } from "./tasks/data";
import { rowStatus } from "./tasks/model";
import { TaskList, taskGroups } from "./tasks/TaskList";
import { type TaskApi, TaskView } from "./tasks/TaskView";

export function App() {
  const [stale, setStale] = useState(false);
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // A stopped server shows its state at once. The live channel refetches after it reconnects.
          queries: { retry },
        },
        mutationCache: new MutationCache({ onError: (e) => isStale(e) && setStale(true) }),
      }),
  );
  useLive(qc);
  return (
    <QueryClientProvider client={qc}>
      <Toaster>
        <TooltipProvider delay={500}>
          <Shell stale={stale} />
        </TooltipProvider>
      </Toaster>
    </QueryClientProvider>
  );
}

const INITIAL: KeyState = { focus: "list", mobile: "list", selected: null, help: false, settings: false, chord: null };

function media(query: string) {
  const q = window.matchMedia(query);
  const subscribe = (fn: () => void) => {
    q.addEventListener("change", fn);
    return () => q.removeEventListener("change", fn);
  };
  return { q, use: () => useSyncExternalStore(subscribe, () => q.matches) };
}
// One pane at a time below 760 px (index.css). The URL then names a PR only while the detail shows it, so Back returns to the list.
const narrowMedia = media("(max-width: 759px)");
// Decision D4: the sidebar choice "auto" gives the rail below 1440 px.
const wideMedia = media("(min-width: 1440px)");
const onResize = (fn: () => void) => {
  addEventListener("resize", fn);
  return () => removeEventListener("resize", fn);
};

const prRef = (p: PrRow): PrRef => ({ project: p.project, repo: p.repo, id: p.prId });
// The effects of keys that act on a PR. The Tasks view ignores them.
const DETAIL_ONLY: ReadonlySet<Effect> = new Set<Effect>([
  "next-new",
  "prev-new",
  "next-your",
  "files",
  "commits",
  "show-in-diff",
  "overview",
  "drafts",
  "log",
  "rerun",
  "rereview",
  "ask",
  "brief",
  "accept",
  "edit",
  "discard",
  "discuss",
  "post",
  "fix",
  "fix-list",
  "resolve",
  "explain",
  "explain-back",
]);
const findRef = (list: PrRow[] | undefined, r: PrRef) => list?.find((p) => p.prId === r.id && p.project === r.project && p.repo === r.repo);
const DONE: readonly Group[] = GROUPS.find((g) => g[0] === "done")?.[2] ?? [];

// The thread and the file of the URL. key: the PR that they belong to (prKeyOf). explain: the Explain page of that PR shows.
// The PR keeps its thread and file under the Explain page.
type DetailRoute = { key: string | null; thread: number | null; file: FileRef | null; explain: boolean };
type SettingsPlace = { section: SettingsSection | null; profile: string | null };

const EMPTY: Record<Exclude<ListView, "post" | "tasks">, string> = {
  needs: "Nothing needs you. New replies and review requests show here.",
  reviewing: "No open pull requests to review.",
  mine: "You have no open pull requests.",
  following: "You follow no pull requests. Paste a pull request URL into the filter to follow it.",
  runs: "No review has run yet. Open a pull request and press r to start one.",
  archive: "Nothing is archived.",
};

function Shell({ stale }: { stale: boolean }) {
  const meta = useMeta();
  const prs = usePrs();
  const status = useStatus();
  const settings = useSettings();
  const checkNow = useCheckNow();
  const follow = useFollowUrl();
  const restore = useRestore();
  const narrow = narrowMedia.use();
  const wide = wideMedia.use();
  // The URL at start: a reload or a link opened in a new tab shows the same place.
  const [start] = useState(() => ({ route: parseRoute(location.pathname, location.search), scroll: enterEntry() }));
  const r0 = start.route.kind === "list" ? start.route : null;
  const s0: SettingsPlace =
    start.route.kind === "settings" ? { section: start.route.section, profile: start.route.profile } : { section: null, profile: null };
  const [view, setView] = useState<ListView>(r0?.view ?? "needs");
  // The task that the Tasks view shows (docs/plans/review-v2/spec.md section 6.12). The PR selection stays apart from it.
  const [task, setTask] = useState<number | null>(r0?.task ?? null);
  const taskApi = useRef<TaskApi | null>(null);
  const [repo, setRepo] = useState<string | null>(r0?.repo ?? null);
  const [query, setQuery] = useState(r0?.q ?? "");
  const [doneOpen, setDoneOpen] = useState(false);
  const [ks, setKs] = useState<KeyState>(() => {
    const detail = start.route.kind === "settings" || !!r0?.pr;
    return {
      ...INITIAL,
      settings: start.route.kind === "settings",
      mobile: detail ? "detail" : "list",
      focus: detail && narrowMedia.q.matches ? "detail" : "list",
    };
  });
  const [frozen, setFrozen] = useState<{ scope: string; slots: Slot[] }>({ scope: "", slots: [] });
  // The PR that the URL names. It waits for the PR list, then becomes the selection. A PR that no list holds stays named.
  const [pin, setPin] = useState<PrRef | null>(r0?.pr ?? null);
  // The PR that the last pin selected. It stays in the list while selected, also when it does not match the view.
  const [routed, setRouted] = useState<number | null>(null);
  const [detail, setDetail] = useState<DetailRoute>({
    key: r0?.pr ? prKeyOf(r0.pr) : null,
    thread: r0?.thread ?? null,
    file: r0?.file ?? null,
    explain: r0?.explain ?? false,
  });
  // The thread, file, and scroll position that the detail restores. n changes on each Back or Forward.
  const [at, setAt] = useState<DetailAt | null>(() =>
    r0?.pr ? { key: prKeyOf(r0.pr), thread: r0.thread, file: r0.file, close: null, scroll: start.scroll, n: 0, explain: r0.explain } : null,
  );
  // Full width (plan pr-view-v4 4.3, decision D5): "full=1" in the URL, so Back leaves it.
  const [full, setFull] = useState(r0?.full ?? false);
  // Viewer preferences in localStorage, never in the URL (plan pr-view-v4 4.4). listW null: the default width.
  const [side, setSide] = useState<SidePref>(readSide);
  const [listW, setListW] = useState<number | null>(readListWidth);
  const [settingsRoute, setSettingsRoute] = useState<SettingsPlace>(s0);
  // The section or the profile that Settings jumps to. It changes only when Settings opens or on Back and Forward.
  const [settingsAt, setSettingsAt] = useState<SettingsAt>({ ...s0, n: 0 });
  // A PR opened by a click, Enter, or a notification pushes a history entry. j and k replace it.
  const opened = useRef(false);
  const lastRoute = useRef<Route>(start.route);
  const filterRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const detailApi = useRef<DetailApi | null>(null);
  const pending = useRef<Effect>(null);

  const s = settings.data;
  const locked = s ? s.baseUrl === null || (s.tokenStorage === "memory" && !s.tokenStored) : false;
  const showSettings = locked || ks.settings;
  const all = prs.data ?? [];
  const forge = meta.data?.forge.name ?? "";
  const runs = useRuns().data;
  const taskRows = useTasks().data;
  const tasksView = view === "tasks";
  const taskIds = useMemo(() => taskGroups(taskRows ?? []).flatMap((g) => g.rows.map((r) => r.id)), [taskRows]);
  // The first task is the default, as the first row of a PR list is.
  const shownTask = tasksView ? (task ?? taskIds[0] ?? null) : null;
  const latest = useMemo(() => latestByPr(runs ?? []), [runs]);
  const running = runs?.some((r) => r.status === "running") ?? false;
  // Accepted items sit in review runs, so only PRs with a run can have a post plan.
  const ready = useReadyToPost([...latest.keys()]);
  const readyWhy = useMemo(
    () =>
      new Map(
        [...ready].flatMap(([id, plan]) => {
          const line = readyLine(plan);
          return line ? [[id, line] as const] : [];
        }),
      ),
    [ready],
  );
  // A repository replaces the view (prototype/v3 aiMode), so filterRows then ignores the view argument.
  const aiView = (view === "runs" || view === "post") && !repo;
  const archiveView = view === "archive" && !repo;
  // The pin counts until a selection replaces it. A pinned PR that all does not hold can be in the Archive.
  const pinFor = pin && ks.selected === null ? pin : null;
  const pinInAll = pinFor && prs.data ? findRef(all, pinFor) : undefined;
  const routedOut = routed !== null && ks.selected === routed && !!prs.data && !all.some((p) => p.id === routed);
  const archive = useArchived(archiveView || (!!pinFor && !!prs.data && !pinInAll) || routedOut);
  const pinRow = pinFor ? (pinInAll ?? findRef(archive.data, pinFor)) : undefined;
  // A stale link, for example to a PR that the server no longer has. The detail says so and selects nothing, so nothing turns read.
  const pinMissing = !!pinFor && !pinRow && !!prs.data && !archive.isPending;
  const pinWait = !!pinFor && !pinRow && !pinMissing;
  const want = pinRow?.id ?? ks.selected;
  // The Archive rows are not in all. The kept row comes from the list on screen.
  const pool = archiveView ? (archive.data ?? []) : all;
  const live = archiveView
    ? pool.filter((p) => matches(p, query))
    : !aiView
      ? filterRows(all, view === "runs" || view === "post" || view === "archive" || view === "tasks" ? "following" : view, repo, query)
      : view === "runs"
        ? runRows(all, latest, query)
        : all.filter((p) => ready.has(p.id) && matches(p, query));
  const layout = (list: PrRow[], groupOf?: (p: PrRow) => Group): ListGroup[] =>
    aiView || archiveView ? (list.length ? [{ id: "flat", label: "", rows: list }] : []) : groupRows(list, groupOf);
  // A view, repository, or filter change, or the re-sort chip, gives the server order again.
  const scope = JSON.stringify([view, repo, query]);
  const prev = frozen.scope === scope ? frozen.slots : [];
  // The selected PR stays in the list after it stops matching, for example after its read. Else the next row is shown and read.
  // A PR from the URL stays too: a link to a PR outside the view keeps that PR shown.
  const kept =
    want !== null && !live.some((p) => p.id === want) && (prev.some((s) => s.id === want) || want === routed || want === pinRow?.id)
      ? (pool.find((p) => p.id === want) ?? all.find((p) => p.id === want) ?? archive.data?.find((p) => p.id === want))
      : undefined;
  const slots = freezeOrder(prev, kept ? [...live, kept] : live);
  const byId = new Map([...live, ...(kept ? [kept] : [])].map((p) => [p.id, p]));
  const rows = slots.flatMap((x) => byId.get(x.id) ?? []);
  const slotGroup = new Map(slots.map((x) => [x.id, x.group]));
  const groups = layout(rows, (p) => slotGroup.get(p.id) ?? p.group);
  const updated = movedCount(groups, layout(live));
  const ids = navIds(groups, doneOpen);
  // The first open row is the default. A row of the folded Done group stays selected only after a click.
  // A pending or missing pin selects nothing, so no other PR shows and turns read.
  const selected = rows.some((p) => p.id === want) ? want : pinFor ? null : (ids[0] ?? null);
  const current = rows.find((p) => p.id === selected) ?? null;
  const candidate = followCandidate(query, s?.baseUrl ?? null);
  const unread = unreadTotal(all);
  const sync = status.data?.sync;
  const now = useNow(sync?.state === "offline");
  const info = sync ? statusInfo(sync, now, forge) : null;
  const state: KeyState = { ...ks, selected };
  const mobile = showSettings && locked ? "detail" : ks.mobile;

  // Plan pr-view-v4 section 5: the URL of this state. A missing or pending pin keeps its PR in the URL.
  const shown = current ? prRef(current) : pinFor;
  const shownKey = shown ? prKeyOf(shown) : null;
  const own = detail.key !== null && detail.key === shownKey;
  const explainOn = own && detail.explain;
  const detailShown = !narrow || mobile === "detail";
  const routePr = !tasksView && detailShown ? shown : null;
  const route: Route = showSettings
    ? { kind: "settings", ...settingsRoute }
    : {
        kind: "list",
        view,
        pr: routePr,
        thread: routePr && own && !explainOn ? detail.thread : null,
        file: routePr && own && !explainOn ? detail.file : null,
        full: !tasksView && full,
        explain: routePr !== null && explainOn,
        repo: tasksView ? null : repo,
        q: tasksView ? "" : query,
        task: tasksView && detailShown ? shownTask : null,
      };
  // The narrow layout has no rail and no full width. Full width needs a PR in the detail.
  const rail = !narrow && railOn(side, wide);
  // The shell renders again only when the cap changes, not on each resize event.
  const cap = useSyncExternalStore(onResize, () => listCap(document.documentElement.clientWidth, rail));
  const listWidth = fitList(listW ?? listDefault(rail), cap);
  const fullOn = !narrow && route.kind === "list" && route.pr !== null && route.full;
  // A locked app shows Settings over any URL. The URL stays, so the PR of a link shows after the token is saved.
  const urlReady = !!settings.data && !!prs.data && !!meta.data && !locked;
  useLayoutEffect(() => {
    if (!urlReady) return;
    const from = lastRoute.current;
    const mode = navMode(from, route, opened.current);
    opened.current = false;
    lastRoute.current = route;
    writeUrl(formatRoute(route), mode);
    // The Explain page entry that its PR pushed. Its Back is a step back in the history.
    const fromPr = from.kind === "list" && !from.explain && from.pr ? prKeyOf(from.pr) : null;
    if (mode === "push" && route.kind === "list" && route.explain && route.pr && fromPr === prKeyOf(route.pr)) markBack();
  });

  // Back and Forward. Dialogs, the help sheet, and the panel slot close with the location change.
  const refocus = useRef(false);
  const applyRoute = useRef((_: Route, __: number | null) => {});
  applyRoute.current = (r, scroll) => {
    const toDetail = r.kind === "settings" || !!r.pr || (r.kind === "list" && r.task !== null);
    pending.current = narrow && !toDetail ? "focus-list" : null;
    refocus.current = true;
    setKs((k) => ({
      ...k,
      help: false,
      chord: null,
      settings: r.kind === "settings" || locked,
      mobile: toDetail ? "detail" : "list",
      focus: narrow ? (toDetail ? "detail" : "list") : k.focus,
      // A route without a PR keeps the selection, so the narrow list shows the row that was open.
      selected: r.kind === "list" && r.pr ? null : k.selected,
    }));
    if (r.kind === "settings") {
      setSettingsRoute({ section: r.section, profile: r.profile });
      setSettingsAt((a) => ({ section: r.section, profile: r.profile, n: a.n + 1 }));
      return;
    }
    setView(r.view);
    setRepo(r.repo);
    setQuery(r.q);
    setFull(r.full);
    if (r.view === "tasks") {
      setTask(r.task);
      return;
    }
    if (!r.pr) return;
    const key = prKeyOf(r.pr);
    setPin(r.pr);
    // An Explain page entry keeps the thread and the file of the PR under it.
    if (r.explain) {
      setDetail((d) => (d.key === key ? { ...d, explain: true } : { key, thread: null, file: null, explain: true }));
      setAt((a) => ({ key, thread: null, file: null, close: null, scroll, n: (a?.n ?? 0) + 1, explain: true }));
      return;
    }
    const close = detail.key === key && detail.file && detail.file.path !== r.file?.path ? detail.file.path : null;
    setDetail({ key, thread: r.thread, file: r.file, explain: false });
    setAt((a) => ({ key, thread: r.thread, file: r.file, close, scroll, n: (a?.n ?? 0) + 1 }));
  };
  useEffect(() => {
    const pop = () => {
      const r = parseRoute(location.pathname, location.search);
      lastRoute.current = r;
      applyRoute.current(r, enterEntry());
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);

  // Esc and ← in the narrow detail, and the Back buttons there. The first entry of the app has no Back, so the list shows instead.
  const goBack = () => {
    if (canGoBack()) history.back();
    else go({ mobile: "list", focus: "list", settings: locked }, "focus-list");
  };

  // The detail reports its thread and file. A file open pushes a history entry (navMode).
  const onDetailRoute = useCallback(
    (key: string, patch: DetailPatch) =>
      setDetail((d) => (d.key === key ? { ...d, ...patch } : { key, thread: null, file: null, explain: false, ...patch })),
    [],
  );

  // docs/plans/review-v2/spec.md section 3.1: the Explain page of the shown PR. Open pushes a history entry. Back is a history step
  // when the PR pushed the page, else it goes to the PR in place. push: a step to the PR that pushes, such as "Go to the drafts".
  const explainTo = (open: boolean, push = false) => {
    const key = shownKey;
    if (key === null) return;
    if (!open && !push && backIsPr()) return history.back();
    if (push) opened.current = true;
    setDetail((d) => (d.key === key ? { ...d, explain: open } : { key, thread: null, file: null, explain: open }));
  };
  // A diff link of the Explain page: the PR at that file and line, with a history entry. The detail opens the file as on a restore.
  const explainDiff = (to: FileRef) => {
    const key = shownKey;
    if (key === null) return;
    opened.current = true;
    setDetail((d) => ({ key, thread: d.key === key ? d.thread : null, file: to, explain: false }));
    setAt((a) => ({ key, thread: null, file: to, close: null, scroll: null, n: (a?.n ?? 0) + 1 }));
  };

  // A notification click opens its PR in a view that holds it. A digest opens Needs you.
  useClaims(claimEvents, !!s?.baseUrl, !!s?.notifications, (id) => {
    const pr = id === null ? undefined : all.find((p) => p.id === id);
    const v = pr ? ((Object.keys(VIEWS) as View[]).find((x) => VIEWS[x](pr)) ?? "following") : "needs";
    setView(v);
    setRepo(null);
    setQuery("");
    opened.current = !!pr;
    if (pr) go({ selected: pr.id, settings: locked, focus: "detail", mobile: "detail" }, "open-cause");
    else go({ settings: locked, focus: "list", mobile: "list" }, "focus-list");
  });

  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) PR Review Inbox` : "PR Review Inbox";
  }, [unread]);

  // The default row becomes the selection, so the selection follows the PR and not the first place.
  useEffect(() => {
    if (selected !== null && selected !== ks.selected) setKs((k) => ({ ...k, selected }));
  }, [selected, ks.selected]);

  // A resolved pin becomes the selection (the effect above). A PR of the folded Done group opens the group, so its keys work.
  useEffect(() => {
    if (!pin) return;
    if (pinRow) {
      setRouted(pinRow.id);
      setPin(null);
      if (DONE.includes(pinRow.group)) setDoneOpen(true);
    } else if (ks.selected !== null) setPin(null);
  }, [pin, pinRow, ks.selected]);

  // The restore request belongs to one PR. Another selection drops it, so a later visit opens that PR fresh.
  // The Explain page belongs to one PR too. A later visit opens the PR itself.
  useEffect(() => {
    if (at && shownKey !== null && shownKey !== at.key) setAt(null);
    if (detail.explain && shownKey !== null && shownKey !== detail.key) setDetail((d) => ({ ...d, explain: false }));
  }, [at, shownKey, detail.explain, detail.key]);

  useEffect(() => {
    const same =
      frozen.scope === scope &&
      frozen.slots.length === slots.length &&
      slots.every((x, i) => {
        const y = frozen.slots[i];
        return y?.id === x.id && y.group === x.group;
      });
    if (!same) setFrozen({ scope, slots });
  });

  // Runs the focus effect of the last key after the new state renders.
  useLayoutEffect(() => {
    const effect = pending.current;
    // Full width hides the list. An effect that goes to the list shows it first and runs after that render.
    if (fullOn && (effect === "focus-list" || effect === "focus-filter")) {
      setFull(false);
      return;
    }
    pending.current = null;
    // After Back or Forward, focus that the change removed goes to the detail.
    if (refocus.current) {
      refocus.current = false;
      const a = document.activeElement;
      if (effect !== "focus-list" && (!a || a === document.body)) detailRef.current?.focus({ preventScroll: true });
    }
    if (effect === "focus-filter") filterRef.current?.focus();
    else if (effect === "focus-list") {
      const listSel = tasksView ? shownTask : selected;
      const row = listSel === null ? null : document.getElementById(`row-${listSel}`);
      (row ?? document.getElementById("rows"))?.focus({ preventScroll: true });
      row?.scrollIntoView({ block: "nearest" });
    } else if (effect && tasksView) {
      // The Task view keys (spec.md section 6.12): j and k move over the steps and parts, Enter runs the primary action.
      if (!detailRef.current?.contains(document.activeElement)) detailRef.current?.focus({ preventScroll: true });
      const t = taskApi.current;
      if (effect === "thread-next" || effect === "thread-prev") t?.step(effect === "thread-next" ? 1 : -1);
      else if (effect === "thread-toggle") t?.primary();
      else if (effect === "close-log") t?.close();
    } else if (effect) {
      // Detail effects. Focus outside the pane moves into it, so a key without a target still leaves focus in the detail.
      // Focus inside the pane stays: n, j, and o start from it.
      if (!detailRef.current?.contains(document.activeElement)) detailRef.current?.focus({ preventScroll: true });
      const api = detailApi.current;
      if (effect === "overview") detailRef.current?.querySelector("[data-scroll]")?.scrollTo({ top: 0 });
      else if (effect === "open-cause") {
        // A row open shows the PR itself, also when its Explain page shows.
        if (explainOn) setDetail((d) => ({ ...d, explain: false }));
        api?.cause();
      } else if (effect === "explain") explainTo(true);
      else if (effect === "explain-back") explainTo(false);
      else if (effect === "thread-next" || effect === "thread-prev") api?.step(effect === "thread-next" ? 1 : -1);
      else if (effect === "thread-toggle") api?.toggle();
      else if (effect === "next-new" || effect === "prev-new") api?.nextNew(effect === "next-new" ? 1 : -1);
      else if (effect === "next-your") api?.nextYour();
      else if (effect === "files" || effect === "commits") api?.section(effect);
      else if (effect === "show-in-diff") api?.showInDiff();
      else if (effect === "drafts") api?.drafts();
      else if (effect === "log") api?.log();
      else if (effect === "rerun") api?.rerun();
      else if (effect === "rereview") api?.rereview();
      else if (effect === "ask") api?.ask();
      else if (effect === "brief") api?.brief();
      else if (effect === "accept" || effect === "edit" || effect === "discard") api?.triage(effect);
      else if (effect === "discuss") api?.discuss();
      else if (effect === "post") api?.post();
      else if (effect === "fix" || effect === "fix-list") api?.fix(effect === "fix-list");
      else if (effect === "resolve") api?.resolve();
      else if (effect === "close-brief" || effect === "close-confirm" || effect === "close-log")
        api?.close(effect.slice(6) as Exclude<Layer, null>);
    }
  });

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    // An open menu or popover takes its own keys: the arrows, the letters, and Esc.
    if (t.closest('[role="menu"], [data-slot="popover-content"]')) return;
    // A modal dialog takes Esc. Base UI moves the focus into it one frame after it opens, so the target can still be outside.
    if (e.key === "Escape" && document.querySelector('[data-slot="dialog-content"]')) return;
    // In that frame, other keys must not act behind the dialog. A closing dialog has data-closed and lets keys through.
    if (document.querySelector('[data-slot="dialog-content"]:not([data-closed])') && !t.closest('[data-slot="dialog-content"]')) return;
    // A checkbox takes keys like a button, so the detail keys work after the thread filter.
    const box = t instanceof HTMLInputElement && (t.type === "checkbox" || t.type === "radio");
    // The arrow keys move between the profile radios of the review brief, between the items of a toggle group, and between tabs.
    if (e.key.startsWith("Arrow") && ((box && t.type === "radio") || t.closest('[data-slot="toggle-group"], [role="tablist"]'))) return;
    const typing = (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !box) || t.isContentEditable;
    const onButton = (t.tagName === "BUTTON" && !t.hasAttribute("data-row")) || t.tagName === "A" || t.tagName === "SUMMARY" || box;
    const layer = (tasksView ? taskApi.current?.layer(e.target) : detailApi.current?.layer(e.target)) ?? null;
    const dialog = !!t.closest('[role="dialog"]') || !!document.querySelector('[data-slot="dialog-content"]');
    // The Tasks view moves over task rows. The keys of a PR do nothing there: no PR detail shows.
    const r = reduceKey(tasksView ? { ...state, selected: shownTask } : state, e.key, {
      ids: tasksView ? taskIds : ids,
      typing,
      onButton,
      settingsLocked: locked,
      now: Date.now(),
      layer,
      narrow,
      full: fullOn,
      dialog,
      explain: !tasksView && explainOn && !showSettings,
    });
    if (!r.handled) return;
    if (tasksView && (r.effect === "full-on" || r.effect === "full-off" || (r.effect !== null && DETAIL_ONLY.has(r.effect)))) return;
    e.preventDefault();
    // Esc leaves full width first. The text field keeps the focus, as in the prototype.
    if (e.key === "Escape" && typing && r.effect !== "full-off") t.blur();
    if (r.effect === "back") return goBack();
    if (r.effect === "full-on" || r.effect === "full-off") setFull(r.effect === "full-on");
    if (r.effect === "open-cause") opened.current = true;
    pending.current = r.effect;
    if (tasksView) {
      setTask(r.state.selected);
      setKs({ ...r.state, selected: ks.selected });
    } else setKs(r.state);
  };
  useEffect(() => {
    const fn = (e: KeyboardEvent) => onKey.current(e);
    document.addEventListener("keydown", fn);
    return () => document.removeEventListener("keydown", fn);
  }, []);

  const go = (patch: Partial<KeyState>, effect: Effect = null) => {
    pending.current = effect;
    setKs((k) => ({ ...k, ...patch }));
  };

  // Stable, so the memo rows render again only when their own data changes.
  // prototype/v3: a click and Enter open the PR at the thread that put it in the inbox.
  const onOpen = useCallback(
    (id: number) => {
      pending.current = "open-cause";
      opened.current = true;
      setKs((k) => ({ ...k, selected: id, settings: locked, focus: "detail", mobile: "detail" }));
    },
    [locked],
  );

  // Settings open at the top, at a section, or at one profile. Each open pushes a history entry (navMode).
  const openSettings = (section: SettingsSection | null = null, profile: string | null = null) => {
    setSettingsRoute({ section, profile });
    setSettingsAt((a) => ({ section, profile, n: a.n + 1 }));
    go({ settings: true, mobile: "detail", focus: "detail" });
  };

  // docs/plans/review-v2/spec.md section 6.12: "Build this task" opens the Task view. A history entry is pushed (navMode).
  const openTask = useCallback(
    (id: number) => {
      opened.current = true;
      setView("tasks");
      setRepo(null);
      setTask(id);
      pending.current = null;
      setKs((k) => ({ ...k, settings: locked, focus: "detail", mobile: "detail" }));
    },
    [locked],
  );
  // "Go to the PR" of a task: the PR in My PRs. The pin waits until the sync lists it.
  const openPr = (r: PrRef) => {
    opened.current = true;
    setView("mine");
    setRepo(null);
    setQuery("");
    setPin(r);
    setDetail({ key: prKeyOf(r), thread: null, file: null, explain: false });
    go({ selected: null, settings: false, focus: "detail", mobile: "detail" });
  };
  const onCreateTask = async (input: TaskCreateInput) => openTask((await createTask(input)).id);

  // The selection leaves a restored row, as it leaves an archived one. Focus stays in the list without a scroll.
  const restoreRef = useRef((_: PrRow) => {});
  restoreRef.current = (p) => {
    if (p.id === selected) {
      const i = ids.indexOf(p.id);
      go({ selected: ids[i + 1] ?? ids[i - 1] ?? null, focus: "list" }, "focus-list");
    } else document.getElementById("rows")?.focus({ preventScroll: true });
    restore.mutate(p);
  };
  const onRestore = useCallback((p: PrRow) => restoreRef.current(p), []);

  if (isStopped(prs.error) || isStopped(status.error) || isStopped(settings.error) || isStopped(meta.error)) return <Stopped />;
  // Every product name comes from meta. It is one local request, sent together with the others.
  if (!meta.data) return null;

  return (
    <div
      className="rl-app"
      data-m={mobile}
      data-rail={rail ? "" : undefined}
      data-full={fullOn ? "" : undefined}
      style={{ "--list-w": `${listWidth}px` } as CSSProperties}
    >
      {/* A button, not a "#rows" link: a hash change pushes a history entry with no state. Full width hides the list. */}
      {!fullOn && (
        <button
          type="button"
          className="sr-only cursor-pointer rounded-md bg-pane text-pen focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:px-3 focus:py-1.5"
          onClick={() => document.getElementById("rows")?.focus()}
        >
          Skip to the list
        </button>
      )}
      <Sidebar
        view={showSettings || repo ? null : view}
        counts={viewCounts(all)}
        runs={{ count: all.filter((p) => latest.has(p.id)).length, running }}
        post={all.filter((p) => ready.has(p.id)).length}
        tasks={taskRows?.filter((r) => rowStatus(r).needsYou).length ?? 0}
        repos={repoTree(all)}
        repo={repo}
        status={info}
        checking={checkNow.isPending || !!sync?.running}
        onView={(v) => {
          setView(v);
          setRepo(null);
          go({ mobile: "list", settings: locked, focus: "list" });
        }}
        onRepo={(r) => {
          if (tasksView) setView("needs");
          setRepo(r);
          go({ mobile: "list", settings: locked, focus: "list" });
        }}
        onCheck={() => checkNow.mutate()}
        onSettings={() => (ks.settings && !locked ? go({ settings: false, mobile: "detail", focus: "detail" }) : openSettings())}
        settingsOpen={showSettings}
        rail={rail}
        onRail={() => {
          const next = rail ? "full" : "rail";
          setSide(next);
          writeSide(next);
        }}
      />
      <main className="contents">
        {tasksView ? (
          <TaskList
            rows={taskRows}
            selected={showSettings ? null : shownTask}
            focused={ks.focus === "list" && !showSettings}
            repos={repoTree(all)}
            tracker={trackerOf(meta.data)?.name ?? "issue"}
            runner={meta.data.runner.short}
            profiles={meta.data.profiles}
            banner={<Banner stale={stale} status={status.data} now={now} forge={forge} onSettings={() => openSettings()} />}
            onSelect={openTask}
            onOpen={openTask}
            onCreate={onCreateTask}
            onMenu={() => go({ mobile: "side" })}
            onFocus={() => ks.focus !== "list" && setKs((k) => ({ ...k, focus: "list" }))}
          />
        ) : (
          <ListPane
            title={
              repo ??
              (view === "runs" ? "Review runs" : view === "post" ? "Ready to post" : view === "archive" ? "Archive" : VIEW_LABEL[view])
            }
            count={rows.length}
            groups={groups}
            updated={updated}
            onResort={() => {
              setFrozen({ scope, slots: [] });
              go({ focus: "list" }, "focus-list");
            }}
            loading={archiveView ? archive.isPending : prs.isPending}
            repo={repo}
            query={query}
            empty={
              view === "post"
                ? `Nothing is ready to post. Accept drafts from ${meta.data.runner.short} to post them to ${forge}.`
                : EMPTY[view]
            }
            selected={showSettings ? null : selected}
            focused={ks.focus === "list" && !showSettings}
            doneOpen={doneOpen}
            forge={forge}
            runs={aiView && view === "runs" ? latest : null}
            ready={aiView && view === "post" ? readyWhy : null}
            onRestore={archiveView ? onRestore : null}
            candidate={candidate}
            following={follow.isPending}
            followError={follow.error && !isStale(follow.error) ? follow.error.message : null}
            banner={<Banner stale={stale} status={status.data} now={now} forge={forge} onSettings={() => openSettings()} />}
            filterRef={filterRef}
            onQuery={(q) => {
              setQuery(q);
              if (follow.error) follow.reset();
            }}
            onRepo={setRepo}
            onDoneOpen={setDoneOpen}
            onSelect={onOpen}
            onOpen={onOpen}
            onFollow={() =>
              follow.mutate(query.trim(), {
                onSuccess: () => {
                  setQuery("");
                  setView("following");
                  setRepo(null);
                },
              })
            }
            onMenu={() => go({ mobile: "side" })}
            onFocus={() => ks.focus !== "list" && setKs((k) => ({ ...k, focus: "list" }))}
          />
        )}
        <Splitter
          width={listWidth}
          max={cap}
          onWidth={(w) => {
            setListW(w);
            writeListWidth(w);
          }}
          onReset={() => {
            setListW(null);
            writeListWidth(null);
          }}
        />
        <section
          ref={detailRef}
          tabIndex={-1}
          aria-label="Details"
          className={cn("rl-pane rl-detail flex flex-col bg-pane outline-none", ks.focus === "detail" && "pane-edge")}
          onFocus={() => ks.focus !== "detail" && setKs((k) => ({ ...k, focus: "detail" }))}
        >
          {showSettings && s ? (
            <Settings
              settings={s}
              required={locked}
              prs={all}
              selected={selected}
              at={settingsAt}
              onSection={(section) => setSettingsRoute({ section, profile: null })}
              // Wide: Close replaces the entry, so it adds no Back step. Narrow: the buttons go back like the browser.
              onBack={() => (narrow ? goBack() : go({ settings: false, mobile: "list", focus: "list" }, "focus-list"))}
              onSaved={() => go({ settings: false, mobile: "list" })}
            />
          ) : tasksView ? (
            <>
              <BackBar onBack={goBack} />
              {shownTask !== null ? (
                <div key={`task-${shownTask}`} data-scroll className="relative flex-1 overflow-auto overscroll-contain">
                  <TaskView ref={taskApi} id={shownTask} meta={meta.data} onPr={openPr} />
                </div>
              ) : (
                <div className="mx-auto my-10 grid max-w-[52ch] gap-3 px-6 text-ink-2">
                  <p className="m-0">
                    {meta.data.runner.short} can build a task from your issue tracker: it asks a few questions, writes a short plan, and
                    builds the code in its own copy of the repository. Nothing goes to {forge} before you click.
                  </p>
                  <p className="m-0">
                    Start with “Build a {trackerOf(meta.data)?.name ?? "issue"} task” in the list, or with Build on a task chip of a pull
                    request.
                  </p>
                </div>
              )}
            </>
          ) : prs.isPending || settings.isPending || (archiveView && archive.isPending) || pinWait ? (
            <DetailSkeleton />
          ) : current ? (
            <>
              {/* The Explain page has its own Back to the PR. */}
              {!explainOn && <BackBar onBack={goBack} />}
              {/* The sticky post bar covers the bottom of the pane, so focus and scroll targets stop above it. The top bar of the
                  Explain page covers its top. It wins over the inline padding of the hidden action bar.
                  The key gives each PR a new scroll box, so the next PR starts at the top. */}
              <div
                key={current.id}
                data-scroll
                className="relative flex-1 overflow-auto overscroll-contain has-[[data-postbar]]:scroll-pb-16 has-[[data-explain]]:scroll-pt-12!"
                onScroll={(e) => noteScroll(e.currentTarget.scrollTop)}
              >
                <PrDetail
                  ref={detailApi}
                  pr={current}
                  me={s?.user ?? null}
                  at={at?.key === shownKey ? at : null}
                  file={own ? (detail.file?.path ?? null) : null}
                  full={fullOn}
                  explain={explainOn}
                  onFull={() => setFull(!fullOn)}
                  onRoute={(patch) => shownKey && onDetailRoute(shownKey, patch)}
                  onExplain={explainTo}
                  onDiff={explainDiff}
                  onSettings={() => openSettings()}
                  onTaskIds={() => openSettings("task-ids")}
                  onTask={openTask}
                  onProfile={(id) => openSettings("profiles", id)}
                  onLeave={() => {
                    const i = ids.indexOf(current.id);
                    setKs((k) => ({ ...k, selected: ids[i + 1] ?? ids[i - 1] ?? null }));
                  }}
                  onRestore={onRestore}
                />
              </div>
            </>
          ) : pinMissing && pin ? (
            <>
              <BackBar onBack={goBack} />
              <Calm title="Cannot find this pull request">
                <p className="m-0">
                  PR Review Inbox has no data for{" "}
                  <span translate="no" className="font-mono">
                    {pin.project}/{pin.repo} #{pin.id}
                  </span>
                  . The link can be old, or the pull request is not in your lists. Select another pull request.
                </p>
              </Calm>
            </>
          ) : (
            <>
              <BackBar onBack={goBack} />
              {aiView && view === "post" && !rows.length && !query.trim() ? (
                <Empty className="my-10 flex-none">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Send aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>Nothing is ready to post</EmptyTitle>
                    <EmptyDescription>
                      Accept drafts from {meta.data.runner.short} on a pull request. Accepted drafts wait here until you post them to{" "}
                      {forge}.
                    </EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setView("runs");
                        go({ mobile: "list", focus: "list" }, "focus-list");
                      }}
                    >
                      <Terminal aria-hidden data-icon="inline-start" />
                      Go to Review runs
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : archiveView && !rows.length && !query.trim() ? (
                <Empty className="my-10 flex-none">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Archive aria-hidden />
                    </EmptyMedia>
                    <EmptyTitle>Nothing is archived</EmptyTitle>
                    <EmptyDescription>
                      A pull request that you archive shows here. So does one that you stop following after it leaves your dashboard.
                      Restore it to follow it again.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="mx-auto my-10 grid max-w-[52ch] gap-3 px-6 text-ink-2">
                  <p className="m-0">
                    {!all.length
                      ? "Pull requests appear here after the first check."
                      : rows.length
                        ? "Select a pull request in the list."
                        : query.trim()
                          ? "No pull request matches the filter."
                          : "This list has no pull requests."}
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </main>
      <HelpSheet open={ks.help} onOpenChange={(help) => setKs((k) => ({ ...k, help }))} />
    </div>
  );
}

function BackBar({ onBack }: { onBack: () => void }) {
  return (
    <div className="rl-m-only border-b px-3 py-1.5">
      <button
        type="button"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-ink-2 hover:bg-hover hover:text-foreground"
        onClick={onBack}
      >
        <ArrowLeft aria-hidden className="size-4" />
        Back to the list
      </button>
    </div>
  );
}

function Banner({
  stale,
  status,
  now,
  forge,
  onSettings,
}: {
  stale: boolean;
  status: Status | undefined;
  now: number;
  forge: string;
  onSettings: () => void;
}) {
  const box = "m-3 mb-0 w-auto";
  if (stale) {
    return (
      <Alert className={box}>
        <AlertTitle>The service restarted. Reload the page.</AlertTitle>
        <AlertAction>
          <Button size="sm" onClick={() => location.reload()}>
            Reload
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  const sync = status?.sync;
  if (sync?.state === "auth") {
    return (
      <Alert variant="destructive" className={box}>
        <AlertTitle>{forge} rejected the token</AlertTitle>
        <AlertDescription>Checks are paused until you save a new token.</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onSettings}>
            Open settings
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  if (sync?.state === "offline") {
    return (
      <Alert className={box}>
        <AlertTitle>{statusInfo(sync, now, forge).text}</AlertTitle>
        <AlertDescription>The list shows the data from the last check.</AlertDescription>
      </Alert>
    );
  }
  if (sync?.state === "error" && sync.error) {
    return (
      <Alert variant="destructive" className={box}>
        <AlertTitle>The last check failed</AlertTitle>
        <AlertDescription>{sync.error}</AlertDescription>
      </Alert>
    );
  }
  const dash = incompleteText(status?.dashboard ?? null, forge);
  if (dash) {
    return (
      <Alert className={box}>
        <AlertTitle>The dashboard list is incomplete</AlertTitle>
        <AlertDescription>{dash}. The list can miss pull requests until the next check.</AlertDescription>
      </Alert>
    );
  }
  return null;
}

function DetailSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading details" className="grid gap-3 px-6 pt-5">
      <Skeleton className="h-5 w-3/5" />
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="mt-4 h-20 w-full max-w-[760px]" />
      <Skeleton className="h-20 w-full max-w-[760px]" />
    </div>
  );
}

function Stopped() {
  return (
    <main className="grid h-full place-items-center bg-background p-6">
      <div className="grid max-w-[52ch] gap-3">
        <h1 className="m-0 text-[19px] font-bold tracking-tight">PR Review Inbox is not running</h1>
        <p className="m-0 text-ink-2">The local service does not answer. Start it again in a terminal:</p>
        <pre className="m-0 rounded-md border bg-card px-3 py-2 font-mono text-[12px]">bun run start</pre>
        <p className="m-0 text-ink-2">This page reconnects by itself when the service is back.</p>
      </div>
    </main>
  );
}
