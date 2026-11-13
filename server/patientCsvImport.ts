/**
 * server/patientCsvImport.ts — P4-P29
 *
 * "Bulk Upload Patients" on Patient Records. Available to every signed-in
 * dashboard role that can add a patient by hand (Staff, Clinic Admin, Owner):
 * the router gates it with normalProtectedProcedure, the same gate as
 * patients.create. It reads and writes patient demographics and session
 * counts only — never money, claim status or any claims field — so it stays
 * separate from the CMS1500 / Insurance Reimbursement imports, which remain
 * behind claimsAccessProcedure.
 *
 * Preview has no writes. Commit re-parses the same file text and re-checks
 * every patient against the database, so nothing the client sends besides the
 * file and the reviewer's choices affects what is saved. Each new patient is
 * saved with its sessions and audit rows in one transaction
 * (import_patient_csv_group_with_audit), under the same lock and name rule as
 * the P4-P28 claims-import patient creation, so retries and concurrent imports
 * (of either kind) never create the same patient twice.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fuzzyNameMatch } from "@shared/nameMatch";
import { normalizeInsurerName, insurerMatchValues } from "@shared/insuranceCatalog";
import {
  PATIENT_CSV_MAX_BYTES,
  groupPatientRows,
  parsePatientCsv,
  patientNameKey,
  type PatientCsvFileError,
  type PatientCsvGroup,
} from "@shared/patientCsvImport";
import type { ActorContext } from "./actorIdentity";
import { commitPatientCsvGroup, getAllPatients, listInsurerCatalog, InsurerDeletedError } from "./db";

export const patientCsvPreviewInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  csvText: z.string().max(PATIENT_CSV_MAX_BYTES),
});

export const patientCsvCommitInput = patientCsvPreviewInput.extend({
  /** Patients the reviewer unticked in the review (group keys). */
  skipKeys: z.array(z.string().max(400)).max(2000).default([]),
  /** Possible duplicates the reviewer explicitly chose to add as new patients. */
  confirmKeys: z.array(z.string().max(400)).max(2000).default([]),
});

export interface PatientCsvPreview {
  fileName: string;
  fileError: PatientCsvFileError | null;
  ignoredColumns: string[];
  groups: PatientCsvGroup[];
  counts: { rows: number; new: number; existing: number; possibleDuplicate: number; invalid: number; sessions: number; duplicateLines: number };
}

async function review(fileName: string, csvText: string): Promise<PatientCsvPreview> {
  const parsed = parsePatientCsv(csvText);
  const empty = { rows: 0, new: 0, existing: 0, possibleDuplicate: 0, invalid: 0, sessions: 0, duplicateLines: 0 };
  if (parsed.fileError) return { fileName, fileError: parsed.fileError, ignoredColumns: [], groups: [], counts: empty };

  const groups = groupPatientRows(parsed.rows);
  const [patients, catalog] = await Promise.all([getAllPatients(), listInsurerCatalog()]);
  const byKey = new Map(patients.map(p => [patientNameKey(p.name), p.name]));

  for (const g of groups) {
    if (g.insurance) {
      const wanted = normalizeInsurerName(g.insurance);
      const entry = catalog.find(e => insurerMatchValues(e).some(v => normalizeInsurerName(v) === wanted));
      if (!entry) g.errors.push(`Insurance "${g.insurance}" is not in the insurance list. Leave it blank, or ask an admin to add it.`);
      else if (!entry.isActive) g.errors.push(`Insurance "${entry.name}" is deactivated. Choose an active insurance company or leave it blank.`);
      else g.insurance = entry.name;
    }
    if (g.errors.length > 0) {
      g.status = "invalid";
      continue;
    }
    const exact = byKey.get(g.key);
    if (exact) {
      g.status = "existing";
      g.matchedName = exact;
      continue;
    }
    const similar = patients.find(p => fuzzyNameMatch(g.name, p.name));
    if (similar) {
      g.status = "possible_duplicate";
      g.matchedName = similar.name;
    }
  }

  const counts = { ...empty, rows: parsed.rows.length };
  for (const g of groups) {
    if (g.status === "new") counts.new++;
    else if (g.status === "existing") counts.existing++;
    else if (g.status === "possible_duplicate") counts.possibleDuplicate++;
    else counts.invalid++;
    if (g.status === "new" || g.status === "possible_duplicate") counts.sessions += g.visits.length;
    counts.duplicateLines += g.duplicateLines.length;
  }
  return { fileName, fileError: null, ignoredColumns: parsed.ignoredColumns, groups, counts };
}

export function previewPatientCsvImport(input: z.infer<typeof patientCsvPreviewInput>): Promise<PatientCsvPreview> {
  return review(input.fileName, input.csvText);
}

export type PatientCsvSaveOutcome = "created" | "already_exists" | "skipped" | "invalid" | "failed";

export interface PatientCsvCommitResult {
  importBatchId: string;
  fileError: PatientCsvFileError | null;
  results: Array<{ key: string; name: string; lines: number[]; outcome: PatientCsvSaveOutcome; sessions: number; message: string | null }>;
  summary: { created: number; sessionsCreated: number; alreadyExists: number; skipped: number; invalid: number; failed: number };
}

export async function commitPatientCsvImport(
  input: z.infer<typeof patientCsvCommitInput>,
  actor: ActorContext
): Promise<PatientCsvCommitResult> {
  const importBatchId = randomUUID();
  const preview = await review(input.fileName, input.csvText);
  const summary = { created: 0, sessionsCreated: 0, alreadyExists: 0, skipped: 0, invalid: 0, failed: 0 };
  if (preview.fileError) return { importBatchId, fileError: preview.fileError, results: [], summary };

  const skip = new Set(input.skipKeys);
  const confirm = new Set(input.confirmKeys);
  const results: PatientCsvCommitResult["results"] = [];

  for (const g of preview.groups) {
    const base = { key: g.key, name: g.name, lines: g.lines };
    if (g.status === "invalid") {
      summary.invalid++;
      results.push({ ...base, outcome: "invalid", sessions: 0, message: g.errors.join(" ") });
      continue;
    }
    if (g.status === "existing") {
      summary.alreadyExists++;
      results.push({ ...base, outcome: "already_exists", sessions: 0, message: `Already on the dashboard as ${g.matchedName}. Not changed.` });
      continue;
    }
    if (skip.has(g.key) || (g.status === "possible_duplicate" && !confirm.has(g.key))) {
      summary.skipped++;
      results.push({ ...base, outcome: "skipped", sessions: 0, message: g.status === "possible_duplicate" ? `Not added: similar to ${g.matchedName}.` : "Not selected." });
      continue;
    }
    try {
      const r = await commitPatientCsvGroup({
        name: g.name,
        insurance: g.insurance,
        authDate: g.authDate,
        visits: g.visits,
        fileName: input.fileName,
        importBatchId,
      }, actor);
      if (r.status === "created") {
        summary.created++;
        summary.sessionsCreated += r.sessions;
        results.push({ ...base, outcome: "created", sessions: r.sessions, message: null });
      } else {
        // Saved by an earlier attempt or a concurrent import: nothing new was written.
        summary.alreadyExists++;
        results.push({ ...base, outcome: "already_exists", sessions: 0, message: "Already on the dashboard (saved earlier). Not changed." });
      }
    } catch (err) {
      summary.failed++;
      const message = err instanceof InsurerDeletedError ? err.message : "Could not be saved. Nothing was saved for this patient; try again.";
      if (!(err instanceof InsurerDeletedError)) console.error("[patientCsvImport] commit failed:", err);
      results.push({ ...base, outcome: "failed", sessions: 0, message });
    }
  }
  return { importBatchId, fileError: null, results, summary };
}
