/**
 * server/authRequestHold.pg.integration.test.ts
 *
 * Real-Postgres tests for supabase/migrations/20261124000000_authorization_request_holds.sql,
 * synthetic data only:
 *
 *   "upgrade" database — references/local-setup-schema.sql as of 8f82c43
 *     (main before this change) plus every earlier migration, seeded, THEN
 *     the new migration applied twice (re-runnable). Proves it is additive.
 *   "fresh" database — the updated local-setup-schema.sql plus every migration.
 *
 * Proves: reason validation; scope checks against a stale screen; one hold +
 * one audit row per change and none on a retry; a hold never touches
 * visit_records (Pending stays Pending); one active hold per patient;
 * concurrent duplicate holds / resumes; hold racing an approval never leaves
 * a hold that scopes the new period; service_role-only access.
 *
 * Same harness as periodSessionCorrection.pg.integration.test.ts: disposable
 * `postgres:16` Docker container; self-skips when Docker isn't available,
 * unless REQUIRE_PG_INTEGRATION=1 (CI's postgres-integration job).
 *
 *   npx vitest run server/authRequestHold.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `auth-hold-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const HOLD_MIGRATION = "20261124000000_authorization_request_holds.sql";
/** main immediately before this change. Pinned so the fixture stays "before". */
const PRE_REF = "8f82c43";

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
    return execFileSync("git", ["show", `${PRE_REF}:references/local-setup-schema.sql`], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    return null;
  }
}
const HAS_DOCKER = dockerAvailable();
const PRE_SCHEMA = preChangeSchema();
if (process.env.REQUIRE_PG_INTEGRATION === "1" && (!HAS_DOCKER || !PRE_SCHEMA)) {
  throw new Error(`REQUIRE_PG_INTEGRATION=1 but docker=${HAS_DOCKER}, pre-change schema at ${PRE_REF}=${PRE_SCHEMA !== null}`);
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

const ACTOR = ["00000000-0000-4000-8000-0000000000d4", "clinic_user", "Synthetic Staff"] as const;
const HOLD_SIG = "public.hold_authorization_request_with_audit(uuid, integer, integer, text, uuid, text, text)";
const RELEASE_SIG = "public.release_authorization_request_hold_with_audit(uuid, uuid, uuid, text, text)";

/** As server/db.ts holdAuthorizationRequest calls it. */
async function hold(db: string, patientId: string, period: number | null, latest: number | null, reason: string | null = "Waiting on referral") {
  const [{ r }] = await q<{ r: { hold_id: string; changed: boolean } }>(db,
    `SELECT hold_authorization_request_with_audit($1, $2, $3, $4, $5, $6, $7) AS r`, [patientId, period, latest, reason, ...ACTOR]);
  return r;
}
/** As server/db.ts releaseAuthorizationRequestHold calls it. */
async function release(db: string, patientId: string, holdId: string) {
  const [{ n }] = await q<{ n: number }>(db,
    `SELECT release_authorization_request_hold_with_audit($1, $2, $3, $4, $5) AS n`, [patientId, holdId, ...ACTOR]);
  return n;
}
async function approveRenewal(db: string, patientId: string, targetPeriod: number, n: number) {
  return q(db, `SELECT approve_authorization_with_audit($1, $2, $3, NULL, NULL, false, NULL, $4, $5, $6)`, [patientId, targetPeriod, n, ...ACTOR]);
}

/** Period 1: 4 sessions, 3 used, last row Pending (a request was made). */
async function seed(db: string, withVisits = true) {
  const [{ id }] = await q<{ id: string }>(db, `INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [`pg_hold_${randomUUID()}`]);
  if (withVisits) {
    for (let i = 1; i <= 4; i++) {
      await q(db, `INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period, date_of_service, auth_status)
                   VALUES ($1, 4, $2, $3, 1, $4, $5)`, [id, 4 - i, i, i <= 3 ? `2026-11-0${i}` : null, i === 4 ? "pending" : "approved"]);
    }
  }
  return id;
}
async function visitsSnapshot(db: string, patientId: string) {
  return q(db, `SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
                       auth_status, date_ash_submitted::text AS ash, period_expired_at::text AS mark, updated_at::text AS upd
                FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number`, [patientId]);
}
async function audits(db: string, patientId: string) {
  return q<{ action: string; actor_id: string; actor_type: string; actor_display: string; entity_type: string; after_data: Record<string, unknown> }>(db,
    `SELECT action, actor_id::text, actor_type, actor_display, entity_type, after_data FROM audit_logs
     WHERE patient_id = $1 AND action IN ('AUTHORIZATION_REQUEST_HELD', 'AUTHORIZATION_REQUEST_HOLD_RELEASED') ORDER BY created_at`, [patientId]);
}
async function activeHolds(db: string, patientId: string) {
  return q<{ id: string; auth_period: number | null }>(db,
    `SELECT id, auth_period FROM authorization_request_holds WHERE patient_id = $1 AND released_at IS NULL`, [patientId]);
}

let workDir = "";
let upgradePatient = "";

describe.skipIf(!HAS_DOCKER || !PRE_SCHEMA)("Authorization requests on hold (real Postgres)", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), "auth-hold-"));
    sh("docker", ["run", "-d", "--name", CONTAINER_NAME, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    const match = sh("docker", ["port", CONTAINER_NAME, "5432"]).trim().match(/:(\d+)$/);
    if (!match) throw new Error("Could not parse published port");
    port = Number(match[1]);
    await waitForReady();

    psqlInline("postgres", "CREATE DATABASE upgrade_db");
    psqlInline("postgres", "CREATE DATABASE fresh_db");
    const migrations = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    const prePath = path.join(workDir, "pre-hold-local-setup-schema.sql");
    writeFileSync(prePath, PRE_SCHEMA ?? "");
    psqlInline("upgrade_db", SUPABASE_ROLES);
    psqlFile("upgrade_db", prePath);
    for (const f of migrations.filter((f) => f < HOLD_MIGRATION)) psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, f));
    upgradePatient = await seed("upgrade_db");
    psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, HOLD_MIGRATION));
    psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, HOLD_MIGRATION));
    for (const f of migrations.filter((f) => f > HOLD_MIGRATION)) psqlFile("upgrade_db", path.join(MIGRATIONS_DIR, f));

    psqlInline("fresh_db", SUPABASE_ROLES);
    psqlFile("fresh_db", path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const f of migrations) psqlFile("fresh_db", path.join(MIGRATIONS_DIR, f));
  }, 240_000);

  afterAll(() => {
    try { sh("docker", ["rm", "-f", CONTAINER_NAME]); } catch { /* already gone */ }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  it("upgrade: additive — existing rows untouched, no holds, no audit rows", async () => {
    const rows = await visitsSnapshot("upgrade_db", upgradePatient);
    expect(rows).toHaveLength(4);
    expect(rows[3].auth_status).toBe("pending");
    expect(await activeHolds("upgrade_db", upgradePatient)).toHaveLength(0);
    expect(await audits("upgrade_db", upgradePatient)).toHaveLength(0);
  });

  for (const db of ["upgrade_db", "fresh_db"]) {
    describe(db, () => {
      it("hold: blank/oversized reason and missing actor refused; nothing written", async () => {
        const p = await seed(db);
        for (const reason of [null, "", "   ", "x".repeat(501)]) {
          await expect(hold(db, p, 1, 1, reason)).rejects.toMatchObject({ code: "22023" });
        }
        await expect(q(db, `SELECT hold_authorization_request_with_audit($1, 1, 1, 'r', NULL, 'clinic_user', 'X')`, [p])).rejects.toMatchObject({ code: "22023" });
        expect(await activeHolds(db, p)).toHaveLength(0);
        expect(await audits(db, p)).toHaveLength(0);
      });

      it("hold: trimmed reason, one hold, one audit row with the actor; visit rows (Pending) untouched; retry is a no-op", async () => {
        const p = await seed(db);
        const before = await visitsSnapshot(db, p);
        const r1 = await hold(db, p, 1, 1, "  Waiting on referral  ");
        expect(r1.changed).toBe(true);
        const r2 = await hold(db, p, 1, 1, "different text on retry");
        expect(r2).toEqual({ hold_id: r1.hold_id, changed: false });

        expect(await visitsSnapshot(db, p)).toEqual(before);
        const [row] = await q<Record<string, unknown>>(db, `SELECT * FROM authorization_request_holds WHERE id = $1`, [r1.hold_id]);
        expect(row).toMatchObject({ patient_id: p, auth_period: 1, reason: "Waiting on referral", held_by: ACTOR[0], held_by_type: "clinic_user", held_by_display: "Synthetic Staff", released_at: null });
        const a = await audits(db, p);
        expect(a).toHaveLength(1);
        expect(a[0]).toMatchObject({ action: "AUTHORIZATION_REQUEST_HELD", actor_id: ACTOR[0], actor_type: "clinic_user", actor_display: "Synthetic Staff", entity_type: "visit_record" });
        expect(a[0].after_data).toMatchObject({ hold_id: r1.hold_id, auth_period: 1, reason: "Waiting on referral" });
      });

      it("hold: a stale screen (wrong period / newest period / missing patient) is refused", async () => {
        const p = await seed(db);
        await expect(hold(db, p, 2, 2)).rejects.toMatchObject({ code: "P0050" }); // period doesn't exist
        await expect(hold(db, p, 1, null)).rejects.toMatchObject({ code: "P0050" }); // caller thought no period
        await expect(hold(db, p, null, null)).rejects.toMatchObject({ code: "P0050" });
        await expect(hold(db, randomUUID(), 1, 1)).rejects.toMatchObject({ code: "P0020" });
        const noAuth = await seed(db, false);
        expect((await hold(db, noAuth, null, null)).changed).toBe(true); // no-authorization patient
        expect(await audits(db, p)).toHaveLength(0);
      });

      it("approval after a hold: the new period exists, the old hold stays scoped to period 1 (app treats it as superseded); a new hold needs it removed first", async () => {
        const p = await seed(db);
        const { hold_id } = await hold(db, p, 1, 1);
        await approveRenewal(db, p, 1, 6);
        const [{ latest }] = await q<{ latest: number }>(db, `SELECT max(auth_period) AS latest FROM visit_records WHERE patient_id = $1`, [p]);
        expect(latest).toBe(2);
        expect(await activeHolds(db, p)).toEqual([{ id: hold_id, auth_period: 1 }]);
        // The old screen can't hold again; the new period can't be held while the old hold exists.
        await expect(hold(db, p, 1, 1)).rejects.toMatchObject({ code: "P0050" });
        await expect(hold(db, p, 2, 2)).rejects.toMatchObject({ code: "P0051" });
        expect(await release(db, p, hold_id)).toBe(1);
        expect((await hold(db, p, 2, 2)).changed).toBe(true);
      });

      it("release: audited once; retry is a no-op; wrong patient/hold refused; a new hold is allowed afterwards", async () => {
        const p = await seed(db);
        const other = await seed(db);
        const { hold_id } = await hold(db, p, 1, 1);
        await expect(release(db, other, hold_id)).rejects.toMatchObject({ code: "P0052" });
        await expect(release(db, randomUUID(), hold_id)).rejects.toMatchObject({ code: "P0020" });
        expect(await release(db, p, hold_id)).toBe(1);
        expect(await release(db, p, hold_id)).toBe(0);
        const a = await audits(db, p);
        expect(a.map(r => r.action)).toEqual(["AUTHORIZATION_REQUEST_HELD", "AUTHORIZATION_REQUEST_HOLD_RELEASED"]);
        const [row] = await q<Record<string, unknown>>(db, `SELECT released_by::text, released_by_type, released_by_display FROM authorization_request_holds WHERE id = $1`, [hold_id]);
        expect(row).toEqual({ released_by: ACTOR[0], released_by_type: "clinic_user", released_by_display: "Synthetic Staff" });
        expect((await hold(db, p, 1, 1)).changed).toBe(true);
      });

      it("audit rollback: if the audit insert fails, the hold / release is not written either", async () => {
        const p = await seed(db);
        const fn = `pg_hold_fail_audit_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
        // Test-only trigger, scoped to this synthetic patient, so no other test is affected.
        await q(db, `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $f$
                     BEGIN
                       IF NEW.patient_id = '${p}'::uuid THEN RAISE EXCEPTION 'synthetic_audit_failure' USING ERRCODE = 'P0099'; END IF;
                       RETURN NEW;
                     END $f$`);
        const addTrigger = () => q(db, `CREATE TRIGGER ${fn} BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
        const dropTrigger = () => q(db, `DROP TRIGGER IF EXISTS ${fn} ON public.audit_logs`);
        try {
          await addTrigger();
          await expect(hold(db, p, 1, 1)).rejects.toMatchObject({ code: "P0099" });
          expect(await activeHolds(db, p)).toHaveLength(0);
          const [{ n }] = await q<{ n: number }>(db, `SELECT count(*)::int AS n FROM authorization_request_holds WHERE patient_id = $1`, [p]);
          expect(n).toBe(0);
          await dropTrigger();

          const { hold_id } = await hold(db, p, 1, 1);
          await addTrigger();
          await expect(release(db, p, hold_id)).rejects.toMatchObject({ code: "P0099" });
          expect(await activeHolds(db, p)).toEqual([{ id: hold_id, auth_period: 1 }]);
          await dropTrigger();
          expect((await audits(db, p)).map(r => r.action)).toEqual(["AUTHORIZATION_REQUEST_HELD"]);
        } finally {
          await dropTrigger();
          await q(db, `DROP FUNCTION IF EXISTS public.${fn}()`);
        }
      });

      it("concurrency: parallel duplicate holds → one hold, one audit row; parallel resumes → one release", async () => {
        const p = await seed(db);
        const results = await Promise.all(Array.from({ length: 5 }, () => hold(db, p, 1, 1)));
        expect(results.filter(r => r.changed)).toHaveLength(1);
        expect(new Set(results.map(r => r.hold_id)).size).toBe(1);
        expect(await activeHolds(db, p)).toHaveLength(1);
        const released = await Promise.all(Array.from({ length: 5 }, () => release(db, p, results[0].hold_id)));
        expect(released.filter(n => n === 1)).toHaveLength(1);
        expect((await audits(db, p)).map(r => r.action)).toEqual(["AUTHORIZATION_REQUEST_HELD", "AUTHORIZATION_REQUEST_HOLD_RELEASED"]);
      });

      it("concurrency: hold racing an approval never scopes the new period", async () => {
        for (let i = 0; i < 5; i++) {
          const p = await seed(db);
          const [h, a] = await Promise.allSettled([hold(db, p, 1, 1), approveRenewal(db, p, 1, 6)]);
          expect(a.status).toBe("fulfilled");
          const holds = await activeHolds(db, p);
          if (h.status === "rejected") {
            expect((h.reason as { code?: string }).code).toBe("P0050");
            expect(holds).toHaveLength(0);
          } else {
            expect(holds).toEqual([{ id: h.value.hold_id, auth_period: 1 }]); // superseded by period 2
          }
        }
      });

      it("one active hold per patient is enforced by the database itself", async () => {
        const p = await seed(db);
        await hold(db, p, 1, 1);
        await expect(q(db, `INSERT INTO authorization_request_holds (patient_id, auth_period, reason, held_by, held_by_type, held_by_display)
                            VALUES ($1, 1, 'dup', $2, 'clinic_user', 'X')`, [p, ACTOR[0]])).rejects.toMatchObject({ code: "23505" });
      });

      it("deleting the patient removes their holds (cascade)", async () => {
        const p = await seed(db);
        await hold(db, p, 1, 1);
        await q(db, `DELETE FROM patients WHERE id = $1`, [p]);
        expect(await activeHolds(db, p)).toHaveLength(0);
      });

      it("service_role only: anon/authenticated can't execute the functions or read the table", async () => {
        for (const role of ["anon", "authenticated"]) {
          const [r] = await q<{ h: boolean; r: boolean; t: boolean }>(db,
            `SELECT has_function_privilege($1, '${HOLD_SIG}', 'EXECUTE') AS h,
                    has_function_privilege($1, '${RELEASE_SIG}', 'EXECUTE') AS r,
                    has_table_privilege($1, 'public.authorization_request_holds', 'SELECT') AS t`, [role]);
          expect(r).toEqual({ h: false, r: false, t: false });
        }
        const [s] = await q<{ h: boolean; t: boolean }>(db,
          `SELECT has_function_privilege('service_role', '${HOLD_SIG}', 'EXECUTE') AS h,
                  has_table_privilege('service_role', 'public.authorization_request_holds', 'SELECT') AS t`);
        expect(s).toEqual({ h: true, t: true });
      });
    });
  }
});
