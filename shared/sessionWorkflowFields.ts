/**
 * shared/sessionWorkflowFields.ts — P4-P23
 *
 * Per-session (visit_records row) workflow fields shown in the Patient
 * Records authorization/session table in place of the three financial
 * total columns. One definition shared by the server's tRPC input
 * validation and the client's dropdowns/length limit, mirroring the CHECK
 * constraints in supabase/migrations/20261025000000_p4_p23_session_workflow_fields.sql.
 *
 * Every field is nullable with NO default: an existing row that was never
 * reviewed reads as "unset", never as an implied "NO" or "Ready to file".
 */
import { z } from "zod";

export const ASSIGNMENT_OF_BENEFITS_VALUES = ["yes", "no"] as const;
export type AssignmentOfBenefits = (typeof ASSIGNMENT_OF_BENEFITS_VALUES)[number];

export const SUBMISSION_STATUS_VALUES = ["ready_to_file", "hold", "do_not_file"] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUS_VALUES)[number];

/** Matches the visit_records_remarks_length CHECK constraint. */
export const SESSION_REMARKS_MAX_LENGTH = 2000;

export const ASSIGNMENT_OF_BENEFITS_LABELS: Record<AssignmentOfBenefits, string> = {
  yes: "YES",
  no: "NO",
};

export const SUBMISSION_STATUS_LABELS: Record<SubmissionStatus, string> = {
  ready_to_file: "Ready to file",
  hold: "Hold",
  do_not_file: "Do not file",
};

/** `null` is an explicit clear; omitting the key leaves the stored value untouched. */
export const sessionWorkflowFieldsInput = z.object({
  assignmentOfBenefits: z.enum(ASSIGNMENT_OF_BENEFITS_VALUES).nullable().optional(),
  submissionStatus: z.enum(SUBMISSION_STATUS_VALUES).nullable().optional(),
  // Whitespace-only remarks are stored as NULL (cleared) rather than as an
  // invisible non-empty value.
  remarks: z
    .string()
    .max(SESSION_REMARKS_MAX_LENGTH, `Remarks must be ${SESSION_REMARKS_MAX_LENGTH} characters or fewer`)
    .transform(v => (v.trim() === "" ? null : v))
    .nullable()
    .optional(),
});

export type SessionWorkflowFieldsInput = z.infer<typeof sessionWorkflowFieldsInput>;
