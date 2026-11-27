// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { describe, expect, test } from "bun:test";
import { detailStep, HELP_KEYS, type KeyContext, type KeyState, reduceKey } from "../../src/web/keys";

const S: KeyState = { focus: "list", mobile: "list", selected: null, help: false, settings: false, chord: null };
const C: KeyContext = { ids: [10, 20, 30], typing: false, onButton: false, settingsLocked: false, now: 10_000 };
const press = (keys: string[], s: KeyState = S, c: KeyContext = C) => keys.reduce((st, k) => reduceKey(st, k, c).state, s);

describe("list keys", () => {
  test("j and k move within the list and stop at the ends", () => {
    expect(press(["j"]).selected).toBe(10);
    expect(press(["j", "j"]).selected).toBe(20);
    expect(press(["j", "j", "j", "j"]).selected).toBe(30);
    expect(press(["j", "k", "k"]).selected).toBe(10);
    expect(reduceKey(S, "j", C).effect).toBe("focus-list");
  });

  test("a selection that left the list restarts at the top", () => {
    expect(press(["j"], { ...S, selected: 99 }).selected).toBe(10);
  });

  // v3 (WP5, plan I14): j and k move between threads in the detail. M1 scrolled the pane.
  test("j and k move between threads when the detail has focus", () => {
    const r = reduceKey({ ...S, focus: "detail", selected: 20 }, "j", C);
    expect(r.state.selected).toBe(20);
    expect(r.effect).toBe("thread-next");
    expect(reduceKey({ ...S, focus: "detail" }, "k", C).effect).toBe("thread-prev");
  });

  // v3 (WP5): Enter opens the PR at its cause thread. M1 focused the pane.
  test("Enter and → open the selection at its cause, Esc and ← go back", () => {
    const open = reduceKey({ ...S, selected: 20 }, "Enter", C);
    expect(open.state).toMatchObject({ focus: "detail", mobile: "detail" });
    expect(open.effect).toBe("open-cause");
    expect(reduceKey({ ...S, selected: 20 }, "ArrowRight", C).state.focus).toBe("detail");
    for (const k of ["Escape", "ArrowLeft"]) {
      const r = reduceKey(open.state, k, C);
      expect(r.state).toMatchObject({ focus: "list", mobile: "list" });
      expect(r.effect).toBe("focus-list");
    }
  });

  test("Enter without a selection or on a button does nothing", () => {
    expect(reduceKey(S, "Enter", C).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20 }, "Enter", { ...C, onButton: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20 }, "Enter", { ...C, ids: [] }).handled).toBe(false);
  });

  test("/ focuses the filter and shows the list on a phone", () => {
    const r = reduceKey({ ...S, mobile: "detail", focus: "detail" }, "/", C);
    expect(r.effect).toBe("focus-filter");
    expect(r.state).toMatchObject({ mobile: "list", focus: "list" });
  });
});

describe("typing, help, and settings", () => {
  test("only Esc works while typing, and it leaves the field", () => {
    const typing = { ...C, typing: true };
    expect(reduceKey(S, "j", typing).handled).toBe(false);
    expect(reduceKey(S, "?", typing).handled).toBe(false);
    expect(reduceKey(S, "Escape", typing).effect).toBe("focus-list");
  });

  test("? toggles help, and other keys wait while it is open", () => {
    const open = press(["?"]);
    expect(open.help).toBe(true);
    expect(reduceKey(open, "j", C).handled).toBe(false);
    expect(press(["?"], open).help).toBe(false);
    expect(press(["Escape"], open).help).toBe(false);
  });

  test("Esc on the phone views pane goes to the list", () => {
    expect(press(["Escape"], { ...S, mobile: "side" }).mobile).toBe("list");
  });

  test("Esc closes settings unless they are required", () => {
    const settings = { ...S, settings: true, focus: "detail" as const };
    expect(press(["Escape"], settings).settings).toBe(false);
    expect(press(["Escape"], settings, { ...C, settingsLocked: true }).settings).toBe(true);
  });

  // Plan pr-view-v4 section 5: only the narrow layout makes Esc a Back. The shell then goes back in the browser history.
  test("Esc and ← in the narrow detail are Back, and the state waits for the location change", () => {
    const narrow = { ...C, narrow: true };
    const detail = { ...S, focus: "detail" as const, mobile: "detail" as const, selected: 20 };
    for (const k of ["Escape", "ArrowLeft"]) expect(reduceKey(detail, k, narrow)).toEqual({ state: detail, effect: "back", handled: true });
    const settings = { ...detail, settings: true };
    expect(reduceKey(settings, "Escape", narrow).effect).toBe("back");
    // Wide: Esc goes to the list and keeps history. Required settings stay.
    expect(reduceKey(detail, "Escape", C).effect).toBe("focus-list");
    expect(reduceKey(settings, "Escape", { ...narrow, settingsLocked: true }).effect).toBe("focus-list");
    // The narrow list and the views pane are no detail.
    expect(reduceKey({ ...S, mobile: "side" }, "Escape", narrow).effect).toBe("focus-list");
    expect(reduceKey(S, "ArrowLeft", narrow).handled).toBe(false);
  });

  test("unknown keys are not handled", () => {
    expect(reduceKey(S, "x", C).handled).toBe(false);
    expect(reduceKey(S, "n", C).handled).toBe(false);
  });
});

describe("detail keys", () => {
  test("n, N, y, o, 1 to 3, r, and R move focus to the detail and name their effect", () => {
    const r = reduceKey({ ...S, selected: 20 }, "n", C);
    expect(r.state).toMatchObject({ focus: "detail", mobile: "detail" });
    expect(r.effect).toBe("next-new");
    const effect = (key: string) => reduceKey({ ...S, selected: 20 }, key, C).effect;
    expect(["N", "y", "o", "1", "2", "3", "r", "R"].map(effect)).toEqual([
      "prev-new",
      "next-your",
      "thread-toggle",
      "overview",
      "drafts",
      "log",
      "rerun",
      "brief",
    ]);
  });

  // Plan v3 WP11, prototype/v3 Esc order: help, then the review brief or the run log, then the field, then the pane.
  test("Esc closes the open layer of the detail first, also while typing in the note", () => {
    const detail = { ...S, selected: 20, focus: "detail" as const, mobile: "detail" as const };
    expect(reduceKey(detail, "Escape", { ...C, layer: "brief", typing: true })).toMatchObject({ effect: "close-brief", state: detail });
    expect(reduceKey(detail, "Escape", { ...C, layer: "log" })).toMatchObject({ effect: "close-log", state: detail });
    expect(reduceKey({ ...detail, help: true }, "Escape", { ...C, layer: "log" })).toMatchObject({ effect: null, state: { help: false } });
    expect(reduceKey(detail, "Escape", { ...C, layer: null }).effect).toBe("focus-list");
  });

  test("r and R do nothing while typing", () => {
    for (const k of ["r", "R"]) expect(reduceKey({ ...S, selected: 20 }, k, { ...C, typing: true }).handled).toBe(false);
  });

  // Plan r2 UI-RR: c starts a re-review. After g, c still opens Commits.
  test("c reviews the new commits; g c still opens Commits; c does nothing while typing or without a PR", () => {
    expect(reduceKey({ ...S, selected: 20 }, "c", C)).toMatchObject({ effect: "rereview", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey(reduceKey({ ...S, selected: 20 }, "g", C).state, "c", C).effect).toBe("commits");
    expect(reduceKey({ ...S, selected: 20 }, "c", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey(S, "c", C).handled).toBe(false);
  });

  // Plan pr-view-v4 section 6: f fixes the current thread, F opens the Fix list. The detail decides about a reviewer PR.
  test("f and F open the Fix list; they do nothing while typing, in the help, or without a PR", () => {
    expect(reduceKey({ ...S, selected: 20 }, "f", C)).toMatchObject({ effect: "fix", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey({ ...S, selected: 20, focus: "detail" }, "F", C)).toMatchObject({ effect: "fix-list", handled: true });
    expect(reduceKey({ ...S, selected: 20 }, "f", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20, help: true }, "F", C).handled).toBe(false);
    expect(reduceKey(S, "f", C).handled).toBe(false);
    // After g, f is the second key of "g f".
    expect(reduceKey(reduceKey({ ...S, selected: 20 }, "g", C).state, "f", C).effect).toBe("files");
    const text = (k: string) => HELP_KEYS.flatMap((g) => g.keys).find((x) => x.keys[0] === k && !x.second)?.text;
    expect(text("f")).toBe("Your pull request: open the Fix list with the current thread or finding ticked");
    expect(text("F")).toBe("Your pull request: open the Fix list");
  });

  test("x resolves or reopens the current thread; it does nothing while typing, in a dialog, behind the post confirm, in the help, or without a PR", () => {
    expect(reduceKey({ ...S, selected: 20 }, "x", C)).toMatchObject({ effect: "resolve", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey({ ...S, selected: 20, focus: "detail" }, "x", { ...C, layer: "brief" }).effect).toBe("resolve");
    expect(reduceKey({ ...S, selected: 20 }, "x", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20 }, "x", { ...C, dialog: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20 }, "x", { ...C, layer: "confirm" }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20, help: true }, "x", C).handled).toBe(false);
    expect(reduceKey(S, "x", C).handled).toBe(false);
    const text = HELP_KEYS.flatMap((g) => g.keys).find((x) => x.keys[0] === "x")?.text;
    expect(text).toBe("Resolve the current thread on the server, or reopen it when it is resolved");
  });

  test("a dialog keeps every key but Esc and ?, so no key acts on the PR or the list behind it", () => {
    const dlg = { ...C, dialog: true };
    for (const st of [
      { ...S, selected: 20 },
      { ...S, selected: 20, focus: "detail" as const },
    ]) {
      for (const k of ["d", "p", "r", "a", "e", "f", "F", "c", "q", "x", "z", "g", "j", "k", "/", "Enter", "ArrowLeft", "ArrowRight"]) {
        expect(reduceKey(st, k, dlg)).toMatchObject({ handled: false, effect: null, state: st });
      }
    }
    expect(reduceKey({ ...S, selected: 20 }, "?", dlg).state.help).toBe(true);
    expect(reduceKey({ ...S, selected: 20, help: true }, "?", dlg).state.help).toBe(false);
    expect(reduceKey({ ...S, selected: 20, focus: "detail" }, "Escape", { ...dlg, layer: "confirm" }).effect).toBe("close-confirm");
  });

  // Plan r2 UI-ASK, pr-view-v4 2.4: q opens Ask in the panel slot. In a text field, q is a letter.
  test("q asks; it does nothing while typing or without a PR", () => {
    expect(reduceKey({ ...S, selected: 20 }, "q", C)).toMatchObject({ effect: "ask", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey({ ...S, selected: 20 }, "q", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey(S, "q", C).handled).toBe(false);
  });

  test("Enter in the detail toggles the current thread, but not on a button", () => {
    const detail = { ...S, selected: 20, focus: "detail" as const };
    expect(reduceKey(detail, "Enter", C).effect).toBe("thread-toggle");
    expect(reduceKey(detail, "Enter", { ...C, onButton: true }).handled).toBe(false);
  });

  test("g then f or c opens Files or Commits; the chord ends after 1.2 s or on another key", () => {
    const pr = { ...S, selected: 20 };
    const g = reduceKey(pr, "g", C);
    expect(g).toMatchObject({ handled: true, effect: null });
    expect(reduceKey(g.state, "f", C)).toMatchObject({ effect: "files", state: { focus: "detail", chord: null } });
    expect(reduceKey(g.state, "c", C).effect).toBe("commits");
    expect(reduceKey(g.state, "x", C)).toMatchObject({ handled: true, effect: null, state: { chord: null } });
    // After the chord ends, f is the Fix key.
    expect(reduceKey(g.state, "f", { ...C, now: C.now + 1300 }).effect).toBe("fix");
    expect(reduceKey(S, "g", C).handled).toBe(false);
  });

  test("g then d shows the current thread or draft in the diff (plan r2 UI-DIFF); d alone still discards", () => {
    const pr = { ...S, selected: 20 };
    const g = reduceKey(pr, "g", C);
    expect(reduceKey(g.state, "d", C)).toMatchObject({ effect: "show-in-diff", state: { focus: "detail", chord: null } });
    expect(reduceKey(pr, "d", C).effect).toBe("discard");
    expect(reduceKey(g.state, "d", { ...C, now: C.now + 1300 }).effect).toBe("discard");
    expect(reduceKey(g.state, "d", { ...C, typing: true }).handled).toBe(false);
  });

  test("detail keys do nothing without a PR or while typing", () => {
    expect(reduceKey(S, "n", C).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20 }, "n", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20, settings: true }, "n", { ...C, settingsLocked: true }).handled).toBe(false);
  });

  // docs/plans/review-v2/spec.md section 3.1 (AC-X1): w opens the Explain page. w had no other use (prototype/v3 keyboard model).
  test("w opens the Explain page; it does nothing while typing, in the help, or without a PR", () => {
    expect(reduceKey({ ...S, selected: 20 }, "w", C)).toMatchObject({ effect: "explain", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey({ ...S, selected: 20 }, "w", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20, help: true }, "w", C).handled).toBe(false);
    expect(reduceKey(S, "w", C).handled).toBe(false);
    expect(HELP_KEYS.flatMap((g) => g.keys).find((x) => x.keys[0] === "w")?.text).toContain("Explain this PR");
  });

  // docs/plans/review-v2/spec.md section 2.1 (AC-D9): t opens the talk about the focused finding. t had no other use.
  test("t opens the talk; it does nothing while typing, in the help, on the Explain page, or without a PR", () => {
    expect(reduceKey({ ...S, selected: 20 }, "t", C)).toMatchObject({ effect: "discuss", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey({ ...S, selected: 20 }, "t", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20, help: true }, "t", C).handled).toBe(false);
    expect(reduceKey({ ...S, selected: 20 }, "t", { ...C, explain: true }).effect).toBe(null);
    expect(reduceKey(S, "t", C).handled).toBe(false);
    expect(HELP_KEYS.flatMap((g) => g.keys).find((x) => x.keys[0] === "t")?.text).toContain("Esc closes the talk");
  });

  test("on the Explain page, Esc goes back to the PR and the keys of the hidden PR do nothing", () => {
    const ex = { ...C, explain: true };
    const detail = { ...S, selected: 20, focus: "detail" as const, mobile: "detail" as const };
    expect(reduceKey(detail, "Escape", ex)).toMatchObject({ effect: "explain-back", handled: true });
    // The run log over the page closes first, then the page. Esc in the list does not close the page.
    expect(reduceKey(detail, "Escape", { ...ex, layer: "log" }).effect).toBe("close-log");
    expect(reduceKey({ ...S, selected: 20 }, "Escape", ex).effect).not.toBe("explain-back");
    for (const k of ["w", "n", "j", "r", "q", "a", "x", "g", "Enter", "2"]) expect([k, reduceKey(detail, k, ex).effect]).toEqual([k, null]);
    // The list keys, the help, and full width still work.
    expect(reduceKey({ ...S, selected: 20 }, "j", ex).state.selected).toBe(30);
    expect(reduceKey(detail, "z", ex).effect).toBe("full-on");
    expect(reduceKey(detail, "?", ex).state.help).toBe(true);
  });
});

// Plan v3 WP14a, prototype/v3 2744-2745: a, e, d, and p. Esc closes the post confirm after the brief.
describe("triage and post keys", () => {
  test("a, e, d, and p act on the selected PR in the detail", () => {
    const pr = { ...S, selected: 20 };
    const effects = ["a", "e", "d", "p"].map((k) => reduceKey(pr, k, C));
    expect(effects.map((r) => r.effect)).toEqual(["accept", "edit", "discard", "post"]);
    for (const r of effects) expect(r.state).toMatchObject({ focus: "detail", mobile: "detail" });
  });

  test("they do nothing while typing, so a reply box takes the letters", () => {
    for (const k of ["a", "e", "d", "p"]) expect(reduceKey({ ...S, selected: 20 }, k, { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey(S, "p", C).handled).toBe(false);
  });

  test("Esc closes the post confirm", () => {
    const detail = { ...S, selected: 20, focus: "detail" as const, mobile: "detail" as const };
    expect(reduceKey(detail, "Escape", { ...C, layer: "confirm" })).toMatchObject({ effect: "close-confirm", state: detail });
  });
});

// Plan pr-view-v4 4.3, 4.4, and section 6: z turns full width on or off. Esc order: dialog, panel slot, full width, then the list.
describe("full width", () => {
  const pr = { ...S, selected: 20 };
  const detail = { ...pr, focus: "detail" as const, mobile: "detail" as const };

  test("z turns full width on from the list or the detail and moves focus to the detail", () => {
    expect(reduceKey(pr, "z", C)).toMatchObject({ effect: "full-on", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey(detail, "z", C).effect).toBe("full-on");
    expect(reduceKey(detail, "z", { ...C, full: true })).toMatchObject({ effect: "full-off", state: { focus: "detail" } });
  });

  test("z does nothing without a PR, while typing, in help, in the narrow layout, or over required settings", () => {
    expect(reduceKey(S, "z", C).handled).toBe(false);
    expect(reduceKey(pr, "z", { ...C, typing: true }).handled).toBe(false);
    expect(reduceKey({ ...pr, help: true }, "z", C).handled).toBe(false);
    expect(reduceKey(pr, "z", { ...C, narrow: true }).handled).toBe(false);
    expect(reduceKey({ ...pr, settings: true }, "z", { ...C, settingsLocked: true }).handled).toBe(false);
  });

  test("z over open settings closes them, as the other detail keys do", () => {
    expect(reduceKey({ ...pr, settings: true }, "z", C)).toMatchObject({ effect: "full-on", state: { settings: false } });
  });

  test("Esc closes the help, then the panel slot, then leaves full width, then goes to the list", () => {
    const full = { ...C, full: true };
    expect(reduceKey({ ...detail, help: true }, "Escape", { ...full, layer: "brief" })).toMatchObject({
      effect: null,
      state: { help: false },
    });
    expect(reduceKey(detail, "Escape", { ...full, layer: "brief" }).effect).toBe("close-brief");
    expect(reduceKey(detail, "Escape", { ...full, layer: "confirm" }).effect).toBe("close-confirm");
    expect(reduceKey(detail, "Escape", full)).toMatchObject({ effect: "full-off", state: { focus: "detail", mobile: "detail" } });
    expect(reduceKey(detail, "Escape", C).effect).toBe("focus-list");
  });

  test("Esc in a text field leaves full width before it leaves the field", () => {
    expect(reduceKey(detail, "Escape", { ...C, full: true, typing: true }).effect).toBe("full-off");
    expect(reduceKey(detail, "Escape", { ...C, typing: true }).effect).toBe("focus-list");
  });

  test("the help names z and the Esc step of full width", () => {
    const keys = HELP_KEYS.flatMap((g) => g.keys);
    expect(keys.find((x) => x.keys[0] === "z")?.text).toBe("Full width on or off: hide the views and the list");
    expect(keys.find((x) => x.keys[0] === "Esc" && x.keys[1] === "←")?.text).toContain(
      "In full width, Esc first goes back to three panes.",
    );
  });
});

// Plan pr-view-v4 section 6 and 2.7: j and k in the detail move over the Drafts rows, the threads, and the file rows.
describe("j and k over the items of the detail", () => {
  test("they move one item and stop at the ends", () => {
    expect(detailStep(5, 0, 1)).toBe(1);
    expect(detailStep(5, 3, -1)).toBe(2);
    expect(detailStep(5, 4, 1)).toBe(4);
    expect(detailStep(5, 0, -1)).toBe(0);
  });

  test("without a current item, j goes to the first item and k to the given item, by default the last", () => {
    expect(detailStep(5, -1, 1, 2)).toBe(0);
    expect(detailStep(5, -1, -1, 2)).toBe(2);
    expect(detailStep(5, -1, -1)).toBe(4);
  });

  test("an empty detail gives no item", () => {
    expect(detailStep(0, -1, 1)).toBeNull();
    expect(detailStep(0, -1, -1)).toBeNull();
  });

  test("j, k, Enter, and o keep their effects; the help names drafts and files", () => {
    const detail = { ...S, selected: 20, focus: "detail" as const };
    expect(["j", "k", "o", "Enter"].map((k) => reduceKey(detail, k, C).effect)).toEqual([
      "thread-next",
      "thread-prev",
      "thread-toggle",
      "thread-toggle",
    ]);
    const text = (k: string) => HELP_KEYS.flatMap((g) => g.keys).find((x) => x.keys[0] === k && !x.second)?.text;
    expect(text("j")).toContain("draft, thread, or file in the detail");
    expect(text("o")).toBe("Open or close the current draft, thread, or file");
  });
});
