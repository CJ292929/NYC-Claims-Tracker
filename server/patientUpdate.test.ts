/**
 * server/patientUpdate.test.ts
 *
 * Covers the P4-P1 patient-edit fix: updatePatient (server/db.ts) must
 * distinguish an omitted claimsStatus field (leave the column untouched)
 * from an explicit clear (write SQL NULL), and never write the "none"
 * sentinel string into the claims_status column -- "none" is an API-level
 * display convention (see getPatientById's `claims_status ?? "none"`
 * mapping), not a value the DB's CHECK constraint accepts.
 *
 * P4-P17: updatePatient now writes through the write_patient_with_audit RPC
 * (one Postgres transaction for the row update + its audit_logs entry) —
 * these tests assert the p_data payload the RPC call carries, the same
 * contract the raw `update` payload used to carry directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpcMock } = vi.hoisted(() => ({ rpcMock: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { rpc: rpcMock } }));

import { updatePatient } from "./db";
import type { ActorContext } from "./actorIdentity";

const ACTOR: ActorContext = { actorId: "actor-1", actorType: "owner", actorDisplay: "Owner" };

beforeEach(() => {
  vi.clearAllMocks();
  rpcMock.mockResolvedValue({ data: "p1", error: null });
});

describe("updatePatient — claimsStatus contract", () => {
  it("omitting claimsStatus (e.g. a name-only edit) leaves claims_status untouched", async () => {
    await updatePatient("p1", { name: "Jonathan Doe" }, ACTOR);

    const call = rpcMock.mock.calls[0];
    expect(call[0]).toBe("write_patient_with_audit");
    const payload = call[1].p_data as Record<string, unknown>;
    expect(payload).toEqual({ name: "Jonathan Doe" });
    expect("claims_status" in payload).toBe(false);
  });

  it("explicitly clearing status (claimsStatus: null) writes SQL NULL, not the string \"none\"", async () => {
    await updatePatient("p1", { name: "Jonathan Doe", claimsStatus: null }, ACTOR);

    const payload = rpcMock.mock.calls[0][1].p_data as Record<string, unknown>;
    expect(payload.claims_status).toBeNull();
  });

  it("a valid status survives an unrelated field edit unchanged", async () => {
    await updatePatient("p1", { insurance: "Aetna", claimsStatus: "approved" }, ACTOR);

    const payload = rpcMock.mock.calls[0][1].p_data as Record<string, unknown>;
    expect(payload).toEqual({ insurance: "Aetna", claims_status: "approved" });
  });

  it("an empty-string authDate clears the column to NULL rather than storing ''", async () => {
    await updatePatient("p1", { authDate: null }, ACTOR);

    const payload = rpcMock.mock.calls[0][1].p_data as Record<string, unknown>;
    expect(payload.auth_date).toBeNull();
  });

  it("passes the actor's id/type/display and the patient id as p_id", async () => {
    await updatePatient("p1", { name: "Jonathan Doe" }, ACTOR);

    const args = rpcMock.mock.calls[0][1];
    expect(args.p_id).toBe("p1");
    expect(args.p_actor_id).toBe("actor-1");
    expect(args.p_actor_type).toBe("owner");
    expect(args.p_actor_display).toBe("Owner");
    expect(args.p_action).toBe("PATIENT_UPDATE");
  });

  it("skips the RPC call entirely when nothing is being updated", async () => {
    await updatePatient("p1", {}, ACTOR);
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
