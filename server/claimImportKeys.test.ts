/**
 * server/claimImportKeys.test.ts — P4-P24
 * Source identity assigned at extraction time: stable, order-independent,
 * distinct for identical repeated lines, and free of patient identifiers.
 */
import { describe, expect, it } from "vitest";
import { CLAIM_IMPORT_KEY_RE } from "@shared/claimImport";
import { assignEobLineKeys, cms1500GroupsFromClaims, eobGroupsFromClaims, groupKeyFor, sha256Hex, toIsoDate } from "./claimImportKeys";

const templateGroup = {
  patientName: "TESTPATIENT, ALEX",
  claims: [
    {
      dateOfService: "2026-03-02", placeOfService: "12", visitNumber: 3, claimSubmittedDate: "2026-03-16",
      cptLines: [
        { cptCodes: "97110", modifier: "GP", unitsBilled: 1, diagnosisCodes: "M54.50", chargeAmount: 175, insuranceReimbursement: null },
        { cptCodes: "97110", modifier: "GP", unitsBilled: 1, diagnosisCodes: "M54.50", chargeAmount: 175, insuranceReimbursement: null },
        { cptCodes: "97140", modifier: "59", unitsBilled: 1, diagnosisCodes: "M62.81", chargeAmount: 175, insuranceReimbursement: 99 },
      ],
    },
  ],
};

describe("cms1500GroupsFromClaims", () => {
  const [group] = cms1500GroupsFromClaims([templateGroup]);

  it("drops visit numbers and money, keeping the Box 24F charge only for validation", () => {
    for (const l of group.lines) {
      expect(l).not.toHaveProperty("visitNumber");
      expect(l).not.toHaveProperty("insuranceReimbursement");
      expect(l).not.toHaveProperty("chargeAmount");
      expect(l.lineChargeForValidation).toBe(175);
    }
  });

  it("gives identical repeated lines distinct, valid keys", () => {
    const keys = group.lines.map(l => l.sourceLineKey);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(CLAIM_IMPORT_KEY_RE);
    expect(keys[0].endsWith("_0")).toBe(true);
    expect(keys[1].endsWith("_1")).toBe(true);
  });

  it("does not depend on the order the extractor returned lines in", () => {
    const reversed = { ...templateGroup, claims: [{ ...templateGroup.claims[0], cptLines: [...templateGroup.claims[0].cptLines].reverse() }] };
    const [again] = cms1500GroupsFromClaims([reversed]);
    expect(new Set(again.lines.map(l => l.sourceLineKey))).toEqual(new Set(group.lines.map(l => l.sourceLineKey)));
  });

  it("keeps a group's key when other groups are added or reordered, and never embeds the name", () => {
    const other = { ...templateGroup, patientName: "OTHERPERSON, SAM" };
    const [a] = cms1500GroupsFromClaims([templateGroup, other]);
    const [, b] = cms1500GroupsFromClaims([other, templateGroup]);
    expect(a.groupKey).toBe(b.groupKey);
    expect(a.groupKey).toMatch(/^g[0-9a-f]{12}$/);
    expect(a.lines[0].sourceLineKey).not.toMatch(/TESTPATIENT/i);
  });

  it("treats the template's UNKNOWN placeholder name as unreadable", () => {
    const [g] = cms1500GroupsFromClaims([{ ...templateGroup, patientName: "UNKNOWN" }]);
    expect(g.patientName).toBeNull();
  });
});

describe("eobGroupsFromClaims", () => {
  it("keeps claim-level combined totals unresolved and off every line", () => {
    const [g] = eobGroupsFromClaims([{
      patientName: "TESTPATIENT, ALEX",
      claims: [{
        dateOfService: "03/02/2026", cptCodes: "97110, 97112",
        unresolvedClaimTotal: { planPaid: 300, patientResponsibility: 40, cptCount: 2 },
        cptLines: [
          { cptCodes: "97110", chargeAmount: 175, insuranceReimbursement: null, patientAmountDue: null },
          { cptCodes: "97112", chargeAmount: 175, insuranceReimbursement: null, patientAmountDue: null },
        ],
      }],
    }]);
    expect(g.unresolvedClaimTotals).toEqual([{ dateOfService: "2026-03-02", cptCodes: "97110, 97112", planPaid: 300, patientResponsibility: 40, cptCount: 2 }]);
    expect(g.lines.every(l => l.insuranceReimbursement === null && l.patientAmountDue === null)).toBe(true);
    expect(g.warnings[0]).toMatch(/not saved to any line/);
  });

  it("distinguishes identical EOB lines and keeps keys deterministic", () => {
    const lines = () => [
      { page: null, dateOfService: "2026-03-02", cptCodes: "97110", modifier: "GP", unitsBilled: 1, chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: null, patientAmountPaid: null, claimStatus: null, oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null, notes: null },
      { page: null, dateOfService: "2026-03-02", cptCodes: "97110", modifier: "GP", unitsBilled: 1, chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: null, patientAmountPaid: null, claimStatus: null, oaClaimNumber: null, checkDate: null, checkNumberVirtualCard: null, notes: null },
    ];
    const a = assignEobLineKeys("gabc", lines()).map(l => l.sourceLineKey);
    const b = assignEobLineKeys("gabc", lines()).map(l => l.sourceLineKey);
    expect(a[0]).not.toBe(a[1]);
    expect(a).toEqual(b);
  });
});

describe("helpers", () => {
  it("hashes bytes and keys groups without identifiers", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(groupKeyFor("x")).toBe(groupKeyFor(" X "));
  });

  it("normalizes dates without guessing", () => {
    expect(toIsoDate("03/02/2026")).toBe("2026-03-02");
    expect(toIsoDate("3/2/26")).toBe("2026-03-02");
    expect(toIsoDate("2026-03-02T00:00:00Z")).toBe("2026-03-02");
    expect(toIsoDate("March 2")).toBeNull();
  });
});
