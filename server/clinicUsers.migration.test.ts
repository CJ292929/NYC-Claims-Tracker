/**
 * server/clinicUsers.migration.test.ts
 * S1: schema-design review of the prepared (not-yet-applied) migration SQL.
 * No live database — these assertions read the migration/seed SQL text
 * directly, covering what test D from the S1 spec calls "testable without
 * a live DB": case-insensitive username uniqueness, defaults, and that the
 * migration stays scoped to public.clinic_users only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const migrationSql = readFileSync(
  join(__dirname, "..", "supabase", "migrations", "20260823000000_staff_auth_identity_foundation.sql"),
  "utf-8"
);
const forwardSql = migrationSql.split(/ROLLBACK/i)[0];

describe("S1 migration SQL", () => {
  it("D: drops the case-sensitive UNIQUE(username) constraint", () => {
    expect(forwardSql).toMatch(/DROP CONSTRAINT IF EXISTS clinic_users_username_key/);
  });

  it("D: adds a case-insensitive unique index on lower(username)", () => {
    expect(forwardSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS clinic_users_username_lower_key ON public\.clinic_users \(lower\(username\)\)/
    );
  });

  it("D: does not leave the old case-sensitive constraint alongside the new index", () => {
    expect(forwardSql).not.toMatch(/ADD CONSTRAINT clinic_users_username_key UNIQUE/);
  });

  it("adds role/status CHECK constraints matching the approved enum values", () => {
    expect(forwardSql).toMatch(/CHECK \(role IN \('admin', 'staff'\)\)/);
    expect(forwardSql).toMatch(/CHECK \(status IN \('active', 'archived'\)\)/);
  });

  it("F/G/H/I: new columns default to role=staff, status=active, must_change_password=true, token_version=0", () => {
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'staff'/);
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'/);
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT true/);
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS token_version integer NOT NULL DEFAULT 0/);
  });

  it("name/email/department are added nullable, with no fabricated backfill", () => {
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS name text(?!\s+NOT NULL)/);
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS email text(?!\s+NOT NULL)/);
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS department text(?!\s+NOT NULL)/);
    expect(forwardSql).not.toMatch(/UPDATE public\.clinic_users SET name/);
  });

  it("reuses the existing set_updated_at() trigger function rather than inventing a new one", () => {
    expect(forwardSql).toMatch(/CREATE TRIGGER trg_clinic_users_updated_at BEFORE UPDATE ON public\.clinic_users/);
    expect(forwardSql).toMatch(/EXECUTE FUNCTION public\.set_updated_at\(\)/);
    expect(forwardSql).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/);
  });

  it("is scoped to public.clinic_users only — no owner/OAuth table changes", () => {
    expect(forwardSql).not.toMatch(/public\.users\b/);
    expect(forwardSql).not.toMatch(/OWNER_OPEN_ID/);
  });

  it("is idempotent (IF NOT EXISTS / IF EXISTS guards), matching the repo's schema-file convention", () => {
    expect(forwardSql).toMatch(/ADD COLUMN IF NOT EXISTS/);
    expect(forwardSql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
    expect(forwardSql).toMatch(/DROP TRIGGER IF EXISTS/);
  });
});

describe("references/local-setup-schema.sql", () => {
  const seedSql = readFileSync(join(__dirname, "..", "references", "local-setup-schema.sql"), "utf-8");

  it("no longer contains the plaintext seed password in a comment", () => {
    expect(seedSql).not.toMatch(/nychomerehab/i);
  });

  it("declares clinic_users.username without a plain UNIQUE (replaced by the lower(username) index)", () => {
    expect(seedSql).not.toMatch(/username text NOT NULL UNIQUE/);
    expect(seedSql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS clinic_users_username_lower_key ON public\.clinic_users \(lower\(username\)\)/
    );
  });

  it("seed INSERT's ON CONFLICT target matches the lower(username) unique index, not a plain column", () => {
    // A plain `ON CONFLICT (username)` would fail at runtime once the inline
    // UNIQUE(username) constraint is gone — Postgres requires the conflict
    // target to match an actual unique constraint/index definition.
    expect(seedSql).toMatch(/ON CONFLICT \(\(lower\(username\)\)\) DO NOTHING/);
    expect(seedSql).not.toMatch(/ON CONFLICT \(username\) DO NOTHING/);
  });
});

describe("server/routers.ts", () => {
  it("E: passwordHash is referenced only in the bcrypt comparison, never returned to a client", () => {
    const routersSrc = readFileSync(join(__dirname, "routers.ts"), "utf-8");
    const occurrences = routersSrc.match(/passwordHash/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});
