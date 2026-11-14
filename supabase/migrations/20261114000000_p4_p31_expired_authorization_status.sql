-- ============================================================================
-- P4-P31: manual "Expired" per AUTHORIZATION PERIOD.
--
-- Authorization only. Claim/payment status (claims.claim_status) and
-- visit_records.auth_status are NOT touched: expiry is a fact about a whole
-- period, not a per-session request status, so it lives in its own column
-- and never overwrites a row's auth_status.
--
-- 1. visit_records.period_expired_at timestamptz NULL (new). NULL = the
--    period is not expired. Period-level: every row of one
--    (patient_id, auth_period) carries the same value. Nothing is backfilled;
--    every existing row stays NULL. Expiry is never inferred from dates,
--    Authorization Valid Until or a zero balance.
--
-- 2. visit_records_period_expiry_guard (BEFORE INSERT OR UPDATE trigger),
--    enforced for EVERY write path (tRPC create/update/bulkCreate, imports,
--    approval, direct service_role writes):
--      a. period_expired_at can only be changed by
--         set_auth_period_expired_with_audit (P0035 otherwise). Row edits
--         cannot expire or reactivate a period.
--      b. A row inserted into, or moved into, an expired period inherits that
--         period's period_expired_at, so a period is never half-expired.
--      c. In an expired period, a date_of_service may only be set or changed
--         to a date on or before the expiry date (UTC calendar date, the
--         app's date convention) — P0036 otherwise. Late entry or correction
--         of a session that happened before expiry is allowed; recording a
--         session after expiry is refused. Clearing a date is allowed.
--         Availability never reopens: an expired period reports 0 remaining
--         however its rows are edited.
--
-- 3. set_auth_period_expired_with_audit(...) (new): one transaction.
--      p_expired = true  — marks ONE period of ONE patient Expired.
--      p_expired = false — restores it. Reason required. Refused (P0037)
--        once a later period exists (a newer authorization superseded it).
--    Only period_expired_at changes (plus updated_by attribution). Row
--    auth_status, session counts, dates, claims and money are never
--    written, so restoring needs no guessing: the pre-expiry statuses were
--    never changed. One audit_logs row per actual change (none for a
--    no-op), with the period, counts, affected row ids, actor and reason.
--
-- approve_authorization_with_audit is NOT changed: it still marks the target
-- period's auth_status approved and creates MAX(auth_period)+1 with exactly
-- p_sessions_authorized rows. An expired target stays expired (its
-- period_expired_at is untouched); unused sessions never carry forward.
--
-- Deploy order: apply this migration FIRST, then deploy the app. The current
-- app keeps working on this schema (it never writes period_expired_at). The
-- new app REQUIRES it. Idempotent, safe to re-run.
--
-- Rollback (manual, only after the app is rolled back; drops expiry marks —
-- export them first if they must be kept):
--   DROP TRIGGER IF EXISTS visit_records_period_expiry_guard ON public.visit_records;
--   DROP FUNCTION IF EXISTS public.visit_records_period_expiry_guard();
--   DROP FUNCTION IF EXISTS public.set_auth_period_expired_with_audit(uuid, integer, boolean, text, uuid, text, text);
--   ALTER TABLE public.visit_records DROP COLUMN IF EXISTS period_expired_at;
-- ============================================================================

BEGIN;

-- ─── 1: period-level column ─────────────────────────────────────────────────
ALTER TABLE public.visit_records
  ADD COLUMN IF NOT EXISTS period_expired_at timestamptz NULL;

-- ─── 2: guard trigger ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.visit_records_period_expiry_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_period_expired_at timestamptz;
BEGIN
  -- The only sanctioned writer of period_expired_at (transaction-local flag).
  IF current_setting('app.p4p31_period_expiry_write', true) = 'on' THEN
    RETURN NEW;
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
    -- period's mark. Supplying a different mark directly is refused.
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
     AND NEW.date_of_service > (NEW.period_expired_at AT TIME ZONE 'UTC')::date
     AND (TG_OP = 'INSERT'
          OR NEW.date_of_service IS DISTINCT FROM OLD.date_of_service
          OR NEW.period_expired_at IS DISTINCT FROM OLD.period_expired_at) THEN
    RAISE EXCEPTION 'session_after_period_expiry: % is after authorization period % expired on %',
      NEW.date_of_service, NEW.auth_period, (NEW.period_expired_at AT TIME ZONE 'UTC')::date
      USING ERRCODE = 'P0036';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visit_records_period_expiry_guard ON public.visit_records;
CREATE TRIGGER visit_records_period_expiry_guard
  BEFORE INSERT OR UPDATE ON public.visit_records
  FOR EACH ROW EXECUTE FUNCTION public.visit_records_period_expiry_guard();

-- ─── 3: set_auth_period_expired_with_audit ──────────────────────────────────
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
