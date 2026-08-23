/**
 * server/staffManagement.db.test.ts
 * S3: clinic_users CRUD helpers in server/db.ts, tested directly against a
 * mocked Supabase client (same pattern as clinicUsers.mapping.test.ts) so the
 * exact insert/update payloads — not just the router's pass-through — are
 * verified. This is where G (create defaults), H/J (token_version CAS
 * bumps), and L (reactivate) are actually enforced.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { method: string; args: unknown[] };

function makeChain(result: { data: unknown; error: unknown }) {
  const calls: Call[] = [];
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return chain;
  };
  chain.insert = record("insert");
  chain.update = record("update");
  chain.eq = record("eq");
  chain.select = record("select");
  chain.order = record("order");
  chain.single = () => Promise.resolve(result);
  chain.maybeSingle = () => Promise.resolve(result);
  // supabase-js query builders are themselves thenable, so a query with no
  // terminal .single()/.maybeSingle() (e.g. listClinicUsers' .order(...)) is
  // awaited directly — mirror that here instead of forcing every caller to
  // add an explicit terminal method.
  chain.then = (resolve: (value: unknown) => void) => resolve(result);
  return { chain, calls };
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from: fromMock } }));

import {
  createClinicUser,
  updateClinicUserRole,
  adminResetClinicUserPassword,
  archiveClinicUser,
  reactivateClinicUser,
  listClinicUsers,
} from "./db";

const ROW = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  username: "nurse.jane",
  password_hash: "$2b$10$staff-hash",
  name: "Jane Nurse",
  email: "jane@example.com",
  department: "PT",
  role: "staff",
  status: "active",
  must_change_password: false,
  token_version: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_login_at: null,
  archived_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createClinicUser (G)", () => {
  it("always inserts must_change_password:true and token_version:0, regardless of caller input", async () => {
    const { chain, calls } = makeChain({ data: ROW, error: null });
    fromMock.mockReturnValue(chain);

    await createClinicUser({
      username: "nurse.jane",
      passwordHash: "$2b$10$staff-hash",
      name: "Jane Nurse",
      email: "jane@example.com",
      department: "PT",
      role: "staff",
      status: "active",
    });

    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall?.args[0]).toMatchObject({
      must_change_password: true,
      token_version: 0,
      role: "staff",
      status: "active",
      password_hash: "$2b$10$staff-hash",
    });
  });
});

describe("adminResetClinicUserPassword (H)", () => {
  it("rehashes, forces must_change_password:true, and bumps token_version via compare-and-swap", async () => {
    const { chain, calls } = makeChain({
      data: { ...ROW, password_hash: "$2b$10$new-hash", must_change_password: true, token_version: 3 },
      error: null,
    });
    fromMock.mockReturnValue(chain);

    const result = await adminResetClinicUserPassword({
      id: ROW.id,
      passwordHash: "$2b$10$new-hash",
      expectedTokenVersion: 2,
    });

    const updateCall = calls.find((c) => c.method === "update");
    expect(updateCall?.args[0]).toEqual({
      password_hash: "$2b$10$new-hash",
      must_change_password: true,
      token_version: 3,
    });
    // CAS guard: the update is scoped to the row that still has the expected
    // token_version — a concurrent change would make this UPDATE match nothing.
    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["id", ROW.id] });
    expect(eqCalls).toContainEqual({ method: "eq", args: ["token_version", 2] });
    expect(result?.mustChangePassword).toBe(true);
    expect(result?.tokenVersion).toBe(3);
  });

  it("returns undefined (conflict) when the row's token_version already moved", async () => {
    const { chain } = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    const result = await adminResetClinicUserPassword({
      id: ROW.id,
      passwordHash: "$2b$10$new-hash",
      expectedTokenVersion: 2,
    });

    expect(result).toBeUndefined();
  });
});

describe("archiveClinicUser (J)", () => {
  it("sets status=archived, stamps archived_at, and bumps token_version", async () => {
    const { chain, calls } = makeChain({
      data: { ...ROW, status: "archived", archived_at: "2026-02-01T00:00:00Z", token_version: 3 },
      error: null,
    });
    fromMock.mockReturnValue(chain);

    const result = await archiveClinicUser({ id: ROW.id, expectedTokenVersion: 2 });

    const updateCall = calls.find((c) => c.method === "update");
    const payload = updateCall?.args[0] as Record<string, unknown>;
    expect(payload.status).toBe("archived");
    expect(payload.token_version).toBe(3);
    expect(payload.archived_at).toEqual(expect.any(String));
    expect(result?.status).toBe("archived");
    expect(result?.archivedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
  });
});

describe("reactivateClinicUser (L)", () => {
  it("sets status=active and clears archived_at without touching token_version", async () => {
    const { chain, calls } = makeChain({
      data: { ...ROW, status: "active", archived_at: null },
      error: null,
    });
    fromMock.mockReturnValue(chain);

    const result = await reactivateClinicUser(ROW.id);

    const updateCall = calls.find((c) => c.method === "update");
    expect(updateCall?.args[0]).toEqual({ status: "active", archived_at: null });
    expect(result?.status).toBe("active");
    expect(result?.archivedAt).toBeNull();
  });
});

describe("updateClinicUserRole (M)", () => {
  it("sets the new role and bumps token_version via compare-and-swap", async () => {
    const { chain, calls } = makeChain({
      data: { ...ROW, role: "admin", token_version: 3 },
      error: null,
    });
    fromMock.mockReturnValue(chain);

    const result = await updateClinicUserRole({ id: ROW.id, role: "admin", expectedTokenVersion: 2 });

    const updateCall = calls.find((c) => c.method === "update");
    expect(updateCall?.args[0]).toEqual({ role: "admin", token_version: 3 });
    const eqCalls = calls.filter((c) => c.method === "eq");
    expect(eqCalls).toContainEqual({ method: "eq", args: ["token_version", 2] });
    expect(result?.role).toBe("admin");
  });
});

describe("listClinicUsers", () => {
  it("returns every clinic_users row, mapped, ordered by name", async () => {
    const { chain, calls } = makeChain({ data: [ROW], error: null });
    fromMock.mockReturnValue(chain);

    const result = await listClinicUsers();

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("nurse.jane");
    expect(calls.find((c) => c.method === "order")?.args).toEqual(["name", { ascending: true }]);
  });
});
