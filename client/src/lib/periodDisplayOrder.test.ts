import { describe, expect, it } from "vitest";
import { addedAfterLaterVisitIds, orderPeriodVisitsForDisplay } from "./periodDisplayOrder";

// Synthetic Period 1 as stored after backfilling Jan 19 once Jan 26 exists:
// rows come back in Session # order, the backfill filled slot 4.
const row = (id: string, sessionNumber: number | null, dos: string | null, sessionsRemaining: number | null) =>
  ({ id, sessionNumber, dateOfService: dos ? new Date(`${dos}T00:00:00Z`) : null, sessionsRemaining });

const stored = [
  row("s1", 1, "2026-01-05", 5),
  row("s2", 2, "2026-01-12", 4),
  row("s3", 3, "2026-01-26", 3),
  row("s4", 4, "2026-01-19", 2),
  row("s5", 5, null, null),
  row("s6", 6, null, null),
];

describe("orderPeriodVisitsForDisplay", () => {
  it("shows the backfilled Jan 19 before Jan 26 and keeps stored values", () => {
    const out = orderPeriodVisitsForDisplay(stored);
    expect(out.map(r => r.id)).toEqual(["s1", "s2", "s4", "s3", "s5", "s6"]);
    // Same objects: Session #, # Remaining and ids are untouched.
    expect(out.find(r => r.id === "s4")).toBe(stored[3]);
    expect(out.map(r => r.sessionNumber)).toEqual([1, 2, 4, 3, 5, 6]);
    expect(stored.map(r => r.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6"]); // input not mutated
  });

  it("keeps undated rows and placeholders exactly where they were", () => {
    const rows = [
      row("a", 1, "2026-02-10", 3),
      row("gap", 2, null, null),
      row("b", 3, "2026-02-03", 2),
      row("ph", null, null, 4),
    ];
    expect(orderPeriodVisitsForDisplay(rows).map(r => r.id)).toEqual(["b", "gap", "a", "ph"]);
  });

  it("is a no-op for rows already in date order, and breaks same-day ties by Session #", () => {
    expect(orderPeriodVisitsForDisplay(stored.slice(0, 2)).map(r => r.id)).toEqual(["s1", "s2"]);
    const tie = [row("x", 2, "2026-03-01", 1), row("y", 1, "2026-03-01", 2)];
    expect(orderPeriodVisitsForDisplay(tie).map(r => r.id)).toEqual(["y", "x"]);
  });
});

describe("addedAfterLaterVisitIds", () => {
  it("flags only the visit entered after a later-dated one", () => {
    expect([...addedAfterLaterVisitIds(stored)]).toEqual(["s4"]);
    expect(addedAfterLaterVisitIds(stored.slice(0, 3)).size).toBe(0);
  });
});
