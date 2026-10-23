-- ============================================================================
-- P4-P22: Permanent insurer deletion removes the CATALOG ENTRY only
--
-- P4-P21's delete_insurer_catalog_with_audit refused (P0040) whenever any
-- patient, visit, or claim row stored the entry's name or an alias,
-- normalized (case/spacing-insensitive) and across discharged/historical
-- rows. In practice that blocked entries whose UI filter count read 0: the
-- filter counts ACTIVE patients by EXACT string, so e.g. patients storing a
-- different-casing spelling of the name were invisible to the count but
-- still blocked the delete.
--
-- The requirement is now: after the confirmation warning, Permanently Delete
-- removes the insurer from the catalog even when records still carry its
-- name. Those records keep their recorded insurer text exactly as stored.
--
-- Why this is safe / non-destructive:
--   * patients.insurance, visit_records.insurance_company and
--     claims_records.insurance_billed are FREE TEXT. There is no foreign key
--     into insurer_catalog (verified in production: 0 FK constraints
--     reference it), so deleting the catalog row cannot cascade, null out,
--     or otherwise change any record. The function never writes those
--     tables.
--   * Defensive: if a foreign key into insurer_catalog is ever added, the
--     function refuses (P0042) instead of letting ON DELETE CASCADE / SET
--     NULL silently rewrite records. That future change would need its own
--     reviewed strategy (e.g. snapshotting the display name first).
--
-- Changes:
--
-- 1. delete_insurer_catalog_with_audit (CREATE OR REPLACE, same signature
--    and return value) — still locks the exact row by id (FOR UPDATE; never
--    a name match), deletes it, tombstones its normalized name + aliases,
--    and writes the INSURER_PERMANENT_DELETE audit row in one transaction.
--    The reference check no longer blocks; instead the reference COUNTS at
--    deletion time (patients / visits / claims — counts only, no record
--    data) are kept in the audit row's before_data.retained_references.
--
-- 2. guard_insurer_assignment now only guards patients.insurance. That is
--    the column staff actually SELECT an insurer for (Add/Edit Patient, CSV
--    import, New Authorization's insurer change), so it is where "no new
--    selections of a deleted insurer" belongs. The visit_records and
--    claims_records triggers are dropped: those rows RECORD what happened.
--    With referenced deletion allowed, a patient may legitimately still
--    carry a deleted insurer's name, and approve_authorization_with_audit
--    copies the patient's insurer into every new visit row — keeping the
--    visit trigger would make approving the next authorization for such a
--    patient fail with P0041. Likewise a historical EOB billed to a deleted
--    insurer must still import. Unchanged patients.insurance values (any
--    UPDATE that doesn't change the normalized value) were and remain
--    exempt, so editing other fields of such a patient keeps working.
--
-- Unchanged from P4-P21: tombstones (re-run seed/backfill migrations —
-- including 20261004000000's patients/visits backfill, which would now find
-- the name on records — cannot recreate a deleted entry), explicit re-add
-- through Add Insurance Company clears the tombstone, and the FOR KEY SHARE
-- / FOR UPDATE handshake that serializes a patient assignment against an
-- in-flight delete.
--
-- Written idempotently, matching prior migrations, and mirrored in
-- references/local-setup-schema.sql. Must be applied BEFORE the app code
-- that relies on it is deployed (see the PR description).
-- ============================================================================

BEGIN;

-- ─── 2: narrow the assignment guard to patients.insurance ─────────────────
-- guard_insurer_assignment() itself is unchanged; only where it runs.
DROP TRIGGER IF EXISTS visit_records_guard_insurer_assignment ON public.visit_records;
DROP TRIGGER IF EXISTS claims_records_guard_insurer_assignment ON public.claims_records;

-- ─── 1: delete_insurer_catalog_with_audit — catalog-only delete ───────────
CREATE OR REPLACE FUNCTION public.delete_insurer_catalog_with_audit(
  p_id uuid,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row public.insurer_catalog;
  v_values text[];
  v_patients integer;
  v_visits integer;
  v_claims integer;
BEGIN
  -- Never delete through a foreign key: an FK's ON DELETE action would change
  -- records this function promises to leave untouched.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.insurer_catalog'::regclass
  ) THEN
    RAISE EXCEPTION 'insurer_catalog_has_foreign_keys: refusing to delete %', p_id
      USING ERRCODE = 'P0042';
  END IF;

  SELECT * INTO v_row FROM public.insurer_catalog WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insurer_catalog_not_found: %', p_id USING ERRCODE = 'P0032';
  END IF;

  SELECT array_agg(DISTINCT v) INTO v_values
  FROM (
    SELECT public.normalize_insurer_name(x) AS v
    FROM unnest(array_prepend(v_row.name, v_row.aliases)) AS x
  ) s
  WHERE v IS NOT NULL AND v <> '';

  -- Informational only (recorded in the audit row) — records that store
  -- this name keep it; nothing here blocks the delete.
  SELECT count(*) INTO v_patients FROM public.patients
  WHERE public.normalize_insurer_name(insurance) = ANY(v_values);
  SELECT count(*) INTO v_visits FROM public.visit_records
  WHERE public.normalize_insurer_name(insurance_company) = ANY(v_values);
  SELECT count(*) INTO v_claims FROM public.claims_records
  WHERE public.normalize_insurer_name(insurance_billed) = ANY(v_values);

  DELETE FROM public.insurer_catalog WHERE id = p_id;

  INSERT INTO public.insurer_catalog_deleted_names (normalized_name, deleted_insurer_id)
  SELECT unnest(v_values), p_id
  ON CONFLICT (normalized_name) DO UPDATE
    SET deleted_insurer_id = EXCLUDED.deleted_insurer_id, deleted_at = now();

  INSERT INTO public.audit_logs (
    entity_type, entity_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'insurer_catalog', p_id, p_actor_id, p_actor_type, p_actor_display,
    'INSURER_PERMANENT_DELETE',
    jsonb_build_object(
      'id', v_row.id,
      'name', v_row.name,
      'aliases', to_jsonb(v_row.aliases),
      'is_active', v_row.is_active,
      'created_at', v_row.created_at,
      'retained_references', jsonb_build_object(
        'patients', v_patients, 'visits', v_visits, 'claims', v_claims
      )
    ),
    NULL
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_insurer_catalog_with_audit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_insurer_catalog_with_audit(uuid, uuid, text, text) TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- Re-run the "1: delete_insurer_catalog_with_audit" and the visit_records /
-- claims_records CREATE TRIGGER sections of
-- 20261023000000_p4_p21_insurer_permanent_delete.sql. Catalog rows already
-- deleted are NOT restored; recover them from the INSURER_PERMANENT_DELETE
-- audit_logs before_data if needed (an explicit Add Insurance Company re-add
-- also works and clears the tombstone). Patient/visit/claim rows need no
-- rollback — this migration never changes them.
-- ============================================================================
