/**
 * server/cms1500Enrichment.test.ts
 *
 * P4-P10: CMS1500 enrichment must never create or modify a financial/payment
 * field, must search for a matching Reimbursement/EOB row across every auth
 * period (never just the patient's latest), and must require explicit staff
 * selection when more than one candidate row matches. These tests cover the
 * db.ts primitives (findCms1500EnrichmentCandidates, patientHasAnyClaimRecords,
 * applyCms1500Enrichment) with a synthetic in-memory fake of the one
 * Supabase table they touch -- no real network/DB access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

function makeFakeClaimsTable(seed: Row[] = []) {
  const rows: Row[] = seed.map(r => ({ ...r }));
  let nextId = rows.length + 1;

  const from = vi.fn((table: string) => {
    if (table !== "claims_records") throw new Error(`unexpected table: ${table}`);

    let pendingFilter: Partial<Row> = {};
    let pendingCptIsNull = false;
    let isCountHead = false;

    const chain: Record<string, (...args: unknown[]) => unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) isCountHead = true;
        return chain;
      },
      eq: (col: string, val: unknown) => {
        pendingFilter = { ...pendingFilter, [col]: val };
        return chain;
      },
      is: (col: string) => {
        if (col === "cpt_codes") pendingCptIsNull = true;
        return chain;
      },
      then: undefined, // not a real promise; force callers to await the explicit terminal methods below
      maybeSingle: () => {
        const matches = rows.filter(r =>
          Object.entries(pendingFilter).every(([k, v]) => r[k] === v) &&
          (pendingCptIsNull ? r.cpt_codes == null : true)
        );
        if (matches.length > 1) throw new Error("maybeSingle() matched more than one row — test setup bug");
        return Promise.resolve({ data: matches[0] ? { id: matches[0].id } : null, error: null });
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          const row = rows.find(r => r.id === id);
          if (row) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };

    // findCms1500EnrichmentCandidates / patientHasAnyClaimRecords don't call
    // .maybeSingle() -- they await the query object directly (array select or
    // head-count select). Give the chain a thenable so `await query` resolves.
    (chain as any)[Symbol.toPrimitive] = undefined;
    const resolveList = () => {
      const matches = rows.filter(r =>
        Object.entries(pendingFilter).every(([k, v]) => r[k] === v) &&
        (pendingCptIsNull ? r.cpt_codes == null : true)
      );
      if (isCountHead) return { data: null, error: null, count: matches.length };
      return { data: matches, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveList()).then(resolve);

    return chain;
  });

  return { from, rows, insertRow: (r: Omit<Row, "id">) => { const row = { id: String(nextId++), ...r }; rows.push(row); return row; } };
}

const { tableMock } = vi.hoisted(() => ({ tableMock: { from: vi.fn() } }));
vi.mock("./supabase", () => ({ supabase: tableMock }));

import {
  findCms1500EnrichmentCandidates,
  patientHasAnyClaimRecords,
  applyCms1500Enrichment,
} from "./db";

const PATIENT_A = "11111111-1111-4111-8111-111111111111";
const PATIENT_B = "22222222-2222-4222-8222-222222222222";
const MAY_19 = new Date("2026-05-19T00:00:00Z");
const SEP_1 = new Date("2026-09-01T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findCms1500EnrichmentCandidates", () => {
  it("finds an existing reimbursement row by patient + exact date + CPT, regardless of auth period", async () => {
    const { from, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 2, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100, insurance_reimbursement: 80, patient_amount_paid: 0, patient_amount_due: 0, visit_number: null, diagnosis_codes: null, modifier: null, units_billed: null },
    ]);
    tableMock.from = from;

    const candidates = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97110");
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("r1");
    expect(candidates[0].authPeriod).toBe(2); // older period than "latest" -- never forced to maxPeriod
    expect(rows).toHaveLength(1); // read-only, no row created
  });

  it("different service dates with the same CPT do not match, even for the same patient", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;

    // CMS1500 row claims Sept 1 for the same CPT -- screenshot scenario:
    // must NOT be treated as describing the same service.
    const candidates = await findCms1500EnrichmentCandidates(PATIENT_A, SEP_1, "97110");
    expect(candidates).toHaveLength(0);
  });

  it("a different patient's row is never returned as a candidate", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_B, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;

    const candidates = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97110");
    expect(candidates).toHaveLength(0);
  });

  it("returns multiple candidates when more than one row matches, requiring explicit staff selection", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
      { id: "r2", patient_id: PATIENT_A, auth_period: 2, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;

    const candidates = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97110");
    expect(candidates).toHaveLength(2);
  });
});

describe("patientHasAnyClaimRecords", () => {
  it("is false when the patient has zero claims_records rows (reimbursement never uploaded)", async () => {
    const { from } = makeFakeClaimsTable([]);
    tableMock.from = from;
    expect(await patientHasAnyClaimRecords(PATIENT_A)).toBe(false);
  });

  it("is true once at least one row exists for the patient, in any period", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 3, date_of_service: "2025-01-01" },
    ]);
    tableMock.from = from;
    expect(await patientHasAnyClaimRecords(PATIENT_A)).toBe(true);
  });
});

describe("applyCms1500Enrichment", () => {
  it("patches only visit/diagnosis/modifier/units -- never charge or any payment field", async () => {
    const { from, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100, insurance_reimbursement: 80, patient_amount_paid: 20, patient_amount_due: 0, visit_number: null, diagnosis_codes: null, modifier: null, units_billed: null },
    ]);
    tableMock.from = from;

    await applyCms1500Enrichment({
      claimRecordId: "r1",
      patientId: PATIENT_A,
      dateOfService: MAY_19,
      cptCodes: "97110",
      visitNumber: 2,
      diagnosisCodes: "M54.5",
      modifier: "GP",
      unitsBilled: 1,
    });

    expect(rows[0].visit_number).toBe(2);
    expect(rows[0].diagnosis_codes).toBe("M54.5");
    expect(rows[0].modifier).toBe("GP");
    expect(rows[0].units_billed).toBe(1);
    // Untouched -- these belong exclusively to the reimbursement upload.
    expect(rows[0].charge_amount).toBe(100);
    expect(rows[0].insurance_reimbursement).toBe(80);
    expect(rows[0].patient_amount_paid).toBe(20);
    expect(rows[0].patient_amount_due).toBe(0); // legitimate zero survives untouched
  });

  it("ignores a CMS1500-supplied charge amount even if somehow passed in -- the function has no charge parameter at all", async () => {
    const { from, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100 },
    ]);
    tableMock.from = from;

    await applyCms1500Enrichment({
      claimRecordId: "r1",
      patientId: PATIENT_A,
      dateOfService: MAY_19,
      cptCodes: "97110",
      unitsBilled: 3,
    });

    expect(rows[0].charge_amount).toBe(100); // untouched regardless of what CMS1500 "saw"
    expect(rows[0].units_billed).toBe(3);
  });

  it("missing EOB modifier does not block CMS1500 from supplying it", async () => {
    const { from, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", modifier: null },
    ]);
    tableMock.from = from;

    await applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", modifier: "GP" });
    expect(rows[0].modifier).toBe("GP");
  });

  it("preserves existing values when an enrichment field is absent (null/undefined), including legitimate zeros", async () => {
    const { from, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", visit_number: 1, diagnosis_codes: "M54.5", modifier: "GP", units_billed: 0 },
    ]);
    tableMock.from = from;

    // Re-import with only diagnosisCodes supplied -- visit/modifier/units absent.
    await applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", diagnosisCodes: "M54.5" });

    expect(rows[0].visit_number).toBe(1); // preserved
    expect(rows[0].modifier).toBe("GP"); // preserved
    expect(rows[0].units_billed).toBe(0); // legitimate zero preserved, not treated as missing
  });

  it("re-applying the identical enrichment twice (reimport) does not duplicate rows or change values", async () => {
    const { from, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100, insurance_reimbursement: 80 },
    ]);
    tableMock.from = from;

    const args = { claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", visitNumber: 2, modifier: "GP", unitsBilled: 1 };
    await applyCms1500Enrichment(args);
    await applyCms1500Enrichment(args);

    expect(rows).toHaveLength(1);
    expect(rows[0].visit_number).toBe(2);
    expect(rows[0].charge_amount).toBe(100);
    expect(rows[0].insurance_reimbursement).toBe(80);
  });

  it("rejects a claimRecordId that does not belong to this patient (server-side ownership validation)", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_B, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;

    await expect(
      applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", modifier: "GP" })
    ).rejects.toThrow(/does not belong/i);
  });

  it("rejects a claimRecordId that no longer matches the service date/CPT (compatibility re-check)", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;

    await expect(
      applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: SEP_1, cptCodes: "97110", modifier: "GP" })
    ).rejects.toThrow(/does not belong|no longer matches/i);
  });
});
