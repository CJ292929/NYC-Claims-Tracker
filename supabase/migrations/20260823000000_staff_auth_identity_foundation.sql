-- ============================================================================
-- S1: Staff auth identity foundation
--
-- Extends public.clinic_users so it can represent real individual staff
-- identities (name/email/department/role/status/must_change_password/
-- token_version), while preserving the current single-account clinic login
-- exactly as-is. No staff CRUD, no first-login flow, no session/token
-- revocation enforcement — those are later stages.
--
-- REVIEW ONLY. Do not run this against production until the owner approves
-- the migration safety report. Written idempotently (IF NOT EXISTS / DO
-- blocks) so it is safe to re-run, matching the style of
-- references/local-setup-schema.sql, the repo's authoritative schema
-- snapshot (kept in sync with this migration once applied).
-- ============================================================================

BEGIN;

ALTER TABLE public.clinic_users
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS department text,
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'staff',
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- role/status CHECK constraints (added via DO block so re-running is safe —
-- ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS form).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clinic_users_role_check') THEN
    ALTER TABLE public.clinic_users
      ADD CONSTRAINT clinic_users_role_check CHECK (role IN ('admin', 'staff'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'clinic_users_status_check') THEN
    ALTER TABLE public.clinic_users
      ADD CONSTRAINT clinic_users_status_check CHECK (status IN ('active', 'archived'));
  END IF;
END $$;

-- Case-insensitive username uniqueness: replace the existing case-sensitive
-- UNIQUE(username) constraint (auto-named clinic_users_username_key) with a
-- unique index on lower(username), so jerome / Jerome / JEROME collide.
ALTER TABLE public.clinic_users DROP CONSTRAINT IF EXISTS clinic_users_username_key;
CREATE UNIQUE INDEX IF NOT EXISTS clinic_users_username_lower_key ON public.clinic_users (lower(username));

-- Reuse the existing set_updated_at() trigger function already defined for
-- users/patients/visit_records/claims_records (references/local-setup-schema.sql).
DROP TRIGGER IF EXISTS trg_clinic_users_updated_at ON public.clinic_users;
CREATE TRIGGER trg_clinic_users_updated_at BEFORE UPDATE ON public.clinic_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

COMMIT;

-- ============================================================================
-- ROLLBACK (for reference — not executed by this file)
-- ============================================================================
-- BEGIN;
-- DROP TRIGGER IF EXISTS trg_clinic_users_updated_at ON public.clinic_users;
-- DROP INDEX IF EXISTS clinic_users_username_lower_key;
-- ALTER TABLE public.clinic_users ADD CONSTRAINT clinic_users_username_key UNIQUE (username);
-- ALTER TABLE public.clinic_users DROP CONSTRAINT IF EXISTS clinic_users_role_check;
-- ALTER TABLE public.clinic_users DROP CONSTRAINT IF EXISTS clinic_users_status_check;
-- ALTER TABLE public.clinic_users
--   DROP COLUMN IF EXISTS name,
--   DROP COLUMN IF EXISTS email,
--   DROP COLUMN IF EXISTS department,
--   DROP COLUMN IF EXISTS role,
--   DROP COLUMN IF EXISTS status,
--   DROP COLUMN IF EXISTS must_change_password,
--   DROP COLUMN IF EXISTS token_version,
--   DROP COLUMN IF EXISTS updated_at,
--   DROP COLUMN IF EXISTS last_login_at,
--   DROP COLUMN IF EXISTS archived_at;
-- COMMIT;
