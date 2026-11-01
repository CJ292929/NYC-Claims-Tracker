/**
 * server/claimImport.identity.test.ts — P4-P28
 *
 * The rules for who a bulk import's group belongs to. Pure function, invented
 * patients. No database (see claimImportPatients.postgrest.integration.test.ts
 * for the same rules end to end).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./_core/llm", () => ({ invokeLLM: vi.fn() }));

import type { ImportPatientIdentity } from "@shared/claimImport";
import { resolveImportPatient } from "./claimImport";
import type { PatientExternalIdRow } from "./db";

const ALEX = { id: "11111111-1111-4111-8111-111111111111", name: "TESTPATIENT, ALEX" };
const SAM = { id: "22222222-2222-4222-8222-222222222222", name: "OTHERPERSON, SAM" };
const ALEX2 = { id: "33333333-3333-4333-8333-333333333333", name: "ALEX TESTPATIENT" };
const STRONG = (externalId: string | null, birthDate: string | null = null, conflict: string | null = null): ImportPatientIdentity =>
  ({ sourceSystem: "billing_invoice_export", externalId, strength: "patient", birthDate, conflict });
const BOX26 = (externalId: string | null, birthDate: string | null = null): ImportPatientIdentity =>
  ({ sourceSystem: "cms1500_box26", externalId, strength: "account", birthDate });
const mapping = (patientId: string, externalId: string, birthDate: string | null = null, sourceSystem = "billing_invoice_export"): PatientExternalIdRow =>
  ({ patientId, sourceSystem, externalId, birthDate });

const resolve = (o: Partial<Parameters<typeof resolveImportPatient>[0]> & { patientName: string | null }) => resolveImportPatient({
  identity: null, requestedPatientId: null, createRequest: null, allPatients: [ALEX, SAM], externalIds: [], ...o,
});

describe("existing patient", () => {
  it("a mapped external id decides, whatever the name order", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: STRONG("G1"), externalIds: [mapping(ALEX.id, "G1")] });
    expect(r).toMatchObject({ identityStatus: "existing", patientId: ALEX.id, requiresConfirmation: false, canCreate: false });
  });

  it("a mapped id beats a same-name duplicate on the roster", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: STRONG("G1"), allPatients: [ALEX, ALEX2], externalIds: [mapping(ALEX2.id, "G1")] });
    expect(r).toMatchObject({ identityStatus: "existing", patientId: ALEX2.id });
  });

  it("an id in another system's namespace means nothing here", () => {
    const r = resolve({ patientName: "New Person", identity: STRONG("G1"), externalIds: [mapping(ALEX.id, "G1", null, "cms1500_box26")] });
    expect(r.identityStatus).toBe("new");
  });

  it("a unique name with no id still matches, as every existing import does", () => {
    const r = resolve({ patientName: "Alex Testpatient" });
    expect(r).toMatchObject({ identityStatus: "existing", patientId: ALEX.id, linkExternalId: null });
  });

  it("a form account number joins a unique name match and is linked on save", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: BOX26("99") });
    expect(r).toMatchObject({ identityStatus: "existing", patientId: ALEX.id, requiresConfirmation: false });
    expect(r.linkExternalId).toEqual({ sourceSystem: "cms1500_box26", externalId: "99", birthDate: null });
  });
});

describe("needs confirmation", () => {
  it("the first link of a stable id to a name match is a person's decision", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: STRONG("G1") });
    expect(r).toMatchObject({ identityStatus: "needs_confirmation", patientId: null, requiresConfirmation: true, canCreate: true, allowedIds: [ALEX.id] });
    expect(r.identityReasons!.join(" ")).toMatch(/matched by name only/);
  });

  it("once chosen, that link is what saving persists", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: STRONG("G1", "1950-03-14"), requestedPatientId: ALEX.id });
    expect(r.patientId).toBe(ALEX.id);
    expect(r.linkExternalId).toEqual({ sourceSystem: "billing_invoice_export", externalId: "G1", birthDate: "1950-03-14" });
  });

  it("duplicate names never auto-match", () => {
    const r = resolve({ patientName: "Alex Testpatient", allPatients: [ALEX, ALEX2] });
    expect(r).toMatchObject({ identityStatus: "needs_confirmation", patientId: null, canCreate: true });
    expect(r.candidates.map(c => c.id).sort()).toEqual([ALEX.id, ALEX2.id].sort());
  });

  it("a request cannot pick a patient outside the allowed set", () => {
    const r = resolve({ patientName: "Alex Testpatient", allPatients: [ALEX, ALEX2, SAM], requestedPatientId: SAM.id });
    expect(r.patientId).toBeNull();
  });

  it("a patient holding a different id from this system may be someone else", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: STRONG("G2"), externalIds: [mapping(ALEX.id, "G1")] });
    expect(r.identityStatus).toBe("needs_confirmation");
    expect(r.identityReasons!.join(" ")).toMatch(/different patient ID/);
  });

  it("a mapped id with a different name is a question, and cannot create a second patient", () => {
    const r = resolve({ patientName: "Sam Otherperson", identity: STRONG("G1"), externalIds: [mapping(ALEX.id, "G1")] });
    expect(r).toMatchObject({ identityStatus: "needs_confirmation", canCreate: false, allowedIds: [ALEX.id] });
  });

  it("a mapped id with a different birth date is a question", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: STRONG("G1", "1960-01-01"), externalIds: [mapping(ALEX.id, "G1", "1950-03-14")] });
    expect(r.identityStatus).toBe("needs_confirmation");
    expect(r.identityReasons!.join(" ")).toMatch(/birth date/);
  });

  it("a name match with a conflicting birth date on record is a question", () => {
    const r = resolve({ patientName: "Alex Testpatient", identity: BOX26(null, "1960-01-01"), externalIds: [mapping(ALEX.id, "99", "1950-03-14", "cms1500_box26")] });
    expect(r.identityStatus).toBe("needs_confirmation");
  });

  it("a file contradicting itself is a question, even with no roster match", () => {
    const r = resolve({ patientName: "New Person", identity: STRONG("G9", null, "One patient_guid in this file has more than one Birth Date.") });
    expect(r).toMatchObject({ identityStatus: "needs_confirmation", canCreate: true, creatingName: null });
  });

  it("an unreadable name can be assigned, or created under a typed name, not guessed", () => {
    const r = resolve({ patientName: null });
    expect(r).toMatchObject({ status: "unreadable", identityStatus: "needs_confirmation", canCreate: true, creatingName: null, patientId: null });
    expect(r.allowedIds).toEqual([ALEX.id, SAM.id]);
    const typed = resolve({ patientName: null, createRequest: { name: "Typed Name", distinctConfirmed: true } });
    expect(typed).toMatchObject({ identityStatus: "new", creatingName: "Typed Name" });
  });
});

describe("new patient", () => {
  it("no match at all is new, under the file's name", () => {
    const r = resolve({ patientName: "New Person", identity: STRONG("G9", "1970-01-01") });
    expect(r).toMatchObject({ identityStatus: "new", creatingName: "New Person", patientId: null });
    expect(r.creatingIdentity).toEqual({ sourceSystem: "billing_invoice_export", externalId: "G9", birthDate: "1970-01-01" });
  });

  it("the reviewer's corrected name wins", () => {
    expect(resolve({ patientName: "NEW PERSN", createRequest: { name: "New Person" } }).creatingName).toBe("New Person");
  });

  it("a duplicate name only creates when the reviewer says it is someone else", () => {
    expect(resolve({ patientName: "Alex Testpatient", allPatients: [ALEX, ALEX2], createRequest: { name: "Alex Testpatient" } }).creatingName ?? null).toBeNull();
    const r = resolve({ patientName: "Alex Testpatient", allPatients: [ALEX, ALEX2], createRequest: { name: "Alex Testpatient", distinctConfirmed: true } });
    expect(r).toMatchObject({ identityStatus: "new", creatingName: "Alex Testpatient" });
  });

  it("a stale create request cannot duplicate someone now matched", () => {
    const r = resolve({ patientName: "Alex Testpatient", createRequest: { name: "Alex Testpatient" } });
    expect(r).toMatchObject({ identityStatus: "existing", patientId: ALEX.id, creatingName: null });
  });

  it("a reused form account number is ignored: not that patient, and not this person's mapping", () => {
    const r = resolve({ patientName: "New Person", identity: BOX26("99"), externalIds: [mapping(ALEX.id, "99", null, "cms1500_box26")] });
    expect(r).toMatchObject({ identityStatus: "new", creatingName: "New Person" });
    expect(r.creatingIdentity!.externalId).toBeNull();
  });
});

describe("one person across a file", () => {
  it("groups share a key by id, or by name in any order when there is no id", () => {
    const a = resolve({ patientName: "New Person", identity: STRONG("G9") });
    const b = resolve({ patientName: "Person, New", identity: STRONG("G9") });
    expect(a.clusterKey).toBe(b.clusterKey);
    expect(resolve({ patientName: "New Person" }).clusterKey).toBe(resolve({ patientName: "PERSON, NEW" }).clusterKey);
    expect(a.clusterKey).not.toBe(resolve({ patientName: "New Person", identity: STRONG("G10") }).clusterKey);
  });
});
