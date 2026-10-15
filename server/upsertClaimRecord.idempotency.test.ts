/**
 * server/upsertClaimRecord.idempotency.test.ts
 *
 * Covers the P4-P1 Cigna-import requirement that re-importing the same EOB
 * (or the same row twice within one import) never duplicates a claim or
 * double-counts reimbursement: upsertClaimRecord (server/db.ts) matches an
 * existing row by (patient_id, auth_period, date_of_service, cpt_codes) and
 * patches it in place rather than inserting a second row.
 *
 * Uses a minimal in-memory fake of the one Supabase table this function
 * touches -- no real network/DB access, synthetic patient/claim data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown> & { id: string };

function makeFakeClaimsTable() {
  const rows: Row[] = [];
  let nextId = 1;

  const from = vi.fn((table: string) => {
    if (table !== "claims_records") throw new Error(`unexpected table: ${table}`);

    let pendingFilter: Partial<Row> = {};
    let pendingCptIsNull = false;

    const chain: Record<string, (...args: unknown[]) => unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        pendingFilter = { ...pendingFilter, [col]: val };
        return chain;
      },
      is: (col: string) => {
        if (col === "cpt_codes") pendingCptIsNull = true;
        return chain;
      },
      maybeSingle: () => {
        const match = rows.find(r =>
          Object.entries(pendingFilter).every(([k, v]) => r[k] === v) &&
          (pendingCptIsNull ? r.cpt_codes == null : true)
        );
        return Promise.resolve({ data: match ? { id: match.id } : null, error: null });
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

import { upsertClaimRecord } from "./db";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const DOS = new Date("2026-03-05T00:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("upsertClaimRecord idempotency", () => {
  it("reimporting the identical row patches the existing claim instead of inserting a duplicate", async () => {
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

  // P4-P13: documents a real structural side effect of the idempotency match
  // key above, investigated as a candidate explanation for a reported UHC
  // import where one of two same-day 97530 lines didn't show up in the
  // tracker. This is NOT a fix — the (patient, period, date, cpt_codes) key
  // is deliberate (see the P4-P1 Cigna re-import requirement this file
  // covers above) and changing it risks reintroducing duplicate-row
  // double-counting for every other insurer that already relies on it. It's
  // recorded here as a verified, reproducible mechanism so a future pass
  // with the actual UHC source PDF can confirm whether this is what
  // happened and, if so, design a narrower fix (e.g. a disambiguating line
  // index in the match key) without this test regressing in the meantime.
  it("[KNOWN LIMITATION] two distinct service lines sharing the same CPT code AND date silently collapse into one row", async () => {
    const { from, rows } = makeFakeClaimsTable();
    tableMock.from = from;

    // Two separate 97530 line items billed on the same date (e.g. two
    // distinct sessions/units reported as separate EOB rows rather than one
    // row with unitsBilled=2) -- a legitimate, real-world EOB shape.
    await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", chargeAmount: 75, insuranceReimbursement: 60 });
    await upsertClaimRecord({ patientId: PATIENT_ID, authPeriod: 1, dateOfService: DOS, cptCodes: "97530", chargeAmount: 90, insuranceReimbursement: 70 });

    // Both calls match the SAME existing row (same patient/period/date/CPT),
    // so the second call patches the first instead of inserting a second
    // row -- the first line's $75/$60 is silently overwritten by the
    // second's $90/$70, and only one 97530 ever appears in the tracker.
    expect(rows).toHaveLength(1);
    expect(rows[0].charge_amount).toBe(90);
    expect(rows[0].insurance_reimbursement).toBe(70);
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
});
