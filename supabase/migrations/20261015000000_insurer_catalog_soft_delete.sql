-- ============================================================================
-- P4-P13: Soft-delete (deactivate) an insurer_catalog entry
--
-- Adds is_active + deactivated_at/by + reactivated_at/by to
-- public.insurer_catalog so staff can remove an insurer from the "Add
-- Insurance Company" / patient-form dropdowns WITHOUT ever deleting or
-- rewriting the row, and therefore without touching any patient, visit, or
-- claim record that already stores this insurer's name (those columns are
-- free text, not a foreign key into this table — see insuranceCatalog.ts).
--
-- Deliberately a boolean flag on the existing row, not a DELETE:
--   - normalized_name stays UNIQUE across active AND inactive rows, so an
--     inactive entry still blocks a second catalog row for the same name
--     (see insurance.create in server/routers.ts, which reactivates the
--     existing inactive row instead of inserting a duplicate).
--   - aliases, created_at, and the row's identity (id) are untouched, so any
--     code path keyed on insurer id/name (filters, counts, CSV export)
--     keeps working exactly as before for historical data.
--
-- There is no actor-audit table this can reuse: public.audit_logs (see
-- 20260923000000_audit_logs.sql) has a NOT NULL FK to patients.id, since it
-- was built for patient-scoped edits, and an insurer_catalog deactivation
-- isn't patient-scoped. Rather than force a non-patient event through a
-- patient-shaped table, the audit trail lives on the row itself —
-- deactivated_at/deactivated_by and reactivated_at/by — following this
-- table's own existing created_at convention. This is the narrow schema
-- change the feature needs; it does not touch audit_logs.
-- ============================================================================

BEGIN;

ALTER TABLE public.insurer_catalog
  ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid,
  ADD COLUMN IF NOT EXISTS reactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS reactivated_by uuid;

-- Dropdowns/typeahead for NEW selections only ever need active rows — this
-- partial index keeps that lookup (list active, ordered by name) cheap as
-- the catalog accumulates deactivated history over time.
CREATE INDEX IF NOT EXISTS insurer_catalog_active_name_idx
  ON public.insurer_catalog (name)
  WHERE is_active;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS insurer_catalog_active_name_idx;
-- ALTER TABLE public.insurer_catalog
--   DROP COLUMN IF EXISTS is_active,
--   DROP COLUMN IF EXISTS deactivated_at,
--   DROP COLUMN IF EXISTS deactivated_by,
--   DROP COLUMN IF EXISTS reactivated_at,
--   DROP COLUMN IF EXISTS reactivated_by;
-- COMMIT;
