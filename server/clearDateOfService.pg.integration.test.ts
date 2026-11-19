/**
 * server/clearDateOfService.pg.integration.test.ts
 *
 * Real-Postgres tests for Clear Date of Service, synthetic data only, on a
 * fresh database: references/local-setup-schema.sql plus every migration.
 * No new migration — visits.clearDateOfService reuses the existing audited
 * write_visit_record_with_audit RPC, called here exactly as
 * server/db.ts updateVisitRecord calls it ({ date_of_service: null }, the
 * patient as ownership guard, action SESSION_DATE_OF_SERVICE_CLEARED).
 *
 * Proves: only date_of_service on the exact row changes (adjacent rows,
 * other periods, statuses, workflow and money fields, the period's
 * authorization and claims rows are untouched); completed/remaining derived
 * from dates drop/rise by one; one audit row with the before/after date and
 * none for a repeat; a wrong patient is refused with nothing changed; and
 * clearing a date in an Expired period keeps the period-level mark on every
 * row (still expired, 0 available) — the expiry guard allows it and it can't
 * be used to move the session or reopen the period.
 *
 * Same harness as periodSessionCorrection.pg.integration.test.ts:
 * disposable `postgres:16` Docker container; self-skips when Docker isn't
 * available, unless REQUIRE_PG_INTEGRATION=1 (CI), which makes it fail.
 *
 *   npx vitest run server/clearDateOfService.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readdirSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPeriodMetrics } from "../shared/authPeriodMetrics";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `clear-dos-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const DB = "fresh_db";
const ACTION = "SESSION_DATE_OF_SERVICE_CLEARED";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const HAS_DOCKER = dockerAvailable();
if (process.env.REQUIRE_PG_INTEGRATION === "1" && !HAS_DOCKER) {
  throw new Error("REQUIRE_PG_INTEGRATION=1 but Docker is not available");
}

function sh(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}
function psqlFile(db: string, filePath: string) {
  const remote = "/tmp/apply.sql";
  sh("docker", ["cp", filePath, `${CONTAINER_NAME}:${remote}`]);
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", remote]);
}
function psqlInline(db: string, sql: string) {
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql]);
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

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: DB });
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

const ACTOR = ["00000000-0000-4000-8000-0000000000d5", "clinic_user", "Synthetic Staff"] as const;

/** Exactly as server/db.ts updateVisitRecord → visits.clearDateOfService. */
async function clearDos(visitId: string, patientId: string) {
  return q(`SELECT write_visit_record_with_audit($1, $2, $3::jsonb, $4, $5, $6, $7) AS id`,
    [visitId, patientId, JSON.stringify({ date_of_service: null }), ...ACTOR, ACTION]);
}
async function approveRenewal(patientId: string, targetPeriod: number, n: number) {
  return q(`SELECT approve_authorization_with_audit($1, $2, $3, NULL, NULL, false, NULL, $4, $5, $6)`, [patientId, targetPeriod, n, ...ACTOR]);
}
async function setExpired(patientId: string, period: number, expired: boolean, reason: string | null = null) {
  return q(`SELECT set_auth_period_expired_with_audit($1, $2, $3, $4, $5, $6, $7)`, [patientId, period, expired, reason, ...ACTOR]);
}

/** Two periods of 4 sessions: P1 fully used, P2 has sessions 1-2 dated.
 *  Every row carries status, workflow and money values to watch. */
async function seedPatient() {
  const [{ id: patientId }] = await q<{ id: string }>(
    `INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_clear_dos_${randomUUID()}`]);
  await q(`SELECT create_initial_authorization_with_audit($1, 4, DATE '2026-09-01', NULL, false, NULL, $2, $3, $4)`, [patientId, ...ACTOR]);
  await q(`UPDATE visit_records SET date_of_service = DATE '2026-09-01' + session_number, auth_status = 'approved',
                                    assignment_of_benefits = 'yes', submission_status = 'ready_to_file', remarks = 'p1 s' || session_number,
                                    total_insurance_reimbursement = 80 + session_number, total_patient_due = 10, total_patient_paid = 5
           WHERE patient_id = $1 AND auth_period = 1`, [patientId]);
  await approveRenewal(patientId, 1, 4); // renews period 1 -> creates period 2
  await q(`UPDATE visit_records SET date_of_service = DATE '2026-10-01' + session_number, auth_status = 'approved',
                                    remarks = 'p2 s' || session_number, total_insurance_reimbursement = 90
           WHERE patient_id = $1 AND auth_period = 2 AND session_number <= 2`, [patientId]);
  return patientId;
}

type Snap = Record<string, unknown> & { id: string; auth_period: number; session_number: number; dos: string | null };
async function snapshot(patientId: string): Promise<Snap[]> {
  return q<Snap>(`SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
                   auth_status, date_ash_submitted::text AS ash, new_auth, remarks, insurance_company,
                   assignment_of_benefits, submission_status,
                   total_insurance_reimbursement::text AS ins, total_patient_due::text AS due, total_patient_paid::text AS paid,
                   period_expired_at::text AS mark
            FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number NULLS LAST, id`, [patientId]);
}
const row = (rows: Snap[], period: number, session: number) => {
  const r = rows.find(x => x.auth_period === period && x.session_number === session);
  if (!r) throw new Error(`no row P${period} S${session}`);
  return r;
};
const metrics = (rows: Snap[], period: number) =>
  getPeriodMetrics(rows.map(r => ({ authPeriod: r.auth_period, sessionsAuthorized: r.sessions_authorized as number | null, dateOfService: r.dos, periodExpiredAt: r.mark })), period);
async function audits(patientId: string, action: string) {
  return q<{ entity_id: string; before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
    `SELECT entity_id, before_data, after_data FROM audit_logs WHERE patient_id = $1 AND action = $2 ORDER BY created_at`, [patientId, action]);
}
async function claimsAndPatient(patientId: string) {
  return {
    patient: await q(`SELECT * FROM patients WHERE id = $1`, [patientId]),
    claims: await q(`SELECT * FROM claims_records WHERE patient_id = $1 ORDER BY id`, [patientId]),
  };
}

describe.skipIf(!HAS_DOCKER)("Clear Date of Service (real Postgres)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    sh("docker", ["run", "-d", "--name", CONTAINER_NAME, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    const match = sh("docker", ["port", CONTAINER_NAME, "5432"]).trim().match(/:(\d+)$/);
    if (!match) throw new Error("Could not parse published port");
    port = Number(match[1]);
    await waitForReady();
    psqlInline("postgres", `CREATE DATABASE ${DB}`);
    psqlInline(DB, SUPABASE_ROLES);
    psqlFile(DB, path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    const migrations = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();
    for (const file of migrations) psqlFile(DB, path.join(MIGRATIONS_DIR, file));
  }, 240_000);

  afterAll(() => {
    try { sh("docker", ["rm", "-f", CONTAINER_NAME]); } catch { /* already gone */ }
  });

  it("clears only the selected Period 1 row's date; Period 2 and adjacent rows are untouched", async () => {
    const patientId = await seedPatient();
    await q(`INSERT INTO claims_records (patient_id, auth_period, date_of_service, cpt_codes, charge_amount)
             VALUES ($1, 1, DATE '2026-09-04', '97110', 150)`, [patientId]);
    const before = await snapshot(patientId);
    const otherBefore = await claimsAndPatient(patientId);
    expect(metrics(before, 1)).toMatchObject({ authorized: 4, completed: 4, remaining: 0 });
    expect(metrics(before, 2)).toMatchObject({ authorized: 4, completed: 2, remaining: 2 });

    const target = row(before, 1, 3);
    await clearDos(target.id, patientId);

    const after = await snapshot(patientId);
    expect(after).toHaveLength(before.length);
    for (const b of before) {
      const a = after.find(x => x.id === b.id)!;
      if (b.id === target.id) expect(a).toEqual({ ...b, dos: null });
      else expect(a).toEqual(b);
    }
    // Claims (incl. the one dated that day) and the patient row are not touched.
    expect(await claimsAndPatient(patientId)).toEqual(otherBefore);

    // Totals recompute from dates after a reload.
    expect(metrics(after, 1)).toMatchObject({ authorized: 4, completed: 3, remaining: 1, expired: false });
    expect(metrics(after, 2)).toMatchObject({ authorized: 4, completed: 2, remaining: 2 });

    const log = await audits(patientId, ACTION);
    expect(log).toEqual([{ entity_id: target.id, before_data: { date_of_service: "2026-09-04" }, after_data: { date_of_service: null } }]);
  });

  it("a repeat clear is a no-op: nothing changes and no second audit row", async () => {
    const patientId = await seedPatient();
    const target = row(await snapshot(patientId), 2, 1);
    await clearDos(target.id, patientId);
    const once = await snapshot(patientId);
    await clearDos(target.id, patientId);
    expect(await snapshot(patientId)).toEqual(once);
    expect(await audits(patientId, ACTION)).toHaveLength(1);
  });

  it("a session of another patient is refused (P0031) with nothing changed", async () => {
    const owner = await seedPatient();
    const other = await seedPatient();
    const target = row(await snapshot(owner), 1, 1);
    const before = await snapshot(owner);
    await expect(clearDos(target.id, other)).rejects.toMatchObject({ code: "P0031" });
    expect(await snapshot(owner)).toEqual(before);
    expect(await audits(owner, ACTION)).toHaveLength(0);
    expect(await audits(other, ACTION)).toHaveLength(0);
  });

  it("a missing session is refused (P0030)", async () => {
    const patientId = await seedPatient();
    await expect(clearDos(randomUUID(), patientId)).rejects.toMatchObject({ code: "P0030" });
  });

  it("clearing a date in an Expired period keeps it expired with zero available", async () => {
    const patientId = await seedPatient();
    await setExpired(patientId, 2, true);
    const before = await snapshot(patientId);
    const mark = row(before, 2, 1).mark;
    expect(mark).not.toBeNull();
    expect(metrics(before, 2)).toMatchObject({ completed: 2, remaining: 0, expired: true, unusedExpired: 2 });

    const target = row(before, 2, 2);
    await clearDos(target.id, patientId);

    const after = await snapshot(patientId);
    for (const b of before) {
      const a = after.find(x => x.id === b.id)!;
      expect(a).toEqual(b.id === target.id ? { ...b, dos: null } : b);
    }
    // The period-level mark is identical on every Period 2 row; Period 1 stays unmarked.
    expect(after.filter(r => r.auth_period === 2).every(r => r.mark === mark)).toBe(true);
    expect(after.filter(r => r.auth_period === 1).every(r => r.mark === null)).toBe(true);
    // Still expired: completed drops, but nothing becomes available.
    expect(metrics(after, 2)).toMatchObject({ authorized: 4, completed: 1, remaining: 0, expired: true, unusedExpired: 3 });
    // The audit records only the date — no expiry or status change.
    expect(await audits(patientId, ACTION)).toEqual([
      { entity_id: target.id, before_data: { date_of_service: "2026-10-03" }, after_data: { date_of_service: null } },
    ]);
  });
});
