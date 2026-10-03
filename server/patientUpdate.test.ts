/**
 * server/patientUpdate.test.ts
 *
 * Covers the P4-P1 patient-edit fix: updatePatient (server/db.ts) must
 * distinguish an omitted claimsStatus field (leave the column untouched)
 * from an explicit clear (write SQL NULL), and never write the "none"
 * sentinel string into the claims_status column -- "none" is an API-level
 * display convention (see getPatientById's `claims_status ?? "none"`
 * mapping), not a value the DB's CHECK constraint accepts.
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
  chain.update = record("update");
  chain.insert = record("insert");
  chain.select = record("select");
  chain.eq = record("eq");
  chain.order = record("order");
  chain.single = () => Promise.resolve(result);
  chain.maybeSingle = () => Promise.resolve(result);
  chain.then = (resolve: (value: unknown) => void) => resolve(result);
  return { chain, calls };
}

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: { from: fromMock } }));

import { updatePatient } from "./db";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updatePatient — claimsStatus contract", () => {
  it("omitting claimsStatus (e.g. a name-only edit) leaves claims_status untouched", async () => {
    const { chain, calls } = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    await updatePatient("p1", { name: "Jonathan Doe" });

    const update = calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>;
    expect(update).toEqual({ name: "Jonathan Doe" });
    expect("claims_status" in update).toBe(false);
  });

  it("explicitly clearing status (claimsStatus: null) writes SQL NULL, not the string \"none\"", async () => {
    const { chain, calls } = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    await updatePatient("p1", { name: "Jonathan Doe", claimsStatus: null });

    const update = calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>;
    expect(update.claims_status).toBeNull();
  });

  it("a valid status survives an unrelated field edit unchanged", async () => {
    const { chain, calls } = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    await updatePatient("p1", { insurance: "Aetna", claimsStatus: "approved" });

    const update = calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>;
    expect(update).toEqual({ insurance: "Aetna", claims_status: "approved" });
  });

  it("an empty-string authDate clears the column to NULL rather than storing ''", async () => {
    const { chain, calls } = makeChain({ data: null, error: null });
    fromMock.mockReturnValue(chain);

    await updatePatient("p1", { authDate: null });

    const update = calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>;
    expect(update.auth_date).toBeNull();
  });
});
