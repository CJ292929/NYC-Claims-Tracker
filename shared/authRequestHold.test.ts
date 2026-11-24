import { describe, expect, it } from "vitest";
import {
  classifyAuthorizationAlert,
  heldAuthorizationAlerts,
  isHoldEffective,
  isHoldSuperseded,
  normalizeHoldReason,
  type AuthorizationRequestHoldInfo,
} from "./authRequestHold";
import { deriveAuthorizationOverviewMetrics, getTopAuthorizationAttention } from "../client/src/lib/authorizationOverview";
import { deriveDashboardKpis } from "../client/src/lib/dashboardOverview";

const hold = (authPeriod: number | null): AuthorizationRequestHoldInfo => ({
  holdId: `h-${authPeriod}`, authPeriod, reason: "Waiting on referral", heldAt: "2026-11-20T15:00:00Z", heldByDisplay: "Synthetic Staff",
});

type Row = Parameters<typeof deriveAuthorizationOverviewMetrics>[0][number];
const row = (patientName: string, over: Partial<Row>): Row => ({
  patientId: patientName, patientName, insurance: "Synthetic Ins", authPeriod: 1, sessionsAuthorized: 10, sessionsRemaining: 5,
  authStatus: "approved", authValidUntil: null, urgency: "ok", hold: null, ...over,
});

describe("classifyAuthorizationAlert — the one shared classification", () => {
  it("held on the current period → on_hold, whatever the urgency (pending stays pending)", () => {
    for (const urgency of ["pending", "critical", "exhausted", "denied", "expired", "warning", "ok"] as const) {
      expect(classifyAuthorizationAlert({ urgency, authPeriod: 2, hold: hold(2) })).toBe("on_hold");
    }
  });

  it("no period yet: a null-scoped hold applies until a first period exists", () => {
    expect(classifyAuthorizationAlert({ urgency: "ok", authPeriod: null, hold: hold(null) })).toBe("on_hold");
    // Initial approval created period 1: the old hold no longer applies.
    const afterApproval = { urgency: "critical" as const, authPeriod: 1, hold: hold(null) };
    expect(isHoldSuperseded(afterApproval)).toBe(true);
    expect(classifyAuthorizationAlert(afterApproval)).toBe("attention");
  });

  it("an old period's hold never suppresses a newly approved period", () => {
    const newPeriodNeedsAttention = { urgency: "warning" as const, authPeriod: 3, hold: hold(2) };
    expect(isHoldEffective(newPeriodNeedsAttention)).toBe(false);
    expect(classifyAuthorizationAlert(newPeriodNeedsAttention)).toBe("attention");
    expect(classifyAuthorizationAlert({ urgency: "ok", authPeriod: 3, hold: hold(2) })).toBe("ok");
  });

  it("no hold: attention iff urgency is not ok", () => {
    expect(classifyAuthorizationAlert({ urgency: "expired", authPeriod: 1 })).toBe("attention");
    expect(classifyAuthorizationAlert({ urgency: "ok", authPeriod: 1, hold: null })).toBe("ok");
  });

  it("the hold list keeps effective AND superseded holds, so a held patient is always findable", () => {
    const rows = [
      { urgency: "ok" as const, authPeriod: 1, hold: hold(1) },
      { urgency: "critical" as const, authPeriod: 3, hold: hold(2) },
      { urgency: "critical" as const, authPeriod: 1, hold: null },
    ];
    expect(heldAuthorizationAlerts(rows)).toHaveLength(2);
  });

  it("reason must be trimmed and nonblank, ≤ 500", () => {
    expect(normalizeHoldReason("  Waiting  ")).toBe("Waiting");
    expect(normalizeHoldReason("   ")).toBeNull();
    expect(normalizeHoldReason(undefined)).toBeNull();
    expect(normalizeHoldReason("x".repeat(500))).toHaveLength(500);
    expect(normalizeHoldReason("x".repeat(501))).toBeNull();
  });
});

describe("counts and lists agree (Authorization Attention, Needs Attention, On Hold)", () => {
  const rows = [
    row("Held Pending", { urgency: "pending", authStatus: "pending", authPeriod: 2, hold: hold(2) }),
    row("Held Expired", { urgency: "expired", periodExpired: true, authPeriod: 1, hold: hold(1) }),
    row("Superseded", { urgency: "critical", authPeriod: 3, hold: hold(2) }),
    row("Plain Critical", { urgency: "critical", authPeriod: 1 }),
    row("No Auth", { urgency: "ok", authStatus: "none", authPeriod: null, sessionsAuthorized: null, sessionsRemaining: null }),
    row("On Track", { urgency: "ok" }),
  ];

  it("held rows leave needsAttention and are counted once as onHold; status tallies are unchanged", () => {
    const m = deriveAuthorizationOverviewMetrics(rows);
    expect(m.needsAttention).toBe(2); // Superseded + Plain Critical
    expect(m.onHold).toBe(2);
    expect(m.pending).toBe(1); // hold never changes the request's status
    expect(m.statusDistribution.pending).toBe(1);
  });

  it("the Needs Attention list and the Dashboard KPI match the count", () => {
    const top = getTopAuthorizationAttention(rows, 10).map(r => r.patientName);
    expect(top.sort()).toEqual(["Plain Critical", "Superseded"]);
    const kpis = deriveDashboardKpis({ activePatientCount: 6, authAlerts: rows, followUpClaimCount: 0, completedPatientCount: 0 });
    expect(kpis.authorizationAttention).toBe(top.length);
    const effectiveHeld = heldAuthorizationAlerts(rows).filter(r => classifyAuthorizationAlert(r) === "on_hold");
    expect(effectiveHeld).toHaveLength(deriveAuthorizationOverviewMetrics(rows).onHold);
    // No row is in both the actionable list and the effective-hold list.
    expect(effectiveHeld.some(r => top.includes(r.patientName))).toBe(false);
  });

  it("resume: the same row without its hold is re-derived from its current urgency", () => {
    const resumed = rows.map(r => ({ ...r, hold: null }));
    const m = deriveAuthorizationOverviewMetrics(resumed);
    expect(m.onHold).toBe(0);
    expect(m.needsAttention).toBe(4); // pending + expired back, superseded + critical unchanged
  });
});
