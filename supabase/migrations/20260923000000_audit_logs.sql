-- ============================================================================
-- TRK-P1B-R: Audit trail for patient edits
--
-- Adds public.audit_logs — an immutable (insert-only, no update trigger) log
-- of who changed a patient's name and when, with the previous and new value.
-- Written idempotently (IF NOT EXISTS) matching the style of
-- references/local-setup-schema.sql, the repo's authoritative schema
-- snapshot (kept in sync with this migration).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  actor_id uuid,
  action text NOT NULL,
  old_value text,
  new_value text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_patient ON public.audit_logs(patient_id, created_at DESC);

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS idx_audit_logs_patient;
-- DROP TABLE IF EXISTS public.audit_logs;
-- COMMIT;
