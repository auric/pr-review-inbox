// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// The risk list of the run record. It reads no page state, so pure tests can render it. linkish and revealList are the run line styles.
import { cn } from "@/lib/utils";
import { snippet } from "../pr/threads";
import { Inline } from "./Inline";
import { RISK_WORD, type RiskEntry } from "./model";

export const linkish =
  "rl-hit inline-flex cursor-pointer items-center gap-1 rounded text-sm font-medium text-pen hover:underline disabled:cursor-default disabled:opacity-60";
export const revealList = "m-0 grid list-none gap-1.5 p-0";

// docs/plans/review-v2/risk-check.md section 4.8 and postable-risks.md section 4.3: one entry per finder risk with its outcome. An
// entry with a draft names its state and title. Triage stays in Drafts, so the only control is "Show draft".
export function RiskEntries({ entries, onDraft }: { entries: RiskEntry[] | null; onDraft: (draft: number) => void }) {
  if (!entries?.length) return null;
  return (
    <ul aria-label="Risks and what the check found" className={revealList}>
      {entries.map(({ draft: d, ...e }, k) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two risks can have the same words.
        <li key={k} data-risk-entry={e.outcome} className="grid gap-1 border-b border-rule pb-2 last:border-b-0 last:pb-0">
          <p className="m-0 text-sm [overflow-wrap:anywhere]">
            <b className="font-semibold">{RISK_WORD[e.outcome]}</b> <Inline text={e.text} />
          </p>
          <p className="m-0 text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {d ? (
              <>
                <span className="font-semibold">{d.state}:</span> <Inline text={snippet(d.title, 160)} />
                {d.linked && (
                  <>
                    {" "}
                    <button type="button" className={cn(linkish, "text-xs")} onClick={() => onDraft(d.id)}>
                      Show draft<span className="sr-only"> of risk {k + 1}</span>
                    </button>
                  </>
                )}
              </>
            ) : (
              <Inline text={e.note} />
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
