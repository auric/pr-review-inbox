// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Ihor Lifanov

// Addressed rate of posted findings (docs/plans/review-v2/spec.md AC-R30): the rows and texts of Settings, Review quality.
import { describe, expect, test } from "bun:test";
import type { PostOutcomes, ReviewStatsDto } from "../../src/shared/dto";
import { addressedRows, addressedText, pendingText, severityText } from "../../src/web/settings/quality";

const ZERO: PostOutcomes = { addressed: 0, open: 0, pending: 0 };
const stats = (profile: string, promptVersion: string, outcomes: Partial<ReviewStatsDto["outcomes"]>) =>
  ({ profile, promptVersion, outcomes: { blocker: ZERO, major: ZERO, minor: ZERO, nit: ZERO, ...outcomes } }) as ReviewStatsDto;

describe("addressed rate model (AC-R30)", () => {
  test("joins profiles per prompt version, sums severities, drops versions without posts, newest first", () => {
    const rows = addressedRows([
      stats("General", "2.5", { major: { addressed: 1, open: 1, pending: 0 } }),
      stats("Security", "2.5", { major: { addressed: 1, open: 0, pending: 1 }, nit: { addressed: 0, open: 1, pending: 0 } }),
      stats("General", "2.10", { blocker: { addressed: 1, open: 0, pending: 0 } }),
      stats("General", "1", {}),
    ]);
    expect(rows.map((r) => r.promptVersion)).toEqual(["2.10", "2.5"]);
    const v25 = rows[1];
    expect(v25?.all).toEqual({ addressed: 2, open: 2, pending: 1 });
    expect(v25?.bySeverity.major).toEqual({ addressed: 2, open: 1, pending: 1 });
    expect(v25?.bySeverity.blocker).toEqual(ZERO);
  });

  test("texts leave pending out of the share", () => {
    expect(addressedText({ addressed: 2, open: 2, pending: 1 })).toBe("Addressed: 2 of 4 posted findings (50%)");
    expect(addressedText({ addressed: 0, open: 0, pending: 3 })).toBe("Addressed: 0 of 0 posted findings");
    expect(pendingText({ addressed: 0, open: 0, pending: 3 })).toBe("3 pending");
    expect(pendingText(ZERO)).toBe("");
    expect(severityText({ addressed: 1, open: 2, pending: 0 })).toBe("1 of 3 (33%)");
    expect(severityText(ZERO)).toBe("–");
  });
});
