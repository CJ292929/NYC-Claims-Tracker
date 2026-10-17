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
    let pendingUpdate: Record<string, unknown> | null = null;

    // update()/eq()/is() share the SAME filter accumulator as a plain
    // select -- this lets the real db.ts code chain
    // .update(patch).eq(...).eq(...).eq(...).select("id") exactly like
    // Supabase does, re-applying the full patient/date/CPT predicate on the
    // write itself rather than trusting an earlier separate check.
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
      update: (patch: Record<string, unknown>) => {
        pendingUpdate = patch;
        return chain;
      },
    };

    // findCms1500EnrichmentCandidates / patientHasAnyClaimRecords / the
    // final applyCms1500Enrichment update+select don't call .maybeSingle()
    // -- they await the query object directly. Give the chain a thenable so
    // `await query` resolves.
    (chain as any)[Symbol.toPrimitive] = undefined;
    const resolveList = () => {
      const matches = rows.filter(r =>
        Object.entries(pendingFilter).every(([k, v]) => r[k] === v) &&
        (pendingCptIsNull ? r.cpt_codes == null : true)
      );
      if (pendingUpdate) {
        for (const r of matches) Object.assign(r, pendingUpdate);
        return { data: matches.map(r => ({ id: r.id })), error: null };
      }
      if (isCountHead) return { data: null, error: null, count: matches.length };
      return { data: matches, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(resolveList()).then(resolve);

    return chain;
  });

  // Fakes write_claim_record_with_audit (see the P4-P17 migration) against
  // this SAME `rows` array — applyCms1500Enrichment's final write now goes
  // through supabase.rpc(...) instead of a second .from("claims_records")
  // call, so this reproduces the RPC's not-found/patient-mismatch error
  // codes (P0010/P0011) and its "merge only the provided keys" patch
  // semantics (plain Object.assign, since the real p_data here only ever
  // carries the keys actually being changed).
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name !== "write_claim_record_with_audit") throw new Error(`unexpected rpc: ${name}`);
    const { p_id, p_patient_id, p_data } = args as { p_id: string | null; p_patient_id: string; p_data: Record<string, unknown> };
    if (p_id) {
      const row = rows.find(r => r.id === p_id);
      if (!row) return Promise.resolve({ data: null, error: { code: "P0010" } });
      if (row.patient_id !== p_patient_id) return Promise.resolve({ data: null, error: { code: "P0011" } });
      Object.assign(row, p_data);
      return Promise.resolve({ data: p_id, error: null });
    }
    const newRow = { id: String(nextId++), patient_id: p_patient_id, ...p_data };
    rows.push(newRow);
    return Promise.resolve({ data: newRow.id, error: null });
  });

  return { from, rpc, rows, insertRow: (r: Omit<Row, "id">) => { const row = { id: String(nextId++), ...r }; rows.push(row); return row; } };
}

const { tableMock } = vi.hoisted(() => ({ tableMock: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock("./supabase", () => ({ supabase: tableMock }));

import {
  findCms1500EnrichmentCandidates,
  patientHasAnyClaimRecords,
  applyCms1500Enrichment,
} from "./db";
import type { ActorContext } from "./actorIdentity";

const ACTOR: ActorContext = { actorId: "actor-1", actorType: "owner", actorDisplay: "Owner" };

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

  it("hasReimbursementEvidence is false when every reimbursement-only field is null (looks like a manual/legacy-CMS1500 row, not a confirmed reimbursement row)", async () => {
    const { from } = makeFakeClaimsTable([
      {
        id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110",
        charge_amount: 100, insurance_reimbursement: null, patient_amount_paid: null, patient_amount_due: null,
        oa_claim_number: null, check_date: null, check_number_virtual_card: null, reference_no: null, payment_received: null,
      },
    ]);
    tableMock.from = from;

    const [candidate] = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97110");
    expect(candidate.hasReimbursementEvidence).toBe(false);
  });

  it("hasReimbursementEvidence is true when a reimbursement field is an explicit zero -- a denied/zero-payment EOB line is still real evidence", async () => {
    const { from } = makeFakeClaimsTable([
      {
        id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110",
        charge_amount: 100, insurance_reimbursement: 0, patient_amount_paid: 0, patient_amount_due: 0,
        oa_claim_number: null, check_date: null, check_number_virtual_card: null, reference_no: null, payment_received: null,
      },
    ]);
    tableMock.from = from;

    const [candidate] = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97110");
    expect(candidate.hasReimbursementEvidence).toBe(true);
  });

  it("hasReimbursementEvidence is true when only a non-money field like oa_claim_number or check_date is present", async () => {
    const { from } = makeFakeClaimsTable([
      {
        id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110",
        charge_amount: 100, insurance_reimbursement: null, patient_amount_paid: null, patient_amount_due: null,
        oa_claim_number: "OA-123", check_date: null, check_number_virtual_card: null, reference_no: null, payment_received: null,
      },
    ]);
    tableMock.from = from;

    const [candidate] = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97110");
    expect(candidate.hasReimbursementEvidence).toBe(true);
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

  // P4-P14: with the source_line_index fix, two legitimate repeated
  // reimbursement lines for the same date/CPT can now coexist as two
  // separate rows (same auth period). This function has no line
  // discriminator (it doesn't select source_line_index at all) and must
  // keep requiring explicit staff selection rather than guessing which one
  // a CMS1500 line enriches.
  it("two repeated reimbursement rows for the same date/CPT (P4-P14) still return as multiple candidates, not auto-resolved", async () => {
    const { from } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97530", source_line_index: 0, charge_amount: 75, insurance_reimbursement: 60 },
      { id: "r2", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97530", source_line_index: 1, charge_amount: 90, insurance_reimbursement: 70 },
    ]);
    tableMock.from = from;

    const candidates = await findCms1500EnrichmentCandidates(PATIENT_A, MAY_19, "97530");
    expect(candidates).toHaveLength(2); // caller must require explicit selection, never auto-pick one
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
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100, insurance_reimbursement: 80, patient_amount_paid: 20, patient_amount_due: 0, visit_number: null, diagnosis_codes: null, modifier: null, units_billed: null },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    await applyCms1500Enrichment({
      claimRecordId: "r1",
      patientId: PATIENT_A,
      dateOfService: MAY_19,
      cptCodes: "97110",
      visitNumber: 2,
      diagnosisCodes: "M54.5",
      modifier: "GP",
      unitsBilled: 1,
      actor: ACTOR,
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
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100 },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    await applyCms1500Enrichment({
      claimRecordId: "r1",
      patientId: PATIENT_A,
      dateOfService: MAY_19,
      cptCodes: "97110",
      unitsBilled: 3,
      actor: ACTOR,
    });

    expect(rows[0].charge_amount).toBe(100); // untouched regardless of what CMS1500 "saw"
    expect(rows[0].units_billed).toBe(3);
  });

  it("missing EOB modifier does not block CMS1500 from supplying it", async () => {
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", modifier: null },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    await applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", modifier: "GP", actor: ACTOR });
    expect(rows[0].modifier).toBe("GP");
  });

  it("preserves existing values when an enrichment field is absent (null/undefined), including legitimate zeros", async () => {
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", visit_number: 1, diagnosis_codes: "M54.5", modifier: "GP", units_billed: 0 },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    // Re-import with only diagnosisCodes supplied -- visit/modifier/units absent.
    await applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", diagnosisCodes: "M54.5", actor: ACTOR });

    expect(rows[0].visit_number).toBe(1); // preserved
    expect(rows[0].modifier).toBe("GP"); // preserved
    expect(rows[0].units_billed).toBe(0); // legitimate zero preserved, not treated as missing
  });

  // P4-P14: with two repeated reimbursement rows for the same date/CPT now
  // possible, staff must pick the exact row (by id) — this proves the
  // commit step only ever patches the id it's told, never spills onto the
  // sibling repeated-line row, and never touches either row's money.
  it("with two repeated rows for the same date/CPT, enriching the one explicitly selected never touches its sibling or either row's money", async () => {
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97530", source_line_index: 0, charge_amount: 75, insurance_reimbursement: 60, visit_number: null, diagnosis_codes: null, modifier: null, units_billed: null },
      { id: "r2", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97530", source_line_index: 1, charge_amount: 90, insurance_reimbursement: 70, visit_number: null, diagnosis_codes: null, modifier: null, units_billed: null },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    // Staff explicitly selected r2 as the target for this CMS1500 line.
    await applyCms1500Enrichment({
      claimRecordId: "r2",
      patientId: PATIENT_A,
      dateOfService: MAY_19,
      cptCodes: "97530",
      visitNumber: 4,
      modifier: "GP",
      actor: ACTOR,
    });

    const r1 = rows.find(r => r.id === "r1")!;
    const r2 = rows.find(r => r.id === "r2")!;
    expect(r2.visit_number).toBe(4);
    expect(r2.modifier).toBe("GP");
    expect(r2.charge_amount).toBe(90); // r2's own money untouched
    expect(r2.insurance_reimbursement).toBe(70);
    // r1 (the sibling repeated line) is completely untouched -- no bleed-over.
    expect(r1.visit_number).toBeNull();
    expect(r1.modifier).toBeNull();
    expect(r1.charge_amount).toBe(75);
    expect(r1.insurance_reimbursement).toBe(60);
  });

  it("re-applying the identical enrichment twice (reimport) does not duplicate rows or change values", async () => {
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", charge_amount: 100, insurance_reimbursement: 80 },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    const args = { claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", visitNumber: 2, modifier: "GP", unitsBilled: 1, actor: ACTOR };
    await applyCms1500Enrichment(args);
    await applyCms1500Enrichment(args);

    expect(rows).toHaveLength(1);
    expect(rows[0].visit_number).toBe(2);
    expect(rows[0].charge_amount).toBe(100);
    expect(rows[0].insurance_reimbursement).toBe(80);
  });

  it("rejects a claimRecordId that does not belong to this patient (server-side ownership validation)", async () => {
    const { from, rpc } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_B, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    await expect(
      applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", modifier: "GP", actor: ACTOR })
    ).rejects.toThrow(/does not belong/i);
  });

  it("rejects a claimRecordId that no longer matches the service date/CPT (compatibility re-check)", async () => {
    const { from, rpc } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110" },
    ]);
    tableMock.from = from;
    tableMock.rpc = rpc;

    await expect(
      applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: SEP_1, cptCodes: "97110", modifier: "GP", actor: ACTOR })
    ).rejects.toThrow(/does not belong|no longer matches/i);
  });

  it("throws rather than reporting success when the target row is deleted between the ownership check and the write (stale-target race)", async () => {
    const { from, rpc, rows } = makeFakeClaimsTable([
      { id: "r1", patient_id: PATIENT_A, auth_period: 1, date_of_service: "2026-05-19", cpt_codes: "97110", visit_number: null },
    ]);
    tableMock.from = from;
    // applyCms1500Enrichment now does its ownership pre-check via .from(...)
    // (passes -- the row still exists) and its actual write via
    // supabase.rpc("write_claim_record_with_audit", ...). Simulate a
    // concurrent delete landing in that window by clearing `rows` the moment
    // the RPC is invoked, before it looks the row up by id -- the RPC fake's
    // own not-found handling (P0010) must then make this throw, not resolve
    // successfully having changed nothing.
    tableMock.rpc = ((name: string, args: Record<string, unknown>) => {
      rows.length = 0;
      return rpc(name, args);
    }) as typeof rpc;

    await expect(
      applyCms1500Enrichment({ claimRecordId: "r1", patientId: PATIENT_A, dateOfService: MAY_19, cptCodes: "97110", modifier: "GP", actor: ACTOR })
    ).rejects.toThrow(/does not belong|no longer matches/i);
  });

});
