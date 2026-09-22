/**
 * server/audit.test.ts — TRK-P1B-R
 * Audit trail for patient edits: createAuditLog (server/db.ts insert against
 * a mocked Supabase client, same pattern as staffManagement.db.test.ts) and
 * diffPatientUpdate (the pure diffing logic patients.update in routers.ts
 * uses to decide which fields are audit-worthy).
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
  chain.then = (resolve: (value: unknown) => void) => resolve(result);
  return { chain, calls };
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from: fromMock } }));

import { createAuditLog, diffPatientUpdate } from "./db";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAuditLog", () => {
  it("inserts a row with the given patient/actor/action/old/new values", async () => {
    const { chain, calls } = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    await createAuditLog({
      patientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      action: "PATIENT_NAME_UPDATE",
      oldValue: "John Doe",
      newValue: "Jonathan Doe",
    });

    expect(fromMock).toHaveBeenCalledWith("audit_logs");
    const insertCall = calls.find((c) => c.method === "insert");
    expect(insertCall?.args[0]).toEqual({
      patient_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      actor_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      action: "PATIENT_NAME_UPDATE",
      old_value: "John Doe",
      new_value: "Jonathan Doe",
    });
  });

  it("throws when the insert fails", async () => {
    const { chain } = makeChain({ data: null, error: new Error("boom") });
    fromMock.mockReturnValue(chain);

    await expect(
      createAuditLog({
        patientId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        actorId: null,
        action: "PATIENT_NAME_UPDATE",
        oldValue: "John Doe",
        newValue: "Jonathan Doe",
      })
    ).rejects.toThrow();
  });
});

describe("diffPatientUpdate", () => {
  it("returns a PATIENT_NAME_UPDATE change with exact old/new values when the name changes", () => {
    const changes = diffPatientUpdate(
      { name: "John Doe" },
      { name: "Jonathan Doe" }
    );
    expect(changes).toEqual([
      { action: "PATIENT_NAME_UPDATE", oldValue: "John Doe", newValue: "Jonathan Doe" },
    ]);
  });

  it("returns no changes when the name is not part of the update payload", () => {
    const changes = diffPatientUpdate({ name: "John Doe" }, {});
    expect(changes).toEqual([]);
  });

  it("returns no changes when the update repeats the existing name (no redundant entries)", () => {
    const changes = diffPatientUpdate(
      { name: "John Doe" },
      { name: "John Doe" }
    );
    expect(changes).toEqual([]);
  });
});
