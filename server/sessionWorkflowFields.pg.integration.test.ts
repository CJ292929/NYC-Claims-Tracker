/**
 * server/sessionWorkflowFields.pg.integration.test.ts — P4-P23
 *
 * Real-Postgres tests for supabase/migrations/20261025000000_p4_p23_session_workflow_fields.sql:
 *
 *   "upgrade" database — the PRE-P4-P23 schema (references/local-setup-schema.sql
 *     as of origin/main, i.e. before this change) plus every earlier
 *     migration, seeded with existing rows, THEN the P4-P23 migration applied
 *     (twice, to prove it is re-runnable). Proves existing rows read as unset
 *     and keep their financial values.
 *   "fresh" database — the updated local-setup-schema.sql plus every
 *     migration, exactly as the other *.pg.integration tests build it.
 *
 * Then, through the real write_visit_record_with_audit RPC: each field
 * saves/reloads/clears and stays on its own row, invalid values are rejected
 * by CHECK constraints, partial updates preserve every other column, a
 * no-op writes no audit row (and doesn't re-stamp updated_by), an audit
 * INSERT failure rolls the row edit back, and the pre-P4-P23 call shape
 * still works against the new function (migration-before-deploy window).
 *
 * Same harness as lastAdminGuard.pg.integration.test.ts: disposable
 * `postgres:16` Docker container; excluded from CI by the
 * `**\/*.integration.test.ts` glob; self-skips when Docker isn't available.
 *
 *   npx vitest run server/sessionWorkflowFields.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `p4p23-session-fields-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const P23_MIGRATION = "20261025000000_p4_p23_session_workflow_fields.sql";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function preChangeSchemaAvailable(): string | null {
  try {
    return execFileSync("git", ["show", "origin/main:references/local-setup-schema.sql"], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    return null;
  }
}

const HAS_DOCKER = dockerAvailable();
const PRE_CHANGE_SCHEMA = preChangeSchemaAvailable();

function sh(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function psqlFile(db: string, filePath: string) {
  const remote = "/tmp/apply.sql";
  sh("docker", ["cp", filePath, `${CONTAINER_NAME}:${remote}`]);
  sh("docker", [
    "exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME,
    "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", remote,
  ]);
}

function psqlInline(db: string, sql: string) {
  sh("docker", [
    "exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME,
    "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql,
  ]);
}

let port = 0;

async function waitForReady() {
  for (let i = 0; i < 30; i++) {
    try {
      sh("docker", ["exec", CONTAINER_NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Postgres container did not become ready in time");
}

async function q<T = Record<string, unknown>>(db: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: db });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

const SUPABASE_ROLES = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`;

const ACTOR_ID = "00000000-0000-4000-8000-0000000000a1";
const ACTOR = [ACTOR_ID, "clinic_user", "Synthetic Staff"] as const;

/** Calls the audited RPC exactly as server/db.ts updateVisitRecord does. */
function rpc(db: string, visitId: string, data: Record<string, unknown>, patientId: string | null = null, action = "SESSION_FIELDS_UPDATE") {
  return q(db, `SELECT write_visit_record_with_audit($1, $2, $3::jsonb, $4, $5, $6, $7) AS id`, [
    visitId, patientId, JSON.stringify(data), ...ACTOR, action,
  ]);
}

async function seedPatientWithVisits(db: string, count = 2) {
  const [{ id: patientId }] = await q<{ id: string }>(db,
    `INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_p23_${randomUUID()}`]);
  const visitIds: string[] = [];
  for (let i = 1; i <= count; i++) {
    const [{ id }] = await q<{ id: string }>(db, `
      INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period,
                                 date_of_service, auth_status, total_insurance_reimbursement, total_patient_due, total_patient_paid)
      VALUES ($1, 10, $2, $3, 1, '2026-05-21', 'approved', $4, $5, $6) RETURNING id`,
      [patientId, 10 - i, i, 100 + i, 20 + i, 5 + i]);
    visitIds.push(id);
  }
  return { patientId, visitIds };
}

async function visit(db: string, id: string) {
  const [row] = await q<Record<string, unknown>>(db, `SELECT * FROM visit_records WHERE id = $1`, [id]);
  return row;
}

async function auditCount(db: string, visitId: string) {
  const [{ n }] = await q<{ n: string }>(db, `SELECT count(*) AS n FROM audit_logs WHERE entity_type = 'visit_record' AND entity_id = $1`, [visitId]);
  return Number(n);
}

let upgradeSeed: { patientId: string; visitIds: string[] } | null = null;
let workDir = "";

describe.skipIf(!HAS_DOCKER || !PRE_CHANGE_SCHEMA)("P4-P23 session workflow fields (real Postgres)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p23-"));
    sh("docker", ["run", "-d", "--name", CONTAINER_NAME, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    const match = sh("docker", ["port", CONTAINER_NAME, "5432"]).trim().match(/:(\d+)$/);
    if (!match) throw new Error("Could not parse published port");
    port = Number(match[1]);
    await waitForReady();

    // CREATE DATABASE can't run inside a multi-statement (implicit transaction) -c.
    psqlInline("postgres", "CREATE DATABASE upgrade_db");
    psqlInline("postgres", "CREATE DATABASE fresh_db");
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    // "upgrade": schema as it was before this change, earlier migrations,
    // existing data, then the P4-P23 migration — twice (idempotency).
    const preSchemaPath = path.join(workDir, "pre-p23-local-setup-schema.sql");
    writeFileSync(preSchemaPath, PRE_CHANGE_SCHEMA!);
    psqlInline("upgrade_db", SUPABASE_ROLES);
    psqlFile("upgrade_db", preSchemaPath);
    for (const file of migrations.filter((f) => f !== P23_MIGRATION)) psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, file));
    upgradeSeed = await seedPatientWithVisits("upgrade_db");
    psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, P23_MIGRATION));
    psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, P23_MIGRATION));

    // "fresh": the updated reference schema + every migration.
    psqlInline("fresh_db", SUPABASE_ROLES);
    psqlFile("fresh_db", path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const file of migrations) psqlFile("fresh_db", path.join(MIGRATIONS_DIR, file));
  }, 240_000);

  afterAll(() => {
    try { sh("docker", ["rm", "-f", CONTAINER_NAME]); } catch { /* already gone */ }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("upgrade: existing rows read as unset and keep their financial values", async () => {
    for (const [i, id] of upgradeSeed!.visitIds.entries()) {
      const row = await visit("upgrade_db", id);
      expect(row).toMatchObject({ assignment_of_benefits: null, submission_status: null, remarks: null });
      expect(Number(row.total_insurance_reimbursement)).toBe(101 + i);
      expect(Number(row.total_patient_due)).toBe(21 + i);
      expect(Number(row.total_patient_paid)).toBe(6 + i);
    }
  });

  for (const db of ["upgrade_db", "fresh_db"]) {
    describe(db, () => {
      it("columns are nullable text with no default, and constraints exist exactly once", async () => {
        const cols = await q<{ column_name: string; is_nullable: string; column_default: string | null; data_type: string }>(db, `
          SELECT column_name, is_nullable, column_default, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'visit_records'
            AND column_name IN ('assignment_of_benefits', 'submission_status', 'remarks') ORDER BY column_name`);
        expect(cols).toEqual([
          { column_name: "assignment_of_benefits", is_nullable: "YES", column_default: null, data_type: "text" },
          { column_name: "remarks", is_nullable: "YES", column_default: null, data_type: "text" },
          { column_name: "submission_status", is_nullable: "YES", column_default: null, data_type: "text" },
        ]);
        const cons = await q<{ conname: string }>(db, `
          SELECT conname FROM pg_constraint WHERE conrelid = 'public.visit_records'::regclass
            AND conname LIKE 'visit_records_%_check' AND conname IN (
              'visit_records_assignment_of_benefits_check', 'visit_records_submission_status_check', 'visit_records_remarks_length_check')
          ORDER BY conname`);
        expect(cons.map((c) => c.conname)).toEqual([
          "visit_records_assignment_of_benefits_check",
          "visit_records_remarks_length_check",
          "visit_records_submission_status_check",
        ]);
      });

      it("each field saves, reloads, clears, and stays on its own row; financials untouched", async () => {
        const { patientId, visitIds: [a, b] } = await seedPatientWithVisits(db);
        const bBefore = await visit(db, b);
        const aFinancialBefore = await q(db, `SELECT total_insurance_reimbursement, total_patient_due, total_patient_paid FROM visit_records WHERE id = $1`, [a]);

        await rpc(db, a, { assignment_of_benefits: "no" }, patientId);
        await rpc(db, a, { submission_status: "do_not_file" }, patientId);
        await rpc(db, a, { remarks: "Line one\nLine two — ✓" }, patientId);
        expect(await visit(db, a)).toMatchObject({ assignment_of_benefits: "no", submission_status: "do_not_file", remarks: "Line one\nLine two — ✓" });
        expect(await visit(db, b)).toEqual(bBefore);

        await rpc(db, a, { assignment_of_benefits: null }, patientId);
        expect(await visit(db, a)).toMatchObject({ assignment_of_benefits: null, submission_status: "do_not_file", remarks: "Line one\nLine two — ✓" });
        await rpc(db, a, { submission_status: null, remarks: null }, patientId);
        expect(await visit(db, a)).toMatchObject({ assignment_of_benefits: null, submission_status: null, remarks: null });

        expect(await q(db, `SELECT total_insurance_reimbursement, total_patient_due, total_patient_paid FROM visit_records WHERE id = $1`, [a]))
          .toEqual(aFinancialBefore);
      });

      it("a partial update preserves every unrelated column", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        const before = await visit(db, a);
        await rpc(db, a, { submission_status: "hold" }, patientId);
        const after = await visit(db, a);
        const { submission_status: _s, updated_by: _u, updated_by_type: _t, updated_at: _ua, ...restAfter } = after;
        const { submission_status: _s0, updated_by: _u0, updated_by_type: _t0, updated_at: _ua0, ...restBefore } = before;
        expect(restAfter).toEqual(restBefore);
        expect(after).toMatchObject({ submission_status: "hold", updated_by: ACTOR_ID, updated_by_type: "clinic_user" });
      });

      it("writes one controlled audit row per real change, with before/after of only the changed keys", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        await rpc(db, a, { assignment_of_benefits: "yes", remarks: "x" }, patientId);
        const rows = await q<Record<string, unknown>>(db, `SELECT * FROM audit_logs WHERE entity_type = 'visit_record' AND entity_id = $1`, [a]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          action: "SESSION_FIELDS_UPDATE", patient_id: patientId, actor_id: ACTOR_ID, actor_type: "clinic_user", actor_display: "Synthetic Staff",
          before_data: { assignment_of_benefits: null, remarks: null },
          after_data: { assignment_of_benefits: "yes", remarks: "x" },
        });
      });

      it("a no-op save writes no audit row and does not re-stamp attribution", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        await rpc(db, a, { submission_status: "ready_to_file" }, patientId);
        const stamped = await visit(db, a);
        const n = await auditCount(db, a);
        const otherActor = ["00000000-0000-4000-8000-0000000000b2", "owner", "Synthetic Owner"];
        await q(db, `SELECT write_visit_record_with_audit($1, $2, $3::jsonb, $4, $5, $6, 'SESSION_FIELDS_UPDATE')`,
          [a, patientId, JSON.stringify({ submission_status: "ready_to_file" }), ...otherActor]);
        await rpc(db, a, { assignment_of_benefits: null, remarks: null }, patientId); // already null
        expect(await auditCount(db, a)).toBe(n);
        expect(await visit(db, a)).toEqual(stamped);
      });

      it("rejects values outside the CHECK constraints and leaves the row unchanged", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        const before = await visit(db, a);
        for (const bad of [{ assignment_of_benefits: "YES" }, { assignment_of_benefits: "maybe" }, { submission_status: "filed" }, { remarks: "x".repeat(2001) }]) {
          await expect(rpc(db, a, bad, patientId)).rejects.toMatchObject({ code: "23514" });
        }
        expect(await visit(db, a)).toEqual(before);
        expect(await auditCount(db, a)).toBe(0);
        await rpc(db, a, { remarks: "x".repeat(2000) }, patientId); // boundary accepted
      });

      it("rejects a session that belongs to another patient (P0031) and an unknown id (P0030)", async () => {
        const { visitIds: [a] } = await seedPatientWithVisits(db, 1);
        const { patientId: other } = await seedPatientWithVisits(db, 1);
        await expect(rpc(db, a, { remarks: "x" }, other)).rejects.toMatchObject({ code: "P0031" });
        await expect(rpc(db, randomUUID(), { remarks: "x" }, other)).rejects.toMatchObject({ code: "P0030" });
        expect((await visit(db, a)).remarks).toBeNull();
      });

      it("an audit INSERT failure rolls the session edit back", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        const before = await visit(db, a);
        const trigger = `p4p23_fail_audit_${randomUUID().slice(0, 8)}`;
        await q(db, `
          CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'synthetic audit failure' USING ERRCODE = 'P0999'; END $$;
          CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ${trigger}();`);
        try {
          await expect(rpc(db, a, { submission_status: "hold", remarks: "should not persist" }, patientId))
            .rejects.toMatchObject({ code: "P0999" });
        } finally {
          await q(db, `DROP TRIGGER ${trigger} ON audit_logs; DROP FUNCTION ${trigger}();`);
        }
        expect(await visit(db, a)).toEqual(before);
        expect(await auditCount(db, a)).toBe(0);
      });

      it("compatibility: the pre-P4-P23 call shape (no new keys) still works and preserves the new fields", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        await rpc(db, a, { assignment_of_benefits: "yes", submission_status: "hold", remarks: "keep me" }, patientId);
        // Exactly what currently deployed code sends from visits.update / markAsRequested:
        await rpc(db, a, { sessions_remaining: 3, auth_status: "pending", date_ash_submitted: "2026-06-01" }, null, "VISIT_RECORD_UPDATE");
        await rpc(db, a, { total_patient_paid: 42.5 }, null, "VISIT_RECORD_UPDATE");
        expect(await visit(db, a)).toMatchObject({
          sessions_remaining: 3, auth_status: "pending", assignment_of_benefits: "yes", submission_status: "hold", remarks: "keep me",
        });
        expect(Number((await visit(db, a)).total_patient_paid)).toBe(42.5);
        // Insert path (createVisitRecord) without the new keys leaves them unset.
        const [{ id }] = await q<{ id: string }>(db, `SELECT write_visit_record_with_audit(NULL, $1, $2::jsonb, $3, $4, $5, 'VISIT_RECORD_CREATE') AS id`,
          [patientId, JSON.stringify({ session_number: 9, auth_period: 1, auth_status: "none" }), ...ACTOR]);
        expect(await visit(db, id)).toMatchObject({ assignment_of_benefits: null, submission_status: null, remarks: null });
      });

      it("concurrent edits to different fields of the same session both survive (row lock serializes them)", async () => {
        const { patientId, visitIds: [a] } = await seedPatientWithVisits(db, 1);
        await Promise.all([
          rpc(db, a, { assignment_of_benefits: "yes" }, patientId),
          rpc(db, a, { submission_status: "ready_to_file" }, patientId),
          rpc(db, a, { remarks: "concurrent" }, patientId),
        ]);
        expect(await visit(db, a)).toMatchObject({ assignment_of_benefits: "yes", submission_status: "ready_to_file", remarks: "concurrent" });
        expect(await auditCount(db, a)).toBe(3);
      });
    });
  }
});
