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
-- normalized_name is a GENERATED column, NOT an application-supplied value —
-- the DB derives it from `name` using the exact same rule as the server/
-- client (shared/insuranceCatalog.ts normalizeInsurerName: trim, collapse
-- internal whitespace runs to a single space, lowercase). This closes the
-- gap where a caller (a bug, a future direct-insert code path, a different
-- client) could otherwise supply a normalized_name that disagrees with
-- `name`, which would silently break the uniqueness guarantee's integrity.
--
-- `aliases` preserves old display names for a product that was renamed (see
-- the "United Healthcare Medicare" -> "United Healthcare Medicare Advantage"
-- backfill below) so existing patient/claim rows storing the old name still
-- resolve to the same catalog entry for filtering/counting. It does NOT
-- merge distinct products — only this one explicit, intentional rename.
--
-- Written idempotently (IF NOT EXISTS / ON CONFLICT DO NOTHING) matching the
-- style of 20260923000000_audit_logs.sql, so this file is safe to re-run —
-- including re-running against a table created by an earlier version of
-- this migration that had normalized_name as a plain application-supplied
-- column (the DO block below upgrades it to the generated form in place).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.insurer_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Upgrade path: if an earlier run of this file left normalized_name as a
-- plain (non-generated) column, drop it so it can be re-added as generated
-- below — existing `name` values are untouched, so the generated value is
-- recomputed from them automatically.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'insurer_catalog'
      AND column_name = 'normalized_name' AND is_generated = 'NEVER'
  ) THEN
    ALTER TABLE public.insurer_catalog DROP COLUMN normalized_name;
  END IF;
END $$;

ALTER TABLE public.insurer_catalog
  ADD COLUMN IF NOT EXISTS normalized_name text GENERATED ALWAYS AS (
    lower(btrim(regexp_replace(name, '\s+', ' ', 'g')))
  ) STORED;

CREATE UNIQUE INDEX IF NOT EXISTS insurer_catalog_normalized_name_key
  ON public.insurer_catalog (normalized_name);

-- ─── Backfill: previously hard-coded insurer choices ───────────────────────
-- (client/src/pages/Dashboard.tsx's old `insuranceList` / AuthAlertPanel's
-- duplicate of it), minus "United Healthcare Medicare" which is handled
-- below as an alias of its corrected display name instead of its own row.
INSERT INTO public.insurer_catalog (name)
VALUES
  ('AARP Medicare Advantage'),
  ('AARP Medicare Supplement'),
  ('Aetna'),
  ('Aetna International'),
  ('American Transit'),
  ('Cigna Healthcare'),
  ('Emblem Health'),
  ('Emblem Health GHI Senior'),
  ('Empire NYSHIP (United Healthcare)'),
  ('GEICO NY PIP'),
  ('Global Excel Management'),
  ('Humana'),
  ('Kaiser Permanente'),
  ('Medicare - Queens (Part B)'),
  ('Meritain Health'),
  ('NYCE PPO Plan'),
  ('NY Empire BCBS'),
  ('Oxford Health Insurance'),
  ('Progressive No Fault'),
  ('United Healthcare')
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Name correction: "United Healthcare Medicare" -> "United Healthcare
-- Medicare Advantage", preserving the old name as an alias so existing
-- patients/claims stored under the old name keep matching. Deliberately NOT
-- merged with the plain "United Healthcare" row above — that's a different
-- product and must stay a separate catalog entry.
INSERT INTO public.insurer_catalog (name, aliases)
VALUES (
  'United Healthcare Medicare Advantage',
  ARRAY['United Healthcare Medicare']
)
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Initial requested insurers (P4-P7) ────────────────────────────────────
INSERT INTO public.insurer_catalog (name)
VALUES
  ('Aegis One Inc.'),
  ('UMR'),
  ('Gallagher Bassett'),
  ('Magnacare'),
  ('UHC Global'),
  ('WellCare'),
  ('TPA Exchange'),
  ('Hanover')
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Backfill: distinct insurer names already stored on existing patients/
-- visits that aren't covered by the lists above (e.g. values entered via
-- CSV import or manual edit before this feature existed). Excludes the old
-- "United Healthcare Medicare" value, which is handled as an alias above,
-- not a separate catalog row.
--
-- DISTINCT ON the normalized form (not the raw trimmed name) so two existing
-- rows that normalize the same but differ only by casing/spacing (e.g. one
-- patient stored as "Aetna", another as "AETNA ") collapse into a single
-- catalog entry — inserting both would violate the same uniqueness rule
-- this migration exists to enforce, and could error the whole backfill
-- (ON CONFLICT only arbitrates against rows outside the current command).
INSERT INTO public.insurer_catalog (name)
SELECT DISTINCT ON (lower(btrim(regexp_replace(src.insurance, '\s+', ' ', 'g'))))
  trim(regexp_replace(src.insurance, '\s+', ' ', 'g'))
FROM (
  SELECT insurance FROM public.patients WHERE insurance IS NOT NULL AND trim(insurance) <> ''
  UNION ALL
  SELECT insurance_company FROM public.visit_records WHERE insurance_company IS NOT NULL AND trim(insurance_company) <> ''
) AS src
WHERE lower(trim(regexp_replace(src.insurance, '\s+', ' ', 'g'))) <> 'united healthcare medicare'
ORDER BY lower(btrim(regexp_replace(src.insurance, '\s+', ' ', 'g')))
ON CONFLICT (normalized_name) DO NOTHING;

-- ─── Lock down direct (PostgREST/browser-role) access ──────────────────────
-- insurer_catalog is read and written exclusively through server/db.ts using
-- the service-role Supabase client (see server/supabase.ts — "Never expose
-- this client or its key to the browser"). There is no browser Supabase
-- client in this app (client/ never imports @supabase/supabase-js), but that
-- is not itself a guarantee: anon/authenticated are real Postgres roles that
-- Supabase's PostgREST layer accepts requests for directly, independent of
-- what this codebase's browser bundle happens to call. Without RLS, any
-- holder of the project's anon key (public by design, shipped to Supabase
-- Studio and every browser Supabase client) could read/write this table
-- over the REST API, bypassing the adminOrOwnerProcedure gate in
-- server/routers.ts entirely.
--
-- Enabling RLS with zero policies makes the table default-deny for every
-- role subject to RLS — there is deliberately no anon/authenticated policy
-- to admit browser-role access, since all legitimate access goes through the
-- server. service_role is unaffected: Supabase provisions it with BYPASSRLS,
-- so RLS enablement never blocks the server's own access. FORCE ROW LEVEL
-- SECURITY is additionally applied so RLS also applies to the table owner —
-- belt-and-suspenders, since BYPASSRLS roles ignore FORCE regardless.
--
-- The REVOKE below removes the ability to even attempt a query as
-- anon/authenticated/PUBLIC (defense in depth below RLS, and keeps the
-- table out of what anon/authenticated can see in schema introspection).
-- The GRANT to service_role is explicit so access does not silently depend
-- on whatever ALTER DEFAULT PRIVILEGES happens to be configured on the
-- project — this table's server access is guaranteed by this migration.
ALTER TABLE public.insurer_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.insurer_catalog FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.insurer_catalog FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.insurer_catalog TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP INDEX IF EXISTS insurer_catalog_normalized_name_key;
-- DROP TABLE IF EXISTS public.insurer_catalog;
-- COMMIT;
