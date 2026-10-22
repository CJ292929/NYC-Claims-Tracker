-- ============================================================================
-- P4-P21: Permanent deletion of an unused insurer_catalog entry
--
-- P4-P13 added a soft delete (is_active = false), which stays the right tool
-- for an insurer that existing records still use. This migration adds a
-- PERMANENT delete for a catalog entry that nothing references (typically a
-- typo or a mistaken add), with four guarantees enforced in the database
-- rather than the application:
--
-- 1. delete_insurer_catalog_with_audit — one transaction that
--      a. locks the exact catalog row by id (FOR UPDATE; never a name match),
--      b. checks patients.insurance, visit_records.insurance_company and
--         claims_records.insurance_billed against the entry's name AND every
--         alias (normalized, so casing/spacing variants count), across ALL
--         rows — discharged patients and old authorization periods included,
--      c. rejects with P0040 if anything matches (nothing is deleted,
--         renamed or reassigned — the function never writes those tables),
--      d. otherwise deletes the row, records a tombstone (see 3), and writes
--         an INSURER_PERMANENT_DELETE audit_logs row whose before_data keeps
--         the deleted id, name and aliases. Any failure (including the audit
--         insert) rolls all of it back.
--
-- 2. guard_insurer_assignment — BEFORE INSERT/UPDATE trigger on the three
--    referencing columns. Those columns are free text, not FKs, so a plain
--    reference COUNT in (1) could race a concurrent assignment: both read
--    "unused", the delete commits, and the new patient row then points at a
--    vanished insurer. The trigger closes that by taking FOR KEY SHARE on
--    every catalog row the new value matches. FOR KEY SHARE conflicts with
--    the delete's FOR UPDATE (but NOT with the FOR NO KEY UPDATE taken by
--    deactivate/reactivate, so soft-delete never blocks assignments):
--      - assignment first: the delete waits on the lock, then its reference
--        check (a new READ COMMITTED snapshot) sees the committed row and
--        rejects with P0040;
--      - delete first: the assignment waits, finds the row gone once the
--        delete commits, and rejects with P0041 instead of storing a name
--        that no longer exists in the catalog.
--    It also rejects (P0041) an assignment of a tombstoned name after the
--    fact — e.g. a form opened before the delete and saved after it.
--    Values that never matched any catalog entry (legacy free text, CSV
--    imports of unknown names) pass through unchanged, as before.
--
-- 3. insurer_catalog_deleted_names + skip_deleted_insurer_reinsert — every
--    migration that seeds insurer_catalog is written to be re-run (ON
--    CONFLICT DO NOTHING). After a permanent delete there is no row left to
--    conflict with, so a re-run would silently recreate the entry. The
--    tombstone table remembers each deleted entry's normalized name and
--    aliases, and a BEFORE INSERT trigger on insurer_catalog turns any later
--    insert of a tombstoned name into a no-op — generically, with no insurer
--    names hard-coded anywhere.
--
-- 4. write_insurer_catalog_with_audit (CREATE OR REPLACE, same signature) —
--    an admin who deliberately re-adds a deleted name through "Add
--    Insurance Company" clears that name's tombstone first, in the same
--    transaction, so the explicit re-add succeeds while seeds stay blocked.
--
-- Written idempotently (IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF
-- EXISTS), matching prior migrations, and mirrored in
-- references/local-setup-schema.sql.
-- ============================================================================

BEGIN;

-- Same rule as shared/insuranceCatalog.ts normalizeInsurerName and the
-- insurer_catalog.normalized_name generated column.
CREATE OR REPLACE FUNCTION public.normalize_insurer_name(p_value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT lower(btrim(regexp_replace(p_value, '\s+', ' ', 'g')));
$$;

-- ─── 3: tombstones ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.insurer_catalog_deleted_names (
  normalized_name text PRIMARY KEY,
  deleted_insurer_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.insurer_catalog_deleted_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurer_catalog_deleted_names NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.insurer_catalog_deleted_names FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.insurer_catalog_deleted_names TO service_role;

CREATE OR REPLACE FUNCTION public.skip_deleted_insurer_reinsert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.insurer_catalog_deleted_names
    WHERE normalized_name = public.normalize_insurer_name(NEW.name)
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS insurer_catalog_skip_deleted_reinsert ON public.insurer_catalog;
CREATE TRIGGER insurer_catalog_skip_deleted_reinsert
  BEFORE INSERT ON public.insurer_catalog
  FOR EACH ROW EXECUTE FUNCTION public.skip_deleted_insurer_reinsert();

-- ─── 2: assignment guard ───────────────────────────────────────────────────
-- TG_ARGV[0] names the referencing column on the table the trigger is on.
CREATE OR REPLACE FUNCTION public.guard_insurer_assignment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_new text := public.normalize_insurer_name(to_jsonb(NEW) ->> TG_ARGV[0]);
  v_ids uuid[];
  v_locked integer;
BEGIN
  IF v_new IS NULL OR v_new = '' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND public.normalize_insurer_name(to_jsonb(OLD) ->> TG_ARGV[0]) IS NOT DISTINCT FROM v_new THEN
    RETURN NEW;
  END IF;

  SELECT array_agg(c.id) INTO v_ids
  FROM public.insurer_catalog c
  WHERE c.normalized_name = v_new
     OR EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE public.normalize_insurer_name(a) = v_new);

  IF v_ids IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.insurer_catalog_deleted_names WHERE normalized_name = v_new) THEN
      RAISE EXCEPTION 'This insurance company was permanently deleted. Choose a different insurance company.'
        USING ERRCODE = 'P0041';
    END IF;
    RETURN NEW;
  END IF;

  -- Blocks while a permanent delete of any of these rows is in flight; a row
  -- that delete removed is simply not returned once it commits.
  SELECT count(*) INTO v_locked FROM (
    SELECT 1 FROM public.insurer_catalog WHERE id = ANY(v_ids) FOR KEY SHARE
  ) locked;

  IF v_locked < cardinality(v_ids) THEN
    RAISE EXCEPTION 'This insurance company was permanently deleted. Choose a different insurance company.'
      USING ERRCODE = 'P0041';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS patients_guard_insurer_assignment ON public.patients;
CREATE TRIGGER patients_guard_insurer_assignment
  BEFORE INSERT OR UPDATE OF insurance ON public.patients
  FOR EACH ROW EXECUTE FUNCTION public.guard_insurer_assignment('insurance');

DROP TRIGGER IF EXISTS visit_records_guard_insurer_assignment ON public.visit_records;
CREATE TRIGGER visit_records_guard_insurer_assignment
  BEFORE INSERT OR UPDATE OF insurance_company ON public.visit_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_insurer_assignment('insurance_company');

DROP TRIGGER IF EXISTS claims_records_guard_insurer_assignment ON public.claims_records;
CREATE TRIGGER claims_records_guard_insurer_assignment
  BEFORE INSERT OR UPDATE OF insurance_billed ON public.claims_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_insurer_assignment('insurance_billed');

-- ─── 1: delete_insurer_catalog_with_audit ──────────────────────────────────
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

  SELECT count(*) INTO v_patients FROM public.patients
  WHERE public.normalize_insurer_name(insurance) = ANY(v_values);
  SELECT count(*) INTO v_visits FROM public.visit_records
  WHERE public.normalize_insurer_name(insurance_company) = ANY(v_values);
  SELECT count(*) INTO v_claims FROM public.claims_records
  WHERE public.normalize_insurer_name(insurance_billed) = ANY(v_values);

  IF v_patients + v_visits + v_claims > 0 THEN
    RAISE EXCEPTION 'insurer_catalog_in_use: %', p_id
      USING ERRCODE = 'P0040',
            DETAIL = format('patients=%s visits=%s claims=%s', v_patients, v_visits, v_claims);
  END IF;

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
      'created_at', v_row.created_at
    ),
    NULL
  );

  RETURN p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_insurer_catalog_with_audit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_insurer_catalog_with_audit(uuid, uuid, text, text) TO service_role;

-- ─── 4: write_insurer_catalog_with_audit — explicit re-add clears tombstone ─
-- Identical to the P4-P17R definition except for the DELETE from
-- insurer_catalog_deleted_names before the insert, and the update path's
-- row lock (FOR NO KEY UPDATE instead of FOR UPDATE).
CREATE OR REPLACE FUNCTION public.write_insurer_catalog_with_audit(
  p_id uuid,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_action text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_before public.insurer_catalog;
  v_after public.insurer_catalog;
  v_id uuid;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
  v_key text;
BEGIN
  IF p_id IS NULL THEN
    v_after := jsonb_populate_record(NULL::public.insurer_catalog, p_data);

    DELETE FROM public.insurer_catalog_deleted_names
    WHERE normalized_name = public.normalize_insurer_name(v_after.name);

    INSERT INTO public.insurer_catalog (
      name, created_by, created_by_type
    ) VALUES (
      v_after.name, p_actor_id, p_actor_type
    )
    RETURNING id INTO v_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, actor_id, actor_type, actor_display,
      action, before_data, after_data
    ) VALUES (
      'insurer_catalog', v_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, NULL, v_after_diff
    );

    RETURN v_id;
  ELSE
    -- NO KEY UPDATE (was FOR UPDATE): deactivate/reactivate never change the
    -- key, so they needn't block guard_insurer_assignment's FOR KEY SHARE.
    -- Still conflicts with delete_insurer_catalog_with_audit's FOR UPDATE.
    SELECT * INTO v_before FROM public.insurer_catalog WHERE id = p_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insurer_catalog_not_found: %', p_id USING ERRCODE = 'P0032';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

    UPDATE public.insurer_catalog SET
      is_active = v_after.is_active,
      deactivated_at = v_after.deactivated_at,
      deactivated_by = v_after.deactivated_by,
      reactivated_at = v_after.reactivated_at,
      reactivated_by = v_after.reactivated_by
    WHERE id = p_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
        v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
      END IF;
    END LOOP;

    IF v_before_diff <> '{}'::jsonb THEN
      INSERT INTO public.audit_logs (
        entity_type, entity_id, actor_id, actor_type, actor_display,
        action, before_data, after_data
      ) VALUES (
        'insurer_catalog', p_id, p_actor_id, p_actor_type, p_actor_display,
        p_action, v_before_diff, v_after_diff
      );
    END IF;

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_insurer_catalog_with_audit(uuid, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_insurer_catalog_with_audit(uuid, jsonb, uuid, text, text, text) TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS patients_guard_insurer_assignment ON public.patients;
-- DROP TRIGGER IF EXISTS visit_records_guard_insurer_assignment ON public.visit_records;
-- DROP TRIGGER IF EXISTS claims_records_guard_insurer_assignment ON public.claims_records;
-- DROP TRIGGER IF EXISTS insurer_catalog_skip_deleted_reinsert ON public.insurer_catalog;
-- DROP FUNCTION IF EXISTS public.delete_insurer_catalog_with_audit(uuid, uuid, text, text);
-- DROP FUNCTION IF EXISTS public.guard_insurer_assignment();
-- DROP FUNCTION IF EXISTS public.skip_deleted_insurer_reinsert();
-- DROP TABLE IF EXISTS public.insurer_catalog_deleted_names;
-- DROP FUNCTION IF EXISTS public.normalize_insurer_name(text);
-- -- then re-apply write_insurer_catalog_with_audit from
-- -- 20261018010000_p4_p17r_atomic_audit_and_concurrency_guard.sql.
-- -- Deleted catalog rows are NOT restored; recover them from the
-- -- INSURER_PERMANENT_DELETE audit_logs before_data if needed.
-- COMMIT;
