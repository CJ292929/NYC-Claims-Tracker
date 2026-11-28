-- ============================================================================
-- Add Missing Session: record a visit that already happened into an
-- EXPLICITLY SELECTED (usually previous) authorization period, without
-- restoring it.
--
-- Why: staff found visits that occurred in Period 1 but were never recorded
-- (no session date, no CMS-1500 line). Period 2 already exists, so
--   * Restore Period is refused (P0037, kept: an older period is never made
--     current again once a newer one exists), and
--   * Correct Count is refused on an Expired period (P0040, kept), and
--   * Log Session only writes to the active (newest usable) period.
-- A historical correction is not a restoration, so it gets its own path.
--
-- add_missing_session_with_audit(patient, period, date, actor...)
--   * fills the first unused session row (lowest session_number without a
--     date of service) of THAT period. No row is created, renumbered or moved,
--     so session ids, session numbers and every claim reference stay as they
--     are. The period's authorized count is the limit: a period with no unused
--     session row is refused (P0062), never extended.
--   * never touches the expiry mark: an Expired period stays Expired, and the
--     guard trigger still refuses a date after its expiry cutoff (P0036), so
--     an expired period's unused sessions never become available for visits
--     after it expired.
--   * refuses a date in the future (New York calendar date, P0060) — this is
--     for visits that already happened.
--   * refuses a date that is already recorded on any session of the patient
--     (P0061, DETAIL = "<period>:<session>"). That visit exists: if it lacks
--     a CMS-1500 line, the fix is the claim, not a second session.
--   * writes one audit_logs row (SESSION_BACKFILLED) in the same transaction.
--   * touches nothing else: other sessions, other periods, claims_records and
--     every money column are unchanged.
--
-- Lock order: patients FOR NO KEY UPDATE, then the patient's visit rows FOR
-- UPDATE — the same patient-then-rows order as mark / restore / approve
-- (P4-P31R), so it can't deadlock against them. Two concurrent backfills for
-- one patient serialise on the patient lock, so the duplicate check and the
-- slot choice can't race.
--
-- Error codes: P0020 patient not found · P0034 period not found ·
-- P0036 after expiry cutoff (guard trigger) · P0060 future date ·
-- P0061 duplicate date · P0062 no unused session in the period ·
-- 22023 invalid input.
--
-- Additive and idempotent (CREATE OR REPLACE). Nothing existing is altered.
-- Deploy order: apply this migration, then deploy the app.
-- Rollback (after the app is rolled back):
--   DROP FUNCTION IF EXISTS public.add_missing_session_with_audit(uuid, integer, date, uuid, text, text);
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.add_missing_session_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_date_of_service date,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_authorized integer;
  v_completed integer;
  v_period_rows integer;
  v_dup_period integer;
  v_dup_session integer;
  v_slot public.visit_records;
  v_remaining integer;
BEGIN
  IF p_auth_period IS NULL OR p_auth_period < 1 OR p_date_of_service IS NULL THEN
    RAISE EXCEPTION 'invalid_missing_session_input' USING ERRCODE = '22023';
  END IF;

  IF p_date_of_service > (now() AT TIME ZONE 'America/New_York')::date THEN
    RAISE EXCEPTION 'missing_session_in_future: %', p_date_of_service USING ERRCODE = 'P0060';
  END IF;

  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  PERFORM 1 FROM public.visit_records WHERE patient_id = p_patient_id FOR UPDATE;

  SELECT count(*)::integer, max(sessions_authorized), count(date_of_service)::integer
    INTO v_period_rows, v_authorized, v_completed
  FROM public.visit_records
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period;

  IF v_period_rows = 0 THEN
    RAISE EXCEPTION 'auth_period_not_found: %', p_auth_period USING ERRCODE = 'P0034';
  END IF;

  SELECT auth_period, session_number INTO v_dup_period, v_dup_session
  FROM public.visit_records
  WHERE patient_id = p_patient_id AND date_of_service = p_date_of_service
  ORDER BY auth_period, session_number NULLS LAST
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'missing_session_duplicate_date: % is already recorded', p_date_of_service
      USING ERRCODE = 'P0061', DETAIL = v_dup_period || ':' || COALESCE(v_dup_session::text, '');
  END IF;

  SELECT * INTO v_slot
  FROM public.visit_records
  WHERE patient_id = p_patient_id AND auth_period = p_auth_period AND date_of_service IS NULL
  ORDER BY session_number NULLS LAST, id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing_session_no_unused_session: period % has no unused session', p_auth_period
      USING ERRCODE = 'P0062', DETAIL = COALESCE(v_authorized, 0)::text;
  END IF;

  -- Same stored value Log Session writes: sessions left after this one.
  v_remaining := GREATEST(0, COALESCE(v_authorized, 0) - (v_completed + 1));

  -- The guard trigger runs here: same period, expiry mark untouched, and a
  -- date after an Expired period's cutoff is refused (P0036).
  UPDATE public.visit_records
  SET date_of_service = p_date_of_service,
      sessions_remaining = v_remaining,
      updated_by = p_actor_id,
      updated_by_type = p_actor_type
  WHERE id = v_slot.id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'visit_record', v_slot.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'SESSION_BACKFILLED',
    jsonb_build_object('date_of_service', NULL::date,'sessions_remaining', v_slot.sessions_remaining),
    jsonb_build_object(
      'date_of_service', p_date_of_service,
      'sessions_remaining', v_remaining,
      'auth_period', p_auth_period,
      'session_number', v_slot.session_number,
      'period_expired', v_slot.period_expired_at IS NOT NULL
    )
  );

  RETURN jsonb_build_object(
    'visit_id', v_slot.id,
    'auth_period', p_auth_period,
    'session_number', v_slot.session_number,
    'sessions_authorized', COALESCE(v_authorized, 0),
    'completed', v_completed + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.add_missing_session_with_audit(uuid, integer, date, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_missing_session_with_audit(uuid, integer, date, uuid, text, text) TO service_role;

COMMIT;
