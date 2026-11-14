// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Addressed rate of posted findings (docs/plans/review-v2/spec.md AC-R30): one row per prompt version over all profiles.
import type { PostOutcomes, ReviewStatsDto } from "../../shared/dto";
import { type Severity, severities } from "../../shared/review";

export type AddressedRow = { promptVersion: string; all: PostOutcomes; bySeverity: Record<Severity, PostOutcomes> };

const zero = (): PostOutcomes => ({ addressed: 0, open: 0, pending: 0 });
const add = (to: PostOutcomes, o: PostOutcomes) => {
  to.addressed += o.addressed;
  to.open += o.open;
  to.pending += o.pending;
};

// Prompt versions without a posted finding give no row. Newest version first.
export function addressedRows(stats: ReviewStatsDto[]): AddressedRow[] {
  const rows = new Map<string, AddressedRow>();
  for (const s of stats) {
    let r = rows.get(s.promptVersion);
    if (!r) {
      r = {
        promptVersion: s.promptVersion,
        all: zero(),
        bySeverity: Object.fromEntries(severities.map((v) => [v, zero()])) as Record<Severity, PostOutcomes>,
      };
      rows.set(s.promptVersion, r);
    }
    for (const v of severities) {
      add(r.bySeverity[v], s.outcomes[v]);
      add(r.all, s.outcomes[v]);
    }
  }
  return [...rows.values()]
    .filter((r) => r.all.addressed + r.all.open + r.all.pending > 0)
    .sort((a, b) => b.promptVersion.localeCompare(a.promptVersion, undefined, { numeric: true }));
}

// Pending findings are not in the denominator.
const share = (o: PostOutcomes, noun: string) => {
  const of = o.addressed + o.open;
  return `${o.addressed} of ${of}${noun}${of ? ` (${Math.round((o.addressed / of) * 100)}%)` : ""}`;
};

export const addressedText = (o: PostOutcomes) => `Addressed: ${share(o, " posted findings")}`;

// docs/plans/review-v2/review-questions.md: the finder questions of the runs with counts. Empty: no such run.
export const questionsText = (q: ReviewStatsDto["questions"]) =>
  q.runs ? `Questions: ${q.asked} asked, ${q.answered} answered, ${q.findings} to findings, ${q.kept} kept` : "";
export const severityText = (o: PostOutcomes) => (o.addressed + o.open + o.pending ? share(o, "") : "–");
export const pendingText = (o: PostOutcomes) => (o.pending ? `${o.pending} pending` : "");
