/**
 * server/expiredAuthorization.pg.integration.test.ts — P4-P31
 *
 * Real-Postgres tests for supabase/migrations/20261114000000_p4_p31_expired_authorization_status.sql,
 * synthetic data only:
 *
 *   "upgrade" database — references/local-setup-schema.sql as of origin/main
 *     (before this change) plus every earlier migration, seeded with existing
 *     Approved/Denied rows, THEN the P4-P31 migration applied twice
 *     (re-runnable). Proves no existing row is converted.
 *   "fresh" database — the updated local-setup-schema.sql plus every migration.
 *
 * Then, through the real RPCs: 13/16 marked Expired changes only that
 * period's auth_status (counts, dates, money and the other period untouched),
 * every changed row is audited with before/after + actor, Denied -> Expired is
 * an audited individual correction, clearing works, a request + approval from
 * an expired period creates a new period without reactivating the old one or
 * carrying unused sessions forward, and bad values / unknown targets are
 * refused.
 *
 * Same harness as sessionWorkflowFields.pg.integration.test.ts: disposable
 * `postgres:16` Docker container; excluded from CI by the
 * `**\/*.integration.test.ts` glob; self-skips when Docker isn't available.
 *
 *   npx vitest run server/expiredAuthorization.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `p4p31-expired-auth-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const P31_MIGRATION = "20261114000000_p4_p31_expired_authorization_status.sql";

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

const ACTOR_ID = "00000000-0000-4000-8000-0000000000b1";
const ACTOR = [ACTOR_ID, "clinic_user", "Synthetic Staff"] as const;

/** Calls the RPC exactly as server/db.ts setAuthPeriodExpired does. */
async function setExpired(db: string, patientId: string, authPeriod: number, expired: boolean) {
  const [{ n }] = await q<{ n: number }>(db, `SELECT set_auth_period_expired_with_audit($1, $2, $3, $4, $5, $6) AS n`, [
    patientId, authPeriod, expired, ...ACTOR,
  ]);
  return n;
}

/** Period 1: 4 used + Approved. Period 2: 16 authorized, 13 completed, with money on the used rows. */
async function seed(db: string, period2Status = "none") {
  const [{ id: patientId }] = await q<{ id: string }>(db,
    `INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_p31_${randomUUID()}`]);
  for (let i = 1; i <= 4; i++) {
    await q(db, `INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period, date_of_service, auth_status)
                 VALUES ($1, 4, $2, $3, 1, '2026-03-0${i}', 'approved')`, [patientId, 4 - i, i]);
  }
  for (let i = 1; i <= 16; i++) {
    const used = i <= 13;
    await q(db, `INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period,
                                            date_of_service, auth_status, total_insurance_reimbursement, total_patient_due, total_patient_paid)
                 VALUES ($1, 16, $2, $3, 2, $4, $5, $6, $7, $8)`,
      [patientId, 16 - i, i, used ? `2026-05-${String(i).padStart(2, "0")}` : null, period2Status,
        used ? 80 + i : null, used ? 10 : null, used ? 5 : null]);
  }
  return patientId;
}

type Snap = Record<string, unknown>;
async function snapshot(db: string, patientId: string): Promise<Snap[]> {
  return q(db, `SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
                       auth_status, total_insurance_reimbursement::text AS ins, total_patient_due::text AS due, total_patient_paid::text AS paid
                FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number`, [patientId]);
}

function withoutStatus(rows: Snap[]) {
  return rows.map(({ auth_status: _s, ...rest }) => rest);
}

let upgradePatient = "";
let workDir = "";

describe.skipIf(!HAS_DOCKER || !PRE_CHANGE_SCHEMA)("P4-P31 Expired authorization status (real Postgres)", () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p31-"));
    sh("docker", ["run", "-d", "--name", CONTAINER_NAME, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    const match = sh("docker", ["port", CONTAINER_NAME, "5432"]).trim().match(/:(\d+)$/);
    if (!match) throw new Error("Could not parse published port");
    port = Number(match[1]);
    await waitForReady();

    psqlInline("postgres", "CREATE DATABASE upgrade_db");
    psqlInline("postgres", "CREATE DATABASE fresh_db");
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    const preSchemaPath = path.join(workDir, "pre-p31-local-setup-schema.sql");
    writeFileSync(preSchemaPath, PRE_CHANGE_SCHEMA!);
    psqlInline("upgrade_db", SUPABASE_ROLES);
    psqlFile("upgrade_db", preSchemaPath);
    for (const file of migrations.filter((f) => f !== P31_MIGRATION)) psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, file));
    upgradePatient = await seed("upgrade_db", "denied");
    psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, P31_MIGRATION));
    psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, P31_MIGRATION));

    psqlInline("fresh_db", SUPABASE_ROLES);
    psqlFile("fresh_db", path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const file of migrations) psqlFile("fresh_db", path.join(MIGRATIONS_DIR, file));
  }, 240_000);

  afterAll(() => {
    try { sh("docker", ["rm", "-f", CONTAINER_NAME]); } catch { /* already gone */ }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("upgrade: existing Denied/Approved rows are not converted", async () => {
    const rows = await snapshot("upgrade_db", upgradePatient);
    expect(rows.filter(r => r.auth_period === 1).every(r => r.auth_status === "approved")).toBe(true);
    expect(rows.filter(r => r.auth_period === 2).every(r => r.auth_status === "denied")).toBe(true);
    const [{ n }] = await q<{ n: string }>("upgrade_db", `SELECT count(*) AS n FROM audit_logs WHERE patient_id = $1`, [upgradePatient]);
    expect(Number(n)).toBe(0);
  });

  it("upgrade: Denied -> Expired is an individual, audited correction with before/after", async () => {
    const before = await snapshot("upgrade_db", upgradePatient);
    expect(await setExpired("upgrade_db", upgradePatient, 2, true)).toBe(16);
    const after = await snapshot("upgrade_db", upgradePatient);
    expect(withoutStatus(after)).toEqual(withoutStatus(before));
    const audits = await q<{ before_data: { auth_status: string }; after_data: { auth_status: string } }>("upgrade_db",
      `SELECT before_data, after_data FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_PERIOD_EXPIRED'`, [upgradePatient]);
    expect(audits).toHaveLength(16);
    expect(audits.every(a => a.before_data.auth_status === "denied" && a.after_data.auth_status === "expired")).toBe(true);
  });

  for (const db of ["upgrade_db", "fresh_db"]) {
    describe(db, () => {
      it("CHECK accepts 'expired' and still rejects unknown values; exactly one auth_status CHECK", async () => {
        const patientId = await seed(db);
        await q(db, `UPDATE visit_records SET auth_status = 'expired' WHERE patient_id = $1 AND session_number = 1 AND auth_period = 2`, [patientId]);
        await expect(q(db, `UPDATE visit_records SET auth_status = 'lapsed' WHERE patient_id = $1`, [patientId])).rejects.toMatchObject({ code: "23514" });
        const cons = await q<{ conname: string }>(db, `SELECT conname FROM pg_constraint WHERE conrelid = 'public.visit_records'::regclass
          AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%auth_status%'`);
        expect(cons.map(c => c.conname)).toEqual(["visit_records_auth_status_check"]);
      });

      it("13/16 marked Expired: only period 2 auth_status changes; counts, dates, money and period 1 untouched", async () => {
        const patientId = await seed(db);
        const before = await snapshot(db, patientId);
        expect(await setExpired(db, patientId, 2, true)).toBe(16);
        const after = await snapshot(db, patientId);

        expect(withoutStatus(after)).toEqual(withoutStatus(before));
        expect(after.filter(r => r.auth_period === 1).map(r => r.auth_status)).toEqual(["approved", "approved", "approved", "approved"]);
        const p2 = after.filter(r => r.auth_period === 2);
        expect(p2.every(r => r.auth_status === "expired")).toBe(true);
        expect(p2.filter(r => r.dos !== null)).toHaveLength(13);
        expect(p2).toHaveLength(16);

        const audits = await q<{ actor_id: string; actor_display: string; entity_id: string; before_data: Snap; after_data: Snap }>(db,
          `SELECT actor_id, actor_display, entity_id, before_data, after_data FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_PERIOD_EXPIRED'`, [patientId]);
        expect(audits).toHaveLength(16);
        expect(new Set(audits.map(a => a.entity_id))).toEqual(new Set(p2.map(r => r.id)));
        for (const a of audits) {
          expect(a).toMatchObject({ actor_id: ACTOR_ID, actor_display: "Synthetic Staff" });
          expect(a.before_data).toEqual({ auth_status: "none" });
          expect(a.after_data).toEqual({ auth_status: "expired" });
        }

        // Re-running is a no-op: nothing changes, no new audit rows.
        expect(await setExpired(db, patientId, 2, true)).toBe(0);
        const [{ n }] = await q<{ n: string }>(db, `SELECT count(*) AS n FROM audit_logs WHERE patient_id = $1`, [patientId]);
        expect(Number(n)).toBe(16);
      });

      it("request + approval from an expired period: new period, old one stays expired, nothing carried forward", async () => {
        const patientId = await seed(db);
        await setExpired(db, patientId, 2, true);
        // Mark Requested: the status row (last row of period 2) -> pending, as server/routers.ts does.
        const [{ id: lastRow }] = await q<{ id: string }>(db,
          `SELECT id FROM visit_records WHERE patient_id = $1 AND auth_period = 2 ORDER BY session_number DESC LIMIT 1`, [patientId]);
        await q(db, `SELECT write_visit_record_with_audit($1, $2, $3::jsonb, $4, $5, $6, 'AUTHORIZATION_MARKED_REQUESTED')`,
          [lastRow, patientId, JSON.stringify({ auth_status: "pending", date_ash_submitted: "2026-11-14" }), ...ACTOR]);
        const before = await snapshot(db, patientId);

        const ids = await q<{ id: string }>(db,
          `SELECT approve_authorization_with_audit($1, 2, 12, '2026-11-14', NULL, false, NULL, $2, $3, $4) AS id`, [patientId, ...ACTOR]);
        expect(ids).toHaveLength(12);

        const after = await snapshot(db, patientId);
        const oldP2 = after.filter(r => r.auth_period === 2);
        // Every row that was expired is still expired; only the pending request row became approved.
        expect(oldP2.filter(r => r.auth_status === "expired")).toHaveLength(15);
        expect(oldP2.find(r => r.id === lastRow)?.auth_status).toBe("approved");
        expect(withoutStatus(oldP2)).toEqual(withoutStatus(before.filter(r => r.auth_period === 2)));

        const p3 = after.filter(r => r.auth_period === 3);
        expect(p3).toHaveLength(12);
        expect(p3.every(r => r.sessions_authorized === 12 && r.dos === null && r.auth_status === "none")).toBe(true);
        expect(after.filter(r => r.auth_period === 1).every(r => r.auth_status === "approved")).toBe(true);
      });

      it("clearing a mistaken Expired sets only that period's expired rows to none, audited", async () => {
        const patientId = await seed(db);
        await setExpired(db, patientId, 2, true);
        expect(await setExpired(db, patientId, 2, false)).toBe(16);
        const after = await snapshot(db, patientId);
        expect(after.filter(r => r.auth_period === 2).every(r => r.auth_status === "none")).toBe(true);
        expect(after.filter(r => r.auth_period === 1).every(r => r.auth_status === "approved")).toBe(true);
        const [{ n }] = await q<{ n: string }>(db,
          `SELECT count(*) AS n FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_PERIOD_EXPIRY_CLEARED'
             AND before_data = '{"auth_status":"expired"}'::jsonb AND after_data = '{"auth_status":"none"}'::jsonb`, [patientId]);
        expect(Number(n)).toBe(16);
      });

      it("refuses an unknown period or patient and writes nothing", async () => {
        const patientId = await seed(db);
        await expect(setExpired(db, patientId, 9, true)).rejects.toMatchObject({ code: "P0034" });
        await expect(setExpired(db, randomUUID(), 1, true)).rejects.toMatchObject({ code: "P0020" });
        const rows = await snapshot(db, patientId);
        expect(rows.some(r => r.auth_status === "expired")).toBe(false);
      });

      it("is executable by service_role only", async () => {
        const [{ svc, anon, authd }] = await q<{ svc: boolean; anon: boolean; authd: boolean }>(db, `SELECT
          has_function_privilege('service_role', 'public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text)', 'EXECUTE') AS svc,
          has_function_privilege('anon', 'public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text)', 'EXECUTE') AS anon,
          has_function_privilege('authenticated', 'public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text)', 'EXECUTE') AS authd`);
        expect({ svc, anon, authd }).toEqual({ svc: true, anon: false, authd: false });
      });
    });
  }
});
