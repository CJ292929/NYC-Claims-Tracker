/**
 * server/claimImport.ts — P4-P24
 *
 * Preview and commit for CMS1500 and EOB / Insurance Reimbursement imports,
 * shared by the single-patient upload buttons and the two Claims-access bulk
 * uploads (claims.importPreview / claims.importCommit in routers.ts — both
 * claimsAccessProcedure).
 *
 * Preview never writes. Commit re-derives the patient decision and the
 * authorization period server-side, then writes each line through one
 * audited RPC call (commit_cms1500_line_with_audit /
 * apply_eob_line_with_audit), which re-checks ownership, CMS1500-first,
 * source-line uniqueness and existing money under a per-patient lock. A
 * line the database refuses comes back as review_required with the reason;
 * it never fails the rest of the file.
 *
 * P4-P28: in bulk mode a group's patient is resolved from the file's identity
 * evidence (resolveImportPatient). A patient that does not exist yet is
 * created only by commit, only when the request asks for it, and in one
 * transaction with that group's lines (commit_import_with_new_patient). An EOB
 * line with no CMS1500 line to land on is kept in pending_eob_lines, never
 * discarded and never written to a claim row (see server/pendingEob.ts).
 */
import { z } from "zod";
import { randomUUID } from "crypto";
import { classifyPatientMatch, fuzzyNameMatch } from "@shared/nameMatch";
import {
  CLAIM_IMPORT_KEY_RE,
  CLAIM_IMPORT_STATUSES,
  BIRTH_EVIDENCE_SOURCE_SYSTEM,
  CMS1500_BOX26_SOURCE_SYSTEM,
  EOB_LINE_DISMISSED,
  SHA256_RE,
  UPLOAD_CMS1500_FIRST,
  allowedEobTargets,
  changedSavedLines,
  classifyCms1500Line,
  classifyEobLine,
  classifyEobLineForTarget,
  classifyExportLine,
  exportLineIdentityProblem,
  findDismissedEobLine,
  resolveAuthPeriod,
  resolveAuthPeriodWithFilePeriod,
  type Cms1500LineClassification,
  type EobCsvTarget,
  type EobLineClassification,
  type ExistingClaimLine,
  type ImportPatientIdentity,
  type PeriodResolution,
  type SavedDocumentLine,
} from "@shared/claimImport";
import {
  applyEobLine,
  ClaimImportRuleError,
  commitCms1500Line,
  commitImportWithNewPatient,
  findClaimImportDocumentId,
  getAllPatients,
  holdEobLine,
  linkPatientExternalId,
  listClaimLinesForDocument,
  listDismissedEobLines,
  listHeldEobLineKeys,
  listPatientClaimLinesOnDates,
  listPatientExternalIds,
  listPatientVisitPeriodDates,
  reopenDismissedEobLine,
  type PatientExternalIdRow,
} from "./db";
import type { ActorContext } from "./actorIdentity";

// ─── Input validation ────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const key = z.string().regex(CLAIM_IMPORT_KEY_RE);
const money = z.number().finite().min(-10_000_000).max(10_000_000).nullable();
const shortText = (max: number) => z.string().trim().max(max).nullable();

const documentInput = z.object({
  sha256: z.string().regex(SHA256_RE),
  fileName: z.string().max(255),
  pageCount: z.number().int().min(1).max(500).nullable(),
});

const lineIdentity = {
  sourceLineKey: key,
  dateOfService: isoDate.nullable(),
  cptCodes: shortText(20),
  modifier: shortText(40),
  unitsBilled: z.number().int().min(1).max(999).nullable(),
};

const cms1500LineInput = z.object({
  ...lineIdentity,
  placeOfService: shortText(10),
  diagnosisCodes: shortText(200),
  claimSubmittedDate: isoDate.nullable(),
  insuranceBilled: shortText(60),
  visitNumber: z.number().int().min(1).max(10000).nullable().optional(),
  unreadable: z.array(z.string().max(40)).max(20),
});

const CLAIM_STATUSES = CLAIM_IMPORT_STATUSES;

const eobLineInput = z.object({
  ...lineIdentity,
  chargeAmount: money,
  insuranceReimbursement: money,
  patientAmountDue: money,
  patientAmountPaid: money,
  claimStatus: z.enum(CLAIM_STATUSES).nullable(),
  oaClaimNumber: shortText(80),
  checkDate: isoDate.nullable(),
  checkNumberVirtualCard: shortText(80),
});

/** P4-P28: identity evidence the extractor returned with the group. Box 26 / DOB only: nothing here is decisive alone. */
export const patientIdentityInput = z.object({
  sourceSystem: z.literal(CMS1500_BOX26_SOURCE_SYSTEM),
  externalId: z.string().trim().min(1).max(200).nullable(),
  // A client request can only ever carry the weak kind; a CSV export's id is re-read from the file.
  strength: z.literal("account"),
  birthDate: isoDate.nullable(),
});

/** P4-P28: reviewer's request to create this group's patient. Only name is ever written. */
export const createPatientRequest = z.object({
  name: z.string().trim().min(1).max(200),
  /** The reviewer saw a same-name or conflicting record and says this is someone else. */
  distinctConfirmed: z.boolean().optional(),
});

const groupBase = {
  groupKey: key,
  patientName: shortText(200),
  /** Reviewer's patient choice; re-validated against the allowed set. */
  patientId: z.string().uuid().nullable().optional(),
  patientIdentity: patientIdentityInput.nullable().optional(),
  createPatient: createPatientRequest.nullable().optional(),
};

const MAX_GROUPS = 100;
const MAX_LINES = 500;

export const importPreviewInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cms1500"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    groups: z.array(z.object({ ...groupBase, lines: z.array(cms1500LineInput).max(MAX_LINES) })).min(1).max(MAX_GROUPS),
  }),
  z.object({
    kind: z.literal("eob"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    groups: z.array(z.object({ ...groupBase, lines: z.array(eobLineInput).max(MAX_LINES) })).min(1).max(MAX_GROUPS),
  }),
]);

export const cms1500Decision = z.object({
  action: z.enum(["create", "create_distinct", "associate", "skip"]),
  claimRecordId: z.string().uuid().nullable().optional(),
  authPeriod: z.number().int().min(1).max(1000).nullable().optional(),
  periodSource: z.enum(["resolved", "selected", "context"]).nullable().optional(),
  acknowledgeFlags: z.boolean().optional(),
});

export const eobDecision = z.object({
  /** hold (P4-P28): keep this reviewed line pending until its CMS1500 line exists. */
  action: z.enum(["apply", "skip", "hold"]),
  claimRecordId: z.string().uuid().nullable().optional(),
  confirmReplace: z.boolean().optional(),
  /** P4-P28: the reviewer knows this line was dismissed earlier and is bringing it back. */
  reopenDismissed: z.boolean().optional(),
});

export const importCommitInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cms1500"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    contextAuthPeriod: z.number().int().min(1).max(1000).nullable().optional(),
    groups: z.array(z.object({
      ...groupBase,
      patientConfirmed: z.boolean().optional(),
      /** Every line key this group was extracted with (not just the ones being retried). */
      allLineKeys: z.array(key).max(MAX_LINES),
      lines: z.array(cms1500LineInput.extend({ decision: cms1500Decision })).max(MAX_LINES),
    })).min(1).max(MAX_GROUPS),
  }),
  z.object({
    kind: z.literal("eob"),
    document: documentInput,
    contextPatientId: z.string().uuid().nullable().optional(),
    contextAuthPeriod: z.number().int().min(1).max(1000).nullable().optional(),
    groups: z.array(z.object({
      ...groupBase,
      patientConfirmed: z.boolean().optional(),
      allLineKeys: z.array(key).max(MAX_LINES),
      lines: z.array(eobLineInput.extend({ decision: eobDecision })).max(MAX_LINES),
    })).min(1).max(MAX_GROUPS),
  }),
]);

export type ImportPreviewInput = z.infer<typeof importPreviewInput>;
export type ImportCommitInput = z.infer<typeof importCommitInput>;
type Cms1500PreviewGroup = Extract<ImportPreviewInput, { kind: "cms1500" }>["groups"][number];
type EobPreviewGroup = Extract<ImportPreviewInput, { kind: "eob" }>["groups"][number];
type Cms1500CommitGroup = Extract<ImportCommitInput, { kind: "cms1500" }>["groups"][number];
type EobCommitGroup = Extract<ImportCommitInput, { kind: "eob" }>["groups"][number];

/**
 * P4-P26: per-line facts a CSV row states, keyed by sourceLineKey. Built only
 * by the server from the parsed file (server/claimCsvImport.ts) — never part
 * of a client request. filePeriods: the CMS1500 row's auth_period.
 * eobTargets: the reimbursement row's CMS1500 reference / period; when a line
 * has one, commit re-classifies it and only accepts a target the
 * classification allows.
 */
export interface ClaimImportHints {
  filePeriods?: Record<string, number>;
  eobTargets?: Record<string, EobCsvTarget>;
  /** Preloaded patient roster (one load for a CSV with many claims). */
  roster?: Array<{ id: string; name: string }>;
  /** One id for a whole CSV save click across its claims. */
  importBatchId?: string;
  /** P4-P28: preloaded external-id mappings. Mutated with mappings this save adds, like roster. */
  externalIds?: PatientExternalIdRow[];
  /** P4-P28: the file's own group-level identity evidence for CSV claims; never from a client request. */
  fileIdentity?: ImportPatientIdentity | null;
  /** P4-P28: invoice export. A line key alone does not prove the same service, so a disagreement with what is saved is reviewed, not written. */
  strictLineIdentity?: boolean;
}

function linePeriod(visits: Array<{ authPeriod: number; dateOfService: string | null }>, key: string, dateOfService: string | null, hints: ClaimImportHints): PeriodResolution {
  const fp = hints.filePeriods?.[key];
  return fp != null ? resolveAuthPeriodWithFilePeriod(visits, dateOfService, fp) : resolveAuthPeriod(visits, dateOfService);
}

function classifyEob(line: Parameters<typeof classifyEobLine>[0]["line"], documentId: string | null, existing: ExistingClaimLine[], hints: ClaimImportHints): EobLineClassification {
  const target = hints.eobTargets?.[line.sourceLineKey];
  return target ? classifyEobLineForTarget({ line, documentId, existing, target }) : classifyEobLine({ line, documentId, existing });
}

// ─── Patient decision ───────────────────────────────────────────────────────

export type GroupPatientStatus = "matched" | "candidates" | "unreadable" | "unmatched" | "other_patient";

/** P4-P28: what the review screen shows for a group's patient. */
export type PatientIdentityStatus = "existing" | "new" | "needs_confirmation";

export interface GroupPatientResolution {
  status: GroupPatientStatus;
  /** The patient the group will be saved to, or null until a reviewer chooses. */
  patientId: string | null;
  patientName: string | null;
  candidates: Array<{ id: string; name: string }>;
  /** Patient ids a reviewer may choose for this group. */
  allowedIds: string[];
  /** True when the reviewer must explicitly confirm the choice before saving. */
  requiresConfirmation: boolean;
  /** P4-P28 (bulk uploads): null only for a group naming someone else in single-patient mode. */
  identityStatus?: PatientIdentityStatus | null;
  /** P4-P28: why a person must confirm, in reviewer language. */
  identityReasons?: string[];
  /** P4-P28: a new patient may be created for this group. */
  canCreate?: boolean;
  /** P4-P28: this group will create a patient with this name when saved. */
  creatingName?: string | null;
  /** P4-P28: the mapping a created patient gets. Null when the file's id must not be trusted. */
  creatingIdentity?: { sourceSystem: string; externalId: string | null; birthDate: string | null } | null;
  /** P4-P28: the mapping to persist when this group is saved to patientId. */
  linkExternalId?: { sourceSystem: string; externalId: string; birthDate: string | null } | null;
  /** P4-P28: groups with the same key are one person; a review choice applies to all of them. */
  clusterKey?: string;
  /** P4-P28: the file's birth date, recorded on save when this patient has none on record yet. */
  fileBirthDate?: string | null;
}

/**
 * Who a group belongs to. Never guessed:
 *   - a safe name match resolves on its own;
 *   - a near match (middle name, duplicate record) or an unreadable name
 *     needs an explicit reviewer choice from an allowed set;
 *   - in single-patient mode only the open patient is allowed, and a group
 *     that names someone else is reported, not imported.
 * Patients carry no date of birth or member ID in this app, so matching is
 * by name only (documented limitation).
 */
export function resolveGroupPatient(params: {
  patientName: string | null;
  requestedPatientId: string | null | undefined;
  contextPatient: { id: string; name: string } | null;
  allPatients: Array<{ id: string; name: string }>;
}): GroupPatientResolution {
  const { patientName, requestedPatientId, contextPatient, allPatients } = params;
  const pick = (allowed: string[]) => (requestedPatientId && allowed.includes(requestedPatientId) ? requestedPatientId : null);
  const nameOf = (id: string | null) => (id ? allPatients.find(p => p.id === id)?.name ?? contextPatient?.name ?? null : null);

  if (contextPatient) {
    const allowed = [contextPatient.id];
    if (!patientName) {
      const id = pick(allowed);
      return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [contextPatient], allowedIds: allowed, requiresConfirmation: true };
    }
    if (fuzzyNameMatch(patientName, contextPatient.name)) {
      return { status: "matched", patientId: contextPatient.id, patientName: contextPatient.name, candidates: [], allowedIds: allowed, requiresConfirmation: false };
    }
    const { candidates } = classifyPatientMatch(patientName, [contextPatient]);
    if (candidates.length > 0) {
      const id = pick(allowed);
      return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [contextPatient], allowedIds: allowed, requiresConfirmation: true };
    }
    return { status: "other_patient", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false };
  }

  if (!patientName) {
    const allowed = allPatients.map(p => p.id);
    const id = pick(allowed);
    return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [], allowedIds: allowed, requiresConfirmation: true };
  }
  const { confirmed, candidates } = classifyPatientMatch(patientName, allPatients);
  if (confirmed) {
    return { status: "matched", patientId: confirmed.id, patientName: confirmed.name, candidates: [], allowedIds: [confirmed.id], requiresConfirmation: false };
  }
  if (candidates.length > 0) {
    const allowed = candidates.map(c => c.id);
    const id = pick(allowed);
    return {
      status: "candidates", patientId: id, patientName: nameOf(id),
      candidates: candidates.map(c => ({ id: c.id, name: c.name })), allowedIds: allowed, requiresConfirmation: true,
    };
  }
  return { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false };
}

/** Token-set key for a name, so a file's groups for one person share a review choice. */
function nameClusterKey(name: string | null): string {
  return (name ?? "").toUpperCase().replace(/['’]/g, "").split(/[^A-Z0-9]+/).filter(Boolean).sort().join(" ");
}

/**
 * P4-P28: who a bulk import's group belongs to. Never decided by name alone
 * when anything is ambiguous. In order:
 *   1. A stated external id that is already mapped decides (a "patient"
 *      strength id alone; an "account" id only when the name agrees, and is
 *      otherwise ignored because the form may reuse that number). A different
 *      birth date or name on a mapped "patient" id is a question for a person.
 *   2. Otherwise the name is matched against the roster. A unique match is
 *      existing when nothing contradicts it, but the first link of a stable
 *      external id to a patient is a person's decision, because later imports
 *      will trust it without asking. Duplicate names, a different id already on
 *      that patient, a conflicting birth date, or an unreadable name all wait
 *      for confirmation.
 *   3. No match at all: a new patient, created only on a confirmed save.
 *
 * Birth dates: patients has no date of birth, so the only thing a file's birth
 * date can be compared with is the one an earlier import left on
 * patient_external_ids. The first one for a patient is the baseline, and it is
 * never replaced. Where it comes from decides how far it is trusted:
 *   - a linked "patient" id that also agrees on the name: accepted and recorded;
 *   - a name match alone (or a form account number): a person confirms it once,
 *     because nothing else says this file's birth date is this patient's.
 * With a baseline, a different birth date is always a question for a person.
 * Without any birth date in the file, there is nothing to check and no baseline
 * is created. This cannot catch a wrong person until the first file with a
 * birth date has been confirmed.
 */
export function resolveImportPatient(params: Parameters<typeof resolvePatientFromEvidence>[0]): GroupPatientResolution {
  return { ...resolvePatientFromEvidence(params), fileBirthDate: params.identity?.birthDate ?? null };
}

function resolvePatientFromEvidence(params: {
  patientName: string | null;
  identity: ImportPatientIdentity | null | undefined;
  requestedPatientId: string | null | undefined;
  createRequest: { name: string; distinctConfirmed?: boolean } | null | undefined;
  allPatients: Array<{ id: string; name: string }>;
  externalIds: PatientExternalIdRow[];
}): GroupPatientResolution {
  const { patientName, requestedPatientId, createRequest, allPatients, externalIds } = params;
  let identity = params.identity ?? null;
  const pick = (allowed: string[]) => (requestedPatientId && allowed.includes(requestedPatientId) ? requestedPatientId : null);
  const nameOf = (id: string | null) => (id ? allPatients.find(p => p.id === id)?.name ?? null : null);
  const reasons: string[] = identity?.conflict ? [identity.conflict] : [];
  const birthConflict = (patientId: string) =>
    !!identity?.birthDate && externalIds.some(e => e.patientId === patientId && e.birthDate && e.birthDate !== identity!.birthDate);
  const BIRTH_REASON = "The birth date in this file differs from the one recorded for this patient by an earlier import.";
  const noBirthBaseline = (patient: { id: string; name: string }) =>
    !!identity?.birthDate && !externalIds.some(e => e.patientId === patient.id && e.birthDate);
  const noBaselineReason = (patient: { name: string }) =>
    `${patient.name} has no birth date on record yet. Confirm that ${identity!.birthDate} is this patient's; later imports are checked against it.`;

  const mapped = identity?.externalId
    ? externalIds.find(e => e.sourceSystem === identity!.sourceSystem && e.externalId === identity!.externalId)
    : undefined;
  const mappedPatient = mapped ? allPatients.find(p => p.id === mapped.patientId) : undefined;
  if (mapped && mappedPatient && identity!.strength === "account" && patientName && !fuzzyNameMatch(patientName, mappedPatient.name)) {
    // A reused form account number says nothing about this person.
    identity = { ...identity!, externalId: null };
  } else if (mappedPatient) {
    const clusterKey = `id:${identity!.sourceSystem}:${identity!.externalId}`;
    if (birthConflict(mappedPatient.id)) reasons.push(BIRTH_REASON);
    else if (identity!.strength === "account" && noBirthBaseline(mappedPatient)) reasons.push(noBaselineReason(mappedPatient));
    if (patientName && !fuzzyNameMatch(patientName, mappedPatient.name)) reasons.push(`This file's patient ID belongs to ${mappedPatient.name}, but the file says ${patientName}.`);
    if (reasons.length === 0) {
      return { status: "matched", patientId: mappedPatient.id, patientName: mappedPatient.name, candidates: [], allowedIds: [mappedPatient.id], requiresConfirmation: false, identityStatus: "existing", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: null, clusterKey };
    }
    const id = pick([mappedPatient.id]);
    return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [{ id: mappedPatient.id, name: mappedPatient.name }], allowedIds: [mappedPatient.id], requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: reasons, canCreate: false, creatingName: null, linkExternalId: null, clusterKey };
  }

  const clusterKey = identity?.externalId ? `id:${identity.sourceSystem}:${identity.externalId}` : `name:${nameClusterKey(patientName)}`;
  const link = (patientId: string | null) =>
    patientId && identity?.externalId ? { sourceSystem: identity.sourceSystem, externalId: identity.externalId, birthDate: identity.birthDate } : null;
  const creatingIdentity = identity ? { sourceSystem: identity.sourceSystem, externalId: identity.externalId, birthDate: identity.birthDate } : null;
  const creating = (status: GroupPatientStatus): GroupPatientResolution | null => {
    if (!createRequest) return null;
    return { status, patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false, identityStatus: "new", identityReasons: [], canCreate: true, creatingName: createRequest.name, creatingIdentity, linkExternalId: null, clusterKey };
  };

  if (!patientName) {
    const allowed = allPatients.map(p => p.id);
    const id = pick(allowed);
    if (!id) { const c = creating("unreadable"); if (c) return c; }
    if (id && birthConflict(id)) reasons.push(BIRTH_REASON);
    return { status: "unreadable", patientId: id, patientName: nameOf(id), candidates: [], allowedIds: allowed, requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: [...reasons, "The patient's name could not be read from the file."], canCreate: true, creatingName: null, linkExternalId: link(id), clusterKey };
  }

  const classified = classifyPatientMatch(patientName, allPatients);
  // An exact spelling is not evidence between "DOE, JANE" and "JANE DOE": same tokens, two records, so ambiguous.
  const sameTokens = allPatients.filter(p => nameClusterKey(p.name) === nameClusterKey(patientName));
  const confirmed = sameTokens.length > 1 ? null : classified.confirmed;
  const candidates = sameTokens.length > 1 ? sameTokens : classified.candidates;
  if (confirmed) {
    const strongId = identity?.strength === "patient" && identity.externalId;
    if (birthConflict(confirmed.id)) reasons.push(BIRTH_REASON);
    else if (!strongId && noBirthBaseline(confirmed)) reasons.push(noBaselineReason(confirmed));
    if (strongId) {
      const other = externalIds.find(e => e.patientId === confirmed.id && e.sourceSystem === identity!.sourceSystem);
      reasons.push(other
        ? `${confirmed.name} already has a different patient ID from this system, so this may be a different person with the same name.`
        : `${confirmed.name} is matched by name only. Confirm this is the same person; later imports with this patient ID then match automatically.`);
    }
    if (reasons.length === 0) {
      return { status: "matched", patientId: confirmed.id, patientName: confirmed.name, candidates: [], allowedIds: [confirmed.id], requiresConfirmation: false, identityStatus: "existing", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: link(confirmed.id), clusterKey };
    }
    if (createRequest?.distinctConfirmed) { const c = creating("candidates"); if (c) return c; }
    const id = pick([confirmed.id]);
    return { status: "candidates", patientId: id, patientName: nameOf(id), candidates: [{ id: confirmed.id, name: confirmed.name }], allowedIds: [confirmed.id], requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: reasons, canCreate: true, creatingName: null, linkExternalId: link(id), clusterKey };
  }
  if (candidates.length > 0) {
    if (createRequest?.distinctConfirmed) { const c = creating("candidates"); if (c) return c; }
    const differing = candidates.filter(c => birthConflict(c.id));
    if (differing.length > 0) reasons.push(`The birth date in this file differs from the one recorded for ${differing.map(c => c.name).join(", ")}.`);
    const allowed = candidates.map(c => c.id);
    const id = pick(allowed);
    return {
      status: "candidates", patientId: id, patientName: nameOf(id),
      candidates: candidates.map(c => ({ id: c.id, name: c.name })), allowedIds: allowed, requiresConfirmation: true,
      identityStatus: "needs_confirmation",
      identityReasons: [...reasons, candidates.length > 1 ? "More than one patient has a matching name." : "A patient with a similar name exists."],
      canCreate: true, creatingName: null, linkExternalId: link(id), clusterKey,
    };
  }
  if (reasons.length > 0 && !createRequest?.distinctConfirmed) {
    return { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: true, identityStatus: "needs_confirmation", identityReasons: reasons, canCreate: true, creatingName: null, linkExternalId: null, clusterKey };
  }
  return creating("unmatched") ?? { status: "unmatched", patientId: null, patientName: null, candidates: [], allowedIds: [], requiresConfirmation: false, identityStatus: "new", identityReasons: [], canCreate: true, creatingName: patientName, creatingIdentity, linkExternalId: null, clusterKey };
}

// ─── Preview ────────────────────────────────────────────────────────────────

export type PreviewLine =
  | ({ sourceLineKey: string; kind: "cms1500" } & Cms1500LineClassification)
  | ({ sourceLineKey: string; kind: "eob" } & EobLineClassification)
  | { sourceLineKey: string; kind: "cms1500" | "eob"; status: "patient_required"; candidates: []; reason: string };

export interface PreviewGroup {
  groupKey: string;
  patient: GroupPatientResolution;
  lines: PreviewLine[];
  /** The patient's known authorization periods (for the period selector). */
  periodOptions: number[];
}

async function loadPatients(contextPatientId: string | null | undefined, roster?: Array<{ id: string; name: string }>) {
  const allPatients = roster ?? (await getAllPatients()).map(p => ({ id: p.id, name: p.name }));
  const contextPatient = contextPatientId ? allPatients.find(p => p.id === contextPatientId) ?? null : null;
  if (contextPatientId && !contextPatient) throw new ClaimImportRuleError("not_found", "The selected patient no longer exists.");
  return { allPatients, contextPatient };
}

/** One group's patient: the open patient in single-patient mode, the identity rules otherwise. */
function patientFor(group: { patientName: string | null; patientId?: string | null; patientIdentity?: ImportPatientIdentity | null; createPatient?: { name: string; distinctConfirmed?: boolean } | null }, contextPatient: { id: string; name: string } | null, allPatients: Array<{ id: string; name: string }>, hints: ClaimImportHints, externalIds: PatientExternalIdRow[]): GroupPatientResolution {
  if (contextPatient) {
    const base = resolveGroupPatient({ patientName: group.patientName, requestedPatientId: group.patientId, contextPatient, allPatients });
    return { ...base, identityStatus: base.status === "matched" ? "existing" : base.status === "other_patient" ? null : "needs_confirmation", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: null, clusterKey: `name:${nameClusterKey(group.patientName)}` };
  }
  return resolveImportPatient({
    patientName: group.patientName,
    identity: hints.fileIdentity ?? group.patientIdentity,
    requestedPatientId: group.patientId,
    createRequest: group.createPatient,
    allPatients,
    externalIds,
  });
}

export async function previewClaimImport(input: ImportPreviewInput, hints: ClaimImportHints = {}): Promise<{ documentId: string | null; groups: PreviewGroup[] }> {
  const { allPatients, contextPatient } = await loadPatients(input.contextPatientId, hints.roster);
  const documentId = await findClaimImportDocumentId(input.kind, input.document.sha256);
  const externalIds = contextPatient ? [] : hints.externalIds ?? await listPatientExternalIds();
  const heldKeys = input.kind === "eob" && documentId ? new Set(await listHeldEobLineKeys(documentId)) : new Set<string>();
  const savedInDocument = hints.strictLineIdentity && documentId ? await listClaimLinesForDocument(documentId) : [];

  const groups: PreviewGroup[] = [];
  for (const group of input.groups) {
    const patient = patientFor(group, contextPatient, allPatients, hints, externalIds);
    if (patient.creatingName) {
      // A patient that will be created has no saved lines and no visits: every
      // CMS1500 line asks for a period, and every EOB line waits for its CMS1500.
      let lines: PreviewLine[];
      if (input.kind === "cms1500") {
        const g = group as Cms1500PreviewGroup;
        const siblings = g.lines.map(l => l.sourceLineKey);
        lines = g.lines.map(l => {
          const c = classifyCms1500Line({ line: l, documentId, siblingLineKeys: siblings, existing: [], period: linePeriod([], l.sourceLineKey, l.dateOfService, hints) });
          return { sourceLineKey: l.sourceLineKey, kind: "cms1500" as const, ...(hints.strictLineIdentity ? classifyExportLine({ classification: c, line: l, patientId: null, siblingLineKeys: siblings, savedInDocument }) : c) };
        });
      } else {
        lines = (group as EobPreviewGroup).lines.map(l => ({ sourceLineKey: l.sourceLineKey, kind: "eob" as const, ...classifyEob(l, documentId, [], hints) }));
      }
      groups.push({ groupKey: group.groupKey, patient, lines, periodOptions: periodOptionsFor([]) });
      continue;
    }
    if (!patient.patientId) {
      groups.push({
        groupKey: group.groupKey,
        patient,
        periodOptions: [],
        lines: group.lines.map(l => ({
          sourceLineKey: l.sourceLineKey, kind: input.kind, status: "patient_required" as const, candidates: [] as [],
          reason: patient.status === "other_patient"
            ? "This part of the file names a different patient. Upload it from that patient's page or with the bulk upload."
            : patient.status === "unmatched"
              ? "No dashboard patient matches this name."
              : "Confirm which patient this belongs to.",
        })),
      });
      continue;
    }

    const existing = await listPatientClaimLinesOnDates(patient.patientId, group.lines.map(l => l.dateOfService ?? ""));
    let periodOptions: number[] = [];
    let lines: PreviewLine[];
    if (input.kind === "cms1500") {
      const visits = await listPatientVisitPeriodDates(patient.patientId);
      periodOptions = periodOptionsFor(visits);
      const g = group as Cms1500PreviewGroup;
      const siblings = g.lines.map(l => l.sourceLineKey);
      lines = g.lines.map(l => {
        const c = classifyCms1500Line({ line: l, documentId, siblingLineKeys: siblings, existing, period: linePeriod(visits, l.sourceLineKey, l.dateOfService, hints) });
        return {
          sourceLineKey: l.sourceLineKey,
          kind: "cms1500" as const,
          ...(hints.strictLineIdentity ? classifyExportLine({ classification: c, line: l, patientId: patient.patientId, siblingLineKeys: siblings, savedInDocument }) : c),
        };
      });
    } else {
      const dismissed = await listDismissedEobLines(patient.patientId);
      lines = (group as EobPreviewGroup).lines.map(l => {
        const c = classifyEob(l, documentId, existing, hints);
        const dismissedLine = c.status !== "already_saved" && findDismissedEobLine(l, documentId, dismissed);
        return {
          sourceLineKey: l.sourceLineKey, kind: "eob" as const, ...c,
          // Saved as pending by an earlier upload of this file and still waiting.
          ...(c.status === "cms1500_required" && heldKeys.has(l.sourceLineKey) ? { held: true } : {}),
          ...(dismissedLine ? { dismissed: true, reason: c.reason ? `${EOB_LINE_DISMISSED} ${c.reason}` : EOB_LINE_DISMISSED } : {}),
        };
      });
    }
    groups.push({ groupKey: group.groupKey, patient, lines, periodOptions });
  }
  return { documentId, groups };
}

function periodOptionsFor(visits: Array<{ authPeriod: number }>): number[] {
  const set = Array.from(new Set(visits.map(v => v.authPeriod))).sort((a, b) => a - b);
  return set.length > 0 ? set : [1];
}

// ─── Commit ────────────────────────────────────────────────────────────────

export type CommitLineStatus = "saved" | "unchanged" | "skipped" | "held" | "review_required" | "failed";

export interface CommitLineResult {
  sourceLineKey: string;
  status: CommitLineStatus;
  outcome?: "created" | "associated" | "updated" | "saved";
  claimId?: string;
  authPeriod?: number;
  reason?: string;
  message?: string;
}

export interface CommitGroupResult {
  groupKey: string;
  patientId: string | null;
  /** P4-P28: created = this save created the patient. */
  patientOutcome?: "created" | "existing" | null;
  lines: CommitLineResult[];
}

const REVIEW_MESSAGES: Record<string, string> = {
  needs_selection: "An existing claim line already sits on this date and CPT. Choose to associate with it or save as a separate line.",
  cms1500_required: UPLOAD_CMS1500_FIRST,
  already_reconciled: "This claim line already has a payment from another EOB line. Confirm replacing it.",
  source_line_already_saved: "This source line is already saved to a different claim line.",
  already_has_cms1500: "That claim line already has a CMS1500 line associated.",
  incompatible: "The chosen claim line has a different date of service or CPT.",
  existing_financials: "The chosen claim line already has different amounts. Confirm replacing them.",
  patient_mismatch: "The chosen claim line belongs to a different patient.",
  not_found: "The chosen claim line no longer exists.",
  invalid_input: "This line is missing required values.",
  period_required: "Choose the authorization period for this date of service.",
  patient_changed: "A patient with this name was added after this review opened. Check the patient and save again.",
  external_id_taken: "This file's patient ID is already linked to a different patient. Check the patient and save again.",
  pending_not_needed: "This line no longer needs to wait: a saved claim line already carries it.",
  line_dismissed: EOB_LINE_DISMISSED,
};

function reviewResult(sourceLineKey: string, reason: string, message?: string): CommitLineResult {
  return { sourceLineKey, status: "review_required", reason, message: message ?? REVIEW_MESSAGES[reason] ?? reason };
}

async function writeLine(sourceLineKey: string, write: () => Promise<{ status: string; claimId: string; authPeriod: number }>): Promise<CommitLineResult> {
  try {
    const r = await write();
    if (r.status === "unchanged") return { sourceLineKey, status: "unchanged", claimId: r.claimId, authPeriod: r.authPeriod };
    return { sourceLineKey, status: "saved", outcome: r.status as CommitLineResult["outcome"], claimId: r.claimId, authPeriod: r.authPeriod };
  } catch (err) {
    if (err instanceof ClaimImportRuleError) return reviewResult(sourceLineKey, err.reason);
    console.error("[ClaimImport] line write failed:", err);
    return { sourceLineKey, status: "failed", reason: "error", message: "Could not save this line. Nothing was changed for it — retry." };
  }
}

/** Which period a new CMS1500 line goes to, or why it can't be decided. */
export function decideAuthPeriod(params: {
  resolution: PeriodResolution;
  allowedPeriods: number[];
  requested: number | null | undefined;
  source: "resolved" | "selected" | "context" | null | undefined;
}): { ok: true; authPeriod: number } | { ok: false; reason: "period_required" | "period_mismatch" } {
  const { resolution, allowedPeriods, requested, source } = params;
  if (resolution.status === "resolved") {
    if (requested == null || requested === resolution.authPeriod) return { ok: true, authPeriod: resolution.authPeriod };
    if (source === "selected" && allowedPeriods.includes(requested)) return { ok: true, authPeriod: requested };
    return { ok: false, reason: "period_mismatch" };
  }
  if (requested != null && (source === "selected" || source === "context") && allowedPeriods.includes(requested)) {
    return { ok: true, authPeriod: requested };
  }
  return { ok: false, reason: "period_required" };
}

function holdPayload(line: z.infer<typeof eobLineInput>) {
  return {
    match: { date_of_service: line.dateOfService, cpt_codes: line.cptCodes, modifier: line.modifier, units_billed: line.unitsBilled },
    data: eobFinancials(line),
  };
}

function eobFinancials(line: z.infer<typeof eobLineInput>) {
  return {
    charge_amount: line.chargeAmount,
    insurance_reimbursement: line.insuranceReimbursement,
    payment_received: line.insuranceReimbursement,
    patient_amount_due: line.patientAmountDue,
    patient_amount_paid: line.patientAmountPaid,
    claim_status: line.claimStatus,
    oa_claim_number: line.oaClaimNumber,
    check_date: line.checkDate,
    check_number_virtual_card: line.checkNumberVirtualCard,
  };
}

/** The file row's CMS1500 reference, kept so the pending line can be re-pinned to that exact row later. */
function holdTarget(sourceLineKey: string, hints: ClaimImportHints): Record<string, unknown> | null {
  const t = hints.eobTargets?.[sourceLineKey];
  if (!t) return null;
  return { cms1500_sha256: t.cms1500Ref?.sha256 ?? null, line_key: t.cms1500Ref?.lineKey ?? null, label: t.cms1500Ref?.label ?? null, auth_period: t.authPeriod ?? null };
}

/**
 * P4-P28: a group whose patient does not exist yet. Every reviewed line goes
 * into one transaction with the new patient, so nothing else can be left half
 * done. Returns a patient id instead when someone else got there first (same
 * external id, or a retry of this same group): the caller then saves normally
 * against that patient. A line that is not ready is reported and left out, and
 * with no ready line at all no patient is created.
 */
async function commitNewPatientGroup(params: {
  input: ImportCommitInput;
  group: Cms1500CommitGroup | EobCommitGroup;
  patient: GroupPatientResolution;
  actor: ActorContext;
  importBatchId: string;
  source: { sha256: string; fileName: string | null; pageCount: number | null };
  hints: ClaimImportHints;
  allPatients: Array<{ id: string; name: string }>;
  externalIds: PatientExternalIdRow[];
}): Promise<{ result: CommitGroupResult } | { existingPatientId: string }> {
  const { input, group, patient, actor, importBatchId, source, hints, allPatients, externalIds } = params;
  const identity = patient.creatingIdentity ?? null;
  const results: CommitLineResult[] = [];
  const rpcLines: Array<Record<string, unknown>> = [];

  if (input.kind === "cms1500") {
    const g = group as Cms1500CommitGroup;
    // A saved row of a patient this request's roster has not seen is a concurrent
    // import of this same group: the RPC below converges on that patient.
    const documentId = hints.strictLineIdentity ? await findClaimImportDocumentId("cms1500", input.document.sha256) : null;
    const foreign = documentId ? (await listClaimLinesForDocument(documentId)).filter(r => allPatients.some(p => p.id === r.patientId)) : [];
    for (const line of g.lines) {
      const d = line.decision;
      if (d.action === "skip") { results.push({ sourceLineKey: line.sourceLineKey, status: "skipped" }); continue; }
      const problem = exportLineIdentityProblem({ line, patientId: null, siblingLineKeys: g.allLineKeys, savedInDocument: foreign });
      if (problem) { results.push(reviewResult(line.sourceLineKey, "line_identity_review", problem)); continue; }
      if (!line.dateOfService || !line.cptCodes) { results.push(reviewResult(line.sourceLineKey, "invalid_input")); continue; }
      if (line.unreadable.length > 0 && !d.acknowledgeFlags) {
        results.push(reviewResult(line.sourceLineKey, "flags_unacknowledged", "This line has unreadable values left blank. Review and acknowledge them before saving."));
        continue;
      }
      const decided = decideAuthPeriod({ resolution: linePeriod([], line.sourceLineKey, line.dateOfService, hints), allowedPeriods: periodOptionsFor([]), requested: d.authPeriod, source: d.periodSource });
      if (!decided.ok) {
        results.push(reviewResult(line.sourceLineKey, "period_required", "A new patient has no authorization periods yet. Choose the period for this line."));
        continue;
      }
      rpcLines.push({
        line_key: line.sourceLineKey,
        auth_period: decided.authPeriod,
        data: {
          date_of_service: line.dateOfService, cpt_codes: line.cptCodes, place_of_service: line.placeOfService,
          modifier: line.modifier, units_billed: line.unitsBilled, diagnosis_codes: line.diagnosisCodes,
          claim_submitted_date: line.claimSubmittedDate, insurance_billed: line.insuranceBilled, visit_number: line.visitNumber ?? null,
        },
      });
    }
  } else {
    const g = group as EobCommitGroup;
    for (const line of g.lines) {
      const d = line.decision;
      if (d.action === "skip") { results.push({ sourceLineKey: line.sourceLineKey, status: "skipped" }); continue; }
      if (!line.dateOfService || !line.cptCodes) { results.push(reviewResult(line.sourceLineKey, "invalid_input")); continue; }
      if (d.action !== "hold") { results.push(reviewResult(line.sourceLineKey, "cms1500_required")); continue; }
      rpcLines.push({ line_key: line.sourceLineKey, ...holdPayload(line), target: holdTarget(line.sourceLineKey, hints) });
    }
  }

  if (rpcLines.length === 0) {
    return { result: { groupKey: group.groupKey, patientId: null, patientOutcome: null, lines: results } };
  }

  const siblings = Array.from(new Set([...group.allLineKeys, ...rpcLines.map(l => String(l.line_key))]));
  let created;
  try {
    created = await commitImportWithNewPatient({
      kind: input.kind,
      patientName: patient.creatingName!,
      sourceSystem: identity?.externalId ? identity.sourceSystem : null,
      externalId: identity?.externalId ?? null,
      birthDate: identity?.birthDate ?? null,
      creationKey: `${input.kind}:${input.document.sha256}:${group.groupKey}`,
      allowSameName: group.createPatient?.distinctConfirmed === true,
      source,
      siblingLineKeys: siblings,
      lines: rpcLines,
      actor,
      importBatchId,
    });
  } catch (err) {
    const message = err instanceof ClaimImportRuleError ? null : "Could not save. Nothing was created for this patient; retry.";
    if (!(err instanceof ClaimImportRuleError)) console.error("[ClaimImport] new patient commit failed:", err);
    return {
      result: {
        groupKey: group.groupKey, patientId: null, patientOutcome: null,
        lines: [...results, ...rpcLines.map((l): CommitLineResult => err instanceof ClaimImportRuleError
          ? reviewResult(String(l.line_key), err.reason)
          : { sourceLineKey: String(l.line_key), status: "failed", reason: "error", message: message! })],
      },
    };
  }
  if (created.status === "patient_exists") return { existingPatientId: created.patientId };

  // Later groups in this request must see this patient and mapping.
  if (!allPatients.some(p => p.id === created.patientId)) allPatients.push({ id: created.patientId, name: patient.creatingName! });
  if (identity?.externalId) externalIds.push({ patientId: created.patientId, sourceSystem: identity.sourceSystem, externalId: identity.externalId, birthDate: identity.birthDate });
  return {
    result: {
      groupKey: group.groupKey, patientId: created.patientId, patientOutcome: "created",
      lines: [...results, ...created.lines.map((l): CommitLineResult => input.kind === "cms1500"
        ? { sourceLineKey: l.lineKey, status: l.status === "unchanged" ? "unchanged" : "saved", outcome: "created", claimId: l.claimId ?? undefined, authPeriod: l.authPeriod ?? undefined }
        : { sourceLineKey: l.lineKey, status: "held", message: UPLOAD_CMS1500_FIRST })],
    },
  };
}

export async function commitClaimImport(input: ImportCommitInput, actor: ActorContext, hints: ClaimImportHints = {}): Promise<{ importBatchId: string; groups: CommitGroupResult[] }> {
  const { allPatients, contextPatient } = await loadPatients(input.contextPatientId, hints.roster);
  const externalIds = contextPatient ? [] : hints.externalIds ?? await listPatientExternalIds();
  // One id for this save click: every audit row it writes is linked by it,
  // and every row carries the source document id in its provenance columns.
  const importBatchId = hints.importBatchId ?? randomUUID();
  const source = { sha256: input.document.sha256, fileName: input.document.fileName, pageCount: input.document.pageCount };
  const results: CommitGroupResult[] = [];

  for (const group of input.groups) {
    let patient = patientFor(group, contextPatient, allPatients, hints, externalIds);
    let patientOutcome: "created" | "existing" = "existing";

    // P4-P28: only a request that asks for it can create a patient.
    if (patient.creatingName && group.createPatient) {
      const outcome = await commitNewPatientGroup({ input, group, patient, actor, importBatchId, source, hints, allPatients, externalIds });
      if ("result" in outcome) { results.push(outcome.result); continue; }
      // Another import (or a retry of this one) created this person first.
      if (!allPatients.some(p => p.id === outcome.existingPatientId)) {
        const fresh = await getAllPatients();
        allPatients.splice(0, allPatients.length, ...fresh.map(p => ({ id: p.id, name: p.name })));
      }
      const name = allPatients.find(p => p.id === outcome.existingPatientId)?.name ?? null;
      patient = { status: "matched", patientId: outcome.existingPatientId, patientName: name, candidates: [], allowedIds: [outcome.existingPatientId], requiresConfirmation: false, identityStatus: "existing", identityReasons: [], canCreate: false, creatingName: null, linkExternalId: null, clusterKey: patient.clusterKey };
    }

    const confirmed = patient.patientId && (!patient.requiresConfirmation || group.patientConfirmed === true);
    if (!confirmed) {
      results.push({
        groupKey: group.groupKey,
        patientId: null,
        patientOutcome: null,
        lines: group.lines.map(l => reviewResult(l.sourceLineKey, "patient_unconfirmed",
          patient.status === "other_patient" ? "This part of the file names a different patient." : patient.creatingName ? "Save this group again to create the new patient." : "Confirm which patient this belongs to before saving.")),
      });
      continue;
    }
    const patientId = patient.patientId!;
    const lineResults: CommitLineResult[] = [];

    // P4-P28: the reviewed link goes first: every line below then runs knowing
    // this id belongs to this patient. Only when at least one line will be written.
    if (group.lines.some(l => l.decision.action !== "skip")) {
      try {
        if (patient.linkExternalId) {
          await linkPatientExternalId({ patientId, ...patient.linkExternalId, actor, importBatchId });
          externalIds.push({ patientId, ...patient.linkExternalId });
        }
        // The patient's first birth date is the baseline later files are checked against.
        if (patient.fileBirthDate && !externalIds.some(e => e.patientId === patientId && e.birthDate)) {
          const evidence = { sourceSystem: BIRTH_EVIDENCE_SOURCE_SYSTEM, externalId: patientId, birthDate: patient.fileBirthDate };
          await linkPatientExternalId({ patientId, ...evidence, actor, importBatchId });
          externalIds.push({ patientId, ...evidence });
        }
      } catch (err) {
        results.push({
          groupKey: group.groupKey, patientId: null, patientOutcome: null,
          lines: group.lines.map((l): CommitLineResult => err instanceof ClaimImportRuleError
            ? reviewResult(l.sourceLineKey, err.reason)
            : { sourceLineKey: l.sourceLineKey, status: "failed", reason: "error", message: "Could not save this line. Nothing was changed for it — retry." }),
        });
        continue;
      }
    }

    if (input.kind === "cms1500") {
      const visits = await listPatientVisitPeriodDates(patientId);
      const allowedPeriods = periodOptionsFor(visits);
      const g = group as Cms1500CommitGroup;
      const siblings = Array.from(new Set([...g.allLineKeys, ...g.lines.map(l => l.sourceLineKey)]));
      let savedInDocument: SavedDocumentLine[] = [];
      if (hints.strictLineIdentity) {
        const documentId = await findClaimImportDocumentId("cms1500", input.document.sha256);
        if (documentId) savedInDocument = await listClaimLinesForDocument(documentId);
      }
      for (const line of g.lines) {
        const d = line.decision;
        if (d.action === "skip") { lineResults.push({ sourceLineKey: line.sourceLineKey, status: "skipped" }); continue; }
        if (hints.strictLineIdentity) {
          const problem = exportLineIdentityProblem({ line, patientId, siblingLineKeys: siblings, savedInDocument });
          if (problem) { lineResults.push(reviewResult(line.sourceLineKey, "line_identity_review", problem)); continue; }
          if (d.action === "create" && changedSavedLines(line, siblings, savedInDocument).length > 0) {
            lineResults.push(reviewResult(line.sourceLineKey, "needs_selection", "A saved line of this invoice with this CPT is no longer in the file, so this may be that line changed. Save this one only if it is a separate service line."));
            continue;
          }
        }
        if (!line.dateOfService || !line.cptCodes) { lineResults.push(reviewResult(line.sourceLineKey, "invalid_input")); continue; }
        if (line.unreadable.length > 0 && !d.acknowledgeFlags) {
          lineResults.push(reviewResult(line.sourceLineKey, "flags_unacknowledged", "This line has unreadable values left blank. Review and acknowledge them before saving."));
          continue;
        }
        if (d.action === "associate" && !d.claimRecordId) { lineResults.push(reviewResult(line.sourceLineKey, "needs_selection")); continue; }

        // Period for a NEW line only. With none decidable, null goes to the
        // RPC: re-applying an already-saved source line needs no period, and
        // a new insert without one is refused there (period_required).
        let authPeriod: number | null = null;
        if (d.action !== "associate") {
          const requested = d.authPeriod ?? (d.periodSource === "context" ? input.contextAuthPeriod ?? null : null);
          const resolution = linePeriod(visits, line.sourceLineKey, line.dateOfService, hints);
          if (requested == null) {
            authPeriod = resolution.status === "resolved" ? resolution.authPeriod : null;
          } else {
            const decided = decideAuthPeriod({ resolution, allowedPeriods, requested, source: d.periodSource });
            if (!decided.ok) {
              lineResults.push(reviewResult(line.sourceLineKey, decided.reason, decided.reason === "period_required"
                ? REVIEW_MESSAGES.period_required
                : "The chosen period does not match the period this date of service belongs to. Select it explicitly to override."));
              continue;
            }
            authPeriod = decided.authPeriod;
          }
        }

        lineResults.push(await writeLine(line.sourceLineKey, () => commitCms1500Line({
          patientId,
          authPeriod,
          source,
          lineKey: line.sourceLineKey,
          siblingLineKeys: siblings,
          targetClaimId: d.action === "associate" ? d.claimRecordId! : null,
          allowNewDistinct: d.action === "create_distinct",
          data: {
            date_of_service: line.dateOfService,
            cpt_codes: line.cptCodes,
            place_of_service: line.placeOfService,
            modifier: line.modifier,
            units_billed: line.unitsBilled,
            diagnosis_codes: line.diagnosisCodes,
            claim_submitted_date: line.claimSubmittedDate,
            insurance_billed: line.insuranceBilled,
            visit_number: line.visitNumber ?? null,
          },
          actor,
          importBatchId,
        })));
      }
    } else {
      const g = group as EobCommitGroup;
      // CSV rows (hinted) are re-classified here, so a client-chosen target
      // is only accepted when the server's own classification allows it.
      const hinted = g.lines.some(l => hints.eobTargets?.[l.sourceLineKey]);
      const holding = g.lines.some(l => l.decision.action === "hold");
      const existing = hinted || holding ? await listPatientClaimLinesOnDates(patientId, g.lines.map(l => l.dateOfService ?? "")) : [];
      const documentId = await findClaimImportDocumentId("eob", input.document.sha256);
      const dismissed = await listDismissedEobLines(patientId);
      /** The line this one repeats, when only an explicit reopen may bring it back. */
      const dismissedLineFor = (line: (typeof g.lines)[number]) => findDismissedEobLine(line, documentId, dismissed);
      const reopen = async (line: (typeof g.lines)[number]) => {
        const hit = dismissedLineFor(line);
        // A different document's line stays dismissed; this save is its own, reviewed, new line.
        if (hit && hit.documentId === documentId && hit.lineKey === line.sourceLineKey) await reopenDismissedEobLine(hit.id, actor, importBatchId);
      };
      for (const line of g.lines) {
        const d = line.decision;
        if (d.action === "skip") { lineResults.push({ sourceLineKey: line.sourceLineKey, status: "skipped" }); continue; }
        if (!line.dateOfService || !line.cptCodes) { lineResults.push(reviewResult(line.sourceLineKey, "invalid_input")); continue; }
        if (dismissedLineFor(line) && !d.reopenDismissed) { lineResults.push(reviewResult(line.sourceLineKey, "line_dismissed")); continue; }
        if (d.action === "hold") {
          // A line that can be applied now is not kept pending by a stale review.
          const c = classifyEob(line, documentId, existing, hints);
          if (c.status !== "cms1500_required") {
            lineResults.push(reviewResult(line.sourceLineKey, "cms1500_available", "A matching CMS1500 line now exists. Re-check this line and apply it."));
            continue;
          }
          try {
            await reopen(line);
            const held = await holdEobLine({ patientId, source, lineKey: line.sourceLineKey, ...holdPayload(line), target: holdTarget(line.sourceLineKey, hints), actor, importBatchId });
            lineResults.push({ sourceLineKey: line.sourceLineKey, status: "held", message: UPLOAD_CMS1500_FIRST, reason: held.status });
          } catch (err) {
            if (err instanceof ClaimImportRuleError) lineResults.push(reviewResult(line.sourceLineKey, err.reason));
            else {
              console.error("[ClaimImport] pending EOB line write failed:", err);
              lineResults.push({ sourceLineKey: line.sourceLineKey, status: "failed", reason: "error", message: "Could not keep this line pending. Nothing was changed for it — retry." });
            }
          }
          continue;
        }
        if (!d.claimRecordId) { lineResults.push(reviewResult(line.sourceLineKey, "cms1500_required")); continue; }
        if (hints.eobTargets?.[line.sourceLineKey]) {
          const c = classifyEob(line, documentId, existing, hints);
          if (!allowedEobTargets(c).includes(d.claimRecordId)) {
            lineResults.push(c.status === "cms1500_required" || c.status === "invalid"
              ? reviewResult(line.sourceLineKey, c.status === "invalid" ? "invalid_input" : "cms1500_required", c.reason)
              : reviewResult(line.sourceLineKey, "target_not_allowed", "The chosen claim line is not one this file row can be applied to. Re-check the file and choose again."));
            continue;
          }
        }
        lineResults.push(await writeLine(line.sourceLineKey, async () => {
          await reopen(line);
          return applyEobLine({
            patientId,
            source,
            lineKey: line.sourceLineKey,
            targetClaimId: d.claimRecordId!,
            match: { date_of_service: line.dateOfService!, cpt_codes: line.cptCodes! },
            confirmReplace: d.confirmReplace === true,
            data: eobFinancials(line),
            actor,
            importBatchId,
          });
        }));
      }
    }
    results.push({ groupKey: group.groupKey, patientId, patientOutcome, lines: lineResults });
  }
  return { importBatchId, groups: results };
}
