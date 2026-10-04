/**
 * server/deleteClaimRecordWithAudit.test.ts — P4-P12R
 * Unit coverage (mocked Supabase client) for db.ts's
 * deleteClaimRecordWithAudit: it now delegates to a single
 * supabase.rpc("delete_claim_record_with_audit", ...) call — one database
 * transaction — instead of separate audit/delete/compensation requests.
 * These tests cover the RPC call shape and the error-code-to-typed-error
 * mapping; the actual transactional/locking/rollback behavior of the
 * Postgres function itself is covered against a real local Postgres
 * instance (see supabase/migrations/20261004010000_delete_claim_record_with_audit_fn.sql
 * and the manual verification notes in the PR description).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let rpcMock: ReturnType<typeof vi.fn>;

vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpcMock(...args),
  },
}));

import {
  deleteClaimRecordWithAudit,
  ClaimRecordNotFoundError,
  ClaimRecordPatientMismatchError,
} from "./db";

const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  rpcMock = vi.fn();
});

describe("deleteClaimRecordWithAudit", () => {
  it("calls the delete_claim_record_with_audit RPC with the expected args", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });

    await deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID });

    expect(rpcMock).toHaveBeenCalledWith("delete_claim_record_with_audit", {
      p_claim_id: CLAIM_ID,
      p_patient_id: PATIENT_ID,
      p_actor_id: ACTOR_ID,
    });
  });

  it("throws ClaimRecordNotFoundError when the function raises P0010 (missing/already-deleted claim)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0010", message: "claim_record_not_found" } });

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toThrow(ClaimRecordNotFoundError);
  });

  it("throws ClaimRecordPatientMismatchError when the function raises P0011 (patient mismatch)", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "P0011", message: "claim_record_patient_mismatch" } });

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toThrow(ClaimRecordPatientMismatchError);
  });

  it("rethrows any other RPC error without mapping it to a typed error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: "08006", message: "connection failure" } });

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toMatchObject({ code: "08006" });
  });

  it("resolves successfully when the RPC reports no error", async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).resolves.toBeUndefined();
  });
});
