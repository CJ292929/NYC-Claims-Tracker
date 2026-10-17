/**
 * server/upsertClaimRecord.idempotency.test.ts
 *
 * Covers two requirements for upsertClaimRecord (server/db.ts):
 *
 * 1. P4-P1 (Cigna): re-importing the same EOB (or the same row twice within
 *    one import) never duplicates a claim or double-counts reimbursement —
 *    matched by (patient_id, auth_period, date_of_service, cpt_codes) and
 *    patched in place rather than inserted as a second row.
 *
 * 2. P4-P14 (UHC): two legitimate, DISTINCT service lines that happen to
 *    share patient/period/date/CPT (e.g. two 97530 sessions billed the same
 *    day) must land in two separate rows, not collapse into one with the
 *    second overwriting the first. Disambiguated via sourceLineIndex — see
 *    the doc comment on upsertClaimRecord and the migration
 *    20261017000000_claims_source_line_index_and_needs_review.sql. Rows
 *    written before that column existed (source_line_index IS NULL) are
 *    treated as index 0 for backward compatibility; a legacy row found
 *    while the import asks for index >= 1 throws
 *    ClaimLineIdentityAmbiguousError rather than guessing (requiring manual
 *    review) — never a silently inserted duplicate or a silent merge.
 *
 * Uses a minimal in-memory fake of the one Supabase table this function
 * touches -- no real network/DB access, synthetic patient/claim data only.
 * (A real disposable Postgres database was separately used, outside this
 * test file, to confirm the same row-preservation/idempotency/constraint
 * behavior holds at the actual SQL level — see the PR description.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

function makeFakeClaimsTable() {
  const rows: Row[] = [];
  let nextId = 1;

  const from = vi.fn((table: string) => {
    if (table !== "claims_records") throw new Error(`unexpected table: ${table}`);

    let pendingFilter: Record<string, unknown> = {};
    const pendingIsNullCols = new Set<string>();

    const chain: Record<string, (...args: unknown[]) => unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        pendingFilter = { ...pendingFilter, [col]: val };
        return chain;
      },
      is: (col: string, val: unknown) => {
        if (val === null) pendingIsNullCols.add(col);
        return chain;
      },
      maybeSingle: () => {
        const matches = rows.filter(r =>
          Object.entries(pendingFilter).every(([k, v]) => r[k] === v) &&
          Array.from(pendingIsNullCols).every(col => r[col] == null)
        );
        if (matches.length > 1) {
          // Mirrors PostgREST's maybeSingle() behavior: more than one
          // matching row is an error, not an arbitrary pick.
          return Promise.resolve({ data: null, error: { code: "PGRST116", message: "multiple rows returned" } });
        }
        return Promise.resolve({ data: matches[0] ? { id: matches[0].id } : null, error: null });
      },
      insert: (payload: Record<string, unknown>) => {
        const row: Row = { id: String(nextId++), ...payload };
        rows.push(row);
        return {
          select: () => ({
            single: () => Promise.resolve({ data: { id: row.id }, error: null }),
          }),
        };
      },
      update: (patch: Record<string, unknown>) => ({
        eq: (_col: string, id: string) => {
          const row = rows.find(r => r.id === id);
          if (row) Object.assign(row, patch);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
    return chain;
  });

  return { from, rows };
}

const { tableMock } = vi.hoisted(() => ({ tableMock: { from: vi.fn() } }));
vi.mock("./supabase", () => ({ supabase: tableMock }));

import { upsertClaimRecord, ClaimLineIdentityAmbiguousError } from "./db";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const DOS = new Date("2026-03-05T00:00:00Z");
const OTHER_DOS = new Date("2026-03-06T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertClaimRecord idempotency", () => {
  it("reimporting the identical row (no sourceLineIndex) patches the existing claim instead of inserting a duplicate", async () => {
    const { from, rows } = makeFakeClaimsTable();
    tableMock.from = from;

    await upsertClaimRecord({
      patientId: PATIENT_ID,
      authPeriod: 1,
      dateOfService: DOS,
      cptCodes: "97110",
      chargeAmount: 100,
      insuranceReimbursement: 80,
    });
    expect(rows).toHaveLength(1);

    // Re-import the same date/CPT row (e.g. the same file imported twice)
    await upsertClaimRecord({
      patientId: PATIENT_ID,
      authPeriod: 1,
      dateOfService: DOS,
      cptCodes: "97110",
      chargeAmount: 100,
      insuranceReimbursement: 80,
    });

    expect(rows).toHaveLength(1); // still one row, not two
    expect(rows[0].insurance_reimbursement).toBe(80);
  });

  it("a different CPT code on the same date creates a separate row (not collapsed into one)", async () => {
    const { from, rows } = makeFakeClaimsTable();
    tableMock.from = from;

    await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97110", chargeAmount: 100 });
    await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97140", chargeAmount: 50 });

    expect(rows).toHaveLength(2);
  });

  it("a later import patching reimbursement does not null out a field only the earlier import set", async () => {
    const { from, rows } = makeFakeClaimsTable();
    tableMock.from = from;

    // First pass (CMS1500): sets place_of_service, no reimbursement yet
    await upsertClaimRecord({
      patientId: PATIENT_ID,
      authPeriod: 1,
      dateOfService: DOS,
      cptCodes: "97110",
      placeOfService: "11",
    });
    // Second pass (reimbursement EOB for the same date/CPT): adds reimbursement
    await upsertClaimRecord({
      patientId: PATIENT_ID,
      authPeriod: 1,
      dateOfService: DOS,
      cptCodes: "97110",
      insuranceReimbursement: 80,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].place_of_service).toBe("11"); // preserved, not wiped by the second (narrower) payload
    expect(rows[0].insurance_reimbursement).toBe(80);
  });

  describe("P4-P14: repeated same-date/same-CPT service lines (sourceLineIndex)", () => {
    it("two legitimate distinct 97530 lines on the same date both survive as separate rows", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      // Two separate 97530 line items billed on the same date -- a
      // legitimate, real-world EOB shape (the reported UHC case).
      await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 75, insuranceReimbursement: 60 });
      await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 1, chargeAmount: 90, insuranceReimbursement: 70 });

      expect(rows).toHaveLength(2);
      const [first, second] = [...rows].sort((a, b) => (a.source_line_index as number) - (b.source_line_index as number));
      expect(first.charge_amount).toBe(75);
      expect(first.insurance_reimbursement).toBe(60);
      expect(second.charge_amount).toBe(90);
      expect(second.insurance_reimbursement).toBe(70);
    });

    it("identical repeated lines (same units/modifier/amounts) still remain two distinct rows", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      const identicalLine = {
        patientId: PATIENT_ID,
        authPeriod: 1,
        dateOfService: DOS,
        cptCodes: "97110",
        unitsBilled: 1,
        modifier: "GP",
        chargeAmount: 50,
        insuranceReimbursement: 40,
      };
      await upsertClaimRecord({ ...identicalLine, sourceLineIndex: 0 });
      await upsertClaimRecord({ ...identicalLine, sourceLineIndex: 1 });

      expect(rows).toHaveLength(2);
      expect(rows[0].charge_amount).toBe(50);
      expect(rows[1].charge_amount).toBe(50);
      expect(rows[0].id).not.toBe(rows[1].id);
    });

    it("reimporting the same two-line document is idempotent -- no extra rows, no double payments", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      const importDocument = async () => {
        await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 75, insuranceReimbursement: 60 });
        await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 1, chargeAmount: 90, insuranceReimbursement: 70 });
      };

      await importDocument();
      expect(rows).toHaveLength(2);

      await importDocument(); // same file re-uploaded
      expect(rows).toHaveLength(2); // still exactly 2 rows, not 4
      const reimbursements = rows.map(r => r.insurance_reimbursement).sort();
      expect(reimbursements).toEqual([60, 70]); // not doubled, not summed
    });

    it("different patients with the same date/CPT remain separate (not merged across patients)", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 75 });
      await upsertClaimRecord({ patientId: OTHER_PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 999 });

      expect(rows).toHaveLength(2);
      const mine = rows.find(r => r.patient_id === PATIENT_ID)!;
      expect(mine.charge_amount).toBe(75);
    });

    it("different dates for the same patient/CPT remain separate", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 75 });
      await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: OTHER_DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 80 });

      expect(rows).toHaveLength(2);
    });

    it("a pre-P4-P14 legacy row (source_line_index NULL) is treated as index 0 and patched in place, not duplicated", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      // Simulate a row written before source_line_index existed.
      rows.push({ id: "legacy-1", patient_id: PATIENT_ID, auth_period: 1, date_of_service: "2026-03-05", cpt_codes: "97530", charge_amount: 75, insurance_reimbursement: 60, source_line_index: null } as Row);

      await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, insuranceReimbursement: 65 });

      expect(rows).toHaveLength(1); // patched, not duplicated
      expect(rows[0].id).toBe("legacy-1");
      expect(rows[0].insurance_reimbursement).toBe(65);
      expect(rows[0].source_line_index).toBe(0); // promoted/tagged going forward
    });

    it("[AMBIGUOUS LEGACY MATCH] a legacy NULL-index row found while importing a SECOND repeated line throws instead of silently inserting or merging", async () => {
      const { from, rows } = makeFakeClaimsTable();
      tableMock.from = from;

      // A pre-P4-P14 row already exists at this exact key with no line
      // index -- it might already be the P4-P13 "KNOWN LIMITATION" merge
      // artifact (two old lines collapsed into one), so a second line for
      // this key cannot be safely inserted or merged without checking the
      // source document.
      rows.push({ id: "legacy-1", patient_id: PATIENT_ID, auth_period: 1, date_of_service: "2026-03-05", cpt_codes: "97530", charge_amount: 90, insurance_reimbursement: 70, source_line_index: null } as Row);

      await expect(
        upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 1, chargeAmount: 75, insuranceReimbursement: 60 })
      ).rejects.toBeInstanceOf(ClaimLineIdentityAmbiguousError);

      expect(rows).toHaveLength(1); // nothing inserted, nothing merged
      expect(rows[0].charge_amount).toBe(90); // legacy row untouched
    });

    it("P4-P16: a genuine database/schema error on the legacy-row lookup is rethrown as-is, not misclassified as ClaimLineIdentityAmbiguousError", async () => {
      // Simulates e.g. a missing source_line_index column (migration not
      // actually applied) or a transient network/permissions failure --
      // anything other than PostgREST's "multiple rows" (PGRST116). Before
      // this fix, upsertClaimRecord treated ANY error from this lookup as
      // the ambiguous-identity case, which would surface a real schema
      // failure to staff as "needs manual review" instead of the actual
      // infrastructure problem.
      const schemaError = { code: "42703", message: 'column "source_line_index" does not exist' };
      const from = vi.fn((table: string) => {
        if (table !== "claims_records") throw new Error(`unexpected table: ${table}`);
        let sawIsNull = false;
        const chain: Record<string, (...args: unknown[]) => unknown> = {
          select: () => chain,
          eq: (_col: string, _val: unknown) => chain,
          is: (col: string, val: unknown) => {
            if (val === null && col === "source_line_index") sawIsNull = true;
            return chain;
          },
          maybeSingle: () => {
            if (sawIsNull) {
              return Promise.resolve({ data: null, error: schemaError });
            }
            // First lookup (exact sourceLineIndex match) finds nothing,
            // forcing the code into the legacy-row lookup above.
            return Promise.resolve({ data: null, error: null });
          },
        };
        return chain;
      });
      tableMock.from = from;

      await expect(
        upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", sourceLineIndex: 0, chargeAmount: 75 })
      ).rejects.toMatchObject(schemaError);
    });
  });
});
