// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { useLayoutEffect, useReducer, useRef } from "react";

export function focusFirst(ids: string[]) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) return el.focus();
  }
}

// focus(ids, ready) moves the focus to the first ID that exists after the render where ready(state) holds.
// A requestAnimationFrame can run before React renders the change. The old element then takes the focus and goes away.
export function useFocusAfter<T>(state: T) {
  const want = useRef<{ ids: string[]; ready: (s: T) => boolean } | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    const w = want.current;
    if (!w?.ready(state)) return;
    want.current = null;
    focusFirst(w.ids);
  });
  return (ids: string[], ready: (s: T) => boolean = () => true) => {
    want.current = { ids, ready };
    rerender();
  };
}
