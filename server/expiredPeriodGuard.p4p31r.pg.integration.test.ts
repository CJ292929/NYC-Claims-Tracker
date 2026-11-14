/**
 * server/expiredPeriodGuard.p4p31r.pg.integration.test.ts — P4-P31R
 *
 * Real-Postgres regression tests for the defects found in the PR #83 review
 * of bf51417, against
 * supabase/migrations/20261115000000_p4_p31r_expired_period_guard_upgrade.sql.
 * Synthetic data only. Disposable `postgres:16` Docker container, removed
 * afterwards.
 *
 *   1. Expiry cutoff is the America/New_York calendar date (was UTC: one day
 *      late from 19:00 EST / 20:00 EDT). Winter and summer midnight
 *      boundaries, and both DST transition days.
 *   2. Lock protocol. Deterministic two-connection tests: the second
 *      connection is observed waiting on a lock (pg_stat_activity) before
 *      the first commits. They cover mark/restore against insert (RPC and
 *      plain), a cross-patient move, a same-patient move (both orders), and
 *      approve. No unmarked row escapes. Where a raw SQL interleaving can
 *      deadlock, Postgres aborts one side with 40P01 and the data stays
 *      consistent.
 *   3. An expired period can't be emptied. The last row can't be moved or
 *      deleted (P0038), including by two concurrent operations that each
 *      see the other's row. A misfiled row can still be moved, and the
 *      patient-delete cascade still works.
 *   4. The internal bypass setting is honoured only for the mark function's
 *      own in-period UPDATE.
 *   5. Upgrade from every earlier state converges to one schema:
 *      fresh_db           head schema + every migration
 *      upgrade_db         pre-P4-P31 schema, bf51417 variant applied (with
 *                         a mark made under it), then P4-P31R twice
 *      legacy_clean_db    pre-P4-P31 schema, d2a6ac5 variant applied (no
 *                         'expired' rows), then P4-P31R
 *      legacy_expired_db  d2a6ac5 variant WITH 'expired' rows: P4-P31R
 *                         refuses (P0039) and changes nothing
 *
 * Runs in CI (postgres-integration job, REQUIRE_PG_INTEGRATION=1: a missing
 * prerequisite fails instead of skipping). Locally it self-skips without
 * Docker.
 *
 *   npx vitest run server/expiredPeriodGuard.p4p31r.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `p4p31r-guard-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const P31_MIGRATION = "20261114000000_p4_p31_expired_authorization_status.sql";
const P31R_MIGRATION = "20261115000000_p4_p31r_expired_period_guard_upgrade.sql";
/** The d2a6ac5 variant of 20261114000000, vendored so CI doesn't need that PR-only commit. */
const LEGACY_D2A6AC5 = path.join(REPO_ROOT, "server", "fixtures", "p4p31-d2a6ac5-legacy-migration.sql");
/** main immediately before P4-P31 (merge of PR #82). */
const PRE_P31_REF = "a5a2a71";

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function preChangeSchema(): string | null {
  try {
    return execFileSync("git", ["show", `${PRE_P31_REF}:references/local-setup-schema.sql`], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    return null;
  }
}
const HAS_DOCKER = dockerAvailable();
const PRE_SCHEMA = preChangeSchema();
if (process.env.REQUIRE_PG_INTEGRATION === "1" && (!HAS_DOCKER || !PRE_SCHEMA)) {
  throw new Error(`REQUIRE_PG_INTEGRATION=1 but docker=${HAS_DOCKER}, pre-P4-P31 schema at ${PRE_P31_REF}=${PRE_SCHEMA !== null}`);
}

function sh(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function psqlFile(db: string, filePath: string) {
  const remote = `/tmp/apply-${randomUUID().slice(0, 8)}.sql`;
  sh("docker", ["cp", filePath, `${CONTAINER_NAME}:${remote}`]);
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME,
    "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", remote]);
}
function psqlInline(db: string, sql: string) {
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME,
    "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql]);
}

let port = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(db: string): Promise<{ c: Client; pid: number }> {
  const c = new Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: db });
  await c.connect();
  const { rows } = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  return { c, pid: rows[0].pid };
}
async function q<T = Record<string, unknown>>(db: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const { c } = await connect(db);
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Deterministic interleaving: resolves once `pid` is blocked waiting on a lock. */
async function waitUntilBlocked(db: string, pid: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const [row] = await q<{ wait_event_type: string | null }>(db,
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
    if (row?.wait_event_type === "Lock") return;
    await sleep(20);
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

type Outcome = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string | undefined; message: string };
function settle(p: Promise<{ rows: Record<string, unknown>[] }>): Promise<Outcome> {
  return p.then(
    (r) => ({ ok: true as const, rows: r.rows }),
    (e: { code?: string; message?: string }) => ({ ok: false as const, code: e.code, message: e.message ?? "" }),
  );
}

const SUPABASE_ROLES = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
  END $$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
`;

const ACTOR_ID = "00000000-0000-4000-8000-0000000000b2";
const ACTOR = [ACTOR_ID, "clinic_user", "Synthetic Staff"] as const;
const MARK_SQL = `SELECT set_auth_period_expired_with_audit($1, $2, $3, $4, $5, $6, $7) AS n`;
const WRITE_SQL = `SELECT write_visit_record_with_audit($1, $2, $3::jsonb, $4, $5, $6, $7) AS id`;
const APPROVE_SQL = `SELECT approve_authorization_with_audit($1, $2, $3, NULL, NULL, false, NULL, $4, $5, $6) AS id`;

const markArgs = (patientId: string, period: number, expired: boolean, reason: string | null = null) =>
  [patientId, period, expired, reason, ...ACTOR];
const writeArgs = (id: string | null, patientId: string, data: Record<string, unknown>, action = "VISIT_RECORD_UPDATE") =>
  [id, patientId, JSON.stringify(data), ...ACTOR, action];

/** One patient; each spec entry is [auth_period, sessions_authorized, used]. Used rows carry dates and money. */
async function seedPatient(db: string, spec: Array<[number, number, number]>) {
  const [{ id: patientId }] = await q<{ id: string }>(db,
    `INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_p31r_${randomUUID()}`]);
  for (const [period, sessions, used] of spec) {
    for (let i = 1; i <= sessions; i++) {
      const isUsed = i <= used;
      await q(db, `INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period,
                                              date_of_service, auth_status, total_insurance_reimbursement, total_patient_due, total_patient_paid)
                   VALUES ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, $9)`,
        [patientId, sessions, sessions - i, i, period, isUsed ? `2026-0${period}-${String(i).padStart(2, "0")}` : null,
          isUsed ? 90 + i : null, isUsed ? 12.5 : null, isUsed ? 7.25 : null]);
    }
  }
  return patientId;
}
async function mark(db: string, patientId: string, period: number) {
  return (await q<{ n: number }>(db, MARK_SQL, markArgs(patientId, period, true)))[0].n;
}
async function rowIds(db: string, patientId: string, period: number) {
  return (await q<{ id: string }>(db,
    `SELECT id FROM visit_records WHERE patient_id = $1 AND auth_period = $2 ORDER BY session_number, id`, [patientId, period])).map((r) => r.id);
}
async function periodState(db: string, patientId: string, period: number) {
  const [r] = await q<{ total: string; marked: string; marks: string }>(db,
    `SELECT count(*) AS total, count(period_expired_at) AS marked, count(DISTINCT period_expired_at) AS marks
     FROM visit_records WHERE patient_id = $1 AND auth_period = $2`, [patientId, period]);
  return { total: Number(r.total), marked: Number(r.marked), marks: Number(r.marks) };
}
/** The invariant every test ends on: a period is fully marked with one value, or not marked at all. */
async function expectNoHalfExpiredPeriod(db: string, patientId: string) {
  const rows = await q<{ auth_period: number; total: string; marked: string; marks: string }>(db,
    `SELECT auth_period, count(*) AS total, count(period_expired_at) AS marked, count(DISTINCT period_expired_at) AS marks
     FROM visit_records WHERE patient_id = $1 GROUP BY auth_period`, [patientId]);
  for (const r of rows) {
    const ok = Number(r.marked) === 0 || (Number(r.marked) === Number(r.total) && Number(r.marks) === 1);
    expect(ok, `period ${r.auth_period}: ${r.marked}/${r.total} marked, ${r.marks} distinct marks`).toBe(true);
  }
}
async function setMarkAt(c: Client, patientId: string, period: number, at: string) {
  // The internal bypass, used here only to put a mark at a chosen instant
  // (set_auth_period_expired_with_audit always uses now()).
  await c.query(`SELECT set_config('app.p4p31_period_expiry_write', 'on', true)`);
  await c.query(`UPDATE visit_records SET period_expired_at = $3 WHERE patient_id = $1 AND auth_period = $2`, [patientId, period, at]);
  await c.query(`SELECT set_config('app.p4p31_period_expiry_write', 'off', true)`);
}
function nextDay(ymd: string) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** [instant marked Expired, expected New York cutoff date, label]. */
const CUTOFF_CASES: Array<[string, string, string]> = [
  ["2026-11-14T23:59:00Z", "2026-11-14", "winter 18:59 EST"],
  ["2026-11-15T00:00:00Z", "2026-11-14", "winter 19:00 EST (UTC is already 11-15)"],
  ["2026-11-15T04:59:00Z", "2026-11-14", "winter 23:59 EST"],
  ["2026-11-15T05:00:00Z", "2026-11-15", "winter midnight EST"],
  ["2026-07-01T23:59:00Z", "2026-07-01", "summer 19:59 EDT"],
  ["2026-07-02T00:00:00Z", "2026-07-01", "summer 20:00 EDT (UTC is already 07-02)"],
  ["2026-07-02T03:59:00Z", "2026-07-01", "summer 23:59 EDT"],
  ["2026-07-02T04:00:00Z", "2026-07-02", "summer midnight EDT"],
  ["2026-03-08T04:59:00Z", "2026-03-07", "spring-forward eve 23:59 EST"],
  ["2026-03-08T05:00:00Z", "2026-03-08", "spring-forward day 00:00 EST"],
  ["2026-03-08T06:59:00Z", "2026-03-08", "spring-forward 01:59 EST (last minute before the gap)"],
  ["2026-03-08T07:00:00Z", "2026-03-08", "spring-forward 03:00 EDT (first minute after the gap)"],
  ["2026-03-09T02:30:00Z", "2026-03-08", "spring-forward day 22:30 EDT"],
  ["2026-03-09T03:59:00Z", "2026-03-08", "spring-forward day 23:59 EDT"],
  ["2026-03-09T04:00:00Z", "2026-03-09", "day after spring-forward 00:00 EDT"],
  ["2026-11-01T03:59:00Z", "2026-10-31", "fall-back eve 23:59 EDT"],
  ["2026-11-01T04:00:00Z", "2026-11-01", "fall-back day 00:00 EDT"],
  ["2026-11-01T05:30:00Z", "2026-11-01", "fall-back 01:30 EDT (first pass)"],
  ["2026-11-01T06:30:00Z", "2026-11-01", "fall-back 01:30 EST (repeated hour)"],
  ["2026-11-02T04:30:00Z", "2026-11-01", "fall-back day 23:30 EST"],
  ["2026-11-02T04:59:00Z", "2026-11-01", "fall-back day 23:59 EST"],
  ["2026-11-02T05:00:00Z", "2026-11-02", "day after fall-back 00:00 EST"],
];

const BEHAVIOUR_DBS = ["fresh_db", "upgrade_db", "legacy_clean_db"] as const;
let workDir = "";
let bfMarkedPatient = "";
let bfMarkBefore = "";
let legacyCleanPatient = "";
let legacyCleanBefore: Record<string, unknown>[] = [];
let legacyExpiredPatient = "";
let legacyExpiredError = "";

const LEGACY_SNAPSHOT = `SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
  auth_status, total_insurance_reimbursement::text AS ins, total_patient_due::text AS due, total_patient_paid::text AS paid
  FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number`;

describe.skipIf(!HAS_DOCKER || !PRE_SCHEMA)("P4-P31R expired-period guard (real Postgres)", { timeout: 90_000 }, () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p31r-"));
    sh("docker", ["run", "-d", "--name", CONTAINER_NAME, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    const match = sh("docker", ["port", CONTAINER_NAME, "5432"]).trim().match(/:(\d+)$/);
    if (!match) throw new Error("Could not parse published port");
    port = Number(match[1]);
    for (let i = 0; ; i++) {
      try { sh("docker", ["exec", CONTAINER_NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); break; } catch {
        if (i > 30) throw new Error("Postgres container did not become ready");
        await sleep(1000);
      }
    }

    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const before = migrations.filter((f) => f < P31_MIGRATION);
    const after = migrations.filter((f) => f > P31R_MIGRATION);
    const preSchemaPath = path.join(workDir, "pre-p31-local-setup-schema.sql");
    writeFileSync(preSchemaPath, PRE_SCHEMA ?? "");
    const mig = (f: string) => path.join(MIGRATIONS_DIR, f);
    const base = (db: string, schema: string) => {
      psqlInline("postgres", `CREATE DATABASE ${db}`);
      psqlInline(db, SUPABASE_ROLES);
      psqlFile(db, schema);
    };

    // A: fresh — the head reference schema plus every migration.
    base("fresh_db", path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const f of migrations) psqlFile("fresh_db", mig(f));

    // B: bf51417 applied, a period marked under it, then P4-P31R twice.
    base("upgrade_db", preSchemaPath);
    for (const f of before) psqlFile("upgrade_db", mig(f));
    psqlFile("upgrade_db", mig(P31_MIGRATION));
    bfMarkedPatient = await seedPatient("upgrade_db", [[1, 4, 4], [2, 6, 3]]);
    await mark("upgrade_db", bfMarkedPatient, 2);
    bfMarkBefore = (await q<{ m: string }>("upgrade_db",
      `SELECT max(period_expired_at)::text AS m FROM visit_records WHERE patient_id = $1 AND auth_period = 2`, [bfMarkedPatient]))[0].m;
    psqlFile("upgrade_db", mig(P31R_MIGRATION));
    psqlFile("upgrade_db", mig(P31R_MIGRATION));
    for (const f of after) psqlFile("upgrade_db", mig(f));

    // C (clean): d2a6ac5 applied (its ledger version is recorded, so the
    // bf51417 file would be skipped by `db push`), no 'expired' rows, then P4-P31R.
    base("legacy_clean_db", preSchemaPath);
    for (const f of before) psqlFile("legacy_clean_db", mig(f));
    psqlFile("legacy_clean_db", LEGACY_D2A6AC5);
    legacyCleanPatient = await seedPatient("legacy_clean_db", [[1, 4, 4], [2, 6, 3]]);
    await q("legacy_clean_db", `UPDATE visit_records SET auth_status = 'denied' WHERE patient_id = $1 AND auth_period = 2 AND session_number = 6`, [legacyCleanPatient]);
    legacyCleanBefore = await q("legacy_clean_db", LEGACY_SNAPSHOT, [legacyCleanPatient]);
    psqlFile("legacy_clean_db", mig(P31R_MIGRATION));
    psqlFile("legacy_clean_db", mig(P31R_MIGRATION));
    for (const f of after) psqlFile("legacy_clean_db", mig(f));

    // C (with rows): d2a6ac5 used to mark a period -> rows hold auth_status = 'expired'.
    base("legacy_expired_db", preSchemaPath);
    for (const f of before) psqlFile("legacy_expired_db", mig(f));
    psqlFile("legacy_expired_db", LEGACY_D2A6AC5);
    legacyExpiredPatient = await seedPatient("legacy_expired_db", [[1, 4, 4], [2, 6, 3]]);
    await q("legacy_expired_db", `SELECT set_auth_period_expired_with_audit($1, 2, true, $2, $3, $4)`, [legacyExpiredPatient, ...ACTOR]);
    try {
      psqlFile("legacy_expired_db", mig(P31R_MIGRATION));
    } catch (e) {
      legacyExpiredError = String((e as { stderr?: string }).stderr ?? e);
    }
  }, 300_000);

  afterAll(() => {
    try { sh("docker", ["rm", "-f", CONTAINER_NAME]); } catch { /* already gone */ }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  // ─── 5: upgrade convergence ────────────────────────────────────────────────
  describe("upgrade from earlier variants", () => {
    const OBJECTS_SQL = `
      SELECT 'fn:' || p.oid::regprocedure::text AS k, pg_get_functiondef(p.oid) AS v
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname IN ('visit_records_period_expiry_guard', 'auth_period_expiry_cutoff',
             'set_auth_period_expired_with_audit', 'write_visit_record_with_audit', 'approve_authorization_with_audit')
      UNION ALL
      SELECT 'grant:' || p.oid::regprocedure::text || ':' || r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE')::text
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        CROSS JOIN (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(rolname)
       WHERE n.nspname = 'public' AND p.proname IN ('set_auth_period_expired_with_audit', 'write_visit_record_with_audit', 'approve_authorization_with_audit')
      UNION ALL
      SELECT 'trigger:' || tgname, pg_get_triggerdef(oid) FROM pg_trigger
       WHERE tgrelid = 'public.visit_records'::regclass AND tgname = 'visit_records_period_expiry_guard'
      UNION ALL
      SELECT 'check:auth_status', pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'public.visit_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%auth_status%'
      UNION ALL
      SELECT 'column:period_expired_at', format_type(atttypid, atttypmod) FROM pg_attribute
       WHERE attrelid = 'public.visit_records'::regclass AND attname = 'period_expired_at' AND NOT attisdropped
      ORDER BY 1`;

    it("fresh, bf51417-upgraded and d2a6ac5-upgraded databases end with identical P4-P31 objects and grants", async () => {
      const [fresh, upgrade, legacy] = await Promise.all(BEHAVIOUR_DBS.map((db) => q<{ k: string; v: string }>(db, OBJECTS_SQL)));
      expect(upgrade).toEqual(fresh);
      expect(legacy).toEqual(fresh);
      const keys = fresh.map((r) => r.k);
      expect(keys).toContain("fn:set_auth_period_expired_with_audit(uuid,integer,boolean,text,uuid,text,text)");
      expect(keys).not.toContain("fn:set_auth_period_expired_with_audit(uuid,integer,boolean,uuid,text,text)");
      expect(fresh.find((r) => r.k === "check:auth_status")?.v).not.toMatch(/expired/);
      expect(fresh.find((r) => r.k.startsWith("fn:approve_authorization_with_audit"))?.v).not.toMatch(/expired/);
      expect(fresh.find((r) => r.k === "trigger:visit_records_period_expiry_guard")?.v).toMatch(/BEFORE INSERT OR DELETE OR UPDATE/);
      expect(fresh.filter((r) => r.k.startsWith("grant:") && !r.k.endsWith(":service_role")).every((r) => r.v === "false")).toBe(true);
    });

    it("bf51417 state: a mark made before the upgrade is kept exactly; statuses, dates and money untouched", async () => {
      const rows = await q<{ auth_period: number; mark: string | null; auth_status: string; dos: string | null; ins: string | null }>("upgrade_db",
        `SELECT auth_period, period_expired_at::text AS mark, auth_status, date_of_service::text AS dos, total_insurance_reimbursement::text AS ins
         FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number`, [bfMarkedPatient]);
      expect(rows.filter((r) => r.auth_period === 2).every((r) => r.mark === bfMarkBefore)).toBe(true);
      expect(rows.filter((r) => r.auth_period === 1).every((r) => r.mark === null)).toBe(true);
      expect(rows.every((r) => r.auth_status === "approved")).toBe(true);
      expect(rows.filter((r) => r.dos !== null)).toHaveLength(7);
      expect(rows.find((r) => r.auth_period === 1)?.ins).toBe("91.00");
    });

    it("d2a6ac5 state without 'expired' rows: every row, status and amount is unchanged by the upgrade", async () => {
      expect(await q("legacy_clean_db", LEGACY_SNAPSHOT, [legacyCleanPatient])).toEqual(legacyCleanBefore);
      expect((await periodState("legacy_clean_db", legacyCleanPatient, 2)).marked).toBe(0);
    });

    it("d2a6ac5 state WITH 'expired' rows: the upgrade refuses (P0039), reports the count, and changes nothing", async () => {
      expect(legacyExpiredError).toMatch(/p4_p31r_legacy_expired_rows: 6 visit_records row\(s\)/);
      const db = "legacy_expired_db";
      const [{ n }] = await q<{ n: string }>(db, `SELECT count(*) AS n FROM visit_records WHERE auth_status = 'expired'`);
      expect(Number(n)).toBe(6);
      const [state] = await q<{ legacy_fn: boolean; new_fn: boolean; col: boolean; cutoff_fn: boolean; approve: string; chk: string }>(db, `SELECT
        to_regprocedure('public.set_auth_period_expired_with_audit(uuid, integer, boolean, uuid, text, text)') IS NOT NULL AS legacy_fn,
        to_regprocedure('public.set_auth_period_expired_with_audit(uuid, integer, boolean, text, uuid, text, text)') IS NOT NULL AS new_fn,
        EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.visit_records'::regclass AND attname = 'period_expired_at' AND NOT attisdropped) AS col,
        to_regprocedure('public.auth_period_expiry_cutoff(timestamptz)') IS NOT NULL AS cutoff_fn,
        pg_get_functiondef('public.approve_authorization_with_audit(uuid, integer, integer, date, text, boolean, bigint, uuid, text, text)'::regprocedure) AS approve,
        (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'visit_records_auth_status_check') AS chk`);
      expect(state).toMatchObject({ legacy_fn: true, new_fn: false, col: false, cutoff_fn: false });
      expect(state.approve).toMatch(/auth_status <> 'expired'/);
      expect(state.chk).toMatch(/expired/);
    });
  });

  for (const db of BEHAVIOUR_DBS) {
    describe(db, () => {
      // ─── 1: New York calendar-date cutoff ──────────────────────────────────
      it("cutoff is the America/New_York date of the mark: winter/summer midnight and both DST days", async () => {
        const got = await q<{ ny: string; utc: string }>(db,
          `SELECT auth_period_expiry_cutoff(t::timestamptz)::text AS ny, ((t::timestamptz) AT TIME ZONE 'UTC')::date::text AS utc
           FROM unnest($1::text[]) WITH ORDINALITY AS u(t, i) ORDER BY i`, [CUTOFF_CASES.map((c) => c[0])]);
        CUTOFF_CASES.forEach(([at, ny, label], i) => expect(got[i].ny, `${label} (${at})`).toBe(ny));
        // The cases discriminate: the old UTC rule gives a later date for 10 of them.
        expect(got.filter((g, i) => g.utc !== CUTOFF_CASES[i][1]).length).toBe(10);
      });

      it("guard refuses the day after the New York cutoff and accepts the cutoff itself (insert and RPC update)", async () => {
        const patientId = await seedPatient(db, [[1, 3, 0]]);
        const [blank] = await rowIds(db, patientId, 1);
        const { c } = await connect(db);
        try {
          for (const [at, ny, label] of CUTOFF_CASES) {
            await c.query("BEGIN");
            await setMarkAt(c, patientId, 1, at);
            await c.query("SAVEPOINT s");
            const late = await settle(c.query(`INSERT INTO visit_records (patient_id, auth_period, session_number, date_of_service) VALUES ($1, 1, 9, $2)`, [patientId, nextDay(ny)]));
            expect(late, label).toMatchObject({ ok: false, code: "P0036" });
            expect(late.ok ? "" : late.message, label).toContain(`expired on ${ny} (New York date)`);
            await c.query("ROLLBACK TO SAVEPOINT s");
            const lateRpc = await settle(c.query(WRITE_SQL, writeArgs(blank, patientId, { date_of_service: nextDay(ny) })));
            expect(lateRpc, label).toMatchObject({ ok: false, code: "P0036" });
            await c.query("ROLLBACK TO SAVEPOINT s");
            await c.query(`INSERT INTO visit_records (patient_id, auth_period, session_number, date_of_service) VALUES ($1, 1, 9, $2)`, [patientId, ny]);
            await c.query(WRITE_SQL, writeArgs(blank, patientId, { date_of_service: ny }));
            await c.query("ROLLBACK");
          }
        } finally {
          await c.end();
        }
      });

      // ─── 2: lock protocol (two connections) ────────────────────────────────
      it("mark holds -> RPC insert and plain INSERT wait, then see the mark (inherit it, or P0036)", async () => {
        const patientId = await seedPatient(db, [[1, 3, 1]]);
        const t1 = await connect(db);
        const t2 = await connect(db);
        const t3 = await connect(db);
        try {
          await t1.c.query("BEGIN");
          await t1.c.query(MARK_SQL, markArgs(patientId, 1, true));
          await t2.c.query("BEGIN");
          const ins = settle(t2.c.query(WRITE_SQL, writeArgs(null, patientId, { auth_period: 1, session_number: 4 }, "VISIT_RECORD_CREATE")));
          const late = settle(t3.c.query(`INSERT INTO visit_records (patient_id, auth_period, session_number, date_of_service) VALUES ($1, 1, 5, '2099-01-01')`, [patientId]));
          await waitUntilBlocked(db, t2.pid);
          await waitUntilBlocked(db, t3.pid);
          await t1.c.query("COMMIT");
          expect(await ins).toMatchObject({ ok: true });
          await t2.c.query("COMMIT");
          expect(await late).toMatchObject({ ok: false, code: "P0036" });
          expect(await periodState(db, patientId, 1)).toEqual({ total: 4, marked: 4, marks: 1 });
          await expectNoHalfExpiredPeriod(db, patientId);
        } finally {
          await Promise.all([t1, t2, t3].map((t) => t.c.end()));
        }
      });

      it("insert holds -> mark waits, then marks the new row too (the review's escaping session 3)", async () => {
        const patientId = await seedPatient(db, [[1, 2, 2]]);
        const t1 = await connect(db);
        const t2 = await connect(db);
        try {
          await t2.c.query("BEGIN");
          const [{ id: created }] = (await t2.c.query(WRITE_SQL, writeArgs(null, patientId,
            { auth_period: 1, session_number: 3, date_of_service: "2099-01-01" }, "VISIT_RECORD_CREATE"))).rows as { id: string }[];
          const marking = settle(t1.c.query(MARK_SQL, markArgs(patientId, 1, true)));
          await waitUntilBlocked(db, t1.pid);
          await t2.c.query("COMMIT");
          expect(await marking).toMatchObject({ ok: true, rows: [{ n: 3 }] });
          expect(await periodState(db, patientId, 1)).toEqual({ total: 3, marked: 3, marks: 1 });
          const [audit] = await q<{ ids: string[] }>(db,
            `SELECT after_data->'visit_ids' AS ids FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_PERIOD_EXPIRED'`, [patientId]);
          expect(audit.ids).toContain(created);
        } finally {
          await Promise.all([t1, t2].map((t) => t.c.end()));
        }
      });

      it("mark holds -> a row moved in from another patient waits, then inherits the mark or is refused", async () => {
        const target = await seedPatient(db, [[1, 2, 1]]);
        const other = await seedPatient(db, [[1, 2, 0]]);
        const [a, b] = await rowIds(db, other, 1);
        const t1 = await connect(db);
        const t2 = await connect(db);
        try {
          await t1.c.query("BEGIN");
          await t1.c.query(MARK_SQL, markArgs(target, 1, true));
          await t2.c.query("BEGIN");
          const moveLate = settle(t2.c.query(`UPDATE visit_records SET patient_id = $2, date_of_service = '2099-01-01' WHERE id = $1`, [a, target]));
          await waitUntilBlocked(db, t2.pid);
          await t1.c.query("COMMIT");
          expect(await moveLate).toMatchObject({ ok: false, code: "P0036" });
          await t2.c.query("ROLLBACK");
          await t1.c.query("BEGIN");
          await t1.c.query(MARK_SQL, markArgs(target, 1, true)); // no-op, still takes the locks
          const move = settle(t2.c.query(`UPDATE visit_records SET patient_id = $2 WHERE id = $1`, [b, target]));
          await waitUntilBlocked(db, t2.pid);
          await t1.c.query("COMMIT");
          expect(await move).toMatchObject({ ok: true });
          expect(await periodState(db, target, 1)).toEqual({ total: 3, marked: 3, marks: 1 });
          await expectNoHalfExpiredPeriod(db, target);
          await expectNoHalfExpiredPeriod(db, other);
        } finally {
          await Promise.all([t1, t2].map((t) => t.c.end()));
        }
      });

      it("same-patient RPC move into a period being marked: both orders serialise, no deadlock, row ends marked", async () => {
        const patientId = await seedPatient(db, [[1, 2, 2], [2, 3, 0]]);
        const [p1a, p1b] = await rowIds(db, patientId, 1);
        const t1 = await connect(db);
        const t2 = await connect(db);
        try {
          // Mark first.
          await t1.c.query("BEGIN");
          await t1.c.query(MARK_SQL, markArgs(patientId, 2, true));
          const move = settle(t2.c.query(WRITE_SQL, writeArgs(p1a, patientId, { auth_period: 2, session_number: 4 })));
          await waitUntilBlocked(db, t2.pid);
          await t1.c.query("COMMIT");
          expect(await move).toMatchObject({ ok: true });
          // Move first.
          await t2.c.query("BEGIN");
          await t2.c.query(WRITE_SQL, writeArgs(p1b, patientId, { auth_period: 2, session_number: 5 }));
          const restoreMark = settle(t1.c.query(MARK_SQL, markArgs(patientId, 2, false, "Mark-order test")));
          await waitUntilBlocked(db, t1.pid);
          await t2.c.query("COMMIT");
          expect(await restoreMark).toMatchObject({ ok: true, rows: [{ n: 5 }] });
          expect(await periodState(db, patientId, 2)).toEqual({ total: 5, marked: 0, marks: 0 });
          await expectNoHalfExpiredPeriod(db, patientId);
        } finally {
          await Promise.all([t1, t2].map((t) => t.c.end()));
        }
      });

      it("restore holds -> an insert waits, then lands in the restored (open) period", async () => {
        const patientId = await seedPatient(db, [[1, 2, 1]]);
        await mark(db, patientId, 1);
        const t1 = await connect(db);
        const t2 = await connect(db);
        try {
          await t1.c.query("BEGIN");
          await t1.c.query(MARK_SQL, markArgs(patientId, 1, false, "Marked by mistake"));
          const ins = settle(t2.c.query(`INSERT INTO visit_records (patient_id, auth_period, session_number, date_of_service) VALUES ($1, 1, 3, '2099-01-01')`, [patientId]));
          await waitUntilBlocked(db, t2.pid);
          await t1.c.query("COMMIT");
          expect(await ins).toMatchObject({ ok: true });
          expect(await periodState(db, patientId, 1)).toEqual({ total: 3, marked: 0, marks: 0 });
        } finally {
          await Promise.all([t1, t2].map((t) => t.c.end()));
        }
      });

      // ─── 3: last-row protection, including concurrent removers ─────────────
      it("the review's reopen: moving rows out stops at the last one (P0038); the period can't be reopened", async () => {
        const patientId = await seedPatient(db, [[1, 4, 4], [2, 2, 0]]);
        await mark(db, patientId, 1);
        const ids = await rowIds(db, patientId, 1);
        for (const id of ids.slice(0, 3)) await q(db, WRITE_SQL, writeArgs(id, patientId, { auth_period: 2 }));
        await expect(q(db, WRITE_SQL, writeArgs(ids[3], patientId, { auth_period: 2 }))).rejects.toMatchObject({ code: "P0038" });
        await expect(q(db, `UPDATE visit_records SET auth_period = 2 WHERE id = $1`, [ids[3]])).rejects.toMatchObject({ code: "P0038" });
        await expect(q(db, `INSERT INTO visit_records (patient_id, auth_period, session_number, date_of_service) VALUES ($1, 1, 9, '2099-06-01')`, [patientId]))
          .rejects.toMatchObject({ code: "P0036" });
        expect(await periodState(db, patientId, 1)).toEqual({ total: 1, marked: 1, marks: 1 });
        // The three corrections are audited at row level.
        const [{ n }] = await q<{ n: string }>(db,
          `SELECT count(*) AS n FROM audit_logs WHERE patient_id = $1 AND action = 'VISIT_RECORD_UPDATE' AND after_data ? 'auth_period'`, [patientId]);
        expect(Number(n)).toBe(3);
        await expectNoHalfExpiredPeriod(db, patientId);
      });

      it("moving a whole expired period in one statement is refused and moves nothing", async () => {
        const patientId = await seedPatient(db, [[1, 3, 3], [2, 1, 0]]);
        await mark(db, patientId, 1);
        await expect(q(db, `UPDATE visit_records SET auth_period = 2 WHERE patient_id = $1 AND auth_period = 1`, [patientId]))
          .rejects.toMatchObject({ code: "P0038" });
        expect(await periodState(db, patientId, 1)).toEqual({ total: 3, marked: 3, marks: 1 });
      });

      it("delete: other rows yes, last row no (P0038); open periods unaffected; patient delete still cascades", async () => {
        const patientId = await seedPatient(db, [[1, 2, 2], [2, 1, 0]]);
        await mark(db, patientId, 1);
        const [a, b] = await rowIds(db, patientId, 1);
        await q(db, `DELETE FROM visit_records WHERE id = $1`, [a]);
        await expect(q(db, `DELETE FROM visit_records WHERE id = $1`, [b])).rejects.toMatchObject({ code: "P0038" });
        const [open] = await rowIds(db, patientId, 2);
        await q(db, `DELETE FROM visit_records WHERE id = $1`, [open]); // last row of a non-expired period: allowed
        await q(db, `DELETE FROM patients WHERE id = $1`, [patientId]);
        const [{ n }] = await q<{ n: string }>(db, `SELECT count(*) AS n FROM visit_records WHERE patient_id = $1`, [patientId]);
        expect(Number(n)).toBe(0);
      });

      it("after Restore the last row can be moved (the documented way out)", async () => {
        const patientId = await seedPatient(db, [[1, 1, 1], [2, 1, 0]]);
        await mark(db, patientId, 1);
        const [only] = await rowIds(db, patientId, 1);
        await expect(q(db, WRITE_SQL, writeArgs(only, patientId, { auth_period: 2 }))).rejects.toMatchObject({ code: "P0038" });
        // Period 2 exists, so restore is refused (P0037) — a superseded period stays as it is.
        await expect(q(db, MARK_SQL, markArgs(patientId, 1, false, "fix"))).rejects.toMatchObject({ code: "P0037" });
        const solo = await seedPatient(db, [[1, 2, 2]]);
        await mark(db, solo, 1);
        await q(db, MARK_SQL, markArgs(solo, 1, false, "Marked by mistake"));
        const [x, y] = await rowIds(db, solo, 1);
        await q(db, WRITE_SQL, writeArgs(x, solo, { auth_period: 2 }));
        await q(db, WRITE_SQL, writeArgs(y, solo, { auth_period: 2 }));
        expect((await periodState(db, solo, 1)).total).toBe(0);
      });

      for (const [label, first, second] of [
        ["two RPC moves", "rpc-move", "rpc-move"],
        ["two raw DELETEs", "delete", "delete"],
        ["raw move then DELETE", "raw-move", "delete"],
        ["DELETE then RPC move", "delete", "rpc-move"],
      ] as const) {
        it(`concurrent removal of the last two rows (${label}): the second waits, then gets P0038`, async () => {
          const patientId = await seedPatient(db, [[1, 2, 2], [2, 1, 0]]);
          await mark(db, patientId, 1);
          const [a, b] = await rowIds(db, patientId, 1);
          const op = (c: Client, kind: string, id: string) =>
            kind === "rpc-move" ? c.query(WRITE_SQL, writeArgs(id, patientId, { auth_period: 2 }))
              : kind === "raw-move" ? c.query(`UPDATE visit_records SET auth_period = 2 WHERE id = $1`, [id])
                : c.query(`DELETE FROM visit_records WHERE id = $1`, [id]);
          const t1 = await connect(db);
          const t2 = await connect(db);
          try {
            await t1.c.query("BEGIN");
            await op(t1.c, first, a);
            await t2.c.query("BEGIN");
            const second2 = settle(op(t2.c, second, b));
            await waitUntilBlocked(db, t2.pid);
            await t1.c.query("COMMIT");
            expect(await second2).toMatchObject({ ok: false, code: "P0038" });
            await t2.c.query("ROLLBACK");
            expect(await periodState(db, patientId, 1)).toEqual({ total: 1, marked: 1, marks: 1 });
          } finally {
            await Promise.all([t1, t2].map((t) => t.c.end()));
          }
        });
      }

      // ─── lock ordering ─────────────────────────────────────────────────────
      it("app RPC move-out vs approve / restore on the same patient: patient-first order, no deadlock", async () => {
        const patientId = await seedPatient(db, [[1, 3, 3], [2, 2, 0]]);
        await mark(db, patientId, 1);
        const [a] = await rowIds(db, patientId, 1);
        const t1 = await connect(db);
        const t2 = await connect(db);
        try {
          await t2.c.query("BEGIN");
          await t2.c.query(WRITE_SQL, writeArgs(a, patientId, { auth_period: 2, session_number: 3 }));
          const approve = settle(t1.c.query(APPROVE_SQL, [patientId, 2, 4, ...ACTOR]));
          await waitUntilBlocked(db, t1.pid);
          await t2.c.query("COMMIT");
          const result = await approve;
          expect(result).toMatchObject({ ok: true });
          expect(result.ok ? result.rows : []).toHaveLength(4);
          expect(await periodState(db, patientId, 1)).toEqual({ total: 2, marked: 2, marks: 1 });
          expect((await periodState(db, patientId, 3)).total).toBe(4);
        } finally {
          await Promise.all([t1, t2].map((t) => t.c.end()));
        }
      });

      it("raw SQL that locks a row before the patient can deadlock with a mark: one side gets 40P01, nothing escapes", async () => {
        const patientId = await seedPatient(db, [[1, 3, 3], [2, 1, 0]]);
        await mark(db, patientId, 1);
        const [a] = await rowIds(db, patientId, 1);
        const t1 = await connect(db);
        const t2 = await connect(db);
        try {
          await t2.c.query("BEGIN");
          await t2.c.query(`SELECT 1 FROM visit_records WHERE id = $1 FOR UPDATE`, [a]); // row lock first
          await t1.c.query("BEGIN");
          const marking = settle(t1.c.query(MARK_SQL, markArgs(patientId, 2, true))); // patient, then waits on row a
          await waitUntilBlocked(db, t1.pid);
          const move = settle(t2.c.query(`UPDATE visit_records SET auth_period = 2 WHERE id = $1`, [a])); // needs the patient
          // The victim keeps its locks until it rolls back, so settle it first.
          const first = await Promise.race([marking.then((o) => ({ who: "mark" as const, o })), move.then((o) => ({ who: "move" as const, o }))]);
          expect(first.o).toMatchObject({ ok: false, code: "40P01" });
          const [victim, survivor, survivorResult] = first.who === "mark" ? [t1, t2, move] : [t2, t1, marking];
          await victim.c.query("ROLLBACK");
          expect(await survivorResult).toMatchObject({ ok: true });
          await survivor.c.query("COMMIT");
          await expectNoHalfExpiredPeriod(db, patientId);
          expect(await periodState(db, patientId, 1)).toEqual({ total: first.who === "mark" ? 2 : 3, marked: first.who === "mark" ? 2 : 3, marks: 1 });
        } finally {
          await Promise.all([t1, t2].map((t) => t.c.end()));
        }
      });

      // ─── 4: internal bypass is narrow ──────────────────────────────────────
      it("the bypass setting doesn't cover inserts, moves or deletes", async () => {
        const patientId = await seedPatient(db, [[1, 1, 1], [2, 1, 0]]);
        await mark(db, patientId, 1);
        const [only] = await rowIds(db, patientId, 1);
        const { c } = await connect(db);
        try {
          await c.query("BEGIN");
          await c.query(`SELECT set_config('app.p4p31_period_expiry_write', 'on', true)`);
          await c.query("SAVEPOINT s");
          expect(await settle(c.query(`INSERT INTO visit_records (patient_id, auth_period, session_number, period_expired_at) VALUES ($1, 2, 2, now())`, [patientId])))
            .toMatchObject({ ok: false, code: "P0035" });
          await c.query("ROLLBACK TO SAVEPOINT s");
          expect(await settle(c.query(`UPDATE visit_records SET auth_period = 2 WHERE id = $1`, [only]))).toMatchObject({ ok: false, code: "P0038" });
          await c.query("ROLLBACK TO SAVEPOINT s");
          expect(await settle(c.query(`DELETE FROM visit_records WHERE id = $1`, [only]))).toMatchObject({ ok: false, code: "P0038" });
          await c.query("ROLLBACK");
        } finally {
          await c.end();
        }
        expect(await periodState(db, patientId, 1)).toEqual({ total: 1, marked: 1, marks: 1 });
      });
    });
  }
});
