// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The attachment switch of the review brief: Ctrl+Enter starts the review and must not toggle the switch.
import { describe, expect, test } from "bun:test";
import { keepModEnter } from "../../src/web/review/model";

console.log(`brief-keys.test.ts imported from ${Bun.resolveSync("../../src/web/review/model", import.meta.dir)}`);

const press = (key: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
  const e = { key, ctrlKey: false, metaKey: false, ...mods, prevented: false, stopped: false };
  keepModEnter({
    ...e,
    preventDefault: () => {
      e.prevented = true;
    },
    stopPropagation: () => {
      e.stopped = true;
    },
  } as Parameters<typeof keepModEnter>[0]);
  return { prevented: e.prevented, stopped: e.stopped };
};

describe("keepModEnter", () => {
  test("Ctrl+Enter and Cmd+Enter are prevented, so Base UI skips the click, and they still bubble", () => {
    expect(press("Enter", { ctrlKey: true })).toEqual({ prevented: true, stopped: false });
    expect(press("Enter", { metaKey: true })).toEqual({ prevented: true, stopped: false });
  });

  test("plain Enter, Space, and Ctrl+Space still toggle the switch", () => {
    expect(press("Enter")).toEqual({ prevented: false, stopped: false });
    expect(press(" ")).toEqual({ prevented: false, stopped: false });
    expect(press(" ", { ctrlKey: true })).toEqual({ prevented: false, stopped: false });
  });
});
