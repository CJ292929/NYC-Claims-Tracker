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
 * Proves: expiry is a period-level mark (period_expired_at) that never
 * rewrites any row's auth_status; Restore needs a reason, is refused once a
 * later period exists, and puts every row back exactly as it was; one audit
 * row per actual change; the guard trigger stops every other write path from
 * expiring/reactivating a period, makes new or moved rows inherit the mark,
 * and refuses dates of service after expiry while allowing earlier
 * corrections; request + approval from an expired period creates a new
 * period without reactivating the old one or carrying unused sessions over.
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
const FN_SIG = "public.set_auth_period_expired_with_audit(uuid, integer, boolean, text, uuid, text, text)";

/** Calls the RPC exactly as server/db.ts setAuthPeriodExpired does. */
async function setExpired(db: string, patientId: string, authPeriod: number, expired: boolean, reason: string | null = null) {
  const [{ n }] = await q<{ n: number }>(db, `SELECT set_auth_period_expired_with_audit($1, $2, $3, $4, $5, $6, $7) AS n`, [
    patientId, authPeriod, expired, reason, ...ACTOR,
  ]);
  return n;
}

/** As server/db.ts updateVisitRecord / createVisitRecord do. */
async function writeVisit(db: string, id: string | null, patientId: string, data: Record<string, unknown>, action = "VISIT_RECORD_UPDATE") {
  const [{ id: out }] = await q<{ id: string }>(db, `SELECT write_visit_record_with_audit($1, $2, $3::jsonb, $4, $5, $6, $7) AS id`,
    [id, patientId, JSON.stringify(data), ...ACTOR, action]);
  return out;
}

/** Period 1: 4 used + Approved. Period 2: 16 authorized, 13 completed, money
 *  on the used rows; "mixed" gives period 2 pending / denied / approved / none rows. */
async function seed(db: string, period2Status = "none") {
  const [{ id: patientId }] = await q<{ id: string }>(db,
    `INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_p31_${randomUUID()}`]);
  for (let i = 1; i <= 4; i++) {
    await q(db, `INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period, date_of_service, auth_status)
                 VALUES ($1, 4, $2, $3, 1, '2026-03-0${i}', 'approved')`, [patientId, 4 - i, i]);
  }
  for (let i = 1; i <= 16; i++) {
    const used = i <= 13;
    const status = period2Status !== "mixed" ? period2Status
      : i === 3 ? "denied" : i === 5 ? "approved" : i === 16 ? "pending" : "none";
    await q(db, `INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period,
                                            date_of_service, auth_status, total_insurance_reimbursement, total_patient_due, total_patient_paid)
                 VALUES ($1, 16, $2, $3, 2, $4, $5, $6, $7, $8)`,
      [patientId, 16 - i, i, used ? `2026-05-${String(i).padStart(2, "0")}` : null, status,
        used ? 80 + i : null, used ? 10 : null, used ? 5 : null]);
  }
  return patientId;
}

type Snap = Record<string, unknown>;
async function snapshot(db: string, patientId: string): Promise<Snap[]> {
  return q(db, `SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
                       auth_status, total_insurance_reimbursement::text AS ins, total_patient_due::text AS due, total_patient_paid::text AS paid,
                       period_expired_at::text AS mark
                FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number`, [patientId]);
}

function without(rows: Snap[], ...keys: string[]) {
  return rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))));
}

async function rowId(db: string, patientId: string, period: number, session: number) {
  const [{ id }] = await q<{ id: string }>(db,
    `SELECT id FROM visit_records WHERE patient_id = $1 AND auth_period = $2 AND session_number = $3`, [patientId, period, session]);
  return id;
}

async function auditCount(db: string, patientId: string, action: string | null = null) {
  const [{ n }] = await q<{ n: string }>(db,
    `SELECT count(*) AS n FROM audit_logs WHERE patient_id = $1 AND ($2::text IS NULL OR action = $2)`, [patientId, action]);
  return Number(n);
}

async function period2Marked(db: string, patientId: string) {
  return (await snapshot(db, patientId)).filter(r => r.auth_period === 2).every(r => r.mark !== null);
}

let upgradePatient = "";
let workDir = "";

describe.skipIf(!HAS_DOCKER || !PRE_CHANGE_SCHEMA)("P4-P31 period-level Expired authorization (real Postgres)", { timeout: 60_000 }, () => {
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
    // PRE_CHANGE_SCHEMA is non-null here: the describe is skipped otherwise.
    writeFileSync(preSchemaPath, PRE_CHANGE_SCHEMA ?? "");
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

  it("upgrade: existing rows are not converted, nothing is marked, nothing audited", async () => {
    const rows = await snapshot("upgrade_db", upgradePatient);
    expect(rows.filter(r => r.auth_period === 1).every(r => r.auth_status === "approved")).toBe(true);
    expect(rows.filter(r => r.auth_period === 2).every(r => r.auth_status === "denied")).toBe(true);
    expect(rows.every(r => r.mark === null)).toBe(true);
    expect(await auditCount("upgrade_db", upgradePatient)).toBe(0);
  });

  it("upgrade: marking a Denied period Expired keeps every row Denied", async () => {
    expect(await setExpired("upgrade_db", upgradePatient, 2, true)).toBe(16);
    const rows = await snapshot("upgrade_db", upgradePatient);
    expect(rows.filter(r => r.auth_period === 2).every(r => r.auth_status === "denied" && r.mark !== null)).toBe(true);
  });

  for (const db of ["upgrade_db", "fresh_db"]) {
    describe(db, () => {
      it("auth_status CHECK is unchanged: there is no row-level 'expired' value", async () => {
        const patientId = await seed(db);
        await expect(q(db, `UPDATE visit_records SET auth_status = 'expired' WHERE patient_id = $1`, [patientId])).rejects.toMatchObject({ code: "23514" });
      });

      it("13/16 marked Expired: one period-level mark; statuses, counts, dates, money and period 1 untouched; one audit row", async () => {
        const patientId = await seed(db, "mixed");
        const before = await snapshot(db, patientId);
        expect(await setExpired(db, patientId, 2, true)).toBe(16);
        const after = await snapshot(db, patientId);

        expect(without(after, "mark")).toEqual(without(before, "mark")); // incl. the mixed auth_status values
        const p2 = after.filter(r => r.auth_period === 2);
        expect(p2.every(r => r.mark !== null)).toBe(true);
        expect(new Set(p2.map(r => r.mark)).size).toBe(1);
        expect(after.filter(r => r.auth_period === 1).every(r => r.mark === null)).toBe(true);

        const audits = await q<{ actor_id: string; actor_display: string; entity_id: string; before_data: Snap; after_data: Snap }>(db,
          `SELECT actor_id, actor_display, entity_id, before_data, after_data FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_PERIOD_EXPIRED'`, [patientId]);
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ actor_id: ACTOR_ID, actor_display: "Synthetic Staff", entity_id: patientId });
        expect(audits[0].before_data).toEqual({ auth_period: 2, period_expired_at: null });
        expect(audits[0].after_data).toMatchObject({ auth_period: 2, sessions_authorized: 16, sessions_completed: 13, sessions_unused: 3, reason: null });
        expect(new Set(audits[0].after_data.visit_ids as string[])).toEqual(new Set(p2.map(r => r.id)));

        // Re-running is a no-op: nothing changes, no new audit rows.
        expect(await setExpired(db, patientId, 2, true)).toBe(0);
        expect(await auditCount(db, patientId)).toBe(1);
      });

      it("Restore: reason required, then every row is exactly as before Mark Expired; audited with the reason", async () => {
        const patientId = await seed(db, "mixed");
        const original = await snapshot(db, patientId);
        await setExpired(db, patientId, 2, true);

        await expect(setExpired(db, patientId, 2, false)).rejects.toMatchObject({ code: "22023" });
        await expect(setExpired(db, patientId, 2, false, "   ")).rejects.toMatchObject({ code: "22023" });
        await expect(setExpired(db, patientId, 2, false, "x".repeat(501))).rejects.toMatchObject({ code: "22023" });
        expect(await period2Marked(db, patientId)).toBe(true);

        expect(await setExpired(db, patientId, 2, false, "Marked by mistake")).toBe(16);
        expect(await snapshot(db, patientId)).toEqual(original);

        const audits = await q<{ before_data: Snap; after_data: Snap }>(db,
          `SELECT before_data, after_data FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_PERIOD_EXPIRY_RESTORED'`, [patientId]);
        expect(audits).toHaveLength(1);
        expect(audits[0].before_data.period_expired_at).not.toBeNull();
        expect(audits[0].after_data).toMatchObject({ auth_period: 2, period_expired_at: null, reason: "Marked by mistake", sessions_unused: 3 });

        // Restoring a period that isn't expired is a no-op (no audit).
        expect(await setExpired(db, patientId, 2, false, "again")).toBe(0);
        expect(await auditCount(db, patientId)).toBe(2);
      });

      it("guard: row writes can't expire or reactivate a period; status edits stay ordinary", async () => {
        const patientId = await seed(db);
        const p2s1 = await rowId(db, patientId, 2, 1);
        const p1s1 = await rowId(db, patientId, 1, 1);
        // Not expired: setting the mark directly is refused; the audited RPC never writes it.
        await expect(q(db, `UPDATE visit_records SET period_expired_at = now() WHERE id = $1`, [p1s1])).rejects.toMatchObject({ code: "P0035" });
        await writeVisit(db, p1s1, patientId, { period_expired_at: "2026-11-01T00:00:00Z" });
        expect((await snapshot(db, patientId)).every(r => r.mark === null)).toBe(true);

        await setExpired(db, patientId, 2, true);
        // Expired: clearing it from one row or the whole period is refused.
        await expect(q(db, `UPDATE visit_records SET period_expired_at = NULL WHERE id = $1`, [p2s1])).rejects.toMatchObject({ code: "P0035" });
        await expect(q(db, `UPDATE visit_records SET period_expired_at = NULL WHERE patient_id = $1 AND auth_period = 2`, [patientId])).rejects.toMatchObject({ code: "P0035" });
        await writeVisit(db, p2s1, patientId, { period_expired_at: null });
        expect(await period2Marked(db, patientId)).toBe(true);

        // Ordinary status edits work on every row and never touch the mark.
        for (const status of ["pending", "approved", "denied", "none"]) {
          await writeVisit(db, p2s1, patientId, { auth_status: status });
        }
        await q(db, `UPDATE visit_records SET auth_status = 'approved' WHERE patient_id = $1 AND auth_period = 2`, [patientId]);
        const rows = await snapshot(db, patientId);
        expect(rows.filter(r => r.auth_period === 2).every(r => r.mark !== null && r.auth_status === "approved")).toBe(true);
        expect(rows.filter(r => r.auth_period === 1).every(r => r.mark === null)).toBe(true);
      });

      it("guard: dates of service on an expired period — earlier corrections allowed, after-expiry refused on every path", async () => {
        const patientId = await seed(db);
        await setExpired(db, patientId, 2, true);
        const blank = await rowId(db, patientId, 2, 14);
        const used = await rowId(db, patientId, 2, 2);

        // Completion after expiry: refused via the RPC and a raw UPDATE.
        await expect(writeVisit(db, blank, patientId, { date_of_service: "2099-01-01" })).rejects.toMatchObject({ code: "P0036" });
        await expect(q(db, `UPDATE visit_records SET date_of_service = '2099-01-01' WHERE id = $1`, [blank])).rejects.toMatchObject({ code: "P0036" });
        // Moving an existing date past expiry: refused.
        await expect(writeVisit(db, used, patientId, { date_of_service: "2099-01-01" })).rejects.toMatchObject({ code: "P0036" });

        // Historical corrections (on/before expiry) and clearing a date: allowed.
        await writeVisit(db, blank, patientId, { date_of_service: "2026-05-20" });
        await writeVisit(db, used, patientId, { date_of_service: "2026-05-03" });
        await writeVisit(db, used, patientId, { date_of_service: null });
        const rows = (await snapshot(db, patientId)).filter(r => r.auth_period === 2);
        expect(rows.find(r => r.id === blank)?.dos).toBe("2026-05-20");
        expect(rows.find(r => r.id === used)?.dos).toBeNull();
        expect(rows.every(r => r.mark !== null)).toBe(true);
      });

      it("guard: rows inserted or moved into an expired period inherit the mark (no half-expired period)", async () => {
        const patientId = await seed(db);
        await setExpired(db, patientId, 2, true);
        const [{ at }] = await q<{ at: string }>(db,
          `SELECT max(period_expired_at)::text AS at FROM visit_records WHERE patient_id = $1 AND auth_period = 2`, [patientId]);

        // createVisitRecord path.
        const created = await writeVisit(db, null, patientId, { auth_period: 2, session_number: 17, date_of_service: "2026-05-30" }, "VISIT_RECORD_CREATE");
        // bulkCreateVisitRecords path (plain INSERT).
        await q(db, `INSERT INTO visit_records (patient_id, auth_period, session_number) VALUES ($1, 2, 18)`, [patientId]);
        await expect(q(db, `INSERT INTO visit_records (patient_id, auth_period, session_number, date_of_service) VALUES ($1, 2, 19, '2099-01-01')`, [patientId]))
          .rejects.toMatchObject({ code: "P0036" });
        // Claiming a mark directly on insert is refused.
        await expect(q(db, `INSERT INTO visit_records (patient_id, auth_period, session_number, period_expired_at) VALUES ($1, 1, 9, now())`, [patientId]))
          .rejects.toMatchObject({ code: "P0035" });
        // Moving a period-1 row into period 2 inherits; moving it back drops it.
        const p1s4 = await rowId(db, patientId, 1, 4);
        await writeVisit(db, p1s4, patientId, { auth_period: 2 });

        const marks = await q<{ id: string; at: string | null; auth_period: number }>(db,
          `SELECT id, period_expired_at::text AS at, auth_period FROM visit_records WHERE patient_id = $1`, [patientId]);
        expect(marks.filter(m => m.auth_period === 2).every(m => m.at === at)).toBe(true);
        expect(marks.find(m => m.id === created)?.at).toBe(at);
        await writeVisit(db, p1s4, patientId, { auth_period: 1 });
        const [{ back }] = await q<{ back: string | null }>(db, `SELECT period_expired_at::text AS back FROM visit_records WHERE id = $1`, [p1s4]);
        expect(back).toBeNull();
      });

      it("request + approval from an expired period: new period, old one stays expired, nothing carried forward", async () => {
        const patientId = await seed(db);
        await setExpired(db, patientId, 2, true);
        // Mark Requested: the status row (last row of period 2) -> pending, as server/routers.ts does.
        const lastRow = await rowId(db, patientId, 2, 16);
        await writeVisit(db, lastRow, patientId, { auth_status: "pending", date_ash_submitted: "2026-11-14" }, "AUTHORIZATION_MARKED_REQUESTED");
        expect(await period2Marked(db, patientId)).toBe(true);
        const before = await snapshot(db, patientId);

        const ids = await q<{ id: string }>(db,
          `SELECT approve_authorization_with_audit($1, 2, 12, '2026-11-14', NULL, false, NULL, $2, $3, $4) AS id`, [patientId, ...ACTOR]);
        expect(ids).toHaveLength(12);

        const after = await snapshot(db, patientId);
        const oldP2 = after.filter(r => r.auth_period === 2);
        expect(oldP2.every(r => r.mark !== null)).toBe(true);
        expect(without(oldP2, "auth_status")).toEqual(without(before.filter(r => r.auth_period === 2), "auth_status"));

        const p3 = after.filter(r => r.auth_period === 3);
        expect(p3).toHaveLength(12);
        expect(p3.every(r => r.sessions_authorized === 12 && r.dos === null && r.auth_status === "none" && r.mark === null)).toBe(true);

        // Period 2 can no longer be restored: a newer authorization superseded it.
        await expect(setExpired(db, patientId, 2, false, "try")).rejects.toMatchObject({ code: "P0037" });
        expect(await period2Marked(db, patientId)).toBe(true);
        expect(await auditCount(db, patientId, "AUTHORIZATION_PERIOD_EXPIRY_RESTORED")).toBe(0);
      });

      it("refuses an unknown period or patient and writes nothing", async () => {
        const patientId = await seed(db);
        await expect(setExpired(db, patientId, 9, true)).rejects.toMatchObject({ code: "P0034" });
        await expect(setExpired(db, randomUUID(), 1, true)).rejects.toMatchObject({ code: "P0020" });
        const rows = await snapshot(db, patientId);
        expect(rows.some(r => r.mark !== null)).toBe(false);
        expect(await auditCount(db, patientId)).toBe(0);
      });

      it("is executable by service_role only", async () => {
        const [{ svc, anon, authd }] = await q<{ svc: boolean; anon: boolean; authd: boolean }>(db, `SELECT
          has_function_privilege('service_role', '${FN_SIG}', 'EXECUTE') AS svc,
          has_function_privilege('anon', '${FN_SIG}', 'EXECUTE') AS anon,
          has_function_privilege('authenticated', '${FN_SIG}', 'EXECUTE') AS authd`);
        expect({ svc, anon, authd }).toEqual({ svc: true, anon: false, authd: false });
      });
    });
  }
});
