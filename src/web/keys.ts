// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Pure key handling (prototype/v3 keyboard model). The shell performs the returned effect.

export type Pane = "list" | "detail";
export type MobilePane = "side" | "list" | "detail";

export type KeyState = {
  focus: Pane;
  mobile: MobilePane;
  // PR id of the selected row.
  selected: number | null;
  help: boolean;
  settings: boolean;
  // ms: the time of a "g" press that waits for its second key.
  chord: number | null;
};

export type KeyContext = {
  // Row ids of the current list, in display order.
  ids: number[];
  // Focus is in a text field.
  typing: boolean;
  // Focus is on a button that is not a list row. Enter then activates the button.
  onButton: boolean;
  // Settings must stay open: no config, or the memory-mode token is missing.
  settingsLocked: boolean;
  // ms.
  now: number;
  // The open layer of the detail that Esc closes first: the review brief, the post confirm, or the run log (prototype/v3 Esc order).
  // A triage edit, a line field, and a reply box close themselves on Esc.
  layer?: Layer;
  // One pane at a time (below 760 px). Esc and ← in the detail then go back in the browser history (plan pr-view-v4 section 5).
  // The narrow layout has no full width.
  narrow?: boolean;
  // Full width is on: the detail hides the sidebar and the list (plan pr-view-v4 4.3).
  full?: boolean;
  // Focus is in a dialog, or a modal dialog is open. Only Esc and ? then work.
  dialog?: boolean;
  // The Explain page shows in the detail (docs/plans/review-v2/spec.md section 3.1). The keys of the hidden PR then do nothing.
  explain?: boolean;
};

export type Layer = "brief" | "confirm" | "log" | null;

export type Effect =
  | "focus-filter"
  | "focus-list"
  | "open-cause"
  | "thread-next"
  | "thread-prev"
  | "thread-toggle"
  | "next-new"
  | "prev-new"
  | "next-your"
  | "files"
  | "commits"
  | "show-in-diff"
  | "overview"
  | "drafts"
  | "log"
  | "rerun"
  | "rereview"
  | "ask"
  | "brief"
  | "accept"
  | "edit"
  | "discard"
  // The talk about the focused finding (docs/plans/review-v2/spec.md section 2.1).
  | "discuss"
  | "post"
  | "fix"
  | "fix-list"
  | "resolve"
  // The Explain page opens, or goes back to its PR.
  | "explain"
  | "explain-back"
  | "close-brief"
  | "close-confirm"
  | "close-log"
  // The shell goes back in the browser history. Without an earlier entry of the app, it shows the list.
  | "back"
  | "full-on"
  | "full-off"
  | null;

export type KeyResult = { state: KeyState; effect: Effect; handled: boolean };

// prototype/v3: the second key of a chord counts within 1.2 s.
const CHORD_MS = 1200;

const ignore = (state: KeyState): KeyResult => ({ state, effect: null, handled: false });

function back(s: KeyState, ctx: KeyContext): KeyResult {
  if (s.focus !== "detail" && s.mobile !== "detail" && !(s.settings && !ctx.settingsLocked)) return ignore(s);
  if (ctx.narrow && s.mobile === "detail" && !(s.settings && ctx.settingsLocked)) return { state: s, effect: "back", handled: true };
  const settings = s.settings && ctx.settingsLocked;
  return { state: { ...s, focus: "list", mobile: "list", settings }, effect: "focus-list", handled: true };
}

// Keys that act on the PR in the detail pane. They move focus there.
const DETAIL: Record<string, Effect> = {
  n: "next-new",
  N: "prev-new",
  y: "next-your",
  o: "thread-toggle",
  "1": "overview",
  "2": "drafts",
  "3": "log",
  r: "rerun",
  R: "brief",
  c: "rereview",
  q: "ask",
  a: "accept",
  e: "edit",
  d: "discard",
  p: "post",
  // Plan pr-view-v4 section 6: f fixes the current thread, F opens the Fix list. A reviewer PR gives a toast.
  f: "fix",
  F: "fix-list",
  // docs/plans/review-v2/spec.md section 3.1: w opens the Explain page.
  w: "explain",
  // spec.md section 2.1: t opens the talk about the focused finding.
  t: "discuss",
};
// Plan r2 UI-DIFF: g d shows the current inline thread or draft in the diff.
const CHORD: Record<string, Effect> = { f: "files", c: "commits", d: "show-in-diff" };

export function reduceKey(state: KeyState, key: string, ctx: KeyContext): KeyResult {
  const done = (next: KeyState, effect: Effect = null): KeyResult => ({ state: next, effect, handled: true });
  const chord = state.chord !== null && ctx.now - state.chord < CHORD_MS;
  const s = state.chord === null ? state : { ...state, chord: null };
  const hasPr = s.selected !== null && ctx.ids.includes(s.selected) && !(s.settings && ctx.settingsLocked);
  // The keys that act on the PR in the detail. The Explain page hides the PR, so they wait until Back.
  const prKeys = hasPr && !ctx.explain;
  const inDetail = { ...s, focus: "detail" as const, mobile: "detail" as const, settings: false };

  // Plan pr-view-v4 section 6. An open menu or popover and the other dialogs keep Esc, so the shell never sees it.
  if (key === "Escape") {
    if (s.help) return done({ ...s, help: false });
    if (ctx.layer) return done(s, `close-${ctx.layer}`);
    if (ctx.full) return done({ ...s, focus: "detail" }, "full-off");
    if (ctx.typing) return done({ ...s, focus: "list" }, "focus-list");
    if (s.mobile === "side") return done({ ...s, mobile: "list", focus: "list" }, "focus-list");
    // The Explain page goes back to its PR first, as a layer of the detail does.
    if (ctx.explain && (s.focus === "detail" || s.mobile === "detail")) return done({ ...s, focus: "detail" }, "explain-back");
    return back(s, ctx);
  }
  if (ctx.typing) return ignore(s);
  // A dialog keeps its own keys. The shell keys must not act on the PR or the list behind it.
  if (ctx.dialog && key !== "?") return ignore(s);
  if (key === "?") return done({ ...s, help: !s.help });
  if (s.help) return ignore(s);
  // The second key of "g f", "g c", or "g d". Any other key ends the chord.
  if (chord) return prKeys && CHORD[key] ? done(inDetail, CHORD[key]) : done(s);
  if (key === "Enter" && s.focus === "detail") return ctx.onButton || !prKeys ? ignore(s) : done(s, "thread-toggle");

  switch (key) {
    case "/":
      return done({ ...s, focus: "list", mobile: s.mobile === "detail" || s.mobile === "side" ? "list" : s.mobile }, "focus-filter");
    case "j":
    case "k": {
      const d = key === "j" ? 1 : -1;
      // plan v3 I14: the detail moves between threads. The Explain page has no threads.
      if (s.focus === "detail") return ctx.explain ? ignore(s) : done(s, d > 0 ? "thread-next" : "thread-prev");
      if (!ctx.ids.length) return done(s);
      const i = s.selected === null ? -1 : ctx.ids.indexOf(s.selected);
      const next = i < 0 ? 0 : Math.max(0, Math.min(ctx.ids.length - 1, i + d));
      return done({ ...s, selected: ctx.ids[next] ?? null, settings: ctx.settingsLocked && s.settings }, "focus-list");
    }
    case "Enter":
    case "ArrowRight":
      if ((key === "Enter" && ctx.onButton) || s.focus !== "list" || s.selected === null || !ctx.ids.includes(s.selected)) return ignore(s);
      // prototype/v3: a row opens at the thread that put it in the inbox.
      return done({ ...s, focus: "detail", mobile: "detail", settings: ctx.settingsLocked && s.settings }, "open-cause");
    case "ArrowLeft":
      return back(s, ctx);
    case "g":
      return prKeys ? done({ ...s, chord: ctx.now }) : ignore(s);
    // x resolves the current thread, or reopens it when it is resolved. It never acts behind the post confirm.
    case "x":
      return prKeys && ctx.layer !== "confirm" ? done(inDetail, "resolve") : ignore(s);
    case "z":
      return hasPr && !ctx.narrow ? done(inDetail, ctx.full ? "full-off" : "full-on") : ignore(s);
    default: {
      const effect = DETAIL[key];
      return effect && prKeys ? done(inDetail, effect) : ignore(s);
    }
  }
}

// Plan pr-view-v4 section 6: j and k in the detail move over the Drafts rows, the threads, and the file rows, in screen order.
// n: the item count. at: the index of the current item, or -1. back: the index that k takes without a current item.
// The ends stop the move. null: no item.
export function detailStep(n: number, at: number, d: 1 | -1, back = n - 1): number | null {
  if (n <= 0) return null;
  if (at < 0) return d > 0 ? 0 : back;
  return Math.max(0, Math.min(n - 1, at + d));
}

// Only the keys that work now.
export const HELP_KEYS: { group: string; keys: { keys: string[]; second?: string[]; text: string }[] }[] = [
  {
    group: "Move",
    keys: [
      { keys: ["j", "k"], text: "Next or previous pull request in the list, or draft, thread, or file in the detail" },
      { keys: ["Enter", "→"], text: "Open the pull request at the thread that put it in the inbox" },
      { keys: ["Esc", "←"], text: "Back to the list. In full width, Esc first goes back to three panes." },
      { keys: ["z"], text: "Full width on or off: hide the views and the list" },
      { keys: ["/"], text: "Filter the list" },
      { keys: ["j", "k", "Enter"], text: "In a task: move over the steps and parts, or press the main button" },
    ],
  },
  {
    group: "Pull request",
    keys: [
      { keys: ["n", "N"], text: "Next or previous new message" },
      { keys: ["y"], text: "Next thread where it is your turn" },
      { keys: ["o"], text: "Open or close the current draft, thread, or file" },
      { keys: ["g"], second: ["f", "c"], text: "Open and go to Files or Commits" },
      { keys: ["g"], second: ["d"], text: "Show the current inline thread or draft on its line in the diff" },
      {
        keys: ["1", "2", "3"],
        text: "Go to the top with the description and the review record, go to the drafts and then the reply drafts, open the run log",
      },
      { keys: ["?"], text: "Show or hide this list" },
    ],
  },
  {
    group: "AI review",
    keys: [
      { keys: ["r"], text: "Open the review brief: task, your note, profile, and run setup. The review starts only from there." },
      { keys: ["c"], text: "Open the review brief for only the commits since the last review. Its open drafts carry over." },
      { keys: ["q"], text: "Ask a question about this pull request. The answer stays here. Nothing posts." },
      { keys: ["w"], text: "Open the walkthrough of this pull request: Explain this PR. Esc goes back to the pull request." },
      {
        keys: ["t"],
        text: "Talk about the current finding, or the finding of the current posted comment. Esc closes the talk. Nothing posts.",
      },
      { keys: ["Ctrl", "Enter"], text: "Start the review from the brief, or send the question from the Ask box or the talk" },
      { keys: ["Esc"], text: "Close an edit, the review brief, the post confirm, or the run log" },
    ],
  },
  {
    group: "Triage and post",
    keys: [
      {
        keys: ["a", "e", "d"],
        text: "Accept, edit, or discard the current draft or question. a again undoes an accept, d again restores.",
      },
      { keys: ["p"], text: "Post the accepted items, after a confirm" },
      { keys: ["f"], text: "Your pull request: open the Fix list with the current thread or finding ticked" },
      { keys: ["F"], text: "Your pull request: open the Fix list" },
      { keys: ["x"], text: "Resolve the current thread on the server, or reopen it when it is resolved" },
      { keys: ["Ctrl", "Enter"], text: "In a reply box: show the reply and its destination before it posts" },
    ],
  },
];
