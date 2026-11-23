// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

import { Fragment } from "react";
import type { RunDto } from "../../shared/dto";
import { relatedText } from "./model";

// submodule-prs.md section 5.6: one footer line per label. A warn part uses the destructive color, as "Not loaded" does.
export function RelatedLines({ run }: { run: Pick<RunDto, "related"> }) {
  return relatedText(run).map(({ label, parts }) => (
    <span key={label} data-run-related className="text-muted-foreground">
      {label}:{" "}
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the parts are stored data in a fixed order, and two parts can have one text.
        <Fragment key={i}>
          {i > 0 && "; "}
          <span data-warn={p.warn || undefined} className={p.warn ? "text-destructive" : undefined}>
            {p.text}
          </span>
        </Fragment>
      ))}
    </span>
  ));
}
