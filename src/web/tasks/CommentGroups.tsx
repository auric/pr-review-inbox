// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// ps6-ps7-plan.md section 4, PS6-C, and part-session.md section 2.14 step 3: the groups of the sorted PR comments of a task part, each
// with one choice. Fix groups go to the part session with "Send N groups". Push back and Reply only keep the draft of the sort, which
// the user accepts and posts from the PR view.
import type { TaskPartDto } from "../../shared/dto";
import { Badge } from "../components/ui/badge";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import { type CommentChoice, type CommentPicks, choiceOf } from "./model";

type Sorted = NonNullable<NonNullable<TaskPartDto["comments"]>["sorted"]>;

const CHOICES: { value: CommentChoice; label: string }[] = [
  { value: "fix", label: "Fix" },
  { value: "pushback", label: "Push back" },
  { value: "reply", label: "Reply only" },
];
const JUDGEMENT: Record<string, string> = {
  valid: "Valid",
  partly: "Partly valid",
  invalid: "Not valid",
  question: "Question",
  settled: "Settled",
  unsettled: "Open",
  followup: "Follow-up",
};

export function CommentGroups(props: {
  sorted: Sorted;
  picks: CommentPicks;
  onPick: (group: number, choice: CommentChoice) => void;
  disabled: boolean;
}) {
  return (
    <section aria-labelledby="comment-groups-title" className="grid gap-2" data-comment-groups>
      <h3 id="comment-groups-title" className="m-0 text-sm font-semibold">
        Sorted PR comments
      </h3>
      <ol className="m-0 grid list-none gap-2 p-0">
        {props.sorted.groups.map((g) => {
          const label = `comment-group-${g.n}`;
          return (
            <li key={g.n} data-group={g.n} className="grid gap-2 rounded-md border bg-card px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span id={label} className="text-sm font-semibold">
                  Group {g.n}
                </span>
                <ToggleGroup
                  aria-labelledby={label}
                  variant="outline"
                  size="sm"
                  spacing={0}
                  className="flex-wrap"
                  disabled={props.disabled}
                  value={[choiceOf(g, props.picks)]}
                  onValueChange={(v) => {
                    const c = v[0] as CommentChoice | undefined;
                    if (c) props.onPick(g.n, c);
                  }}
                >
                  {CHOICES.map((c) => (
                    <ToggleGroupItem
                      key={c.value}
                      value={c.value}
                      className="aria-pressed:bg-foreground aria-pressed:font-semibold aria-pressed:text-background"
                    >
                      {c.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <ul className="m-0 grid list-none gap-1.5 p-0">
                {g.threads.map((x) => (
                  <li key={x.thread} data-thread={x.thread} className="grid gap-0.5 text-sm">
                    <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span translate="no" className="min-w-0 truncate font-mono">
                        {x.place}
                      </span>
                      {x.judgement && <Badge variant="soft">{JUDGEMENT[x.judgement] ?? x.judgement}</Badge>}
                    </span>
                    {x.body && <p className="m-0 line-clamp-3 whitespace-pre-wrap text-ink-2">{x.body}</p>}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
