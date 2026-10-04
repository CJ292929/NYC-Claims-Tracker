/**
 * server/deleteClaimRecordWithAudit.test.ts — TRK-P4-P12
 * Unit coverage (mocked Supabase client, same pattern as audit.test.ts) for
 * db.ts's deleteClaimRecordWithAudit: single-row targeting, patient
 * association re-validation, and the audit-first/compensate-on-failure
 * ordering that keeps a failed delete from ever reporting success or
 * leaving behind an audit entry for a deletion that didn't happen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { method: string; args: unknown[] };
type Result = { data: unknown; error: unknown };

/**
 * One result queue per (table, operation) pair — "fetch" for the initial
 * select/maybeSingle, "insert" for the audit write, "delete" for the
 * row delete — so a test can make, e.g., the delete fail without disturbing
 * the fetch result that already resolved earlier in the same call.
 */
function makeFromMock() {
  const callsByTable: Record<string, Call[]> = {};
  const results: Record<string, Result> = {
    "claims_records:fetch": { data: null, error: null },
    "claims_records:delete": { data: null, error: null },
    "audit_logs:insert": { data: null, error: null },
    "audit_logs:delete": { data: null, error: null },
  };

  const fromMock = vi.fn((table: string) => {
    callsByTable[table] = callsByTable[table] ?? [];
    const calls = callsByTable[table];
    let op: "fetch" | "insert" | "delete" = "fetch";
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
    chain.select = record("select");
    chain.insert = (...args: unknown[]) => {
      op = "insert";
      calls.push({ method: "insert", args });
      return chain;
    };
    chain.delete = (...args: unknown[]) => {
      op = "delete";
      calls.push({ method: "delete", args });
      return chain;
    };
    chain.eq = record("eq");
    chain.maybeSingle = () => Promise.resolve(results[`${table}:fetch`]);
    chain.single = () => Promise.resolve(results[`${table}:${op}`]);
    chain.then = (resolve: (value: unknown) => void) => resolve(results[`${table}:${op}`]);
    return chain;
  });

  return { fromMock, callsByTable, results };
}

let current: ReturnType<typeof makeFromMock>;

vi.mock("./supabase", () => ({
  supabase: { from: (table: string) => current.fromMock(table) },
}));

import {
  deleteClaimRecordWithAudit,
  ClaimRecordNotFoundError,
  ClaimRecordPatientMismatchError,
} from "./db";

const CLAIM_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "actor-1";

beforeEach(() => {
  current = makeFromMock();
});

describe("deleteClaimRecordWithAudit", () => {
  it("writes the audit row first, then deletes exactly the selected claim", async () => {
    current.results["claims_records:fetch"] = { data: { id: CLAIM_ID, patient_id: PATIENT_ID }, error: null };
    current.results["audit_logs:insert"] = { data: { id: "audit-1" }, error: null };
    current.results["claims_records:delete"] = { data: null, error: null };

    await deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID });

    const auditCalls = current.callsByTable["audit_logs"];
    const insertCall = auditCalls.find((c) => c.method === "insert");
    expect(insertCall?.args[0]).toEqual({
      patient_id: PATIENT_ID,
      actor_id: ACTOR_ID,
      action: "CLAIM_RECORD_DELETE",
      old_value: CLAIM_ID,
      new_value: null,
    });

    const claimCalls = current.callsByTable["claims_records"];
    expect(claimCalls.some((c) => c.method === "delete")).toBe(true);
    // Targets exactly one row by id — adjacent rows sharing date/CPT are
    // never touched because the only .eq() scoping the delete is on id.
    expect(claimCalls.some((c) => c.method === "eq" && c.args[0] === "id" && c.args[1] === CLAIM_ID)).toBe(true);
  });

  it("throws ClaimRecordNotFoundError and never deletes or audits when the claim is missing", async () => {
    current.results["claims_records:fetch"] = { data: null, error: null };

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toThrow(ClaimRecordNotFoundError);

    expect(current.callsByTable["audit_logs"]).toBeUndefined();
    expect(current.callsByTable["claims_records"]?.some((c) => c.method === "delete")).toBeFalsy();
  });

  it("throws ClaimRecordPatientMismatchError and never deletes or audits on a mismatched patient", async () => {
    current.results["claims_records:fetch"] = { data: { id: CLAIM_ID, patient_id: OTHER_PATIENT_ID }, error: null };

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toThrow(ClaimRecordPatientMismatchError);

    expect(current.callsByTable["audit_logs"]).toBeUndefined();
    expect(current.callsByTable["claims_records"]?.some((c) => c.method === "delete")).toBeFalsy();
  });

  it("does not delete the claim when the audit write fails", async () => {
    current.results["claims_records:fetch"] = { data: { id: CLAIM_ID, patient_id: PATIENT_ID }, error: null };
    current.results["audit_logs:insert"] = { data: null, error: new Error("audit insert failed") };

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toThrow();

    expect(current.callsByTable["claims_records"]?.some((c) => c.method === "delete")).toBeFalsy();
  });

  it("compensates (removes) the audit row and rethrows when the delete itself fails", async () => {
    current.results["claims_records:fetch"] = { data: { id: CLAIM_ID, patient_id: PATIENT_ID }, error: null };
    current.results["audit_logs:insert"] = { data: { id: "audit-1" }, error: null };
    current.results["claims_records:delete"] = { data: null, error: new Error("delete failed") };
    current.results["audit_logs:delete"] = { data: null, error: null };

    await expect(
      deleteClaimRecordWithAudit({ claimId: CLAIM_ID, patientId: PATIENT_ID, actorId: ACTOR_ID })
    ).rejects.toThrow(/delete failed/);

    const auditCalls = current.callsByTable["audit_logs"];
    const compensatingDelete = auditCalls.find((c) => c.method === "delete");
    expect(compensatingDelete).toBeDefined();
    expect(auditCalls.some((c) => c.method === "eq" && c.args[0] === "id" && c.args[1] === "audit-1")).toBe(true);
  });
});
