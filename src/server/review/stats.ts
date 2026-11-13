// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Review quality (docs/plans/review-v2/spec.md section 4.2, design.md M3): outcome counts per profile name and prompt version,
// from the existing rows. No table of its own.
import type { Database } from "bun:sqlite";
import { DISCARD_REASONS, type PostOutcomes, type ReviewStatsDto, type RunSummary, type RunUsage, type Volume } from "../../shared/dto";
import { type Carried, displayGroup, type FindingPayload, type SessionMark, severities } from "../../shared/review";

const DAY_MS = 86_400_000;

const SQL = {
  // Running, failed, and cancelled runs store no findings to triage. The self-review of a task (pr NULL) counts nowhere.
  runs: `SELECT id, COALESCE(profile_name, profile) AS profile, COALESCE(prompt_version, '1') AS version, summary_json, usage_json,
      started_at, finished_at FROM review_run
    WHERE pr IS NOT NULL AND kind = 'review' AND status IN ('completed', 'incomplete') AND started_at >= $since ORDER BY id`,
  // addressed and outdated need a confirmed post that holds the item. A general post holds many items.
  items: `SELECT i.id, i.run, i.status, i.edited, i.payload_json,
      EXISTS (SELECT 1 FROM post p, json_each(p.items_json) j
          JOIN comment c ON c.pr = p.pr AND c.comment_id = p.remote_id
        WHERE p.state = 'confirmed' AND json_extract(j.value, '$.id') = i.id
          AND (c.thread_resolved = 1 OR EXISTS (SELECT 1 FROM review_item f JOIN review_run fr ON fr.id = f.run
              JOIN fix_commit fc ON fc.id = json_extract(f.payload_json, '$.fix.id')
            WHERE fr.pr = p.pr AND f.kind = 'reply' AND f.thread = p.remote_id AND fc.state <> 'undone'))) AS addressed,
      EXISTS (SELECT 1 FROM post p, json_each(p.items_json) j
          JOIN comment c ON c.pr = p.pr AND c.comment_id = p.remote_id
        WHERE p.state = 'confirmed' AND json_extract(j.value, '$.id') = i.id AND c.orphaned_at > p.created_at) AS outdated,
      EXISTS (SELECT 1 FROM post p, json_each(p.items_json) j
          JOIN comment c ON c.pr = p.pr AND c.comment_id = p.remote_id
        WHERE p.state = 'confirmed' AND json_extract(j.value, '$.id') = i.id AND c.thread_resolved = 1) AS resolved,
      -- The outbox posts only while the PR head is the run head, so another head now is a head after the post.
      EXISTS (SELECT 1 FROM post p, json_each(p.items_json) j
          JOIN comment c ON c.pr = p.pr AND c.comment_id = p.remote_id
          JOIN pull_request pr ON pr.id = p.pr JOIN review_run pr_run ON pr_run.id = p.run
        WHERE p.state = 'confirmed' AND json_extract(j.value, '$.id') = i.id
          AND (pr.source_head <> pr_run.source_head OR pr.state IN ('MERGED', 'DECLINED'))) AS moved,
      EXISTS (SELECT 1 FROM review_item c WHERE c.kind = 'finding' AND json_extract(c.payload_json, '$.carried.from') = i.id) AS copied
    FROM review_item i JOIN review_run r ON r.id = i.run
    WHERE i.kind = 'finding' AND r.pr IS NOT NULL AND r.kind = 'review' AND r.status IN ('completed', 'incomplete') AND r.started_at >= $since
    ORDER BY i.id`,
};

type RunRow = {
  id: number;
  profile: string;
  version: string;
  summary_json: string | null;
  usage_json: string | null;
  started_at: number;
  finished_at: number | null;
};
type ItemRow = {
  id: number;
  run: number;
  status: string;
  edited: number;
  payload_json: string;
  addressed: number;
  outdated: number;
  resolved: number;
  moved: number;
  copied: number;
};
export type StatsPayload = FindingPayload & {
  carried?: Carried;
  fixed?: unknown;
  session?: SessionMark;
  revises?: number;
  discardReason?: { code: string };
};

// A discard by the check, a fix commit, a closing re-review, or a session reject is not a triage by the user.
// A reason chip comes only from the user. hasCopy: a re-review carried the item, which discarded the source.
export function userDiscard(p: StatsPayload, hasCopy: boolean): boolean {
  if (p.discardReason) return true;
  return !(
    p.discardedBy === "verify" ||
    hasCopy ||
    p.fixed ||
    p.session?.verdict === "reject" ||
    (p.carried && p.carried.verdict !== "open")
  );
}

// Candidate A (review-ideas.md): changed = the anchor turned orphaned after the post. moved = the PR got a new head or closed.
// A posted finding stays pending until it is resolved, its line changed, or moved is true.
export function postOutcome(o: { resolved: boolean; changed: boolean; moved: boolean }): keyof PostOutcomes {
  if (o.resolved || o.changed) return "addressed";
  return o.moved ? "open" : "pending";
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const at = (k: number) => s[k] as number;
  return s.length % 2 ? at(m) : (at(m - 1) + at(m)) / 2;
}

export function reviewStats(db: Database, days: number, now = Date.now()): ReviewStatsDto[] {
  const since = now - days * DAY_MS;
  const runs = db.query(SQL.runs).all({ since }) as RunRow[];
  const items = (db.query(SQL.items).all({ since }) as ItemRow[]).map((r) => ({ ...r, p: JSON.parse(r.payload_json) as StatsPayload }));
  // The newest copy of each carried item. Copies have higher IDs than their sources.
  const copyOf = new Map<number, (typeof items)[number]>();
  for (const i of items) if (i.p.carried) copyOf.set(i.p.carried.from, i);
  const last = (i: (typeof items)[number]) => {
    let at = i;
    for (let next = copyOf.get(at.id); next; next = copyOf.get(at.id)) at = next;
    return at;
  };

  const groups = new Map<string, { dto: ReviewStatsDto; minutes: number[] }>();
  const runInfo = new Map<number, { group: ReviewStatsDto; volume: Volume | undefined; checked: boolean }>();
  for (const r of runs) {
    const key = JSON.stringify([r.profile, r.version]);
    let g = groups.get(key);
    if (!g) {
      const byReason = Object.fromEntries([...DISCARD_REASONS, "none"].map((c) => [c, 0])) as ReviewStatsDto["discarded"]["byReason"];
      g = {
        dto: {
          profile: r.profile,
          promptVersion: r.version,
          runs: 0,
          candidates: 0,
          refuted: 0,
          unsure: 0,
          shown: 0,
          accepted: 0,
          acceptedShown: 0,
          edited: 0,
          discarded: { total: 0, byReason },
          posted: 0,
          addressed: 0,
          outdated: 0,
          outcomes: Object.fromEntries(severities.map((v) => [v, { addressed: 0, open: 0, pending: 0 }])) as ReviewStatsDto["outcomes"],
          medianMinutes: null,
          usage: { costUsd: 0, turns: 0 },
          questions: { runs: 0, asked: 0, answered: 0, findings: 0, kept: 0 },
        },
        minutes: [],
      };
      groups.set(key, g);
    }
    const d = g.dto;
    d.runs++;
    const summary = r.summary_json ? (JSON.parse(r.summary_json) as Partial<RunSummary>) : {};
    if (summary.verify) {
      d.candidates += summary.verify.candidates;
      d.refuted += summary.verify.refuted;
      d.unsure += summary.verify.unsure;
    }
    // docs/plans/review-v2/review-questions.md: runs before prompt version 2.7 have no question counts.
    const q = summary.finderQuestions;
    if (q) {
      d.questions.runs++;
      d.questions.asked += q.asked;
      d.questions.answered += q.answered;
      d.questions.findings += q.findings;
      d.questions.kept += q.kept;
    }
    if (r.usage_json) {
      const u = JSON.parse(r.usage_json) as RunUsage;
      d.usage.costUsd += u.costUsd ?? 0;
      d.usage.turns += u.turns ?? 0;
    }
    if (r.finished_at !== null) g.minutes.push((r.finished_at - r.started_at) / 60_000);
    runInfo.set(r.id, { group: d, volume: summary.volume, checked: summary.verify !== undefined });
  }

  for (const i of items) {
    const run = runInfo.get(i.run);
    // A copy counts in the run of its source. A revision of a finding (payload revises) is no finding of its own.
    if (!run || i.p.carried || i.p.revises !== undefined) continue;
    const d = run.group;
    // A run from before the check phase has no candidate count: each stored finding was a candidate.
    if (!run.checked) d.candidates++;
    const shown = displayGroup(i.p, run.volume) === "main";
    if (shown) d.shown++;
    const end = last(i);
    if (end.status === "accepted" || end.status === "posted") {
      d.accepted++;
      if (shown) d.acceptedShown++;
      if (end.edited) d.edited++;
    }
    if (end.status === "posted") {
      d.posted++;
      if (end.addressed) d.addressed++;
      if (end.outdated) d.outdated++;
      const sev = d.outcomes[end.p.severity];
      if (sev) sev[postOutcome({ resolved: end.resolved === 1, changed: end.outdated === 1, moved: end.moved === 1 })]++;
    }
    if (end.status === "discarded" && userDiscard(end.p, end.copied === 1)) {
      d.discarded.total++;
      const code = end.p.discardReason?.code;
      d.discarded.byReason[code && code in d.discarded.byReason ? (code as keyof typeof d.discarded.byReason) : "none"]++;
    }
  }

  return [...groups.values()]
    .map((g) => ({ ...g.dto, medianMinutes: median(g.minutes) }))
    .sort((a, b) => a.profile.localeCompare(b.profile) || b.promptVersion.localeCompare(a.promptVersion, undefined, { numeric: true }));
}
