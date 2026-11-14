-- ============================================================================
-- P4-P31R: Expired authorization periods — New York cutoff, lock protocol,
-- last-row protection, and a versioned upgrade from every earlier P4-P31
-- variant.
--
-- WHY A NEW VERSION. 20261114000000_p4_p31_expired_authorization_status.sql
-- exists in two variants (d2a6ac5: row-level auth_status = 'expired';
-- bf51417: period-level period_expired_at). Either may already be recorded
-- in a target's supabase_migrations.schema_migrations, and `db push` never
-- re-runs a recorded version. So that file is left byte-for-byte as it is,
-- and every correction lives here, written to converge all three possible
-- starting states to one end state:
--
--   A. neither variant applied  — 20261114000000 (bf51417) runs, then this.
--   B. bf51417 applied           — existing marks are kept as they are.
--   C. d2a6ac5 applied           — this file removes the d2a6ac5 objects
--                                  (6-arg function overload, widened CHECK,
--                                  modified approve_authorization_with_audit)
--                                  and installs the period-level design.
--
-- LEGACY 'expired' ROWS ARE NEVER GUESSED. In state C, a row with
-- auth_status = 'expired' had its previous status overwritten, and the only
-- record of it is the audit history. Choosing its replacement status is a
-- business decision this migration does not make: if ANY such row exists,
-- step 0 aborts the whole migration (nothing is changed, the transaction
-- rolls back, the version is not recorded) and reports the count. Those rows
-- need an explicit, reviewed conversion migration first.
--
-- 1. Expiry cutoff = the America/New_York calendar date of
--    period_expired_at (public.auth_period_expiry_cutoff). date_of_service
--    is a plain clinic (New York) calendar date, so the cutoff must be one
--    too. The bf51417 variant used the UTC date, which made the cutoff one
--    day late from 19:00 EST / 20:00 EDT onward.
--
-- 2. Lock protocol. Every path that can change which rows belong to a
--    period, or a period's mark, serialises on the patients row:
--      mark / restore (set_auth_period_expired_with_audit), approve
--        patients FOR UPDATE, then that patient's visit rows FOR UPDATE.
--      INSERT, or a row moved to a different patient
--        trigger takes patients(NEW.patient_id) FOR SHARE before reading the
--        target period's mark. FOR SHARE conflicts with the FOR UPDATE
--        above, so a concurrent mark either commits first (and the read,
--        a new statement with a fresh snapshot, sees it) or waits for this
--        write to commit (and its UPDATE then marks the new row as well).
--        Inserters don't block each other.
--      UPDATE inside one patient (period move, date edit, status edit)
--        the row lock the UPDATE already holds conflicts with the mark's
--        FOR UPDATE of every visit row of that patient, so it is ordered
--        before or after the mark as a whole.
--      removal of a row from an EXPIRED period (DELETE, or a move out)
--        trigger takes patients(OLD.patient_id) FOR NO KEY UPDATE, which
--        conflicts with itself, so two removers of the same patient run the
--        "not the last row" check one after the other and can't both pass.
--      write_visit_record_with_audit (the app's single-row path), when the
--        write may move the row (p_data has auth_period), takes
--        patients FOR NO KEY UPDATE BEFORE the row lock. That gives the app
--        the same patient-then-rows order as mark/restore/approve, so the
--        app cannot deadlock against them.
--    A raw SQL session that takes a row lock first and then needs the
--    patient lock can still deadlock against a concurrent mark. Postgres
--    then aborts one of the two with 40P01. That is an error, not silent
--    damage: no row escapes the mark.
--
-- 3. An expired period can't be emptied. Moving or deleting the LAST row of
--    an expired period is refused (P0038, "restore the period first").
--    Moving or deleting any other row (fixing a misfiled session) is
--    allowed and audited at row level as before. Deleting the patient
--    cascades as before: the check is skipped when the patient row no
--    longer exists.
--
-- 4. Internal bypass (app.p4p31_period_expiry_write). This transaction-local
--    setting is how set_auth_period_expired_with_audit tells the guard that
--    the write is its own. It is NOT a security boundary. Any session with
--    direct SQL access can set it and change a mark without an audit row.
--    PostgREST can't set it, so the app's API paths can't. Against direct
--    SQL, the only protection is who holds a database login with write
--    access to visit_records. Check those grants on each target. RLS is off
--    locally, and hosted default grants may differ. Here the bypass is
--    narrowed to the one write it exists for: an UPDATE that keeps the row
--    in its period. Every other write ignores it.
--
-- Unchanged: API permissions (normalProtectedProcedure, service_role-only
-- RPCs), atomic auditing (one audit_logs row per change, written in the
-- same transaction), and every existing row, status, date, count and
-- money value.
--
-- Deploy order: apply this migration FIRST, then deploy the app. Idempotent,
-- safe to re-run. Run it in READ COMMITTED (the default). The lock protocol
-- relies on each statement taking a fresh snapshot.
--
-- Rollback (manual, after the app is rolled back): re-run section 2 of
-- 20261114000000 (bf51417) for the old guard, and write_visit_record_with_audit
-- from 20261025000000. auth_period_expiry_cutoff can then be dropped.
-- ============================================================================

BEGIN;

-- ─── 0: legacy (d2a6ac5) row-level 'expired' rows: refuse, never guess ─────
DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM public.visit_records WHERE auth_status = 'expired';
  IF v_count > 0 THEN
    RAISE EXCEPTION 'p4_p31r_legacy_expired_rows: % visit_records row(s) have auth_status = ''expired'' (d2a6ac5 variant). Their replacement status needs an explicit decision and a reviewed conversion migration; nothing was changed.', v_count
      USING ERRCODE = 'P0039';
  END IF;
END;
$$;

-- ─── 1: remove d2a6ac5 objects (no-ops on states A and B) ──────────────────
DROP FUNCTION IF EXISTS public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text);

-- Narrow a widened auth_status CHECK back to the pre-P4-P31 set. Safe: step 0
-- proved no row holds 'expired'.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid = 'public.visit_records'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%auth_status%'
      AND pg_get_constraintdef(c.oid) ILIKE '%expired%'
  LOOP
    EXECUTE format('ALTER TABLE public.visit_records DROP CONSTRAINT %I', v_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.visit_records'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%auth_status%'
  ) THEN
    ALTER TABLE public.visit_records
      ADD CONSTRAINT visit_records_auth_status_check
      CHECK (auth_status IN ('none', 'pending', 'approved', 'denied'));
  END IF;
END;
$$;

-- approve_authorization_with_audit: re-asserted exactly as defined by
-- 20261018010000_p4_p17r_atomic_audit_and_concurrency_guard.sql (the
-- d2a6ac5 variant had replaced it; on states A and B this is identical).

CREATE OR REPLACE FUNCTION public.approve_authorization_with_audit(
  p_patient_id uuid,
  p_target_period integer,
  p_sessions_authorized integer,
  p_auth_date date,
  p_new_insurance text,
  p_auth_valid_until_provided boolean,
  p_auth_valid_until bigint,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS SETOF uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_patient_exists boolean;
  v_target_exists boolean;
  v_max_period integer;
  v_next_period integer;
  v_batch_insurance text;
  v_new_ids uuid[];
BEGIN
  IF p_sessions_authorized IS NULL OR p_sessions_authorized < 1 THEN
    RAISE EXCEPTION 'invalid_sessions_authorized: %', p_sessions_authorized USING ERRCODE = 'P0033';
  END IF;

  -- Lock the patient row and every visit row for this patient up front so a
  -- concurrent approval (or edit) for the SAME patient serializes instead of
  -- interleaving with this one.
  SELECT EXISTS (SELECT 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE) INTO v_patient_exists;
  IF NOT v_patient_exists THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  PERFORM 1 FROM public.visit_records WHERE patient_id = p_patient_id FOR UPDATE;

  SELECT EXISTS (
    SELECT 1 FROM public.visit_records WHERE patient_id = p_patient_id AND auth_period = p_target_period
  ) INTO v_target_exists;
  IF NOT v_target_exists THEN
    RAISE EXCEPTION 'auth_period_not_found: %', p_target_period USING ERRCODE = 'P0034';
  END IF;

  UPDATE public.visit_records
  SET auth_status = 'approved', updated_by = p_actor_id, updated_by_type = p_actor_type
  WHERE patient_id = p_patient_id AND auth_period = p_target_period;

  IF p_auth_date IS NOT NULL
     OR (p_new_insurance IS NOT NULL AND length(btrim(p_new_insurance)) > 0)
     OR p_auth_valid_until_provided
  THEN
    UPDATE public.patients SET
      auth_date = COALESCE(p_auth_date, auth_date),
      insurance = CASE
        WHEN p_new_insurance IS NOT NULL AND length(btrim(p_new_insurance)) > 0 THEN btrim(p_new_insurance)
        ELSE insurance
      END,
      auth_valid_until = CASE WHEN p_auth_valid_until_provided THEN p_auth_valid_until ELSE auth_valid_until END,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
    WHERE id = p_patient_id;
  END IF;

  SELECT max(auth_period) INTO v_max_period FROM public.visit_records WHERE patient_id = p_patient_id;
  v_next_period := COALESCE(v_max_period, p_target_period) + 1;

  v_batch_insurance := NULLIF(btrim(COALESCE(p_new_insurance, '')), '');
  IF v_batch_insurance IS NULL THEN
    SELECT insurance INTO v_batch_insurance FROM public.patients WHERE id = p_patient_id;
  END IF;

  WITH inserted AS (
    INSERT INTO public.visit_records (
      patient_id, sessions_authorized, sessions_remaining, session_number,
      auth_period, date_of_service, new_auth, date_ash_submitted, auth_status,
      insurance_company, created_by, created_by_type, updated_by, updated_by_type
    )
    SELECT
      p_patient_id, p_sessions_authorized, p_sessions_authorized - (gs - 1), gs,
      v_next_period, NULL, NULL, NULL, 'none',
      v_batch_insurance, p_actor_id, p_actor_type, p_actor_id, p_actor_type
    FROM generate_series(1, p_sessions_authorized) AS gs
    RETURNING id
  )
  SELECT array_agg(id) INTO v_new_ids FROM inserted;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'visit_record', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'AUTHORIZATION_APPROVED',
    jsonb_build_object('auth_period', p_target_period),
    jsonb_build_object('new_auth_period', v_next_period, 'sessions_authorized', p_sessions_authorized, 'new_visit_ids', to_jsonb(v_new_ids))
  );

  RETURN QUERY SELECT unnest(v_new_ids);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_authorization_with_audit(uuid, integer, integer, date, text, boolean, bigint, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_authorization_with_audit(uuid, integer, integer, date, text, boolean, bigint, uuid, text, text) TO service_role;

-- ─── 2: period-level column (already present on states A and B) ────────────
ALTER TABLE public.visit_records
  ADD COLUMN IF NOT EXISTS period_expired_at timestamptz NULL;

-- ─── 3: New York calendar-date cutoff ───────────────────────────────────────
-- The last date_of_service that may be recorded against a period marked
-- Expired at p_marked_at: that instant's calendar date in America/New_York.
-- tzdata handles both DST transitions.
CREATE OR REPLACE FUNCTION public.auth_period_expiry_cutoff(p_marked_at timestamptz)
RETURNS date
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT (p_marked_at AT TIME ZONE 'America/New_York')::date
$$;

-- ─── 4: guard trigger (replaces the bf51417 definition) ─────────────────────
CREATE OR REPLACE FUNCTION public.visit_records_period_expiry_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_period_expired_at timestamptz;
  v_removing boolean;
BEGIN
  -- Internal bypass for set_auth_period_expired_with_audit's own UPDATE,
  -- which keeps every row in its period. NOT a security boundary: any
  -- session with direct SQL access can set this (see header, point 4).
  IF TG_OP = 'UPDATE'
     AND current_setting('app.p4p31_period_expiry_write', true) = 'on'
     AND NEW.patient_id = OLD.patient_id
     AND NEW.auth_period = OLD.auth_period THEN
    RETURN NEW;
  END IF;

  -- ── Removal from an expired period: DELETE, or a move out of it ──
  v_removing := TG_OP = 'DELETE'
    OR (TG_OP = 'UPDATE' AND (NEW.patient_id <> OLD.patient_id OR NEW.auth_period <> OLD.auth_period));

  -- OLD is the latest row version, and this statement holds its row lock.
  -- So OLD.period_expired_at can't change under us: mark and restore both
  -- need that row lock.
  IF v_removing AND OLD.period_expired_at IS NOT NULL THEN
    -- Removers of one patient serialise here (NO KEY UPDATE conflicts with
    -- itself, with the inserters' FOR SHARE and with mark/restore/approve's
    -- FOR UPDATE). The EXISTS below is a new statement, so it sees every
    -- removal committed while we waited. Two removers can't both see the
    -- other's row and empty the period together.
    PERFORM 1 FROM public.patients WHERE id = OLD.patient_id FOR NO KEY UPDATE;
    -- No patient row: this is the patient-delete cascade (or the patient was
    -- deleted concurrently). Let it through.
    IF FOUND AND NOT EXISTS (
      SELECT 1 FROM public.visit_records vr
      WHERE vr.patient_id = OLD.patient_id
        AND vr.auth_period = OLD.auth_period
        AND vr.id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'expired_period_last_row: session % is the last row of expired authorization period %; restore the period first',
        OLD.id, OLD.auth_period
        USING ERRCODE = 'P0038';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.patient_id = OLD.patient_id
     AND NEW.auth_period = OLD.auth_period THEN
    -- Same period: the expiry mark is not a row field.
    IF NEW.period_expired_at IS DISTINCT FROM OLD.period_expired_at THEN
      RAISE EXCEPTION 'period_expiry_is_period_level: use set_auth_period_expired_with_audit'
        USING ERRCODE = 'P0035';
    END IF;
  ELSE
    -- Insert, or a move to another period/patient: inherit the target
    -- period's mark.
    --
    -- An INSERT, or a move from another patient, holds no lock that a
    -- concurrent mark of NEW.patient_id would wait for. So take one. A move
    -- within one patient already holds this row's lock, which that mark
    -- needs too. Taking the patient lock here as well would only add a
    -- deadlock, so it is skipped.
    IF TG_OP = 'INSERT' OR NEW.patient_id <> OLD.patient_id THEN
      PERFORM 1 FROM public.patients WHERE id = NEW.patient_id FOR SHARE;
    END IF;

    SELECT vr.period_expired_at INTO v_period_expired_at
    FROM public.visit_records vr
    WHERE vr.patient_id = NEW.patient_id
      AND vr.auth_period = NEW.auth_period
      AND vr.id IS DISTINCT FROM NEW.id
      AND vr.period_expired_at IS NOT NULL
    LIMIT 1;

    -- (A moved row's own old mark is simply replaced; only a mark supplied
    -- by the write itself is refused.)
    IF NEW.period_expired_at IS NOT NULL
       AND NEW.period_expired_at IS DISTINCT FROM v_period_expired_at
       AND (TG_OP = 'INSERT' OR NEW.period_expired_at IS DISTINCT FROM OLD.period_expired_at) THEN
      RAISE EXCEPTION 'period_expiry_is_period_level: use set_auth_period_expired_with_audit'
        USING ERRCODE = 'P0035';
    END IF;
    NEW.period_expired_at := v_period_expired_at;
  END IF;

  IF NEW.period_expired_at IS NOT NULL
     AND NEW.date_of_service IS NOT NULL
     AND NEW.date_of_service > public.auth_period_expiry_cutoff(NEW.period_expired_at)
     AND (TG_OP = 'INSERT'
          OR NEW.date_of_service IS DISTINCT FROM OLD.date_of_service
          OR NEW.period_expired_at IS DISTINCT FROM OLD.period_expired_at) THEN
    RAISE EXCEPTION 'session_after_period_expiry: % is after authorization period % expired on % (New York date)',
      NEW.date_of_service, NEW.auth_period, public.auth_period_expiry_cutoff(NEW.period_expired_at)
      USING ERRCODE = 'P0036';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visit_records_period_expiry_guard ON public.visit_records;
CREATE TRIGGER visit_records_period_expiry_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.visit_records
  FOR EACH ROW EXECUTE FUNCTION public.visit_records_period_expiry_guard();

-- ─── 5: write_visit_record_with_audit (P4-P23 definition + patient-first lock) ─
CREATE OR REPLACE FUNCTION public.write_visit_record_with_audit(
  p_id uuid,
  p_patient_id uuid,
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
  v_before public.visit_records;
  v_after public.visit_records;
  v_id uuid;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
  v_key text;
  v_lock_patient uuid;
BEGIN
  IF p_id IS NULL THEN
    v_after := jsonb_populate_record(NULL::public.visit_records, p_data);

    INSERT INTO public.visit_records (
      patient_id, sessions_authorized, sessions_remaining, session_number,
      auth_period, date_of_service, new_auth, date_ash_submitted, auth_status,
      insurance_company, total_insurance_reimbursement, total_patient_due, total_patient_paid,
      assignment_of_benefits, submission_status, remarks,
      created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      p_patient_id, v_after.sessions_authorized, v_after.sessions_remaining, v_after.session_number,
      COALESCE(v_after.auth_period, 1), v_after.date_of_service, v_after.new_auth, v_after.date_ash_submitted,
      COALESCE(v_after.auth_status, 'none'), v_after.insurance_company, v_after.total_insurance_reimbursement,
      v_after.total_patient_due, v_after.total_patient_paid,
      v_after.assignment_of_benefits, v_after.submission_status, v_after.remarks,
      p_actor_id, p_actor_type, p_actor_id, p_actor_type
    )
    RETURNING id INTO v_id;

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data
    ) VALUES (
      'visit_record', v_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, NULL, v_after_diff
    );

    RETURN v_id;
  ELSE
    -- P4-P31R lock protocol: a write that may move the row to another
    -- period locks the patient BEFORE the row, the same order as
    -- mark/restore/approve, so the app can't deadlock against them. It
    -- also serialises the guard trigger's "last row of an expired period"
    -- check. (Unlocked read, re-checked under the row lock below.)
    IF p_data ? 'auth_period' THEN
      SELECT vr.patient_id INTO v_lock_patient FROM public.visit_records vr WHERE vr.id = p_id;
      IF v_lock_patient IS NOT NULL THEN
        PERFORM 1 FROM public.patients WHERE id = v_lock_patient FOR NO KEY UPDATE;
      END IF;
    END IF;

    SELECT * INTO v_before FROM public.visit_records WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'visit_record_not_found: %', p_id USING ERRCODE = 'P0030';
    END IF;
    -- p_patient_id is optional on update (see P4-P17R); when supplied it is
    -- checked as an ownership guard.
    IF p_patient_id IS NOT NULL AND v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'visit_record_patient_mismatch: % does not belong to %', p_id, p_patient_id
        USING ERRCODE = 'P0031';
    END IF;
    IF v_lock_patient IS NOT NULL AND v_before.patient_id <> v_lock_patient THEN
      RAISE EXCEPTION 'visit_record_moved_concurrently: %', p_id USING ERRCODE = '40001';
    END IF;

    v_after := jsonb_populate_record(v_before, p_data);

    FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
      IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
        v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
      END IF;
    END LOOP;

    -- No-op save: nothing changed, so neither the row nor its attribution
    -- is touched and no audit row is written.
    IF v_before_diff = '{}'::jsonb THEN
      RETURN p_id;
    END IF;

    UPDATE public.visit_records SET
      sessions_authorized = v_after.sessions_authorized,
      sessions_remaining = v_after.sessions_remaining,
      session_number = v_after.session_number,
      auth_period = v_after.auth_period,
      date_of_service = v_after.date_of_service,
      new_auth = v_after.new_auth,
      date_ash_submitted = v_after.date_ash_submitted,
      auth_status = v_after.auth_status,
      insurance_company = v_after.insurance_company,
      total_insurance_reimbursement = v_after.total_insurance_reimbursement,
      total_patient_due = v_after.total_patient_due,
      total_patient_paid = v_after.total_patient_paid,
      assignment_of_benefits = v_after.assignment_of_benefits,
      submission_status = v_after.submission_status,
      remarks = v_after.remarks,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
    WHERE id = p_id;

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data
    ) VALUES (
      'visit_record', p_id, v_before.patient_id, p_actor_id, p_actor_type, p_actor_display,
      p_action, v_before_diff, v_after_diff
    );

    RETURN p_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.write_visit_record_with_audit(uuid, uuid, jsonb, uuid, text, text, text) TO service_role;

-- ─── 6: set_auth_period_expired_with_audit (bf51417 definition, unchanged) ─
-- Re-created so state C (d2a6ac5), which never ran the bf51417 file, gets it.
CREATE OR REPLACE FUNCTION public.set_auth_period_expired_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_expired boolean,
  p_reason text,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_current timestamptz;
  v_new timestamptz;
  v_reason text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_authorized integer;
  v_completed integer;
  v_ids uuid[];
  v_changed integer;
BEGIN
  IF p_expired IS NULL THEN
    RAISE EXCEPTION 'invalid_expired_flag' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NOT NULL AND length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_too_long' USING ERRCODE = '22023';
  END IF;

  -- Same lock order as approve_authorization_with_audit: patient, then its visits.
  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  PERFORM 1 FROM public.visit_records WHERE patient_id = p_patient_id FOR UPDATE;

  SELECT max(period_expired_at),
         max(sessions_authorized),
         count(date_of_service)::integer,
         array_agg(id ORDER BY session_number NULLS LAST, id)
    INTO v_current, v_authorized, v_completed, v_ids
  FROM public.visit_records
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period;

  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'auth_period_not_found: %', p_auth_period USING ERRCODE = 'P0034';
  END IF;

  -- No-op: already in the requested state. Nothing written, nothing audited.
  IF (p_expired AND v_current IS NOT NULL) OR (NOT p_expired AND v_current IS NULL) THEN
    RETURN 0;
  END IF;

  IF NOT p_expired THEN
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'restore_reason_required' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.visit_records
      WHERE patient_id = p_patient_id AND auth_period > p_auth_period
    ) THEN
      RAISE EXCEPTION 'expired_period_superseded: period % has a later authorization period', p_auth_period
        USING ERRCODE = 'P0037';
    END IF;
  END IF;

  v_new := CASE WHEN p_expired THEN now() ELSE NULL END;

  PERFORM set_config('app.p4p31_period_expiry_write', 'on', true);
  UPDATE public.visit_records
  SET period_expired_at = v_new,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  PERFORM set_config('app.p4p31_period_expiry_write', 'off', true);

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'visit_record', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    CASE WHEN p_expired THEN 'AUTHORIZATION_PERIOD_EXPIRED' ELSE 'AUTHORIZATION_PERIOD_EXPIRY_RESTORED' END,
    jsonb_build_object('auth_period', p_auth_period, 'period_expired_at', v_current),
    jsonb_build_object(
      'auth_period', p_auth_period,
      'period_expired_at', v_new,
      'sessions_authorized', COALESCE(v_authorized, 0),
      'sessions_completed', v_completed,
      'sessions_unused', GREATEST(0, COALESCE(v_authorized, 0) - v_completed),
      'visit_ids', to_jsonb(v_ids),
      'reason', v_reason
    )
  );

  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.set_auth_period_expired_with_audit(uuid, integer, boolean, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_auth_period_expired_with_audit(uuid, integer, boolean, text, uuid, text, text) TO service_role;

COMMIT;
