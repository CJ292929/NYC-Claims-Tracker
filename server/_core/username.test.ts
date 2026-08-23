/**
 * server/_core/username.test.ts
 * S1: single source of truth for clinic username normalization, shared by
 * getClinicUserByUsername (db.ts) and the login rate limiter.
 */
import { describe, expect, it } from "vitest";
import { normalizeUsername, escapeLikePattern } from "./username";
import { normalizeUsername as rateLimitNormalizeUsername } from "./loginRateLimit";

describe("normalizeUsername", () => {
  it("trims whitespace and lowercases", () => {
    expect(normalizeUsername("  Jerome  ")).toBe("jerome");
    expect(normalizeUsername("JEROME")).toBe("jerome");
    expect(normalizeUsername("jerome")).toBe("jerome");
  });

  it("is re-exported unchanged from loginRateLimit, not reimplemented", () => {
    expect(rateLimitNormalizeUsername).toBe(normalizeUsername);
  });
});

describe("escapeLikePattern", () => {
  it("escapes ILIKE metacharacters %, _, and backslash", () => {
    expect(escapeLikePattern("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("leaves ordinary username characters untouched", () => {
    expect(escapeLikePattern("jerome.rivera123")).toBe("jerome.rivera123");
  });
});
