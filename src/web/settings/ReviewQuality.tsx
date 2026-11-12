// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review quality (docs/plans/review-v2/spec.md section 4.2): one row per profile name and prompt version, last 30 days.
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { DISCARD_REASONS, type ReviewStatsDto } from "../../shared/dto";
import { severities } from "../../shared/review";
import { api } from "../api";
import { DISCARD_LABEL, SEVERITY } from "../review/model";
import { read } from "../shell/data";
import { type AddressedRow, addressedRows, addressedText, pendingText, severityText } from "./quality";

const DAYS = 30;

const useReviewStats = () =>
  useQuery({
    queryKey: ["stats", "review", DAYS],
    queryFn: async () => read<ReviewStatsDto[]>(await api.api.stats.review.$get({ query: { days: String(DAYS) } })),
  });

const pct = (n: number, of: number) => (of ? ` (${Math.round((n / of) * 100)}%)` : "");
const perRun = (n: number, runs: number) => (runs ? (n / runs).toFixed(1) : "0");

function Reasons({ s }: { s: ReviewStatsDto }) {
  const parts = [
    ...DISCARD_REASONS.flatMap((c) => (s.discarded.byReason[c] ? [`${DISCARD_LABEL[c]} ${s.discarded.byReason[c]}`] : [])),
    ...(s.discarded.byReason.none ? [`No reason ${s.discarded.byReason.none}`] : []),
  ];
  return parts.length ? <span className={sub}>{parts.join(", ")}</span> : null;
}

function Addressed({ rows }: { rows: AddressedRow[] }) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <h3 className="m-0 text-sm font-semibold">Addressed by a later change</h3>
        <p className="m-0 text-xs text-muted-foreground">
          A posted finding is addressed when a later commit changed its line or its thread is resolved. It stays pending until the pull
          request gets new commits or closes.
        </p>
      </div>
      {rows.length ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Posted findings that a later change addressed, per prompt version and severity</caption>
            <thead>
              <tr>
                <th scope="col" className={th}>
                  Prompt
                </th>
                <th scope="col" className={th}>
                  All severities
                </th>
                {severities.map((v) => (
                  <th key={v} scope="col" className={th}>
                    {SEVERITY[v]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.promptVersion} data-addressed-row={r.promptVersion}>
                  <th scope="row" className={`${td} text-left font-semibold whitespace-nowrap`}>
                    v{r.promptVersion}
                  </th>
                  <td className={`${td} whitespace-nowrap`}>
                    {addressedText(r.all)}
                    {r.all.pending > 0 && <span className={sub}>{pendingText(r.all)}</span>}
                  </td>
                  {severities.map((v) => (
                    <td key={v} className={`${td} whitespace-nowrap`}>
                      {severityText(r.bySeverity[v])}
                      {r.bySeverity[v].pending > 0 && <span className={sub}>{pendingText(r.bySeverity[v])}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">No posted findings in the last {DAYS} days.</p>
      )}
    </div>
  );
}

const sub = "block text-xs font-normal text-muted-foreground";
const th = "border-b px-2 py-1.5 text-left text-xs font-semibold whitespace-nowrap text-ink-2";
const td = "border-b px-2 py-1.5 align-top tabular-nums";

export function ReviewQuality() {
  const q = useReviewStats();
  const rows = q.data ?? [];
  return (
    <section aria-labelledby="h-quality" className="mt-6 grid max-w-[860px] gap-3 border-t pt-4" data-review-quality>
      <div className="grid gap-0.5">
        <h2 id="h-quality" tabIndex={-1} className="m-0 scroll-mt-4 text-[15px] font-bold outline-none">
          Review quality
        </h2>
        <p className="m-0 text-xs text-muted-foreground">Counts come from your own triage in this app.</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : q.error ? (
        <p className="m-0 flex items-start gap-1.5 text-sm text-destructive">
          <CircleAlert aria-hidden className="mt-0.5 size-[15px] shrink-0" />
          Cannot read the review counts. {q.error.message}
        </p>
      ) : rows.length ? (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Review runs of the last {DAYS} days, per profile and prompt version</caption>
              <thead>
                <tr>
                  <th scope="col" className={th}>
                    Profile
                  </th>
                  <th scope="col" className={th}>
                    Runs
                  </th>
                  <th scope="col" className={th}>
                    Shown per run
                  </th>
                  <th scope="col" className={th}>
                    Check
                  </th>
                  <th scope="col" className={th}>
                    Accepted of shown
                  </th>
                  <th scope="col" className={th}>
                    Discarded
                  </th>
                  <th scope="col" className={th}>
                    Posted
                  </th>
                  <th scope="col" className={th}>
                    Median time
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={`${s.profile}\n${s.promptVersion}`} data-stats-row={`${s.profile}@${s.promptVersion}`}>
                    <th scope="row" className={`${td} text-left font-semibold whitespace-nowrap`}>
                      {s.profile}
                      <span className={sub}>Prompt v{s.promptVersion}</span>
                    </th>
                    <td className={td}>{s.runs}</td>
                    <td className={td}>{perRun(s.shown, s.runs)}</td>
                    <td className={`${td} whitespace-nowrap`}>
                      {s.candidates} found
                      <span className={sub}>
                        {s.refuted} refuted, {s.unsure} unsure
                      </span>
                    </td>
                    {/* One denominator: the shown findings. Accepts from a fold count apart, so the share never exceeds 100%. */}
                    <td className={`${td} whitespace-nowrap`}>
                      {s.acceptedShown} of {s.shown}
                      {pct(s.acceptedShown, s.shown)}
                      {s.accepted > s.acceptedShown && <span className={sub}>{s.accepted - s.acceptedShown} more from a fold</span>}
                      {s.edited > 0 && <span className={sub}>{s.edited} edited</span>}
                    </td>
                    <td className={td}>
                      {s.discarded.total}
                      <Reasons s={s} />
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {s.posted}
                      <span className={sub}>
                        {s.addressed} resolved or fixed{pct(s.addressed, s.posted)}
                      </span>
                      <span className={sub}>
                        {s.outdated} outdated{pct(s.outdated, s.posted)}
                      </span>
                    </td>
                    <td className={`${td} whitespace-nowrap`}>
                      {s.medianMinutes === null ? "–" : `${s.medianMinutes.toFixed(1)} min`}
                      <span className={sub}>${s.runs ? (s.usage.costUsd / s.runs).toFixed(2) : "0.00"} per run</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Addressed rows={addressedRows(rows)} />
        </>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">No review runs in the last {DAYS} days.</p>
      )}
    </section>
  );
}
