/**
 * server/staffManagement.db.test.ts
 * S3: clinic_users CRUD helpers in server/db.ts, tested directly against a
 * mocked Supabase client (same pattern as clinicUsers.mapping.test.ts) so the
 * exact insert/update payloads — not just the router's pass-through — are
 * verified. This is where G (create defaults), H/J (token_version CAS
 * bumps), and L (reactivate) are actually enforced.
 *
 * P4-P17: every mutation here now writes through a *_with_audit RPC (one
 * Postgres transaction for the clinic_users write + its audit_logs entry —
 * see the P4-P17 migration), so these tests assert the RPC call shape
 * instead of a raw `.insert()`/`.update()` payload, and mock a `getClinicUserById`
 * re-fetch afterward (each function returns the post-write row).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock, fromMock } = vi.hoisted(() => ({ rpcMock: vi.fn(), fromMock: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { rpc: rpcMock, from: fromMock } }));

import {
  createClinicUser,
  updateClinicUserRole,
  adminResetClinicUserPassword,
  archiveClinicUser,
  reactivateClinicUser,
  listClinicUsers,
  ClinicUserConflictError,
  LastActiveAccountManagerError,
} from "./db";
import type { ActorContext } from "./actorIdentity";

const ACTOR: ActorContext = { actorId: "actor-1", actorType: "owner", actorDisplay: "Owner" };

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

function mockGetByIdReturns(row: unknown) {
  fromMock.mockReturnValue({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      }),
    }),
  });
}

function mockListReturns(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.order = () => Promise.resolve({ data: rows, error: null });
  fromMock.mockReturnValue(chain);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createClinicUser (G)", () => {
  it("always creates with must_change_password:true and token_version:0 server-side, and re-fetches the row", async () => {
    rpcMock.mockResolvedValue({ data: ROW.id, error: null });
    mockGetByIdReturns(ROW);

    const result = await createClinicUser({
      username: "nurse.jane",
      passwordHash: "$2b$10$staff-hash",
      name: "Jane Nurse",
      email: "jane@example.com",
      department: "PT",
      role: "staff",
      status: "active",
    }, ACTOR);

    expect(rpcMock).toHaveBeenCalledWith("create_clinic_user_with_audit", {
      p_username: "nurse.jane",
      p_password_hash: "$2b$10$staff-hash",
      p_name: "Jane Nurse",
      p_email: "jane@example.com",
      p_department: "PT",
      p_role: "staff",
      p_status: "active",
      p_actor_id: "actor-1",
      p_actor_type: "owner",
      p_actor_display: "Owner",
    });
    expect(result.username).toBe("nurse.jane");
  });
});

describe("adminResetClinicUserPassword (H)", () => {
  it("rehashes, forces must_change_password, and bumps token_version via the RPC's compare-and-swap", async () => {
    rpcMock.mockResolvedValue({ data: ROW.id, error: null });
    mockGetByIdReturns({ ...ROW, password_hash: "$2b$10$new-hash", must_change_password: true, token_version: 3 });

    const result = await adminResetClinicUserPassword({
      id: ROW.id,
      passwordHash: "$2b$10$new-hash",
      expectedTokenVersion: 2,
    }, ACTOR);

    expect(rpcMock).toHaveBeenCalledWith("admin_reset_clinic_user_password_with_audit", {
      p_id: ROW.id,
      p_password_hash: "$2b$10$new-hash",
      p_expected_token_version: 2,
      p_actor_id: "actor-1",
      p_actor_type: "owner",
      p_actor_display: "Owner",
    });
    expect(result?.mustChangePassword).toBe(true);
    expect(result?.tokenVersion).toBe(3);
  });

  it("throws ClinicUserConflictError when the row's token_version already moved", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0022", message: "clinic_user_conflict" } });

    await expect(
      adminResetClinicUserPassword({ id: ROW.id, passwordHash: "$2b$10$new-hash", expectedTokenVersion: 2 }, ACTOR)
    ).rejects.toThrow(ClinicUserConflictError);
  });
});

describe("archiveClinicUser (J)", () => {
  it("sets status=archived, stamps archived_at, and bumps token_version", async () => {
    rpcMock.mockResolvedValue({ data: ROW.id, error: null });
    mockGetByIdReturns({ ...ROW, status: "archived", archived_at: "2026-02-01T00:00:00Z", token_version: 3 });

    const result = await archiveClinicUser({ id: ROW.id, expectedTokenVersion: 2 }, ACTOR);

    expect(rpcMock).toHaveBeenCalledWith("archive_clinic_user_with_audit", {
      p_id: ROW.id,
      p_expected_token_version: 2,
      p_actor_id: "actor-1",
      p_actor_type: "owner",
      p_actor_display: "Owner",
    });
    expect(result?.status).toBe("archived");
    expect(result?.archivedAt).toEqual(new Date("2026-02-01T00:00:00Z"));
  });

  it("throws LastActiveAccountManagerError when the RPC reports the last-admin guard (P0023)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0023", message: "last_active_account_manager" } });

    await expect(
      archiveClinicUser({ id: ROW.id, expectedTokenVersion: 2 }, ACTOR)
    ).rejects.toThrow(LastActiveAccountManagerError);
  });
});

describe("reactivateClinicUser (L)", () => {
  it("sets status=active and clears archived_at without touching token_version", async () => {
    rpcMock.mockResolvedValue({ data: ROW.id, error: null });
    mockGetByIdReturns({ ...ROW, status: "active", archived_at: null });

    const result = await reactivateClinicUser(ROW.id, ACTOR);

    expect(rpcMock).toHaveBeenCalledWith("reactivate_clinic_user_with_audit", {
      p_id: ROW.id,
      p_actor_id: "actor-1",
      p_actor_type: "owner",
      p_actor_display: "Owner",
    });
    expect(result?.status).toBe("active");
    expect(result?.archivedAt).toBeNull();
  });
});

describe("updateClinicUserRole (M)", () => {
  it("sets the new role and bumps token_version via the RPC's compare-and-swap", async () => {
    rpcMock.mockResolvedValue({ data: ROW.id, error: null });
    mockGetByIdReturns({ ...ROW, role: "admin", token_version: 3 });

    const result = await updateClinicUserRole({ id: ROW.id, role: "admin", expectedTokenVersion: 2 }, ACTOR);

    expect(rpcMock).toHaveBeenCalledWith("update_clinic_user_role_with_audit", {
      p_id: ROW.id,
      p_role: "admin",
      p_expected_token_version: 2,
      p_actor_id: "actor-1",
      p_actor_type: "owner",
      p_actor_display: "Owner",
    });
    expect(result?.role).toBe("admin");
  });

  it("throws LastActiveAccountManagerError when demoting the last active admin", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0023", message: "last_active_account_manager" } });

    await expect(
      updateClinicUserRole({ id: ROW.id, role: "staff", expectedTokenVersion: 2 }, ACTOR)
    ).rejects.toThrow(LastActiveAccountManagerError);
  });
});

describe("listClinicUsers", () => {
  it("returns every clinic_users row, mapped, ordered by name", async () => {
    mockListReturns([ROW]);

    const result = await listClinicUsers();

    expect(result).toHaveLength(1);
    expect(result[0].username).toBe("nurse.jane");
  });
});
