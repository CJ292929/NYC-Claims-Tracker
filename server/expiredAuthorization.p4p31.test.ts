/**
 * server/expiredAuthorization.p4p31.test.ts — P4-P31 "Expired" authorization status.
 *
 * Pure-logic coverage (synthetic data only) of the shared period math, the
 * shared urgency, the server's period targeting and the client presentation:
 *   - 16 authorized / 13 completed, then marked Expired: authorized stays 16,
 *     completed stays 13, the 3 unused stay visible as history, none count as
 *     available, and it shows "Authorization Expired" (not Exhausted/Denied).
 *   - A fully used Approved period is still "Sessions Exhausted".
 *   - Denied stays distinct from Expired.
 *   - Expiry is never inferred from dates or a zero balance.
 *   - Mark Requested / Approve target the right period after an expiry.
 * The SQL side (period-scoped write, audit, approve not reactivating the old
 * period) is proven against real Postgres in
 * server/expiredAuthorization.pg.integration.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  deriveAuthPeriodMetrics,
  determineActivePeriod,
  getPeriodMetrics,
  isLatestPeriodExpired,
  isPeriodExpired,
  type AuthPeriodVisit,
} from "@shared/authPeriodMetrics";
import { deriveAuthorizationUrgency } from "@shared/authUrgency";
import { determineActiveAuthPeriod, determineMarkAsRequestedTargetRow } from "./db";
import { getPatientMetrics } from "@/lib/patientMetrics";
import { derivePatientAlertPresentation } from "@/lib/patientAuthUrgency";
import {
  getAuthorizationActivity,
  getCompletedSessions,
  matchesAuthorizationRecordFilters,
  sortAuthorizationRecords,
} from "@/lib/authorizationRecordFilters";
import { deriveAuthorizationOverviewMetrics, type AuthorizationOverviewRecord } from "@/lib/authorizationOverview";

type V = AuthPeriodVisit & { authStatus: string };

/** One period: `authorized` rows, the first `completed` of them dated. */
function period(n: number, authorized: number, completed: number, authStatus = "none"): V[] {
  return Array.from({ length: authorized }, (_, i) => ({
    authPeriod: n,
    sessionsAuthorized: authorized,
    dateOfService: i < completed ? `2026-0${n}-${String(i + 1).padStart(2, "0")}` : null,
    authStatus,
  }));
}

const NOW = new Date("2026-11-14T12:00:00Z");

describe("P4-P31 period math: 13 of 16 then Expired", () => {
  const expired = period(1, 16, 13, "expired");

  it("keeps authorized 16 and completed 13, reports 3 unused, 0 available", () => {
    expect(getPeriodMetrics(expired, 1)).toEqual({
      authorized: 16, completed: 13, remaining: 0, expired: true, unusedExpired: 3,
    });
  });

  it("is never the active period, so nothing counts as available", () => {
    expect(determineActivePeriod(expired)).toBeNull();
    expect(deriveAuthPeriodMetrics(expired).activeMetrics.remaining).toBe(0);
  });

  it("patient metrics show 16 / 13 / 0 with 3 unused as history", () => {
    expect(getPatientMetrics(expired)).toEqual({
      totalAuthorized: 16, completed: 13, remaining: 0, activePeriod: null, expired: true, unusedExpired: 3,
    });
  });

  it("shows Authorization Expired, not Sessions Exhausted or Denied", () => {
    const p = derivePatientAlertPresentation(expired, 0, null, NOW);
    expect(p.urgency).toBe("expired");
    expect(p.label).toBe("Authorization Expired");
  });

  it("one row marked Expired is enough to expire its period (any-row rule), and only that period", () => {
    const rows = [...period(1, 4, 4, "approved"), ...period(2, 16, 13)];
    rows[rows.length - 1] = { ...rows[rows.length - 1], authStatus: "expired" };
    expect(isPeriodExpired(rows, 2)).toBe(true);
    expect(isPeriodExpired(rows, 1)).toBe(false);
    expect(getPeriodMetrics(rows, 1)).toMatchObject({ authorized: 4, completed: 4, expired: false });
  });
});

describe("P4-P31 distinct from Exhausted and Denied", () => {
  it("fully used Approved period is still Sessions Exhausted", () => {
    const used = period(1, 16, 16, "approved");
    expect(getPeriodMetrics(used, 1)).toMatchObject({ remaining: 0, expired: false, unusedExpired: 0 });
    const p = derivePatientAlertPresentation(used, 0, null, NOW);
    expect(p.urgency).toBe("exhausted");
    expect(p.label).toBe("Sessions Exhausted");
  });

  it("Denied stays Denied and does not expire the period", () => {
    const denied = period(1, 16, 13, "denied");
    expect(getPeriodMetrics(denied, 1)).toMatchObject({ remaining: 3, expired: false });
    expect(derivePatientAlertPresentation(denied, 3, null, NOW).urgency).toBe("denied");
  });

  it("a Denied status row in an expired period still reads Denied (denied keeps top priority)", () => {
    expect(deriveAuthorizationUrgency({ remaining: 0, authStatus: "denied", periodExpired: true, now: NOW }).urgency).toBe("denied");
  });
});

describe("P4-P31 expiry is never inferred", () => {
  it("a past Authorization Valid Until date does not make a period expired", () => {
    const rows = period(1, 16, 13);
    expect(isPeriodExpired(rows, 1)).toBe(false);
    const p = derivePatientAlertPresentation(rows, 3, NOW.getTime() - 86_400_000, NOW);
    expect(p.urgency).not.toBe("expired");
  });

  it("zero remaining without Expired is Exhausted, not Expired", () => {
    expect(deriveAuthorizationUrgency({ remaining: 0, authStatus: "none", now: NOW }).urgency).toBe("exhausted");
  });

  it("rows without authStatus are never expired (callers that don't select it)", () => {
    const rows: AuthPeriodVisit[] = [{ authPeriod: 1, sessionsAuthorized: 2, dateOfService: null }];
    expect(getPeriodMetrics(rows, 1)).toMatchObject({ remaining: 2, expired: false });
  });
});

describe("P4-P31 request / re-request / approval targeting", () => {
  type Row = { id: string; auth_period: number; session_number: number; sessions_authorized: number; date_of_service: string | null; auth_status: string };
  function rows(p: number, authorized: number, completed: number, status: string, prefix: string): Row[] {
    return Array.from({ length: authorized }, (_, i) => ({
      id: `${prefix}-${i + 1}`, auth_period: p, session_number: i + 1, sessions_authorized: authorized,
      date_of_service: i < completed ? "2026-05-01" : null, auth_status: status,
    }));
  }

  it("an older expired period with unused sessions is skipped: the newer active period is targeted", () => {
    const all = [...rows(1, 16, 13, "expired", "p1"), ...rows(2, 10, 2, "none", "p2")];
    expect(determineActiveAuthPeriod(all)).toBe(2);
    expect(determineMarkAsRequestedTargetRow(all)?.id).toBe("p2-10");
  });

  it("from an expired latest period, Mark Requested targets that period's status row", () => {
    const all = [...rows(1, 4, 4, "approved", "p1"), ...rows(2, 16, 13, "expired", "p2")];
    expect(determineActiveAuthPeriod(all)).toBeNull();
    expect(determineMarkAsRequestedTargetRow(all)?.id).toBe("p2-16");
  });

  it("after the request, the period stays expired (0 available) and shows Pending so Approved / Re-request are offered", () => {
    const visits: V[] = period(1, 16, 13, "expired");
    visits[15] = { ...visits[15], authStatus: "pending" };
    expect(getPeriodMetrics(visits, 1)).toMatchObject({ remaining: 0, expired: true, unusedExpired: 3 });
    const p = derivePatientAlertPresentation(visits, 0, null, NOW);
    expect(p.urgency).toBe("pending");
    expect(p.authStatus).toBe("pending");
  });

  it("after approval creates the next period, that new period is active with only its own sessions", () => {
    const visits: V[] = [...period(1, 16, 13, "expired"), ...period(2, 12, 0)];
    const m = getPatientMetrics(visits);
    expect(m).toMatchObject({ activePeriod: 2, totalAuthorized: 12, completed: 0, remaining: 12, expired: false });
    expect(getPeriodMetrics(visits, 1)).toMatchObject({ authorized: 16, completed: 13, unusedExpired: 3, expired: true });
  });

  it("isLatestPeriodExpired drives Completed Patients: an expired latest period is not 'completed'", () => {
    expect(isLatestPeriodExpired(period(1, 16, 13, "expired"))).toBe(true);
    expect(isLatestPeriodExpired([...period(1, 16, 13, "expired"), ...period(2, 4, 4, "approved")])).toBe(false);
  });
});

describe("P4-P31 records, filters and overview", () => {
  const base = { insurance: "Synthetic Ins", authPeriod: 1, authValidUntil: null, authExpiryWarning: false };
  const records: AuthorizationOverviewRecord[] = [
    { ...base, patientId: "a", patientName: "Synthetic A", sessionsAuthorized: 16, sessionsRemaining: 0, authStatus: "expired", urgency: "expired", periodExpired: true, unusedExpiredSessions: 3 },
    { ...base, patientId: "b", patientName: "Synthetic B", sessionsAuthorized: 16, sessionsRemaining: 0, authStatus: "approved", urgency: "exhausted", periodExpired: false, unusedExpiredSessions: 0 },
    { ...base, patientId: "c", patientName: "Synthetic C", sessionsAuthorized: 16, sessionsRemaining: 3, authStatus: "denied", urgency: "denied", periodExpired: false, unusedExpiredSessions: 0 },
  ];

  it("completed for an expired record is 13, not 16", () => {
    expect(getCompletedSessions(16, 0, 3)).toBe(13);
    expect(getCompletedSessions(16, 0)).toBe(16);
  });

  it("activity is 'expired' for an expired period, 'exhausted' for a fully used one", () => {
    expect(getAuthorizationActivity(0, true)).toBe("expired");
    expect(getAuthorizationActivity(0, false)).toBe("exhausted");
  });

  it("status, urgency and activity filters separate Expired from Denied and Exhausted", () => {
    const scope = { search: "", insurance: "", authStatus: "all", urgency: "all", activity: "all" };
    expect(records.filter(r => matchesAuthorizationRecordFilters(r, { ...scope, authStatus: "expired" })).map(r => r.patientId)).toEqual(["a"]);
    expect(records.filter(r => matchesAuthorizationRecordFilters(r, { ...scope, urgency: "denied" })).map(r => r.patientId)).toEqual(["c"]);
    expect(records.filter(r => matchesAuthorizationRecordFilters(r, { ...scope, activity: "exhausted" })).map(r => r.patientId)).toEqual(["b"]);
    expect(records.filter(r => matchesAuthorizationRecordFilters(r, { ...scope, activity: "expired" })).map(r => r.patientId)).toEqual(["a"]);
  });

  it("sorts Denied, then Expired, then Exhausted", () => {
    expect(sortAuthorizationRecords(records).map(r => r.urgency)).toEqual(["denied", "expired", "exhausted"]);
  });

  it("overview counts Expired separately", () => {
    const m = deriveAuthorizationOverviewMetrics(records);
    expect(m).toMatchObject({ expired: 1, denied: 1, exhausted: 1 });
    expect(m.statusDistribution).toMatchObject({ expired: 1, denied: 1, approved: 1 });
  });
});
