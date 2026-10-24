-- ============================================================================
-- P4-P24: CMS1500-first claim lines, source-document provenance, and the two
-- audited import RPCs (CMS1500 line commit, EOB line apply)
--
-- Workflow this supports (enforced in SQL, not only in the app):
--   1. A CMS1500 upload establishes clinical service lines (date of service,
--      POS, CPT, modifiers, units, line-specific diagnosis codes). Every
--      money column stays NULL — "unknown", never a confirmed zero.
--   2. An EOB / Insurance Reimbursement upload applies supported financial
--      and adjudication fields onto an EXISTING line that has CMS1500
--      provenance. An EOB line can never create a row here.
--
-- New, all additive:
--   claim_import_documents   one row per uploaded file (kind + SHA-256 of the
--                            file bytes). Re-uploading the same file resolves
--                            to the same row, which is what makes a reimport
--                            or a partial retry idempotent.
--   claims_records.cms1500_document_id / cms1500_line_key
--   claims_records.eob_document_id     / eob_line_key
--                            nullable source provenance. NULL on every
--                            existing (pre-P4-P24) row — historical rows are
--                            NOT backfilled or rewritten by this migration.
--                            Partial UNIQUE indexes make one source line map
--                            to at most one claim row, so concurrent or
--                            repeated submissions cannot duplicate a service
--                            line or apply one EOB payment line twice.
--   commit_cms1500_line_with_audit(...)  create / associate / re-apply one
--                            CMS1500 line + its audit row, atomically.
--   apply_eob_line_with_audit(...)       apply one EOB line onto one
--                            CMS1500-backed row + its audit row, atomically.
--
-- Both RPCs take a per-patient transaction-scoped advisory lock, so two
-- concurrent imports for the same patient serialize instead of racing the
-- "does a compatible line already exist" checks. A retry that changes
-- nothing writes no audit row (same no-op rule as the P4-P17R/P4-P23
-- *_with_audit functions). Any audit INSERT failure raises and rolls the
-- row change back with it.
--
-- Error codes (mapped to typed errors in server/db.ts):
--   P0010 claim row not found            P0011 claim row belongs to another patient
--   P0021 needs explicit selection       P0022 target has no CMS1500 line (upload CMS1500 first)
--   P0023 already reconciled by another EOB line
--   P0024 source line already saved to a different row
--   P0025 target already has CMS1500 provenance
--   P0026 target date of service / CPT incompatible with the source line
--   P0027 invalid import input
--   P0028 target already has different financial values (needs confirmation)
--   P0029 a new line needs an authorization period
--
-- Compatibility during the migration-before-deploy window: nothing existing
-- is altered or replaced (write_claim_record_with_audit and
-- delete_claim_record_with_audit are untouched), so the currently deployed
-- app keeps working against this schema. The new app code REQUIRES this
-- migration — apply it first.
--
-- Written idempotently (IF NOT EXISTS / guarded constraints / CREATE OR
-- REPLACE), so it is safe to re-run.
--
-- Rollback (manual, only after the app is rolled back):
--   DROP FUNCTION IF EXISTS public.apply_eob_line_with_audit(uuid, text, text, integer, text, uuid, jsonb, boolean, jsonb, uuid, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.claim_import_document_id(text, text, text, integer, uuid, text);
--   DROP FUNCTION IF EXISTS public.commit_cms1500_line_with_audit(uuid, integer, text, text, integer, text, text[], uuid, boolean, jsonb, uuid, text, text, uuid);
--   ALTER TABLE public.claims_records
--     DROP COLUMN IF EXISTS cms1500_document_id, DROP COLUMN IF EXISTS cms1500_line_key,
--     DROP COLUMN IF EXISTS eob_document_id, DROP COLUMN IF EXISTS eob_line_key;
--   DROP TABLE IF EXISTS public.claim_import_documents;
--   (dropping the columns loses provenance only; no clinical or money value
--   is stored in them.)
-- ============================================================================

BEGIN;

-- ─── claim_import_documents ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.claim_import_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_kind text NOT NULL CHECK (document_kind IN ('cms1500', 'eob')),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  file_name text CHECK (file_name IS NULL OR char_length(file_name) <= 255),
  page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 500),
  created_by uuid,
  created_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_import_documents_kind_sha_key UNIQUE (document_kind, content_sha256)
);

-- Server-only, same lockdown as audit_logs / insurer_catalog.
ALTER TABLE public.claim_import_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_import_documents NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.claim_import_documents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.claim_import_documents TO service_role;

-- ─── claims_records provenance ─────────────────────────────────────────────
ALTER TABLE public.claims_records
  ADD COLUMN IF NOT EXISTS cms1500_document_id uuid REFERENCES public.claim_import_documents(id),
  ADD COLUMN IF NOT EXISTS cms1500_line_key text,
  ADD COLUMN IF NOT EXISTS eob_document_id uuid REFERENCES public.claim_import_documents(id),
  ADD COLUMN IF NOT EXISTS eob_line_key text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_records_cms1500_source_pair_check') THEN
    ALTER TABLE public.claims_records ADD CONSTRAINT claims_records_cms1500_source_pair_check
      CHECK ((cms1500_document_id IS NULL) = (cms1500_line_key IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_records_eob_source_pair_check') THEN
    ALTER TABLE public.claims_records ADD CONSTRAINT claims_records_eob_source_pair_check
      CHECK ((eob_document_id IS NULL) = (eob_line_key IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claims_records_source_line_key_format_check') THEN
    ALTER TABLE public.claims_records ADD CONSTRAINT claims_records_source_line_key_format_check
      CHECK (
        (cms1500_line_key IS NULL OR cms1500_line_key ~ '^[A-Za-z0-9:_.,-]{1,160}$')
        AND (eob_line_key IS NULL OR eob_line_key ~ '^[A-Za-z0-9:_.,-]{1,160}$')
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_cms1500_source_line
  ON public.claims_records (cms1500_document_id, cms1500_line_key)
  WHERE cms1500_document_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_eob_source_line
  ON public.claims_records (eob_document_id, eob_line_key)
  WHERE eob_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_patient_dos
  ON public.claims_records (patient_id, date_of_service);

-- ─── helper: resolve (or create) the document row for one upload ───────────
CREATE OR REPLACE FUNCTION public.claim_import_document_id(
  p_kind text,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_actor_id uuid,
  p_actor_type text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_content_sha256 IS NULL OR p_content_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_import_input: content_sha256' USING ERRCODE = 'P0027';
  END IF;
  INSERT INTO public.claim_import_documents (document_kind, content_sha256, file_name, page_count, created_by, created_by_type)
  VALUES (p_kind, p_content_sha256, left(p_file_name, 255), p_page_count, p_actor_id, p_actor_type)
  ON CONFLICT ON CONSTRAINT claim_import_documents_kind_sha_key DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.claim_import_documents
    WHERE document_kind = p_kind AND content_sha256 = p_content_sha256;
  END IF;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_import_document_id(text, text, text, integer, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_import_document_id(text, text, text, integer, uuid, text) TO service_role;

-- ─── commit_cms1500_line_with_audit ────────────────────────────────────────
-- p_data carries ONLY clinical keys; anything else is ignored. Accepted:
--   date_of_service (required), cpt_codes (required), place_of_service,
--   modifier, units_billed, diagnosis_codes, claim_submitted_date,
--   insurance_billed, visit_number.
-- Exactly one of three outcomes per call:
--   * this source line was saved before (same document + line key)
--       -> re-apply clinical fields to that row ('updated' / 'unchanged')
--   * p_target_claim_id given (reviewed association with an existing,
--     typically historical reimbursement-first row)
--       -> stamp provenance + clinical fields on it, money untouched,
--          auth_period untouched ('associated')
--   * otherwise insert a new line with every money column NULL
--     ('created'). Refused with P0021 when any other row for this patient
--     already sits at the same date + CPT and is not a sibling line of this
--     same extraction (p_sibling_line_keys), unless p_allow_new_distinct is
--     true (an explicit "this is a separate service line" decision).
CREATE OR REPLACE FUNCTION public.commit_cms1500_line_with_audit(
  p_patient_id uuid,
  p_auth_period integer,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_line_key text,
  p_sibling_line_keys text[],
  p_target_claim_id uuid,
  p_allow_new_distinct boolean,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_clinical constant text[] := ARRAY[
    'date_of_service', 'cpt_codes', 'place_of_service', 'modifier', 'units_billed',
    'diagnosis_codes', 'claim_submitted_date', 'insurance_billed', 'visit_number'
  ];
  v_doc uuid;
  v_clean jsonb;
  v_dos date;
  v_cpt text;
  v_before public.claims_records;
  v_after public.claims_records;
  v_id uuid;
  v_status text;
  v_action text;
  v_key text;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
BEGIN
  IF p_patient_id IS NULL OR p_line_key IS NULL OR p_line_key !~ '^[A-Za-z0-9:_.,-]{1,160}$' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/line key' USING ERRCODE = 'P0027';
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_clean
  FROM jsonb_each(COALESCE(p_data, '{}'::jsonb))
  WHERE key = ANY (c_clinical) AND value <> 'null'::jsonb;

  v_dos := (v_clean ->> 'date_of_service')::date;
  v_cpt := NULLIF(btrim(v_clean ->> 'cpt_codes'), '');
  IF v_dos IS NULL OR v_cpt IS NULL THEN
    RAISE EXCEPTION 'invalid_import_input: date_of_service and cpt_codes are required' USING ERRCODE = 'P0027';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-patient:' || p_patient_id::text));
  v_doc := public.claim_import_document_id('cms1500', p_content_sha256, p_file_name, p_page_count, p_actor_id, p_actor_type);

  SELECT * INTO v_before FROM public.claims_records
  WHERE cms1500_document_id = v_doc AND cms1500_line_key = p_line_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'claim_record_patient_mismatch: source line saved for another patient' USING ERRCODE = 'P0011';
    END IF;
    IF p_target_claim_id IS NOT NULL AND p_target_claim_id <> v_before.id THEN
      RAISE EXCEPTION 'source_line_already_saved: %', v_before.id USING ERRCODE = 'P0024';
    END IF;
    v_action := 'CLAIM_RECORD_CMS1500_REAPPLY';
  ELSIF p_target_claim_id IS NOT NULL THEN
    SELECT * INTO v_before FROM public.claims_records WHERE id = p_target_claim_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'claim_record_not_found: %', p_target_claim_id USING ERRCODE = 'P0010';
    END IF;
    IF v_before.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_target_claim_id, p_patient_id USING ERRCODE = 'P0011';
    END IF;
    IF v_before.cms1500_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'claim_record_has_cms1500: %', p_target_claim_id USING ERRCODE = 'P0025';
    END IF;
    IF v_before.date_of_service IS DISTINCT FROM v_dos OR v_before.cpt_codes IS DISTINCT FROM v_cpt THEN
      RAISE EXCEPTION 'claim_record_incompatible: date/CPT differ' USING ERRCODE = 'P0026';
    END IF;
    v_action := 'CLAIM_RECORD_CMS1500_ASSOCIATE';
  ELSE
    IF NOT COALESCE(p_allow_new_distinct, false) AND EXISTS (
      SELECT 1 FROM public.claims_records r
      WHERE r.patient_id = p_patient_id
        AND r.date_of_service = v_dos
        AND r.cpt_codes = v_cpt
        AND (
          r.cms1500_document_id IS DISTINCT FROM v_doc
          OR NOT (r.cms1500_line_key = ANY (COALESCE(p_sibling_line_keys, ARRAY[]::text[])))
        )
    ) THEN
      RAISE EXCEPTION 'needs_selection: an existing claim line already sits at this date and CPT' USING ERRCODE = 'P0021';
    END IF;
    IF p_auth_period IS NULL OR p_auth_period < 1 THEN
      RAISE EXCEPTION 'period_required: a new line needs an authorization period' USING ERRCODE = 'P0029';
    END IF;

    v_after := jsonb_populate_record(NULL::public.claims_records, v_clean);
    INSERT INTO public.claims_records (
      patient_id, auth_period, place_of_service, date_of_service, visit_number, cpt_codes,
      units_billed, diagnosis_codes, modifier, insurance_billed, claim_submitted_date,
      claim_status, cms1500_document_id, cms1500_line_key,
      created_by, created_by_type, updated_by, updated_by_type
    ) VALUES (
      p_patient_id, p_auth_period, v_after.place_of_service, v_after.date_of_service, v_after.visit_number, v_after.cpt_codes,
      v_after.units_billed, v_after.diagnosis_codes, v_after.modifier, v_after.insurance_billed, v_after.claim_submitted_date,
      'submitted', v_doc, p_line_key,
      p_actor_id, p_actor_type, p_actor_id, p_actor_type
    )
    RETURNING * INTO v_after;

    FOR v_key IN SELECT jsonb_object_keys(v_clean) LOOP
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END LOOP;
    v_after_diff := v_after_diff || jsonb_build_object(
      'auth_period', v_after.auth_period,
      'cms1500_document_id', v_doc,
      'cms1500_line_key', p_line_key
    );

    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data, import_batch_id
    ) VALUES (
      'claim_record', v_after.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      'CLAIM_RECORD_CMS1500_CREATE', NULL, v_after_diff, p_import_batch_id
    );

    RETURN jsonb_build_object('status', 'created', 'claim_id', v_after.id, 'auth_period', v_after.auth_period, 'document_id', v_doc);
  END IF;

  -- Re-apply / associate: patch clinical fields + provenance on v_before.
  v_after := jsonb_populate_record(v_before, v_clean);
  v_after.cms1500_document_id := v_doc;
  v_after.cms1500_line_key := p_line_key;

  FOR v_key IN SELECT unnest(c_clinical || ARRAY['cms1500_document_id', 'cms1500_line_key']) LOOP
    IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
      v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END IF;
  END LOOP;

  IF v_before_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('status', 'unchanged', 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
  END IF;

  UPDATE public.claims_records SET
    date_of_service = v_after.date_of_service,
    cpt_codes = v_after.cpt_codes,
    place_of_service = v_after.place_of_service,
    modifier = v_after.modifier,
    units_billed = v_after.units_billed,
    diagnosis_codes = v_after.diagnosis_codes,
    claim_submitted_date = v_after.claim_submitted_date,
    insurance_billed = v_after.insurance_billed,
    visit_number = v_after.visit_number,
    cms1500_document_id = v_after.cms1500_document_id,
    cms1500_line_key = v_after.cms1500_line_key,
    updated_by = p_actor_id,
    updated_by_type = p_actor_type
  WHERE id = v_before.id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'claim_record', v_before.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    v_action, v_before_diff, v_after_diff, p_import_batch_id
  );

  v_status := CASE WHEN v_action = 'CLAIM_RECORD_CMS1500_ASSOCIATE' THEN 'associated' ELSE 'updated' END;
  RETURN jsonb_build_object('status', v_status, 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_cms1500_line_with_audit(uuid, integer, text, text, integer, text, text[], uuid, boolean, jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_cms1500_line_with_audit(uuid, integer, text, text, integer, text, text[], uuid, boolean, jsonb, uuid, text, text, uuid) TO service_role;

-- ─── apply_eob_line_with_audit ─────────────────────────────────────────────
-- p_match carries the EOB line's own date_of_service / cpt_codes, checked
-- against the target row. p_data carries ONLY financial / adjudication keys;
-- anything else is ignored, and a JSON null (unknown) never overwrites a
-- stored value. Accepted:
--   charge_amount (billed), insurance_reimbursement, payment_received,
--   patient_amount_due (patient responsibility), patient_amount_paid,
--   claim_status, oa_claim_number, check_date, check_number_virtual_card,
--   date_received, expire_bcbs_claim_number.
-- Clinical fields (CPT, modifiers, units, diagnosis) are never written: the
-- CMS1500 owns them.
-- p_confirm_replace is the explicit reviewed decision required to (a)
-- overwrite a different non-null amount already on the row (manual or
-- historical reimbursement-first money), or (b) move the row's EOB
-- provenance from another EOB line (a corrected/reprocessed EOB).
CREATE OR REPLACE FUNCTION public.apply_eob_line_with_audit(
  p_patient_id uuid,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_line_key text,
  p_target_claim_id uuid,
  p_match jsonb,
  p_confirm_replace boolean,
  p_data jsonb,
  p_actor_id uuid,
  p_actor_type text,
  p_actor_display text,
  p_import_batch_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  c_financial constant text[] := ARRAY[
    'charge_amount', 'insurance_reimbursement', 'payment_received', 'patient_amount_due',
    'patient_amount_paid', 'claim_status', 'oa_claim_number', 'check_date',
    'check_number_virtual_card', 'date_received', 'expire_bcbs_claim_number'
  ];
  v_doc uuid;
  v_clean jsonb;
  v_prev_id uuid;
  v_same_line boolean;
  v_before public.claims_records;
  v_after public.claims_records;
  v_key text;
  v_before_diff jsonb := '{}'::jsonb;
  v_after_diff jsonb := '{}'::jsonb;
BEGIN
  IF p_patient_id IS NULL OR p_target_claim_id IS NULL OR p_line_key IS NULL
     OR p_line_key !~ '^[A-Za-z0-9:_.,-]{1,160}$' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/target/line key' USING ERRCODE = 'P0027';
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_clean
  FROM jsonb_each(COALESCE(p_data, '{}'::jsonb))
  WHERE key = ANY (c_financial) AND value <> 'null'::jsonb;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-patient:' || p_patient_id::text));
  v_doc := public.claim_import_document_id('eob', p_content_sha256, p_file_name, p_page_count, p_actor_id, p_actor_type);

  SELECT id INTO v_prev_id FROM public.claims_records
  WHERE eob_document_id = v_doc AND eob_line_key = p_line_key;
  IF v_prev_id IS NOT NULL AND v_prev_id <> p_target_claim_id THEN
    RAISE EXCEPTION 'source_line_already_saved: %', v_prev_id USING ERRCODE = 'P0024';
  END IF;

  SELECT * INTO v_before FROM public.claims_records WHERE id = p_target_claim_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'claim_record_not_found: %', p_target_claim_id USING ERRCODE = 'P0010';
  END IF;
  IF v_before.patient_id <> p_patient_id THEN
    RAISE EXCEPTION 'claim_record_patient_mismatch: % does not belong to %', p_target_claim_id, p_patient_id USING ERRCODE = 'P0011';
  END IF;
  IF v_before.cms1500_document_id IS NULL THEN
    RAISE EXCEPTION 'cms1500_required: upload the matching CMS1500 first' USING ERRCODE = 'P0022';
  END IF;
  IF v_before.date_of_service IS DISTINCT FROM (p_match ->> 'date_of_service')::date
     OR v_before.cpt_codes IS DISTINCT FROM NULLIF(btrim(p_match ->> 'cpt_codes'), '') THEN
    RAISE EXCEPTION 'claim_record_incompatible: date/CPT differ' USING ERRCODE = 'P0026';
  END IF;
  v_same_line := v_before.eob_document_id IS NOT DISTINCT FROM v_doc
    AND v_before.eob_line_key IS NOT DISTINCT FROM p_line_key;
  IF v_before.eob_document_id IS NOT NULL AND NOT v_same_line
     AND NOT COALESCE(p_confirm_replace, false) THEN
    RAISE EXCEPTION 'already_reconciled: row carries another EOB line' USING ERRCODE = 'P0023';
  END IF;

  v_after := jsonb_populate_record(v_before, v_clean);

  IF NOT COALESCE(p_confirm_replace, false) AND NOT v_same_line THEN
    FOR v_key IN SELECT jsonb_object_keys(v_clean) LOOP
      IF v_key <> 'claim_status'
         AND (to_jsonb(v_before) -> v_key) <> 'null'::jsonb
         AND (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
        RAISE EXCEPTION 'existing_financials: % already has a different value', v_key USING ERRCODE = 'P0028';
      END IF;
    END LOOP;
  END IF;

  v_after.eob_document_id := v_doc;
  v_after.eob_line_key := p_line_key;

  FOR v_key IN SELECT unnest(c_financial || ARRAY['eob_document_id', 'eob_line_key']) LOOP
    IF (to_jsonb(v_before) -> v_key) IS DISTINCT FROM (to_jsonb(v_after) -> v_key) THEN
      v_before_diff := v_before_diff || jsonb_build_object(v_key, to_jsonb(v_before) -> v_key);
      v_after_diff := v_after_diff || jsonb_build_object(v_key, to_jsonb(v_after) -> v_key);
    END IF;
  END LOOP;

  IF v_before_diff = '{}'::jsonb THEN
    RETURN jsonb_build_object('status', 'unchanged', 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
  END IF;

  UPDATE public.claims_records SET
    charge_amount = v_after.charge_amount,
    insurance_reimbursement = v_after.insurance_reimbursement,
    payment_received = v_after.payment_received,
    patient_amount_due = v_after.patient_amount_due,
    patient_amount_paid = v_after.patient_amount_paid,
    claim_status = v_after.claim_status,
    oa_claim_number = v_after.oa_claim_number,
    check_date = v_after.check_date,
    check_number_virtual_card = v_after.check_number_virtual_card,
    date_received = v_after.date_received,
    expire_bcbs_claim_number = v_after.expire_bcbs_claim_number,
    eob_document_id = v_after.eob_document_id,
    eob_line_key = v_after.eob_line_key,
    updated_by = p_actor_id,
    updated_by_type = p_actor_type
  WHERE id = v_before.id;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'claim_record', v_before.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'CLAIM_RECORD_EOB_APPLY', v_before_diff, v_after_diff, p_import_batch_id
  );

  RETURN jsonb_build_object('status', 'saved', 'claim_id', v_before.id, 'auth_period', v_before.auth_period, 'document_id', v_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_eob_line_with_audit(uuid, text, text, integer, text, uuid, jsonb, boolean, jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_eob_line_with_audit(uuid, text, text, integer, text, uuid, jsonb, boolean, jsonb, uuid, text, text, uuid) TO service_role;

COMMIT;
