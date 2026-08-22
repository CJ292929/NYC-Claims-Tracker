import { describe, it, expect } from "vitest";
import { deriveAuthorizationUrgency, type AuthorizationUrgencyInput } from "./authUrgency";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-01-15T00:00:00.000Z");

function ms(offsetDays: number): number {
  return NOW.getTime() + offsetDays * DAY_MS;
}

describe("deriveAuthorizationUrgency: core matrix", () => {
  it("CASE A: remaining 0, approved, expiry far => exhausted", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 0,
      authStatus: "approved",
      authValidUntil: ms(90),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "exhausted", authExpiryWarning: false });
  });

  it("CASE B: remaining 1, approved => critical", () => {
    const result = deriveAuthorizationUrgency({ remaining: 1, authStatus: "approved", now: NOW });
    expect(result).toEqual({ urgency: "critical", authExpiryWarning: false });
  });

  it("CASE C: remaining 2, approved => critical", () => {
    const result = deriveAuthorizationUrgency({ remaining: 2, authStatus: "approved", now: NOW });
    expect(result).toEqual({ urgency: "critical", authExpiryWarning: false });
  });

  it("CASE D: remaining 3, approved => warning", () => {
    const result = deriveAuthorizationUrgency({ remaining: 3, authStatus: "approved", now: NOW });
    expect(result).toEqual({ urgency: "warning", authExpiryWarning: false });
  });

  it("CASE E: remaining 8, pending => pending", () => {
    const result = deriveAuthorizationUrgency({ remaining: 8, authStatus: "pending", now: NOW });
    expect(result).toEqual({ urgency: "pending", authExpiryWarning: false });
  });

  it("CASE F: remaining 8, denied => denied", () => {
    const result = deriveAuthorizationUrgency({ remaining: 8, authStatus: "denied", now: NOW });
    expect(result).toEqual({ urgency: "denied", authExpiryWarning: false });
  });

  it("CASE G: remaining 8, approved, expires in 3 days => warning, authExpiryWarning true", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: ms(3),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "warning", authExpiryWarning: true });
  });

  it("CASE H: remaining 8, approved, already expired => warning, authExpiryWarning true", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: ms(-3),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "warning", authExpiryWarning: true });
  });

  it("CASE I: remaining 8, approved, no expiry => ok", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: null,
      now: NOW,
    });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });
});

describe("deriveAuthorizationUrgency: precedence (denied > remaining tier > pending > expiry)", () => {
  it("remaining 1 + pending => critical (remaining tier beats pending)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 1, authStatus: "pending", now: NOW });
    expect(result.urgency).toBe("critical");
  });

  it("remaining 3 + pending => warning (remaining tier beats pending)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 3, authStatus: "pending", now: NOW });
    expect(result.urgency).toBe("warning");
  });

  it("remaining 8 + pending + expiring soon => pending, authExpiryWarning false (pending beats expiry)", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "pending",
      authValidUntil: ms(3),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "pending", authExpiryWarning: false });
  });

  it("remaining 3 + denied => denied (denied beats remaining tier)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 3, authStatus: "denied", now: NOW });
    expect(result.urgency).toBe("denied");
  });

  it("remaining 1 + denied => denied (denied beats remaining tier)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 1, authStatus: "denied", now: NOW });
    expect(result.urgency).toBe("denied");
  });

  it("remaining 0 + denied => denied (denied beats remaining tier, including exhaustion)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 0, authStatus: "denied", now: NOW });
    expect(result.urgency).toBe("denied");
  });

  it("remaining 8 + denied + expiring soon => denied, authExpiryWarning false (denied beats expiry)", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "denied",
      authValidUntil: ms(3),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "denied", authExpiryWarning: false });
  });

  it("remaining 8 + denied + already expired => denied, authExpiryWarning false (denied beats expiry)", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "denied",
      authValidUntil: ms(-3),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "denied", authExpiryWarning: false });
  });
});

describe("deriveAuthorizationUrgency: exhausted semantics preserved for genuine exhaustion", () => {
  it("remaining 0 + approved => exhausted (not denied)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 0, authStatus: "approved", now: NOW });
    expect(result.urgency).toBe("exhausted");
  });

  it("remaining 0 + none => exhausted (not denied)", () => {
    const result = deriveAuthorizationUrgency({ remaining: 0, authStatus: "none", now: NOW });
    expect(result.urgency).toBe("exhausted");
  });
});

describe("deriveAuthorizationUrgency: expiry boundaries", () => {
  it("no authValidUntil => ok, no warning", () => {
    const result = deriveAuthorizationUrgency({ remaining: 8, authStatus: "approved", now: NOW });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  it("expiry well beyond 7 days => ok, no warning", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: ms(30),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  it("expiry exactly 7 days out (inclusive boundary) => warning, authExpiryWarning true", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: NOW.getTime() + 7 * DAY_MS,
      now: NOW,
    });
    expect(result).toEqual({ urgency: "warning", authExpiryWarning: true });
  });

  it("expiry just past the 7-day boundary (7 days + 1ms) => ok, no warning", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: NOW.getTime() + 7 * DAY_MS + 1,
      now: NOW,
    });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  it("expiry within 7 days => warning, authExpiryWarning true", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: ms(1),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "warning", authExpiryWarning: true });
  });

  it("expiry exactly equal to now => ok, no warning (neither > now nor < now)", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: NOW.getTime(),
      now: NOW,
    });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  it("expiry before now (1ms) => warning, authExpiryWarning true", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: NOW.getTime() - 1,
      now: NOW,
    });
    expect(result).toEqual({ urgency: "warning", authExpiryWarning: true });
  });
});

describe("deriveAuthorizationUrgency: input edge cases", () => {
  // production never supplies null explicitly (authStatus defaults to "none"
  // upstream), but the helper treats null the same as any non-pending,
  // non-denied status.
  it("authStatus null behaves like an unremarkable status", () => {
    const result = deriveAuthorizationUrgency({ remaining: 8, authStatus: null, now: NOW });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  it("authStatus omitted (undefined) behaves like an unremarkable status", () => {
    const result = deriveAuthorizationUrgency({ remaining: 8, now: NOW });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  it("unknown authStatus value falls through untouched", () => {
    const result = deriveAuthorizationUrgency({ remaining: 8, authStatus: "some-future-status", now: NOW });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });

  // remaining < 0 cannot occur in production: shared/authPeriodMetrics.ts
  // getPeriodMetrics clamps remaining via Math.max(0, authorized - completed)
  // before getAuthAlertSummaries ever sees it. This test documents the raw
  // mechanical result of the comparison chain rather than adding validation
  // production doesn't have.
  it("remaining < 0 (not reachable in production) falls into the critical tier mechanically", () => {
    const result = deriveAuthorizationUrgency({ remaining: -1, authStatus: "approved", now: NOW });
    expect(result).toEqual({ urgency: "critical", authExpiryWarning: false });
  });

  // authValidUntil is stored/read as a Unix ms number in production
  // (server/db.ts Patient.authValidUntil). An invalid date string is not a
  // case production can produce; new Date(...).getTime() yields NaN, and
  // NaN fails both the ">" and "<" comparisons, so it is silently inert
  // rather than throwing or being treated as expired.
  it("invalid authValidUntil string (not reachable in production) is inert, not a crash", () => {
    const result = deriveAuthorizationUrgency({
      remaining: 8,
      authStatus: "approved",
      authValidUntil: "not-a-real-date",
      now: NOW,
    });
    expect(result).toEqual({ urgency: "ok", authExpiryWarning: false });
  });
});

describe("deriveAuthorizationUrgency: parity with server/db.ts getAuthAlertSummaries", () => {
  // Frozen reproduction of the pre-C5 server urgency block, kept
  // deliberately duplicated (not imported) so this test fails if the shared
  // helper ever drifts unintentionally from the server's original inline
  // logic. Left untouched by C5 on purpose: the "denied" fixtures below now
  // deliberately diverge from this frozen function rather than matching it.
  function serverUrgency(
    sessionsRemaining: number,
    authStatus: string | null,
    authValidUntil: number | null,
    now: number,
  ): { urgency: string; authExpiryWarning: boolean } {
    let urgency = "ok";
    if (sessionsRemaining === 0) urgency = "exhausted";
    else if (sessionsRemaining <= 2) urgency = "critical";
    else if (sessionsRemaining <= 3) urgency = "warning";
    if (authStatus === "pending" && urgency === "ok") urgency = "pending";
    if (authStatus === "denied") urgency = "exhausted";

    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const expiresWithin7Days = authValidUntil !== null && authValidUntil > now && authValidUntil - now <= sevenDaysMs;
    const alreadyExpired = authValidUntil !== null && authValidUntil < now;
    const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
    if (authExpiryWarning) urgency = "warning";

    return { urgency, authExpiryWarning };
  }

  const fixtures: Array<{
    name: string;
    remaining: number;
    authStatus: string | null;
    authValidUntil: number | null;
  }> = [
    { name: "exhausted, approved, no expiry", remaining: 0, authStatus: "approved", authValidUntil: null },
    { name: "critical low, pending", remaining: 1, authStatus: "pending", authValidUntil: null },
    { name: "warning tier, approved", remaining: 3, authStatus: "approved", authValidUntil: null },
    { name: "ok tier, pending", remaining: 8, authStatus: "pending", authValidUntil: null },
    { name: "ok tier, expiring in 3 days", remaining: 8, authStatus: "approved", authValidUntil: ms(3) },
    { name: "ok tier, already expired", remaining: 8, authStatus: "approved", authValidUntil: ms(-3) },
    { name: "pending suppresses expiry warning", remaining: 8, authStatus: "pending", authValidUntil: ms(3) },
  ];

  for (const fixture of fixtures) {
    it(`matches server urgency block: ${fixture.name}`, () => {
      const input: AuthorizationUrgencyInput = {
        remaining: fixture.remaining,
        authStatus: fixture.authStatus,
        authValidUntil: fixture.authValidUntil,
        now: NOW,
      };
      const expected = serverUrgency(fixture.remaining, fixture.authStatus, fixture.authValidUntil, NOW.getTime());
      expect(deriveAuthorizationUrgency(input)).toEqual(expected);
    });
  }

  // C5: denied is now a first-class urgency. The frozen serverUrgency()
  // above still reproduces the pre-C5 denied -> exhausted mapping on
  // purpose — these cases prove the shared helper has intentionally
  // diverged from it for denied, rather than silently drifting.
  const deniedFixtures: Array<{
    name: string;
    remaining: number;
    authValidUntil: number | null;
  }> = [
    { name: "denied overrides high remaining", remaining: 8, authValidUntil: null },
    { name: "denied suppresses expiry warning", remaining: 8, authValidUntil: ms(3) },
  ];

  for (const fixture of deniedFixtures) {
    it(`intentionally diverges from frozen pre-C5 server urgency: ${fixture.name}`, () => {
      const frozenPreC5 = serverUrgency(fixture.remaining, "denied", fixture.authValidUntil, NOW.getTime());
      const current = deriveAuthorizationUrgency({
        remaining: fixture.remaining,
        authStatus: "denied",
        authValidUntil: fixture.authValidUntil,
        now: NOW,
      });

      expect(frozenPreC5).toEqual({ urgency: "exhausted", authExpiryWarning: false });
      expect(current).toEqual({ urgency: "denied", authExpiryWarning: false });
    });
  }
});
