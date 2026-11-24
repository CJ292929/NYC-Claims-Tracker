-- ============================================================================
-- Authorization requests on hold (temporary, manual, audited).
--
-- ADDITIVE ONLY. One new table (authorization_request_holds) and two new
-- service_role-only functions. No existing table, column, constraint,
-- function, row, status, count, date, claim or money value is changed.
--
-- What a hold is: staff deliberately pause the authorization request for ONE
-- authorization period of ONE patient (auth_period; NULL = a patient with no
-- authorization period yet), with a required reason. While the hold matches
-- the patient's current target period, the app shows the patient under
-- "Authorization Requests on Hold" instead of the actionable Authorization
-- Alerts (shared/authRequestHold.ts classifyAuthorizationAlert). The hold
-- never touches visit_records: a Pending request stays Pending, nothing is
-- approved, expired, discharged or created, and it never ends by itself.
--
-- Scope: a hold names the period it was placed on. Once a newer period
-- exists (an approval), the hold no longer matches the target period and
-- stops suppressing anything — it is shown as superseded until staff remove
-- it. It can never silently hide a new authorization period.
--
-- Concurrency: both functions take patients FOR UPDATE first — the same lock
-- approve_authorization_with_audit / create_initial_authorization_with_audit
-- / set_auth_period_expired_with_audit take — so hold, resume and approval of
-- one patient are serialised. The partial unique index allows at most one
-- active hold per patient. Retries are no-ops that write no audit row.
--
-- Deploy order: apply this migration FIRST, then deploy the app (the app's
-- alert query reads this table). Idempotent; safe to re-run.
--
-- Rollback (after the app is rolled back): DROP FUNCTION the two functions
-- below, then DROP TABLE public.authorization_request_holds. Their audit_logs
-- rows stay as history.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.authorization_request_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  auth_period integer CHECK (auth_period IS NULL OR auth_period >= 1),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500 AND reason = btrim(reason)),
  held_at timestamptz NOT NULL DEFAULT now(),
  held_by uuid NOT NULL,
  held_by_type text NOT NULL CHECK (held_by_type IN ('clinic_user', 'owner')),
  held_by_display text NOT NULL,
  released_at timestamptz,
  released_by uuid,
  released_by_type text CHECK (released_by_type IS NULL OR released_by_type IN ('clinic_user', 'owner')),
  released_by_display text,
  CHECK ((released_at IS NULL) = (released_by IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_authorization_request_holds_active_patient
  ON public.authorization_request_holds(patient_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_authorization_request_holds_patient
  ON public.authorization_request_holds(patient_id, held_at DESC);

-- Server-only, same lockdown as audit_logs.
ALTER TABLE public.authorization_request_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.authorization_request_holds NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.authorization_request_holds FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.authorization_request_holds TO service_role;

-- ─── hold ───────────────────────────────────────────────────────────────────
-- p_auth_period: the target period the caller saw (NULL = no period yet).
-- p_expected_latest_period: the newest period the caller saw (NULL = none).
-- Refused (P0050) if either no longer matches, e.g. an approval created a new
-- period in between. Same patient + same period already held: no-op
-- (changed = false, no audit row). A held different (superseded) period:
-- refused (P0051) — remove that hold first, explicitly.
CREATE OR REPLACE FUNCTION public.hold_authorization_request_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_expected_latest_period integer,
  p_reason text,
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
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_latest integer;
  v_existing public.authorization_request_holds%ROWTYPE;
  v_id uuid;
BEGIN
  IF length(v_reason) < 1 OR length(v_reason) > 500 THEN
    RAISE EXCEPTION 'hold_reason_required' USING ERRCODE = '22023';
  END IF;
  IF p_actor_id IS NULL OR p_actor_type IS NULL OR NULLIF(btrim(COALESCE(p_actor_display, '')), '') IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  SELECT max(auth_period) INTO v_latest FROM public.visit_records WHERE patient_id = p_patient_id;
  IF v_latest IS DISTINCT FROM p_expected_latest_period
     OR (p_auth_period IS NULL AND v_latest IS NOT NULL)
     OR (p_auth_period IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM public.visit_records WHERE patient_id = p_patient_id AND auth_period = p_auth_period)) THEN
    RAISE EXCEPTION 'hold_scope_stale' USING ERRCODE = 'P0050';
  END IF;

  SELECT * INTO v_existing FROM public.authorization_request_holds
  WHERE patient_id = p_patient_id AND released_at IS NULL;
  IF FOUND THEN
    IF v_existing.auth_period IS NOT DISTINCT FROM p_auth_period THEN
      RETURN jsonb_build_object('hold_id', v_existing.id, 'changed', false);
    END IF;
    RAISE EXCEPTION 'hold_exists_for_other_period' USING ERRCODE = 'P0051';
  END IF;

  INSERT INTO public.authorization_request_holds (patient_id, auth_period, reason, held_by, held_by_type, held_by_display)
  VALUES (p_patient_id, p_auth_period, v_reason, p_actor_id, p_actor_type, p_actor_display)
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display, action, before_data, after_data
  ) VALUES (
    'visit_record', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'AUTHORIZATION_REQUEST_HELD',
    NULL,
    jsonb_build_object('hold_id', v_id, 'auth_period', p_auth_period, 'reason', v_reason)
  );

  RETURN jsonb_build_object('hold_id', v_id, 'changed', true);
END;
$$;

REVOKE ALL ON FUNCTION public.hold_authorization_request_with_audit(uuid, integer, integer, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_authorization_request_with_audit(uuid, integer, integer, text, uuid, text, text) TO service_role;

-- ─── remove hold / resume ──────────────────────────────────────────────────
-- Returns 1 when the hold was released, 0 when it was already released (a
-- retry or a concurrent resume: nothing written, no audit row). P0052 when
-- the hold doesn't exist for that patient.
CREATE OR REPLACE FUNCTION public.release_authorization_request_hold_with_audit(
  p_patient_id uuid,
  p_hold_id uuid,
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
  v_hold public.authorization_request_holds%ROWTYPE;
BEGIN
  IF p_actor_id IS NULL OR p_actor_type IS NULL OR NULLIF(btrim(COALESCE(p_actor_display, '')), '') IS NULL THEN
    RAISE EXCEPTION 'actor_required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  SELECT * INTO v_hold FROM public.authorization_request_holds
  WHERE id = p_hold_id AND patient_id = p_patient_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hold_not_found: %', p_hold_id USING ERRCODE = 'P0052';
  END IF;
  IF v_hold.released_at IS NOT NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.authorization_request_holds
  SET released_at = now(), released_by = p_actor_id, released_by_type = p_actor_type, released_by_display = p_actor_display
  WHERE id = p_hold_id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display, action, before_data, after_data
  ) VALUES (
    'visit_record', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'AUTHORIZATION_REQUEST_HOLD_RELEASED',
    jsonb_build_object('hold_id', v_hold.id, 'auth_period', v_hold.auth_period, 'reason', v_hold.reason,
                       'held_at', v_hold.held_at, 'held_by_display', v_hold.held_by_display),
    jsonb_build_object('hold_id', v_hold.id, 'released', true)
  );

  RETURN 1;
END;
$$;

REVOKE ALL ON FUNCTION public.release_authorization_request_hold_with_audit(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_authorization_request_hold_with_audit(uuid, uuid, uuid, text, text) TO service_role;

COMMIT;
