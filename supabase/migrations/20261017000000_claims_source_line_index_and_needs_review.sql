-- ============================================================================
-- P4-P14: Preserve repeated same-date/same-CPT service lines; add an
-- explicit "needs_review" claim status for conflicting payment evidence.
--
-- Part 1 — source_line_index
-- --------------------------
-- upsertClaimRecord (server/db.ts) has always matched an existing row by
-- (patient_id, auth_period, date_of_service, cpt_codes) — deliberate, per
-- the P4-P1 Cigna re-import requirement (see
-- server/upsertClaimRecord.idempotency.test.ts), so re-importing the same
-- file never inserts a second row for the same line.
--
-- The side effect (documented in that same test file under P4-P13, and
-- reported against a real UHC EOB) is that TWO distinct service lines
-- sharing the same patient/period/date/CPT collapse onto one row: the
-- second upsertClaimRecord call for that key patches the first line's row
-- instead of inserting a second one, silently overwriting it.
--
-- source_line_index disambiguates them: it is the 0-based position of a
-- service line within its (date, CPT) group as encountered in the source
-- document, assigned deterministically by the extraction/import code
-- (server/routers.ts bulkImportFromEOB, client/src/pages/Dashboard.tsx
-- handleSaveExtractedClaims) — not by staff, and not guessed from content.
-- Re-importing the same document reproduces the same per-line indices in
-- the same order, so the match stays idempotent; two genuinely repeated
-- lines (even with identical units/modifiers/amounts) get distinct indices
-- and therefore distinct rows.
--
-- Nullable and additive: every row that exists before this migration keeps
-- source_line_index = NULL ("legacy slot"). upsertClaimRecord treats a NULL
-- row as index 0 for backward compatibility (so existing single-line
-- claims/imports keep patching the same row they always have), and refuses
-- to silently insert or merge when a legacy NULL row is found but the
-- current import asks for index >= 1 at that same key — that shape means
-- the single existing row might already be P4-P13's merge-overwrite
-- artifact, and nothing in this migration can tell safe apart from
-- corrupted after the fact. That ambiguous case is surfaced to staff for
-- manual review (claimsImported counts it as skipped, with a reason),
-- never silently merged or inserted. See server/db.ts upsertClaimRecord.
--
-- No backfill: existing rows are not rewritten, renumbered, or otherwise
-- touched by this migration. If a historical UHC (or other insurer) import
-- actually hit the collapse bug, the surviving single row is left exactly
-- as it already is — recovering the overwritten line's data would require
-- the original source document, which this change does not have and does
-- not assume.
--
-- Part 2 — needs_review claim status
-- -----------------------------------
-- Reported separately: an Anthem/BCBS row showing "Denied" despite a
-- present, non-zero insurance reimbursement amount. server/aiClaimExtractor.ts
-- now corrects that specific contradiction deterministically (payment
-- present -> never "denied"), but the inverse (claimStatus "approved" with
-- a confirmed $0 reimbursement, or any other evidence we can't safely
-- resolve one way or the other) is not something code should silently
-- guess at either. 'needs_review' is a new, explicit claim_status value for
-- exactly that case -- it is never assigned to existing rows by this
-- migration, only produced going forward by new extraction logic.
-- ============================================================================

BEGIN;

ALTER TABLE public.claims_records
  ADD COLUMN IF NOT EXISTS source_line_index integer;

COMMENT ON COLUMN public.claims_records.source_line_index IS
  'Zero-based position of this service line within its (date_of_service, cpt_codes) group as encountered in the source document/import. NULL = legacy row created before this column existed. Disambiguates genuinely repeated same-date/same-CPT lines so they are not collapsed into one row by the (patient_id, auth_period, date_of_service, cpt_codes) upsert match key.';

-- Disambiguates repeated-line rows under the existing match key without
-- replacing it; source_line_index is only ever an additional filter
-- upsertClaimRecord applies on top of the original four columns.
CREATE INDEX IF NOT EXISTS idx_claims_line_identity
  ON public.claims_records (patient_id, auth_period, date_of_service, cpt_codes, source_line_index);

ALTER TABLE public.claims_records
  DROP CONSTRAINT IF EXISTS claims_records_claim_status_check;

ALTER TABLE public.claims_records
  ADD CONSTRAINT claims_records_claim_status_check CHECK (
    claim_status IN ('submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted', 'needs_review')
  );

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- ALTER TABLE public.claims_records
--   DROP CONSTRAINT IF EXISTS claims_records_claim_status_check;
-- ALTER TABLE public.claims_records
--   ADD CONSTRAINT claims_records_claim_status_check CHECK (
--     claim_status IN ('submitted', 'approved', 'pending', 'denied', 'pended', 'rejected', 'resubmitted')
--   ); -- only safe once no row has claim_status = 'needs_review'
-- DROP INDEX IF EXISTS idx_claims_line_identity;
-- ALTER TABLE public.claims_records
--   DROP COLUMN IF EXISTS source_line_index;
-- COMMIT;

-- ============================================================================
-- RELEASE INSTRUCTIONS
-- ============================================================================
-- Apply this file's SQL directly in the Supabase SQL Editor for this project
-- (see references/local-setup-schema.sql header — that file is the
-- authoritative schema snapshot and must be updated alongside this
-- migration, which it has been in this change). This migration is additive
-- only: it adds one nullable column, one index, and widens an existing CHECK
-- constraint to allow one more value. It does not rewrite, delete, or
-- renumber any existing row. No application code change in this PR requires
-- the migration to be applied before deploying — rows written before this
-- migration runs simply keep source_line_index = NULL and are handled by the
-- backward-compatible legacy-slot path in upsertClaimRecord — but the
-- 'needs_review' status WILL be rejected by the old CHECK constraint until
-- this migration is applied, so apply it before deploying this PR's server
-- changes, not after.
-- ============================================================================
