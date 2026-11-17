/**
 * server/periodSessionCorrection.pg.integration.test.ts — P4-P32
 *
 * Real-Postgres tests for
 * supabase/migrations/20261117000000_p4_p32_initial_authorization_and_period_count_correction.sql,
 * synthetic data only, on a fresh database: references/local-setup-schema.sql
 * plus every migration, with the P4-P32 one applied twice (re-runnable).
 *
 * Proves: a patient created with no count gets exactly one initial period
 * once approval is recorded, and a retry or concurrent double submit creates
 * no duplicate; a period's count can be corrected up and safely down, keeping
 * dates, statuses, workflow fields and money; a correction below completed
 * sessions, over rows that hold data, on an Expired period, or from a stale
 * count is refused with nothing changed; one audit row per change and none
 * for a refusal or no-op; renewal approval is unchanged; and the RPCs are
 * service_role only.
 *
 * Same harness as expiredAuthorization.pg.integration.test.ts: disposable
 * `postgres:16` Docker container; self-skips when Docker isn't available,
 * unless REQUIRE_PG_INTEGRATION=1 (CI), which turns that into a failure.
 *
 *   npx vitest run server/periodSessionCorrection.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readdirSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `p4p32-period-count-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const P32_MIGRATION = "20261117000000_p4_p32_initial_authorization_and_period_count_correction.sql";
const DB = "fresh_db";

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

const ACTOR = ["00000000-0000-4000-8000-0000000000c2", "clinic_user", "Synthetic Staff"] as const;
const INITIAL_SIG = "public.create_initial_authorization_with_audit(uuid, integer, date, text, boolean, bigint, uuid, text, text)";
const CORRECT_SIG = "public.correct_auth_period_sessions_with_audit(uuid, integer, integer, integer, text, uuid, text, text)";

/** As server/db.ts createInitialAuthorization calls it. */
async function initial(patientId: string, n: number, authDate: string | null = "2026-11-10") {
  const rows = await q<{ id: string }>(`SELECT create_initial_authorization_with_audit($1, $2, $3, $4, $5, $6, $7, $8, $9) AS id`,
    [patientId, n, authDate, null, false, null, ...ACTOR]);
  return rows.map(r => r.id);
}
/** As server/db.ts correctAuthPeriodSessions calls it. */
async function correct(patientId: string, period: number, n: number, expected: number, reason: string | null = "synthetic correction") {
  const [{ r }] = await q<{ r: { changed: boolean; sessions_authorized: number; added: number; removed: number } }>(
    `SELECT correct_auth_period_sessions_with_audit($1, $2, $3, $4, $5, $6, $7, $8) AS r`, [patientId, period, n, expected, reason, ...ACTOR]);
  return r;
}
async function approveRenewal(patientId: string, targetPeriod: number, n: number) {
  return q(`SELECT approve_authorization_with_audit($1, $2, $3, NULL, NULL, false, NULL, $4, $5, $6)`, [patientId, targetPeriod, n, ...ACTOR]);
}
async function setExpired(patientId: string, period: number, expired: boolean, reason: string | null = null) {
  return q(`SELECT set_auth_period_expired_with_audit($1, $2, $3, $4, $5, $6, $7)`, [patientId, period, expired, reason, ...ACTOR]);
}

async function newPatient() {
  const [{ id }] = await q<{ id: string }>(`INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_p32_${randomUUID()}`]);
  return id;
}

type Snap = Record<string, unknown>;
async function snapshot(patientId: string): Promise<Snap[]> {
  return q(`SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
                   auth_status, date_ash_submitted::text AS ash, new_auth, remarks, insurance_company,
                   total_insurance_reimbursement::text AS ins, total_patient_due::text AS due, total_patient_paid::text AS paid,
                   period_expired_at::text AS mark
            FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number NULLS LAST, id`, [patientId]);
}
async function audits(patientId: string, action: string | null = null) {
  return q<{ action: string; before_data: Record<string, unknown>; after_data: Record<string, unknown> }>(
    `SELECT action, before_data, after_data FROM audit_logs WHERE patient_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY created_at`,
    [patientId, action]);
}
/** Dates the first `used` sessions of a period and puts money on them. */
async function complete(patientId: string, period: number, used: number) {
  await q(`UPDATE visit_records SET date_of_service = DATE '2026-11-01' + session_number,
                                    total_insurance_reimbursement = 80 + session_number, total_patient_due = 10, total_patient_paid = 5
           WHERE patient_id = $1 AND auth_period = $2 AND session_number <= $3`, [patientId, period, used]);
}
const withoutCountFields = (rows: Snap[]) =>
  rows.map(({ sessions_authorized: _a, sessions_remaining: _r, ...rest }) => rest);

describe.skipIf(!HAS_DOCKER)("P4-P32 initial authorization and period count correction (real Postgres)", { timeout: 60_000 }, () => {
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
    psqlFile(DB, path.join(MIGRATIONS_DIR, P32_MIGRATION)); // re-runnable
  }, 240_000);

  afterAll(() => {
    try { sh("docker", ["rm", "-f", CONTAINER_NAME]); } catch { /* already gone */ }
  });

  describe("initial authorization", () => {
    it("blank-count patient approved for 16: exactly one period 1 of 16 empty sessions, one audit row", async () => {
      const patientId = await newPatient();
      expect(await snapshot(patientId)).toEqual([]);

      const ids = await initial(patientId, 16);
      expect(ids).toHaveLength(16);
      const rows = await snapshot(patientId);
      expect(rows).toHaveLength(16);
      expect(rows.every(r => r.auth_period === 1 && r.sessions_authorized === 16 && r.dos === null && r.auth_status === "none")).toBe(true);
      expect(rows.map(r => r.session_number)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
      expect(rows.map(r => r.sessions_remaining)).toEqual(Array.from({ length: 16 }, (_, i) => 16 - i));
      expect(rows.every(r => r.insurance_company === "Synthetic Ins")).toBe(true);

      const [{ auth_date }] = await q<{ auth_date: string }>(`SELECT auth_date::text FROM patients WHERE id = $1`, [patientId]);
      expect(auth_date).toBe("2026-11-10");
      const log = await audits(patientId);
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ action: "AUTHORIZATION_APPROVED", after_data: { initial: true, new_auth_period: 1, sessions_authorized: 16 } });
    });

    it("retry is refused (P0044) and creates nothing", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      const before = await snapshot(patientId);
      await expect(initial(patientId, 16)).rejects.toMatchObject({ code: "P0044" });
      expect(await snapshot(patientId)).toEqual(before);
      expect(await audits(patientId)).toHaveLength(1);
    });

    it("concurrent double submit: one succeeds, one is refused, 16 rows total", async () => {
      const patientId = await newPatient();
      const results = await Promise.allSettled([initial(patientId, 16), initial(patientId, 16)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "P0044" } });
      expect(await snapshot(patientId)).toHaveLength(16);
    });

    it("refused once ANY row exists (never a renewal), and the renewal path is unchanged", async () => {
      const patientId = await newPatient();
      await initial(patientId, 4);
      await complete(patientId, 1, 4);
      await expect(initial(patientId, 8)).rejects.toMatchObject({ code: "P0044" });
      await approveRenewal(patientId, 1, 8);
      const rows = await snapshot(patientId);
      expect(rows.filter(r => r.auth_period === 2)).toHaveLength(8);
      expect(rows.filter(r => r.auth_period === 1).every(r => r.auth_status === "approved")).toBe(true);
    });

    it("rejects counts outside 1..200 and unknown patients", async () => {
      const patientId = await newPatient();
      await expect(initial(patientId, 0)).rejects.toMatchObject({ code: "P0033" });
      await expect(initial(patientId, 201)).rejects.toMatchObject({ code: "P0033" });
      await expect(initial(randomUUID(), 5)).rejects.toMatchObject({ code: "P0020" });
      expect(await snapshot(patientId)).toEqual([]);
    });
  });

  describe("period count correction", () => {
    it("upward 16 -> 20 with 3 completed: 4 empty rows appended; dates, statuses and money untouched", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      await complete(patientId, 1, 3);
      const before = await snapshot(patientId);

      expect(await correct(patientId, 1, 20, 16)).toEqual({ changed: true, sessions_authorized: 20, added: 4, removed: 0 });
      const after = await snapshot(patientId);
      expect(after).toHaveLength(20);
      expect(withoutCountFields(after.slice(0, 16))).toEqual(withoutCountFields(before));
      expect(after.every(r => r.sessions_authorized === 20)).toBe(true);
      expect(after.map(r => r.sessions_remaining)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
      expect(after.slice(16).every(r => r.dos === null && r.ins === null && r.auth_status === "none")).toBe(true);

      const log = await audits(patientId, "AUTHORIZATION_PERIOD_SESSIONS_CORRECTED");
      expect(log).toHaveLength(1);
      expect(log[0].before_data).toMatchObject({ auth_period: 1, sessions_authorized: 16, session_rows: 16 });
      expect(log[0].after_data).toMatchObject({ sessions_authorized: 20, sessions_completed: 3, session_rows: 20, reason: "synthetic correction" });
    });

    it("safe downward 16 -> 10 with 3 completed: the 6 highest empty rows removed, completed rows kept", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      await complete(patientId, 1, 3);
      const before = await snapshot(patientId);

      expect(await correct(patientId, 1, 10, 16)).toMatchObject({ changed: true, added: 0, removed: 6 });
      const after = await snapshot(patientId);
      expect(after.map(r => r.session_number)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
      expect(withoutCountFields(after)).toEqual(withoutCountFields(before.slice(0, 10)));
      expect(after.filter(r => r.dos !== null)).toHaveLength(3);
      expect(after.every(r => r.sessions_authorized === 10)).toBe(true);
    });

    it("below completed sessions is refused (P0041) with no partial change and no audit", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      await complete(patientId, 1, 13);
      const before = await snapshot(patientId);
      await expect(correct(patientId, 1, 12, 16)).rejects.toMatchObject({ code: "P0041", message: expect.stringContaining("below the 13 completed") });
      expect(await snapshot(patientId)).toEqual(before);
      expect(await audits(patientId, "AUTHORIZATION_PERIOD_SESSIONS_CORRECTED")).toHaveLength(0);
      // exactly the completed count is allowed
      expect(await correct(patientId, 1, 13, 16)).toMatchObject({ changed: true, removed: 3 });
    });

    it("a removable row holding data blocks the whole reduction (P0042) and names the session", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      await q(`UPDATE visit_records SET remarks = 'Synthetic note' WHERE patient_id = $1 AND session_number = 15`, [patientId]);
      await q(`UPDATE visit_records SET auth_status = 'pending', date_ash_submitted = '2026-11-12' WHERE patient_id = $1 AND session_number = 16`, [patientId]);
      const before = await snapshot(patientId);
      await expect(correct(patientId, 1, 14, 16)).rejects.toMatchObject({ code: "P0042", detail: "15, 16" });
      expect(await snapshot(patientId)).toEqual(before);
      expect(await audits(patientId, "AUTHORIZATION_PERIOD_SESSIONS_CORRECTED")).toHaveLength(0);
    });

    it("a status shared by the whole period does not block removal, and appended rows inherit it", async () => {
      const patientId = await newPatient();
      await initial(patientId, 6);
      await complete(patientId, 1, 6);
      await approveRenewal(patientId, 1, 8); // period 1 rows -> approved
      expect(await correct(patientId, 1, 7, 6)).toMatchObject({ added: 1 });
      const p1 = (await snapshot(patientId)).filter(r => r.auth_period === 1);
      expect(p1).toHaveLength(7);
      expect(p1.every(r => r.auth_status === "approved")).toBe(true);
      expect(await correct(patientId, 1, 6, 7)).toMatchObject({ removed: 1 });
    });

    it("an Expired period is refused (P0040) and stays expired", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      await complete(patientId, 1, 5);
      await setExpired(patientId, 1, true);
      const before = await snapshot(patientId);
      for (const n of [20, 10]) await expect(correct(patientId, 1, n, 16)).rejects.toMatchObject({ code: "P0040" });
      expect(await snapshot(patientId)).toEqual(before);
      expect(before.every(r => r.mark !== null)).toBe(true);
      // after a reviewed Restore the correction is allowed
      await setExpired(patientId, 1, false, "synthetic restore");
      expect(await correct(patientId, 1, 20, 16)).toMatchObject({ changed: true });
    });

    it("a stale expected count is refused (P0043)", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      await correct(patientId, 1, 18, 16);
      await expect(correct(patientId, 1, 20, 16)).rejects.toMatchObject({ code: "P0043" });
      expect(await snapshot(patientId)).toHaveLength(18);
    });

    it("unchanged count is a no-op: nothing written, nothing audited", async () => {
      const patientId = await newPatient();
      await initial(patientId, 16);
      const before = await snapshot(patientId);
      expect(await correct(patientId, 1, 16, 16)).toMatchObject({ changed: false });
      expect(await snapshot(patientId)).toEqual(before);
      expect(await audits(patientId, "AUTHORIZATION_PERIOD_SESSIONS_CORRECTED")).toHaveLength(0);
    });

    it("single count-row period (Add Patient layout) only changes its count, never gains rows", async () => {
      const patientId = await newPatient();
      await q(`INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period, new_auth, auth_status)
               VALUES ($1, 20, 20, 1, 1, 'NO', 'none')`, [patientId]);
      expect(await correct(patientId, 1, 12, 20)).toMatchObject({ added: 0, removed: 0 });
      expect(await correct(patientId, 1, 25, 12)).toMatchObject({ added: 0, removed: 0 });
      const rows = await snapshot(patientId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ sessions_authorized: 25, sessions_remaining: 25 });
    });

    it("other periods and patients are untouched", async () => {
      const patientId = await newPatient();
      const other = await newPatient();
      await initial(patientId, 4);
      await complete(patientId, 1, 4);
      await approveRenewal(patientId, 1, 8);
      await initial(other, 5);
      const p1Before = (await snapshot(patientId)).filter(r => r.auth_period === 1);
      const otherBefore = await snapshot(other);
      await correct(patientId, 2, 10, 8);
      expect((await snapshot(patientId)).filter(r => r.auth_period === 1)).toEqual(p1Before);
      expect(await snapshot(other)).toEqual(otherBefore);
    });

    it("refuses an unknown period (P0034)", async () => {
      const patientId = await newPatient();
      await initial(patientId, 4);
      await expect(correct(patientId, 3, 5, 0)).rejects.toMatchObject({ code: "P0034" });
    });
  });

  it("both RPCs are executable by service_role only", async () => {
    for (const sig of [INITIAL_SIG, CORRECT_SIG]) {
      const rows = await q<{ role: string; can: boolean }>(
        `SELECT r AS role, has_function_privilege(r, $1, 'EXECUTE') AS can FROM unnest(ARRAY['anon','authenticated','service_role']) AS r`, [sig]);
      expect(Object.fromEntries(rows.map(r => [r.role, r.can]))).toEqual({ anon: false, authenticated: false, service_role: true });
    }
  });
});
