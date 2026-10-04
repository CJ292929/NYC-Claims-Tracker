-- ============================================================================
-- P4-P12R: Atomic claim deletion + audit
--
-- Replaces the audit-insert-then-delete-with-compensation sequence in
-- server/db.ts's deleteClaimRecordWithAudit with a single database
-- transaction via public.delete_claim_record_with_audit(). The old approach
-- ordered two separate Supabase REST requests so every failure mode was
-- individually safe, but it was never atomic — a crash between the two
-- requests (process restart, lost connection) could still leave a dangling
-- audit row with no matching deletion. A single plpgsql function called
-- through one supabase.rpc() request removes that window: Postgres commits
-- or rolls back both writes together.
--
-- SELECT ... FOR UPDATE locks the target row for the duration of the
-- function's transaction, so two concurrent delete attempts on the same
-- claim serialize: the first to acquire the lock proceeds and commits
-- (deleting the row and writing the one audit entry); the second blocks
-- until the first commits, then finds zero matching rows and raises the
-- not-found error below, writing no audit entry of its own. Only one
-- deletion audit entry is ever produced per claim.
--
-- The function targets exactly one row by primary key (id = p_claim_id) —
-- it never matches on date_of_service/cpt_codes or any other shared column,
-- so adjacent claims for the same patient/visit are never touched.
--
-- SECURITY DEFINER + a fixed search_path (pg_catalog, public) is the
-- standard safe pattern for a privileged Postgres function: without a
-- pinned search_path, a caller able to influence role-level search_path
-- settings could get the function to resolve an unqualified identifier to
-- an attacker-controlled object. Every identifier below is additionally
-- schema-qualified (public.claims_records, public.audit_logs) as
-- defense-in-depth on top of the pinned path.
--
-- EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to
-- service_role, matching claims.delete's adminOrOwnerProcedure gate in
-- server/routers.ts — this function is reachable only from server/db.ts's
-- service-role Supabase client (server/supabase.ts), never from a browser
-- holding the anon key.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_claim_record_with_audit(
  p_claim_id uuid,
  p_patient_id uuid,
  p_actor_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_patient_id uuid;
BEGIN
  SELECT patient_id INTO v_patient_id
  FROM public.claims_records
  WHERE id = p_claim_id
  FOR UPDATE;

  IF v_patient_id IS NULL THEN
    RAISE EXCEPTION 'claim_record_not_found: % ', p_claim_id
      USING ERRCODE = 'P0010';
  END IF;

  IF v_patient_id <> p_patient_id THEN
    RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_claim_id, p_patient_id
      USING ERRCODE = 'P0011';
  END IF;

  INSERT INTO public.audit_logs (patient_id, actor_id, action, old_value, new_value)
  VALUES (p_patient_id, p_actor_id, 'CLAIM_RECORD_DELETE', p_claim_id::text, NULL);

  DELETE FROM public.claims_records WHERE id = p_claim_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_claim_record_with_audit(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_claim_record_with_audit(uuid, uuid, uuid) TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP FUNCTION IF EXISTS public.delete_claim_record_with_audit(uuid, uuid, uuid);
-- COMMIT;
