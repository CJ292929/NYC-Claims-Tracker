/**
 * client/src/lib/sessionFieldSave.ts — P4-P23
 *
 * Pure helpers behind the per-session workflow cells (Assignment of
 * Benefits, Submission Status, Remarks) in the authorization/session table.
 * See client/src/components/dashboard/SessionWorkflowCells.tsx.
 */
import type { AssignmentOfBenefits, SubmissionStatus } from "@shared/sessionWorkflowFields";

export type SessionWorkflowField = "assignmentOfBenefits" | "submissionStatus" | "remarks";

export type SessionWorkflowValues = {
  assignmentOfBenefits: AssignmentOfBenefits | null;
  submissionStatus: SubmissionStatus | null;
  remarks: string | null;
};

/** Writes ONLY `field` from a save response into the cached visit list, and
 *  only on the saved row. Other fields in the response are deliberately not
 *  merged: a concurrent, still-pending save of a sibling field on the same
 *  row would otherwise be overwritten by this (older) response's copy. */
export function mergeSavedSessionField<V extends { id: string } & Partial<SessionWorkflowValues>>(
  visits: V[] | undefined,
  saved: { id: string } & SessionWorkflowValues,
  field: SessionWorkflowField,
): V[] | undefined {
  if (!visits) return visits;
  return visits.map(v => (v.id === saved.id ? { ...v, [field]: saved[field] } : v));
}

/** Remarks are free text: normalize so an unchanged or whitespace-only
 *  draft is recognized as a no-op / clear before any request is sent. */
export function normalizeRemarksDraft(draft: string): string | null {
  return draft.trim() === "" ? null : draft;
}
