-- ============================================================================
-- P4-P7: Insurance Company Management
--
-- Adds public.insurer_catalog — the single source of truth for insurer
-- choices shown in patient forms, insurance filters, and the generic claims
-- import path. Staff can add new insurers from the dashboard without a code
-- change going forward (see insurance.create in server/routers.ts).
--
-- Normalized-name uniqueness (case/whitespace-insensitive) is enforced at
-- the database level via a unique index on normalized_name, so two
-- simultaneous "Add Insurance Company" submissions for the same name (in any
-- casing/spacing) can never both succeed — the server's own pre-check is
-- just a fast-path UX improvement, not the real guard.
--
-- `aliases` preserves old display names for a product that was renamed (see
-- the "United Healthcare Medicare" -> "United Healthcare Medicare Advantage"
-- backfill below) so existing patient/claim rows storing the old name still
-- resolve to the same catalog entry for filtering/counting. It does NOT
-- merge distinct products — only this one explicit, intentional rename.
--
-- Written idempotently (IF NOT EXISTS / ON CONFLICT DO NOTHING) matching the
-- style of 20260923000000_audit_logs.sql, so this file is safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.insurer_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS insurer_catalog_normalized_name_key
  ON public.insurer_catalog (normalized_name);

-- ─── Backfill: previously hard-coded insurer choices ───────────────────────
-- (client/src/pages/Dashboard.tsx's old `insuranceList` / AuthAlertPanel's
-- duplicate of it), minus "United Healthcare Medicare" which is handled
-- below as an alias of its corrected display name instead of its own row.
INSERT INTO public.insurer_catalog (name, normalized_name)
VALUES
  ('AARP Medicare Advantage', 'aarp medicare advantage'),
  ('AARP Medicare Supplement', 'aarp medicare supplement'),
  ('Aetna', 'aetna'),
  ('Aetna International', 'aetna international'),
  ('American Transit', 'american transit'),
  ('Cigna Healthcare', 'cigna healthcare'),
  ('Emblem Health', 'emblem health'),
  ('Emblem Health GHI Senior', 'emblem health ghi senior'),
  ('Empire NYSHIP (United Healthcare)', 'empire nyship (united healthcare)'),
  ('GEICO NY PIP', 'geico ny pip'),
  ('Global Excel Management', 'global excel management'),
  ('Humana', 'humana'),
  ('Kaiser Permanente', 'kaiser permanente'),
  ('Medicare - Queens (Part B)', 'medicare - queens (part b)'),
  ('Meritain Health', 'meritain health'),
  ('NYCE PPO Plan', 'nyce ppo plan'),
  ('NY Empire BCBS', 'ny empire bcbs'),
  ('Oxford Health Insurance', 'oxford health insurance'),
  ('Progressive No Fault', 'progressive no fault'),
  ('United Healthcare', 'united healthcare')
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Name correction: "United Healthcare Medicare" -> "United Healthcare
-- Medicare Advantage", preserving the old name as an alias so existing
-- patients/claims stored under the old name keep matching. Deliberately NOT
-- merged with the plain "United Healthcare" row above — that's a different
-- product and must stay a separate catalog entry.
INSERT INTO public.insurer_catalog (name, normalized_name, aliases)
VALUES (
  'United Healthcare Medicare Advantage',
  'united healthcare medicare advantage',
  ARRAY['United Healthcare Medicare']
)
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Initial requested insurers (P4-P7) ────────────────────────────────────
INSERT INTO public.insurer_catalog (name, normalized_name)
VALUES
  ('Aegis One Inc.', 'aegis one inc.'),
  ('UMR', 'umr'),
  ('Gallagher Bassett', 'gallagher bassett'),
  ('Magnacare', 'magnacare'),
  ('UHC Global', 'uhc global'),
  ('WellCare', 'wellcare'),
  ('TPA Exchange', 'tpa exchange'),
  ('Hanover', 'hanover')
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Backfill: distinct insurer names already stored on existing patients/
-- visits that aren't covered by the lists above (e.g. values entered via
-- CSV import or manual edit before this feature existed). Excludes the old
-- "United Healthcare Medicare" value, which is handled as an alias above,
-- not a separate catalog row.
INSERT INTO public.insurer_catalog (name, normalized_name)
SELECT DISTINCT
  trim(regexp_replace(src.insurance, '\s+', ' ', 'g')),
  lower(trim(regexp_replace(src.insurance, '\s+', ' ', 'g')))
FROM (
  SELECT insurance FROM public.patients WHERE insurance IS NOT NULL AND trim(insurance) <> ''
  UNION ALL
  SELECT insurance_company FROM public.visit_records WHERE insurance_company IS NOT NULL AND trim(insurance_company) <> ''
) AS src
WHERE lower(trim(regexp_replace(src.insurance, '\s+', ' ', 'g'))) <> 'united healthcare medicare'
ON CONFLICT (normalized_name) DO NOTHING;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS insurer_catalog_normalized_name_key;
-- DROP TABLE IF EXISTS public.insurer_catalog;
-- COMMIT;
