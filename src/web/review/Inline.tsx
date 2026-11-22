// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Runner text with inline code. It reads no page state, so pure tests can render it.
// Backticks become code. The text is the runner's output, so nothing else renders as markup.
export function Inline({ text }: { text: string }) {
  return text.split(/(`[^`\n]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one text keep their order.
      <code key={i} className="rounded-[3px] bg-sunken px-[3px] font-mono text-[0.9em]">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}
