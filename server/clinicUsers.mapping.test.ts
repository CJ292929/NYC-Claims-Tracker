/**
 * server/clinicUsers.mapping.test.ts
 * S1: ClinicUser row→object mapping (toClinicUser via getClinicUserByUsername)
 * covers the new staff identity fields, stays login-compatible with the
 * pre-migration seeded row shape, and confirms the case-insensitive lookup.
 */
import { describe, expect, it, vi } from "vitest";

const { fromMock, selectMock, ilikeMock, maybeSingleMock } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const ilikeMock = vi.fn(() => ({ maybeSingle: maybeSingleMock }));
  const selectMock = vi.fn(() => ({ ilike: ilikeMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  return { fromMock, selectMock, ilikeMock, maybeSingleMock };
});

vi.mock("./supabase", () => ({ supabase: { from: fromMock } }));

import { getClinicUserByUsername } from "./db";

// Shape of the row before S1's migration runs — no new columns present.
const LEGACY_ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  username: "jeromerivera123",
  password_hash: "$2b$10$fakefakefakefakefakefakefakefakefakefakefakefakef",
  created_at: "2026-01-01T00:00:00Z",
};

// Shape of the row after S1's migration runs, fully populated.
const FULL_ROW = {
  ...LEGACY_ROW,
  name: "Jerome Rivera",
  email: "jerome@example.com",
  department: "PT",
  role: "admin",
  status: "active",
  must_change_password: false,
  token_version: 3,
  updated_at: "2026-02-01T00:00:00Z",
  last_login_at: "2026-02-02T00:00:00Z",
  archived_at: null,
};

describe("ClinicUser mapping (S1)", () => {
  it("A: maps every new staff identity field from a fully-migrated row", async () => {
    maybeSingleMock.mockResolvedValue({ data: FULL_ROW, error: null });

    const user = await getClinicUserByUsername("jeromerivera123");

    expect(user).toMatchObject({
      id: FULL_ROW.id,
      username: "jeromerivera123",
      passwordHash: FULL_ROW.password_hash,
      name: "Jerome Rivera",
      email: "jerome@example.com",
      department: "PT",
      role: "admin",
      status: "active",
      mustChangePassword: false,
      tokenVersion: 3,
    });
    expect(user?.updatedAt).toEqual(new Date(FULL_ROW.updated_at));
    expect(user?.lastLoginAt).toEqual(new Date(FULL_ROW.last_login_at));
    expect(user?.archivedAt).toBeNull();
  });

  it("B: remains login-compatible with the legacy seeded row shape, applying safe defaults", async () => {
    maybeSingleMock.mockResolvedValue({ data: LEGACY_ROW, error: null });

    const user = await getClinicUserByUsername("jeromerivera123");

    expect(user).toBeDefined();
    expect(user?.username).toBe("jeromerivera123");
    expect(user?.passwordHash).toBe(LEGACY_ROW.password_hash);
    expect(user?.name).toBeNull();
    expect(user?.email).toBeNull();
    expect(user?.department).toBeNull();
    expect(user?.lastLoginAt).toBeNull();
    expect(user?.archivedAt).toBeNull();
    // F/G/H/I: defaults applied when the DB hasn't populated these yet.
    expect(user?.role).toBe("staff");
    expect(user?.status).toBe("active");
    expect(user?.mustChangePassword).toBe(true);
    expect(user?.tokenVersion).toBe(0);
  });

  it("C: performs a case-insensitive lookup — trims and lowercases before querying", async () => {
    maybeSingleMock.mockResolvedValue({ data: FULL_ROW, error: null });

    await getClinicUserByUsername("  JEROMErivera123  ");

    expect(selectMock).toHaveBeenCalledWith("*");
    expect(ilikeMock).toHaveBeenCalledWith("username", "jeromerivera123");
  });

  it("escapes ILIKE wildcard characters so they can't be used as pattern injection", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });

    await getClinicUserByUsername("weird_name%");

    expect(ilikeMock).toHaveBeenCalledWith("username", "weird\\_name\\%");
  });

  it("E: passwordHash stays on the internal field name only — no duplicate public-looking key", async () => {
    maybeSingleMock.mockResolvedValue({ data: FULL_ROW, error: null });

    const user = await getClinicUserByUsername("jeromerivera123");

    expect(user).toHaveProperty("passwordHash");
    expect(user).not.toHaveProperty("password");
  });
});
