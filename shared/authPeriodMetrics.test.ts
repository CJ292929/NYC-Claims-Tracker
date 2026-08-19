import { describe, it, expect } from "vitest";
import {
  getPeriodMetrics,
  determineActivePeriod,
  deriveAuthPeriodMetrics,
  type AuthPeriodVisit,
} from "./authPeriodMetrics";

function visit(
  authPeriod: number | null,
  sessionsAuthorized: number | null,
  dateOfService: unknown,
): AuthPeriodVisit {
  return { authPeriod, sessionsAuthorized, dateOfService };
}

describe("deriveAuthPeriodMetrics", () => {
  it("CASE A: single active period", () => {
    const visits = [
      visit(1, 10, "2026-01-01"),
      visit(1, null, "2026-01-02"),
      visit(1, null, "2026-01-03"),
      visit(1, null, null),
    ];

    const result = deriveAuthPeriodMetrics(visits);

    expect(result.periods).toEqual([1]);
    expect(result.activePeriod).toBe(1);
    expect(result.activeMetrics).toEqual({ authorized: 10, completed: 3, remaining: 7 });
  });

  it("CASE B: period 1 exhausted, period 2 active", () => {
    const visits = [
      visit(1, 5, "2026-01-01"),
      visit(1, null, "2026-01-02"),
      visit(1, null, "2026-01-03"),
      visit(1, null, "2026-01-04"),
      visit(1, null, "2026-01-05"),
      visit(2, 8, "2026-02-01"),
      visit(2, null, "2026-02-02"),
      visit(2, null, null),
    ];

    const result = deriveAuthPeriodMetrics(visits);

    expect(result.periods).toEqual([1, 2]);
    expect(result.activePeriod).toBe(2);
    expect(result.activeMetrics).toEqual({ authorized: 8, completed: 2, remaining: 6 });
  });

  it("CASE C: oldest non-exhausted period wins, never newest", () => {
    const visits = [
      visit(1, 10, "2026-01-01"),
      visit(1, null, "2026-01-02"),
      visit(1, null, "2026-01-03"),
      visit(1, null, "2026-01-04"),
      visit(1, null, "2026-01-05"),
      visit(1, null, "2026-01-06"),
      visit(1, null, "2026-01-07"),
      visit(1, null, "2026-01-08"),
      visit(1, null, null),
      visit(1, null, null),
      visit(2, 10, null),
    ];

    const result = deriveAuthPeriodMetrics(visits);

    expect(result.activePeriod).toBe(1);
  });

  it("CASE D: all periods exhausted", () => {
    const visits = [
      visit(1, 5, "2026-01-01"),
      visit(1, null, "2026-01-02"),
      visit(1, null, "2026-01-03"),
      visit(1, null, "2026-01-04"),
      visit(1, null, "2026-01-05"),
    ];

    const result = deriveAuthPeriodMetrics(visits);

    expect(result.activePeriod).toBeNull();
    expect(result.activeMetrics).toEqual({ authorized: 0, completed: 0, remaining: 0 });
  });

  it("CASE E: null authPeriod normalizes to period 1", () => {
    const visits = [visit(null, 10, "2026-01-01"), visit(null, null, null)];

    const result = deriveAuthPeriodMetrics(visits);

    expect(result.periods).toEqual([1]);
    expect(result.activePeriod).toBe(1);
  });

  it("CASE F: stale stored sessionsRemaining on the input object is ignored", () => {
    const withoutStale: AuthPeriodVisit[] = [visit(1, 10, "2026-01-01"), visit(1, null, "2026-01-02")];
    const withStale = withoutStale.map(v => ({ ...v, sessionsRemaining: 999 }));

    const resultWithoutStale = getPeriodMetrics(withoutStale, 1);
    const resultWithStale = getPeriodMetrics(withStale, 1);

    expect(resultWithoutStale).toEqual({ authorized: 10, completed: 2, remaining: 8 });
    expect(resultWithStale).toEqual(resultWithoutStale);
  });

  it("CASE G: authorized below completed clamps remaining to zero, never negative", () => {
    const visits = [visit(1, 2, "2026-01-01"), visit(1, null, "2026-01-02"), visit(1, null, "2026-01-03")];

    const result = getPeriodMetrics(visits, 1);

    expect(result).toEqual({ authorized: 2, completed: 3, remaining: 0 });
  });

  it("CASE H: empty input", () => {
    const result = deriveAuthPeriodMetrics([]);

    expect(result.periods).toEqual([]);
    expect(result.activePeriod).toBeNull();
    expect(result.activeMetrics).toEqual({ authorized: 0, completed: 0, remaining: 0 });
  });

  it("CASE I: periods are sorted ascending regardless of input order", () => {
    const visits = [
      visit(3, 10, "2026-03-01"),
      visit(1, 10, "2026-01-01"),
      visit(1, null, "2026-01-02"),
      visit(1, null, "2026-01-03"),
      visit(1, null, "2026-01-04"),
      visit(1, null, "2026-01-05"),
      visit(1, null, "2026-01-06"),
      visit(1, null, "2026-01-07"),
      visit(1, null, "2026-01-08"),
      visit(1, null, "2026-01-09"),
      visit(1, null, "2026-01-10"),
      visit(2, 10, "2026-02-01"),
    ];

    const result = deriveAuthPeriodMetrics(visits);

    expect(result.periods).toEqual([1, 2, 3]);
  });
});

describe("determineActivePeriod parity with existing implementations", () => {
  // Mirrors server/db.ts determineActiveAuthPeriod for the same fixture.
  function serverDetermineActiveAuthPeriod(
    visits: { auth_period: number | null; sessions_authorized: number | null; date_of_service: string | null }[],
  ): number | null {
    const periods = Array.from(new Set(visits.map(v => v.auth_period ?? 1))).sort((a, b) => a - b);
    for (const period of periods) {
      const periodVisits = visits.filter(v => (v.auth_period ?? 1) === period);
      const authRow = periodVisits.find(v => v.sessions_authorized != null);
      const periodAuthorized = authRow?.sessions_authorized ?? 0;
      const periodCompleted = periodVisits.filter(v => v.date_of_service != null).length;
      const periodRemaining = Math.max(0, periodAuthorized - periodCompleted);
      if (periodRemaining > 0) return period;
    }
    return null;
  }

  // Mirrors client/src/pages/Dashboard.tsx getPatientMetrics active-period selection for the same fixture.
  function clientActivePeriod(visits: { authPeriod: number; sessionsAuthorized: number | null; dateOfService: unknown }[]): number | null {
    const allPeriods = Array.from(new Set(visits.map(v => v.authPeriod ?? 1))).sort((a, b) => a - b);
    let activePeriod: number | null = null;
    for (const period of allPeriods) {
      const periodVisits = visits.filter(v => (v.authPeriod ?? 1) === period);
      const authRow = periodVisits.find(v => v.sessionsAuthorized != null);
      const periodAuthorized = authRow?.sessionsAuthorized ?? 0;
      const periodCompleted = periodVisits.filter(v => v.dateOfService != null).length;
      const periodRemaining = Math.max(0, periodAuthorized - periodCompleted);
      if (periodRemaining > 0) {
        activePeriod = period;
        break;
      }
    }
    return activePeriod;
  }

  const fixtures = [
    {
      name: "period 1 still open",
      rows: [
        { auth_period: 1, sessions_authorized: 10, date_of_service: "2026-01-01" },
        { auth_period: 1, sessions_authorized: null, date_of_service: null },
        { auth_period: 2, sessions_authorized: 8, date_of_service: null },
      ],
    },
    {
      name: "period 1 exhausted, period 2 open",
      rows: [
        { auth_period: 1, sessions_authorized: 2, date_of_service: "2026-01-01" },
        { auth_period: 1, sessions_authorized: null, date_of_service: "2026-01-02" },
        { auth_period: 2, sessions_authorized: 6, date_of_service: null },
      ],
    },
    {
      name: "all exhausted",
      rows: [
        { auth_period: 1, sessions_authorized: 2, date_of_service: "2026-01-01" },
        { auth_period: 1, sessions_authorized: null, date_of_service: "2026-01-02" },
      ],
    },
  ];

  for (const fixture of fixtures) {
    it(`matches server determineActiveAuthPeriod: ${fixture.name}`, () => {
      const sharedVisits: AuthPeriodVisit[] = fixture.rows.map(r => ({
        authPeriod: r.auth_period,
        sessionsAuthorized: r.sessions_authorized,
        dateOfService: r.date_of_service,
      }));

      expect(determineActivePeriod(sharedVisits)).toBe(serverDetermineActiveAuthPeriod(fixture.rows));
    });

    it(`matches client getPatientMetrics active period: ${fixture.name}`, () => {
      const sharedVisits: AuthPeriodVisit[] = fixture.rows.map(r => ({
        authPeriod: r.auth_period,
        sessionsAuthorized: r.sessions_authorized,
        dateOfService: r.date_of_service,
      }));
      const clientVisits = fixture.rows.map(r => ({
        authPeriod: r.auth_period ?? 1,
        sessionsAuthorized: r.sessions_authorized,
        dateOfService: r.date_of_service,
      }));

      expect(determineActivePeriod(sharedVisits)).toBe(clientActivePeriod(clientVisits));
    });
  }
});
