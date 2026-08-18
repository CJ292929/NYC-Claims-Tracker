/**
 * server/clinicLogin.rateLimit.test.ts
 * Regression tests for the clinic.login brute-force guard
 * (server/_core/loginRateLimit.ts, wired in server/routers.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClinicUser } from "../drizzle/schema";
import type { TrpcContext } from "./_core/context";

const { bcryptMock, dbMock, createSessionToken } = vi.hoisted(() => ({
  bcryptMock: { compare: vi.fn() },
  dbMock: {
    getClinicUserByUsername: vi.fn(),
    upsertUser: vi.fn(),
  },
  createSessionToken: vi.fn(),
}));

vi.mock("bcryptjs", () => ({ default: bcryptMock, ...bcryptMock }));
vi.mock("./db", () => dbMock);
vi.mock("./_core/sdk", () => ({ sdk: { createSessionToken } }));

import { appRouter } from "./routers";
import { __resetLoginRateLimitForTests } from "./_core/loginRateLimit";

const FAKE_USER: ClinicUser = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "nurse.jane",
  passwordHash: "$2a$10$fakefakefakefakefakefakefakefakefakefakefakefakefak",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

function makeCaller(ip = "203.0.113.10") {
  const setCookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];

  const ctx: TrpcContext = {
    user: null,
    req: {
      protocol: "https",
      headers: { "x-forwarded-for": ip },
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as TrpcContext["req"],
    res: {
      cookie: (name: string, value: string, options: Record<string, unknown>) => {
        setCookies.push({ name, value, options });
      },
      clearCookie: () => {},
    } as unknown as TrpcContext["res"],
  };

  return { caller: appRouter.createCaller(ctx), setCookies };
}

async function login(caller: ReturnType<typeof appRouter.createCaller>, password = "correct-password") {
  return caller.clinic.login({ username: "nurse.jane", password });
}

beforeEach(() => {
  __resetLoginRateLimitForTests();
  vi.clearAllMocks();
  dbMock.getClinicUserByUsername.mockResolvedValue(FAKE_USER);
  dbMock.upsertUser.mockResolvedValue(undefined);
  createSessionToken.mockResolvedValue("fake-session-token");
});

afterEach(() => {
  __resetLoginRateLimitForTests();
});

describe("clinic.login rate limiting", () => {
  it("allows a valid login to succeed", async () => {
    bcryptMock.compare.mockResolvedValue(true);
    const { caller, setCookies } = makeCaller();

    const result = await login(caller);

    expect(result).toEqual({ success: true, username: "nurse.jane" });
    expect(setCookies).toHaveLength(1);
  });

  it("returns the normal invalid-credential error for attempts below the threshold", async () => {
    bcryptMock.compare.mockResolvedValue(false);
    const { caller } = makeCaller();

    for (let i = 0; i < 4; i++) {
      await expect(login(caller, "wrong-password")).rejects.toMatchObject({
        code: "UNAUTHORIZED",
        message: "Invalid username or password",
      });
    }
  });

  it("rejects further attempts once the failure threshold is exceeded", async () => {
    bcryptMock.compare.mockResolvedValue(false);
    const { caller } = makeCaller();

    for (let i = 0; i < 5; i++) {
      await expect(login(caller, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }

    await expect(login(caller, "wrong-password")).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Too many login attempts. Please try again later.",
    });
  });

  it("does not invoke bcrypt or the user lookup once a key is rate-limited", async () => {
    bcryptMock.compare.mockResolvedValue(false);
    const { caller } = makeCaller();

    for (let i = 0; i < 5; i++) {
      await expect(login(caller, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    dbMock.getClinicUserByUsername.mockClear();
    bcryptMock.compare.mockClear();

    await expect(login(caller, "wrong-password")).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

    expect(dbMock.getClinicUserByUsername).not.toHaveBeenCalled();
    expect(bcryptMock.compare).not.toHaveBeenCalled();
  });

  it("does not block a different username/IP key when one key is exhausted", async () => {
    bcryptMock.compare.mockResolvedValue(false);
    const { caller: exhaustedCaller } = makeCaller("203.0.113.10");

    for (let i = 0; i < 6; i++) {
      await expect(login(exhaustedCaller, "wrong-password")).rejects.toBeTruthy();
    }

    // Same username, different IP: should not be rate-limited by the other key.
    bcryptMock.compare.mockResolvedValue(true);
    const { caller: otherIpCaller } = makeCaller("198.51.100.20");
    await expect(login(otherIpCaller)).resolves.toEqual({ success: true, username: "nurse.jane" });

    // Different username, same original IP: should not be rate-limited either.
    dbMock.getClinicUserByUsername.mockResolvedValueOnce({ ...FAKE_USER, username: "dr.smith" });
    const { caller: otherUserCaller } = makeCaller("203.0.113.10");
    await expect(otherUserCaller.clinic.login({ username: "dr.smith", password: "correct-password" })).resolves.toEqual({
      success: true,
      username: "dr.smith",
    });
  });

  it("resets failed-attempt state after a successful login", async () => {
    bcryptMock.compare.mockResolvedValue(false);
    const { caller } = makeCaller();

    for (let i = 0; i < 4; i++) {
      await expect(login(caller, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }

    bcryptMock.compare.mockResolvedValue(true);
    await expect(login(caller)).resolves.toEqual({ success: true, username: "nurse.jane" });

    bcryptMock.compare.mockResolvedValue(false);
    // Two more failures after the reset should still be treated as within
    // threshold (not immediately rate-limited), proving the counter reset.
    await expect(login(caller, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(login(caller, "wrong-password")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("never reveals whether the username exists, for either failure reason", async () => {
    const { caller } = makeCaller();

    dbMock.getClinicUserByUsername.mockResolvedValueOnce(undefined);
    await expect(login(caller, "whatever")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid username or password",
    });

    bcryptMock.compare.mockResolvedValue(false);
    await expect(login(caller, "wrong-password")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "Invalid username or password",
    });
  });
});
