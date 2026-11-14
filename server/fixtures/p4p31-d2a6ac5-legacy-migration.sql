-- ============================================================================
-- P4-P31: "Expired" authorization status.
--
-- Authorization status only (visit_records.auth_status). Claim/payment status
-- (claims.claim_status) is NOT touched.
--
-- 1. visit_records.auth_status CHECK widened to also allow 'expired'. Every
--    existing value stays valid; no row is read, rewritten or converted.
--    Existing 'denied' rows are deliberately left as they are — staff correct
--    them one period at a time (audited), never in bulk.
--
-- 2. set_auth_period_expired_with_audit(...) (new): marks ONE authorization
--    period of ONE patient Expired (p_expired = true), or clears a mistaken
--    Expired (p_expired = false). One transaction. Each changed row goes
--    through write_visit_record_with_audit, so each gets its own audit_logs
--    row with the before/after auth_status and the actor. Only auth_status
--    changes: session counts, dates of service, claims and money are never
--    written. Clearing sets that period's 'expired' rows to 'none' (their
--    earlier values remain in the audit history).
--
-- 3. approve_authorization_with_audit(...) (replaced, same signature): when
--    it marks the target period approved it now skips rows that are
--    'expired', so approving a new authorization from an expired period
--    never reactivates that period. The new period is still created from
--    MAX(auth_period) + 1 with exactly p_sessions_authorized rows — unused
--    sessions are never carried forward. Otherwise identical to P4-P17R.
--
-- Expiry is never inferred: nothing here reads dates or session balances to
-- decide a period is expired.
--
-- Deploy order: apply this migration FIRST, then deploy the app. The current
-- app keeps working on this schema (it never writes 'expired' and the
-- replaced function keeps its signature). The new app REQUIRES it
-- (visits.setPeriodExpired calls the new function). Idempotent, safe to
-- re-run.
--
-- Rollback (manual, only after the app is rolled back, and only once no row
-- is 'expired' — otherwise the narrower CHECK cannot be re-added):
--   DROP FUNCTION IF EXISTS public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text);
--   re-run approve_authorization_with_audit from 20261018010000_p4_p17r_atomic_audit_and_concurrency_guard.sql
--   ALTER TABLE public.visit_records DROP CONSTRAINT IF EXISTS visit_records_auth_status_check;
--   ALTER TABLE public.visit_records ADD CONSTRAINT visit_records_auth_status_check
--     CHECK (auth_status IN ('none', 'pending', 'approved', 'denied'));
-- ============================================================================

BEGIN;

-- ─── 1: widen the auth_status CHECK ─────────────────────────────────────────
-- The original constraint was declared inline (unnamed), so drop whichever
-- CHECK constraint on visit_records covers auth_status, then add a named one.
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.visit_records'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%auth_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.visit_records DROP CONSTRAINT %I', v_name);
  END LOOP;
END;
$$;

ALTER TABLE public.visit_records
  ADD CONSTRAINT visit_records_auth_status_check
  CHECK (auth_status IN ('none', 'pending', 'approved', 'denied', 'expired'));

-- ─── 2: set_auth_period_expired_with_audit ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_auth_period_expired_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_expired boolean,
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
  v_row record;
  v_changed integer := 0;
BEGIN
  IF p_expired IS NULL THEN
    RAISE EXCEPTION 'invalid_expired_flag' USING ERRCODE = '22023';
  END IF;

  -- Same lock order as approve_authorization_with_audit: patient, then its visits.
  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  PERFORM 1 FROM public.visit_records
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auth_period_not_found: %', p_auth_period USING ERRCODE = 'P0034';
  END IF;

  FOR v_row IN
    SELECT id FROM public.visit_records
    WHERE patient_id = p_patient_id
      AND auth_period = p_auth_period
      AND CASE WHEN p_expired THEN auth_status <> 'expired' ELSE auth_status = 'expired' END
    ORDER BY session_number NULLS LAST, id
  LOOP
    PERFORM public.write_visit_record_with_audit(
      v_row.id,
      p_patient_id,
      jsonb_build_object('auth_status', CASE WHEN p_expired THEN 'expired' ELSE 'none' END),
      p_actor_id,
      p_actor_type,
      p_actor_display,
      CASE WHEN p_expired THEN 'AUTHORIZATION_PERIOD_EXPIRED' ELSE 'AUTHORIZATION_PERIOD_EXPIRY_CLEARED' END
    );
    v_changed := v_changed + 1;
  END LOOP;

  RETURN v_changed;
END;
$$;

REVOKE ALL ON FUNCTION public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text) TO service_role;

-- ─── 3: approve_authorization_with_audit — never overwrite 'expired' ────────
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

  -- P4-P31: an expired period stays expired.
  UPDATE public.visit_records
  SET auth_status = 'approved', updated_by = p_actor_id, updated_by_type = p_actor_type
  WHERE patient_id = p_patient_id AND auth_period = p_target_period
    AND auth_status <> 'expired';

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

COMMIT;
