-- ============================================================================
-- P4-P28: automatic patient creation for reviewed claim imports, external
-- patient-ID mappings, and pending (CMS1500-not-yet-saved) EOB lines.
--
-- New, all additive:
--   patient_external_ids   who a source system's patient id refers to, in that
--                          system's own namespace. UNIQUE (source_system,
--                          external_id), so one external id can never point at
--                          two patients. birth_date is identity evidence from
--                          the file; patients has no date of birth column and
--                          this does not add one. Also records which import
--                          document group created a patient
--                          (source_system 'claims_import_group'), so retrying
--                          the same group can never create a second patient.
--   pending_eob_lines      a reviewed EOB line whose matching CMS1500 line does
--                          not exist yet. Nothing here is a payment: no claim
--                          row is created or changed until the line is applied
--                          through apply_eob_line_with_audit (CMS1500-first is
--                          still enforced there).
--   commit_import_with_new_patient(...)  one transaction: the patient, its
--                          mapping(s), its audit rows, and every reviewed line
--                          of that group. Any failure, including an audit
--                          insert, rolls all of it back, so a patient can never
--                          exist without the import work that justified it.
--   link_patient_external_id_with_audit(...)  reviewed link to an existing patient.
--   hold_eob_line_with_audit(...)        keeps one EOB line pending.
--   apply_pending_eob_line_with_audit(...)  applies one pending line.
--   dismiss_pending_eob_line_with_audit(...) reviewer closes a pending line.
--   trg_claims_records_resolve_pending   marks a pending line applied whenever
--                          its source line lands on a claim row by any path
--                          (e.g. the EOB is uploaded again after the CMS1500),
--                          atomically with that write.
--
-- Concurrency: every new-patient commit takes one transaction-scoped advisory
-- lock, then re-checks the mapping, the creation key and the name, so two
-- concurrent imports of one person create one patient. Line writes keep their
-- per-patient lock; that lock is only ever taken after this one.
--
-- Error codes (mapped to typed errors in server/db.ts):
--   P0030 a patient with this name now exists (re-check the review)
--   P0031 this external id already belongs to a different patient
--   P0032 this EOB line is no longer waiting for a CMS1500
--
-- Compatibility during the migration-before-deploy window: nothing existing is
-- altered except widening audit_logs_entity_type_check, so the currently
-- deployed app keeps working against this schema. The new app code REQUIRES
-- this migration: apply it first.
--
-- Written idempotently, safe to re-run.
--
-- Rollback (manual, only after the app is rolled back; pending lines are lost,
-- so export them first):
--   DROP TRIGGER IF EXISTS trg_claims_records_resolve_pending ON public.claims_records;
--   DROP FUNCTION IF EXISTS public.claims_records_resolve_pending();
--   DROP FUNCTION IF EXISTS public.dismiss_pending_eob_line_with_audit(uuid, uuid, text, text);
--   DROP FUNCTION IF EXISTS public.apply_pending_eob_line_with_audit(uuid, uuid, boolean, uuid, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.commit_import_with_new_patient(text, text, text, text, date, text, boolean, text, text, integer, text[], jsonb, uuid, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.hold_eob_line_with_audit(uuid, text, text, integer, text, jsonb, jsonb, jsonb, uuid, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.link_patient_external_id_with_audit(uuid, text, text, date, uuid, text, text, uuid);
--   DROP FUNCTION IF EXISTS public.import_patient_name_key(text);
--   DROP TABLE IF EXISTS public.pending_eob_lines;
--   DROP TABLE IF EXISTS public.patient_external_ids;
--   (patients created by imports remain; they are ordinary patient rows.)
-- ============================================================================

BEGIN;

-- ─── audit_logs: new entity type ───────────────────────────────────────────
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_entity_type_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_entity_type_check CHECK (
  entity_type IS NULL OR entity_type IN (
    'patient', 'visit_record', 'claim_record', 'insurer_catalog', 'clinic_user', 'pending_eob_line'
  )
);

-- ─── patient_external_ids ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.patient_external_ids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  source_system text NOT NULL CHECK (source_system ~ '^[a-z0-9_]{1,60}$'),
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 200),
  birth_date date,
  created_by uuid,
  created_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_external_ids_source_id_key UNIQUE (source_system, external_id)
);
CREATE INDEX IF NOT EXISTS idx_patient_external_ids_patient ON public.patient_external_ids (patient_id);

ALTER TABLE public.patient_external_ids ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_external_ids NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.patient_external_ids FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.patient_external_ids TO service_role;

-- ─── pending_eob_lines ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pending_eob_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.claim_import_documents(id),
  line_key text NOT NULL CHECK (line_key ~ '^[A-Za-z0-9:_.,-]{1,160}$'),
  date_of_service date NOT NULL,
  cpt_codes text NOT NULL,
  modifier text,
  units_billed integer,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  target jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  applied_claim_id uuid REFERENCES public.claims_records(id) ON DELETE SET NULL,
  created_by uuid,
  created_by_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT pending_eob_lines_source_line_key UNIQUE (document_id, line_key)
);
CREATE INDEX IF NOT EXISTS idx_pending_eob_lines_open ON public.pending_eob_lines (created_at) WHERE status = 'pending';

ALTER TABLE public.pending_eob_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_eob_lines NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.pending_eob_lines FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pending_eob_lines TO service_role;

-- ─── helper: order-insensitive name key (same rule as shared/nameMatch.ts) ─
CREATE OR REPLACE FUNCTION public.import_patient_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT string_agg(t, ' ' ORDER BY t)
  FROM regexp_split_to_table(regexp_replace(regexp_replace(upper(COALESCE(p_name, '')), '[''’]', '', 'g'), '[,.\s-]+', ' ', 'g'), ' ') AS t
  WHERE t <> ''
$$;

REVOKE ALL ON FUNCTION public.import_patient_name_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_patient_name_key(text) TO service_role;

-- ─── link_patient_external_id_with_audit ───────────────────────────────────
-- A reviewed link between an existing patient and an external id. Never
-- changes the patient row. A repeat is a no-op with no audit row.
CREATE OR REPLACE FUNCTION public.link_patient_external_id_with_audit(
  p_patient_id uuid,
  p_source_system text,
  p_external_id text,
  p_birth_date date,
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
  v_existing uuid;
  v_id uuid;
BEGIN
  IF p_patient_id IS NULL OR p_external_id IS NULL OR btrim(p_external_id) = '' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/external id' USING ERRCODE = 'P0027';
  END IF;
  PERFORM 1 FROM public.patients WHERE id = p_patient_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'patient_not_found: %', p_patient_id USING ERRCODE = 'P0020';
  END IF;

  INSERT INTO public.patient_external_ids (patient_id, source_system, external_id, birth_date, created_by, created_by_type)
  VALUES (p_patient_id, p_source_system, p_external_id, p_birth_date, p_actor_id, p_actor_type)
  ON CONFLICT ON CONSTRAINT patient_external_ids_source_id_key DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT patient_id INTO v_existing FROM public.patient_external_ids
    WHERE source_system = p_source_system AND external_id = p_external_id;
    IF v_existing <> p_patient_id THEN
      RAISE EXCEPTION 'external_id_taken: belongs to another patient' USING ERRCODE = 'P0031';
    END IF;
    RETURN jsonb_build_object('status', 'unchanged');
  END IF;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'patient', p_patient_id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'PATIENT_EXTERNAL_ID_LINK', NULL,
    jsonb_build_object('source_system', p_source_system, 'external_id', p_external_id),
    p_import_batch_id
  );
  RETURN jsonb_build_object('status', 'linked');
END;
$$;

REVOKE ALL ON FUNCTION public.link_patient_external_id_with_audit(uuid, text, text, date, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_patient_external_id_with_audit(uuid, text, text, date, uuid, text, text, uuid) TO service_role;

-- ─── hold_eob_line_with_audit ──────────────────────────────────────────────
-- Keeps one reviewed EOB line pending. p_match: date_of_service, cpt_codes,
-- modifier, units_billed. p_data: the same financial keys
-- apply_eob_line_with_audit accepts. p_target: optional CMS1500 reference from
-- a CSV row (cms1500_sha256, line_key, label, auth_period).
-- Refused (P0032) when a claim row already carries this source line. A retry
-- with the same values is a no-op with no audit row; a corrected re-import
-- updates the line, and any reviewed save leaves it pending.
CREATE OR REPLACE FUNCTION public.hold_eob_line_with_audit(
  p_patient_id uuid,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_line_key text,
  p_match jsonb,
  p_data jsonb,
  p_target jsonb,
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
  v_dos date;
  v_cpt text;
  v_row public.pending_eob_lines;
BEGIN
  IF p_patient_id IS NULL OR p_line_key IS NULL OR p_line_key !~ '^[A-Za-z0-9:_.,-]{1,160}$' THEN
    RAISE EXCEPTION 'invalid_import_input: patient/line key' USING ERRCODE = 'P0027';
  END IF;
  v_dos := (p_match ->> 'date_of_service')::date;
  v_cpt := NULLIF(btrim(p_match ->> 'cpt_codes'), '');
  IF v_dos IS NULL OR v_cpt IS NULL THEN
    RAISE EXCEPTION 'invalid_import_input: date_of_service and cpt_codes are required' USING ERRCODE = 'P0027';
  END IF;

  SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_clean
  FROM jsonb_each(COALESCE(p_data, '{}'::jsonb))
  WHERE key = ANY (c_financial) AND value <> 'null'::jsonb;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-patient:' || p_patient_id::text));
  v_doc := public.claim_import_document_id('eob', p_content_sha256, p_file_name, p_page_count, p_actor_id, p_actor_type);

  IF EXISTS (SELECT 1 FROM public.claims_records WHERE eob_document_id = v_doc AND eob_line_key = p_line_key) THEN
    RAISE EXCEPTION 'pending_not_needed: this line is already on a claim row' USING ERRCODE = 'P0032';
  END IF;

  SELECT * INTO v_row FROM public.pending_eob_lines
  WHERE document_id = v_doc AND line_key = p_line_key FOR UPDATE;

  IF FOUND THEN
    IF v_row.patient_id <> p_patient_id THEN
      RAISE EXCEPTION 'pending_line_patient_mismatch: saved for another patient' USING ERRCODE = 'P0011';
    END IF;
    -- A new reviewed save reopens a line that was dismissed, or applied to a
    -- claim row since deleted (a row still carrying it was refused above).
    IF v_row.status = 'pending' AND (
      v_row.data = v_clean AND v_row.date_of_service = v_dos AND v_row.cpt_codes = v_cpt
      AND v_row.modifier IS NOT DISTINCT FROM (p_match ->> 'modifier')
      AND v_row.units_billed IS NOT DISTINCT FROM (p_match ->> 'units_billed')::integer
      AND v_row.target IS NOT DISTINCT FROM p_target
    ) THEN
      RETURN jsonb_build_object('status', 'unchanged', 'pending_id', v_row.id, 'document_id', v_doc);
    END IF;
    UPDATE public.pending_eob_lines SET
      date_of_service = v_dos, cpt_codes = v_cpt, modifier = p_match ->> 'modifier',
      units_billed = (p_match ->> 'units_billed')::integer, data = v_clean, target = p_target,
      status = 'pending', applied_claim_id = NULL, resolved_at = NULL
    WHERE id = v_row.id;
    INSERT INTO public.audit_logs (
      entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
      action, before_data, after_data, import_batch_id
    ) VALUES (
      'pending_eob_line', v_row.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
      'EOB_LINE_PENDING_UPDATE',
      jsonb_build_object('status', v_row.status, 'date_of_service', v_row.date_of_service, 'cpt_codes', v_row.cpt_codes, 'data', v_row.data),
      jsonb_build_object('status', 'pending', 'date_of_service', v_dos, 'cpt_codes', v_cpt, 'data', v_clean),
      p_import_batch_id
    );
    RETURN jsonb_build_object('status', 'updated', 'pending_id', v_row.id, 'document_id', v_doc);
  END IF;

  INSERT INTO public.pending_eob_lines (
    patient_id, document_id, line_key, date_of_service, cpt_codes, modifier, units_billed, data, target,
    created_by, created_by_type
  ) VALUES (
    p_patient_id, v_doc, p_line_key, v_dos, v_cpt, p_match ->> 'modifier', (p_match ->> 'units_billed')::integer, v_clean, p_target,
    p_actor_id, p_actor_type
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'pending_eob_line', v_row.id, p_patient_id, p_actor_id, p_actor_type, p_actor_display,
    'EOB_LINE_PENDING_CREATE', NULL,
    jsonb_build_object('date_of_service', v_dos, 'cpt_codes', v_cpt, 'document_id', v_doc, 'line_key', p_line_key, 'data', v_clean),
    p_import_batch_id
  );
  RETURN jsonb_build_object('status', 'created', 'pending_id', v_row.id, 'document_id', v_doc);
END;
$$;

REVOKE ALL ON FUNCTION public.hold_eob_line_with_audit(uuid, text, text, integer, text, jsonb, jsonb, jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hold_eob_line_with_audit(uuid, text, text, integer, text, jsonb, jsonb, jsonb, uuid, text, text, uuid) TO service_role;

-- ─── commit_import_with_new_patient ────────────────────────────────────────
-- The whole first save of a group whose patient does not exist yet.
--   p_kind 'cms1500': each p_lines item is { line_key, auth_period, data } as
--     commit_cms1500_line_with_audit takes them.
--   p_kind 'eob': each item is { line_key, match, data, target } as
--     hold_eob_line_with_audit takes them. An EOB never creates a claim row.
-- Returns status 'patient_exists' (with patient_id, and writes nothing) when
-- the external id or this group's creation key is already mapped: the caller
-- then saves through the normal per-line path for that patient, which is what
-- makes retries and concurrent imports converge on one patient.
-- Only name is written to the patient: insurance stays '' and every
-- authorization field stays NULL. Requires at least one line, so a save with
-- nothing to keep can never leave an orphan patient behind.
CREATE OR REPLACE FUNCTION public.commit_import_with_new_patient(
  p_kind text,
  p_patient_name text,
  p_source_system text,
  p_external_id text,
  p_birth_date date,
  p_creation_key text,
  p_allow_same_name boolean,
  p_content_sha256 text,
  p_file_name text,
  p_page_count integer,
  p_sibling_line_keys text[],
  p_lines jsonb,
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
  v_name text := NULLIF(btrim(COALESCE(p_patient_name, '')), '');
  v_existing uuid;
  v_patient uuid;
  v_item jsonb;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
BEGIN
  IF p_kind NOT IN ('cms1500', 'eob') OR v_name IS NULL OR char_length(v_name) > 200
     OR p_creation_key IS NULL OR p_creation_key = ''
     OR p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'invalid_import_input: new patient name, creation key and at least one line are required' USING ERRCODE = 'P0027';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('claims-import-new-patient'));

  IF p_external_id IS NOT NULL AND p_source_system IS NOT NULL THEN
    SELECT patient_id INTO v_existing FROM public.patient_external_ids
    WHERE source_system = p_source_system AND external_id = p_external_id;
  END IF;
  IF v_existing IS NULL THEN
    SELECT patient_id INTO v_existing FROM public.patient_external_ids
    WHERE source_system = 'claims_import_group' AND external_id = p_creation_key;
  END IF;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'patient_exists', 'patient_id', v_existing);
  END IF;

  IF NOT COALESCE(p_allow_same_name, false) AND EXISTS (
    SELECT 1 FROM public.patients WHERE public.import_patient_name_key(name) = public.import_patient_name_key(v_name)
  ) THEN
    RAISE EXCEPTION 'patient_name_exists: re-check the review' USING ERRCODE = 'P0030';
  END IF;

  INSERT INTO public.patients (name, created_by, created_by_type, updated_by, updated_by_type)
  VALUES (v_name, p_actor_id, p_actor_type, p_actor_id, p_actor_type)
  RETURNING id INTO v_patient;

  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data, import_batch_id
  ) VALUES (
    'patient', v_patient, v_patient, p_actor_id, p_actor_type, p_actor_display,
    'PATIENT_CREATE_FROM_IMPORT', NULL,
    jsonb_build_object('name', v_name, 'source_kind', p_kind, 'source_file', left(p_file_name, 255)),
    p_import_batch_id
  );

  INSERT INTO public.patient_external_ids (patient_id, source_system, external_id, birth_date, created_by, created_by_type)
  VALUES (v_patient, 'claims_import_group', p_creation_key, p_birth_date, p_actor_id, p_actor_type);

  IF p_external_id IS NOT NULL AND p_source_system IS NOT NULL THEN
    PERFORM public.link_patient_external_id_with_audit(
      v_patient, p_source_system, p_external_id, p_birth_date, p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
    );
  END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF p_kind = 'cms1500' THEN
      v_result := public.commit_cms1500_line_with_audit(
        v_patient, (v_item ->> 'auth_period')::integer, p_content_sha256, p_file_name, p_page_count,
        v_item ->> 'line_key', p_sibling_line_keys, NULL, false, v_item -> 'data',
        p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
      );
    ELSE
      v_result := public.hold_eob_line_with_audit(
        v_patient, p_content_sha256, p_file_name, p_page_count, v_item ->> 'line_key',
        v_item -> 'match', v_item -> 'data', NULLIF(v_item -> 'target', 'null'::jsonb),
        p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
      );
    END IF;
    v_results := v_results || jsonb_build_array(v_result || jsonb_build_object('line_key', v_item ->> 'line_key'));
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'patient_id', v_patient, 'lines', v_results);
END;
$$;

REVOKE ALL ON FUNCTION public.commit_import_with_new_patient(text, text, text, text, date, text, boolean, text, text, integer, text[], jsonb, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_import_with_new_patient(text, text, text, text, date, text, boolean, text, text, integer, text[], jsonb, uuid, text, text, uuid) TO service_role;

-- ─── apply_pending_eob_line_with_audit ─────────────────────────────────────
-- Applies a pending line through apply_eob_line_with_audit, so every
-- CMS1500-first, double-payment and replace rule is the same one a normal EOB
-- save goes through. A second call on an applied line changes nothing.
CREATE OR REPLACE FUNCTION public.apply_pending_eob_line_with_audit(
  p_pending_id uuid,
  p_target_claim_id uuid,
  p_confirm_replace boolean,
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
  v_row public.pending_eob_lines;
  v_doc public.claim_import_documents;
  v_result jsonb;
BEGIN
  SELECT * INTO v_row FROM public.pending_eob_lines WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending_line_not_found: %', p_pending_id USING ERRCODE = 'P0010';
  END IF;
  IF v_row.status = 'applied' THEN
    RETURN jsonb_build_object('status', 'unchanged', 'claim_id', v_row.applied_claim_id, 'document_id', v_row.document_id,
      'auth_period', (SELECT auth_period FROM public.claims_records WHERE id = v_row.applied_claim_id));
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'pending_not_needed: this line was dismissed' USING ERRCODE = 'P0032';
  END IF;
  SELECT * INTO v_doc FROM public.claim_import_documents WHERE id = v_row.document_id;

  v_result := public.apply_eob_line_with_audit(
    v_row.patient_id, v_doc.content_sha256, v_doc.file_name, v_doc.page_count, v_row.line_key, p_target_claim_id,
    jsonb_build_object('date_of_service', v_row.date_of_service, 'cpt_codes', v_row.cpt_codes),
    p_confirm_replace, v_row.data, p_actor_id, p_actor_type, p_actor_display, p_import_batch_id
  );
  -- Covers the no-op case too, where no claim row changed and the trigger did not fire.
  UPDATE public.pending_eob_lines
  SET status = 'applied', applied_claim_id = (v_result ->> 'claim_id')::uuid, resolved_at = now()
  WHERE id = p_pending_id AND status = 'pending';
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_pending_eob_line_with_audit(uuid, uuid, boolean, uuid, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pending_eob_line_with_audit(uuid, uuid, boolean, uuid, text, text, uuid) TO service_role;

-- ─── dismiss_pending_eob_line_with_audit ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.dismiss_pending_eob_line_with_audit(
  p_pending_id uuid,
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
  v_row public.pending_eob_lines;
BEGIN
  SELECT * INTO v_row FROM public.pending_eob_lines WHERE id = p_pending_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pending_line_not_found: %', p_pending_id USING ERRCODE = 'P0010';
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'unchanged');
  END IF;
  UPDATE public.pending_eob_lines SET status = 'dismissed', resolved_at = now() WHERE id = p_pending_id;
  INSERT INTO public.audit_logs (
    entity_type, entity_id, patient_id, actor_id, actor_type, actor_display,
    action, before_data, after_data
  ) VALUES (
    'pending_eob_line', v_row.id, v_row.patient_id, p_actor_id, p_actor_type, p_actor_display,
    'EOB_LINE_PENDING_DISMISS', jsonb_build_object('status', 'pending', 'data', v_row.data), jsonb_build_object('status', 'dismissed')
  );
  RETURN jsonb_build_object('status', 'dismissed');
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_pending_eob_line_with_audit(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_pending_eob_line_with_audit(uuid, uuid, text, text) TO service_role;

-- ─── a pending line resolves when its source line lands on a claim row ─────
CREATE OR REPLACE FUNCTION public.claims_records_resolve_pending()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.pending_eob_lines
  SET status = 'applied', applied_claim_id = NEW.id, resolved_at = now()
  WHERE document_id = NEW.eob_document_id AND line_key = NEW.eob_line_key AND status = 'pending';
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.claims_records_resolve_pending() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_claims_records_resolve_pending ON public.claims_records;
CREATE TRIGGER trg_claims_records_resolve_pending
  AFTER UPDATE OF eob_document_id, eob_line_key ON public.claims_records
  FOR EACH ROW
  WHEN (NEW.eob_document_id IS NOT NULL AND (OLD.eob_document_id IS DISTINCT FROM NEW.eob_document_id OR OLD.eob_line_key IS DISTINCT FROM NEW.eob_line_key))
  EXECUTE FUNCTION public.claims_records_resolve_pending();

COMMIT;
