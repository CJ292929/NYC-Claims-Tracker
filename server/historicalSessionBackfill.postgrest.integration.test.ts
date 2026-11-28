/**
 * server/historicalSessionBackfill.postgrest.integration.test.ts
 *
 * Historical authorization-period corrections, end to end through the REAL app:
 *
 *   appRouter.createCaller → server/routers.ts → server/db.ts →
 *   @supabase/supabase-js → local PostgREST → Postgres 16 with every migration.
 *
 * Scenario staff reported: Period 1 is Expired (or used up) and Period 2 is
 * current. A visit that really happened in Period 1 was never recorded, so it
 * has no session row and no CMS-1500 line. Restore Period is (correctly)
 * refused while a newer period exists, and Correct Count is refused on an
 * Expired period, so there was no way to record it in Period 1.
 *
 * Synthetic data only. Same harness as authRequestHoldFlow.postgrest.integration.test.ts;
 * self-skips without Docker / the PostgREST image.
 *
 *   npx vitest run server/historicalSessionBackfill.postgrest.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "./_core/sdk";
import type { TrpcContext } from "./_core/context";
import { determineActivePeriod, getPeriodMetrics } from "../shared/authPeriodMetrics";
import { resolveAuthPeriod } from "../shared/claimImport";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.5";
const RUN = randomUUID().slice(0, 8);
const NET = `backfill-net-${RUN}`;
const PG = `backfill-pg-${RUN}`;
const REST = `backfill-rest-${RUN}`;
const JWT_SECRET = randomBytes(32).toString("hex");
const DB = "fresh";

function sh(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
}
function dockerReady(): boolean {
  try {
    sh("docker", ["info"]);
    sh("docker", ["image", "inspect", POSTGREST_IMAGE]);
    return true;
  } catch {
    return false;
  }
}
const HAS_DOCKER = dockerReady();

let pgPort = 0;
function psqlFile(file: string) {
  sh("docker", ["cp", file, `${PG}:/tmp/apply.sql`]);
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "postgres", "-d", DB, "-v", "ON_ERROR_STOP=1", "-q", "-f", "/tmp/apply.sql"]);
}
function psql(sql: string, db = DB) {
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql]);
}
async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ host: "127.0.0.1", port: pgPort, user: "postgres", password: "postgres", database: DB });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}
async function waitFor(fn: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 60; i++) {
    try {
      if (await fn()) return;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`${label} did not become ready`);
}

const SUPABASE_DEFAULTS = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'authpw'; END IF;
  END $$;
  GRANT anon, authenticated, service_role TO authenticator;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
`;

let restPort = 0;
let proxy: http.Server;
let proxyPort = 0;
function startProxy(): Promise<void> {
  proxy = http.createServer((req, res) => {
    const upstream = http.request({
      host: "127.0.0.1", port: restPort, method: req.method,
      path: (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/",
      headers: { ...req.headers, host: `127.0.0.1:${restPort}` },
    }, up => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", e => { res.writeHead(502); res.end(String(e)); });
    req.pipe(upstream);
  });
  return new Promise(resolve => proxy.listen(0, "127.0.0.1", () => {
    proxyPort = (proxy.address() as { port: number }).port;
    resolve();
  }));
}

type Router = typeof import("./routers").appRouter;
let appRouter: Router;

const STAFF = {
  id: "00000000-0000-4000-8000-0000000000c1", openId: "clinic_staff", name: "Synthetic staff", email: null, loginMethod: "password",
  role: "user", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
  clinicUser: { clinicUserId: "00000000-0000-4000-8000-0000000000c2", username: "staff.synthetic", name: "Synthetic Staff", email: null, department: null, role: "staff", mustChangePassword: false },
} as unknown as AuthenticatedUser;

const CLINIC_ADMIN = {
  ...STAFF, openId: "clinic_admin",
  clinicUser: { ...(STAFF as any).clinicUser, clinicUserId: "00000000-0000-4000-8000-0000000000c3", username: "admin.synthetic", name: "Synthetic Admin", role: "admin" },
} as unknown as AuthenticatedUser;

function caller(user: AuthenticatedUser | null = STAFF) {
  const ctx: TrpcContext = { user, req: { protocol: "https", headers: {} } as any, res: {} as any };
  return appRouter.createCaller(ctx);
}

function api(user: AuthenticatedUser | null = STAFF) {
  return caller(user).visits;
}

/**
 * Period 1: 6 authorized, sessions 1–3 dated Jan 5 / Jan 12 / Jan 26 (Jan 19
 * was the missed visit), marked Expired. Period 2: 4 authorized, 1 dated,
 * created by the real approval path.
 */
async function seedExpiredThenCurrent(name = "Synthetic Backfill") {
  const [{ id }] = await q<{ id: string }>(`INSERT INTO patients (name, insurance) VALUES ($1, 'Synthetic Ins') RETURNING id`, [name]);
  const p1 = ["2026-01-05", "2026-01-12", "2026-01-26", null, null, null];
  for (const [i, dos] of p1.entries()) {
    await q(`INSERT INTO visit_records (patient_id, sessions_authorized, sessions_remaining, session_number, auth_period, date_of_service, auth_status)
             VALUES ($1, 6, $2, $3, 1, $4, 'approved')`, [id, 6 - i, i + 1, dos]);
  }
  await api().setPeriodExpired({ patientId: id, authPeriod: 1, expired: true });
  await api().approveAuthorization({ patientId: id, sessionsAuthorized: 4 });
  const [first2] = await q<{ id: string }>(`SELECT id FROM visit_records WHERE patient_id = $1 AND auth_period = 2 ORDER BY session_number LIMIT 1`, [id]);
  await api().update({ id: first2.id, dateOfService: "2026-03-02" });
  return id;
}
const rows = async (patientId: string, period?: number) =>
  q(`SELECT id, auth_period, session_number, sessions_authorized, sessions_remaining, date_of_service::text AS dos,
            auth_status, (period_expired_at IS NOT NULL) AS expired, period_expired_at::text AS expired_at, updated_at::text
     FROM visit_records WHERE patient_id = $1 ${period ? "AND auth_period = " + Number(period) : ""}
     ORDER BY auth_period, session_number`, [patientId]);
const audits = async (patientId: string, action: string) =>
  q(`SELECT entity_id, before_data, after_data, actor_display FROM audit_logs WHERE patient_id = $1 AND action = $2`, [patientId, action]);

if (!HAS_DOCKER && process.env.REQUIRE_PG_INTEGRATION === "1") {
  throw new Error("REQUIRE_PG_INTEGRATION=1 but Docker or the PostgREST image is unavailable");
}
const describeDb = HAS_DOCKER ? describe : describe.skip;

describeDb("Historical session backfill through the real app + PostgREST + Postgres", () => {
  let workDir = "";

  beforeAll(async () => {
    sh("docker", ["network", "create", NET]);
    sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    pgPort = Number(sh("docker", ["port", PG, "5432"]).trim().split("\n")[0].split(":").pop());
    await waitFor(() => { sh("docker", ["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }, "postgres");
    psql("CREATE DATABASE fresh", "postgres");
    workDir = mkdtempSync(path.join(os.tmpdir(), "backfill-"));
    const roles = path.join(workDir, "roles.sql");
    writeFileSync(roles, SUPABASE_DEFAULTS);
    psqlFile(roles);
    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const m of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) psqlFile(path.join(MIGRATIONS_DIR, m));

    sh("docker", [
      "run", "-d", "--rm", "--name", REST, "--network", NET,
      "-e", `PGRST_DB_URI=postgres://authenticator:authpw@${PG}:5432/${DB}`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
      "-e", "PGRST_DB_MAX_ROWS=1000",
      "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`,
      "-p", "127.0.0.1::3000", POSTGREST_IMAGE,
    ]);
    restPort = Number(sh("docker", ["port", REST, "3000"]).trim().split("\n")[0].split(":").pop());
    await waitFor(async () => (await fetch(`http://127.0.0.1:${restPort}/`)).status < 500, "postgrest");
    await startProxy();

    const jwt = await new SignJWT({ role: "service_role" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().sign(new TextEncoder().encode(JWT_SECRET));
    process.env.SUPABASE_URL = `http://127.0.0.1:${proxyPort}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = jwt;
    ({ appRouter } = await import("./routers"));
  }, 240_000);

  afterAll(() => {
    proxy?.close();
    for (const c of [REST, PG]) {
      try { sh("docker", ["rm", "-f", c]); } catch { /* already gone */ }
    }
    try { sh("docker", ["network", "rm", NET]); } catch { /* ignore */ }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await q("TRUNCATE authorization_request_holds, audit_logs, claims_records, visit_records, patients CASCADE");
  });

  describe("reproduction (pre-existing paths)", () => {
    it("Restore Period is refused while Period 2 exists (kept), and Correct Count is refused on the expired period", async () => {
      const p = await seedExpiredThenCurrent();
      await expect(api().setPeriodExpired({ patientId: p, authPeriod: 1, expired: false, reason: "add a missed visit" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
      await expect(api().correctPeriodSessions({ patientId: p, authPeriod: 1, sessionsAuthorized: 7, expectedCurrent: 6 }))
        .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/Restore the period first/) });
      expect((await rows(p, 1)).every(r => r.expired)).toBe(true);
    });

    it("the generic visits.update has no duplicate-date protection (why the backfill gets its own audited path)", async () => {
      const p = await seedExpiredThenCurrent();
      const slot = (await rows(p, 1)).find(r => r.dos === null)!;
      await api().update({ id: slot.id, dateOfService: "2026-01-12" }); // same date as session 2
      expect((await rows(p, 1)).filter(r => r.dos === "2026-01-12")).toHaveLength(2);
    });
  });

  describe("Add Missing Session", () => {
    const metricsOf = async (p: string) => {
      const v = await api().listByPatient({ patientId: p });
      return { p1: getPeriodMetrics(v, 1), p2: getPeriodMetrics(v, 2), active: determineActivePeriod(v), visits: v };
    };

    it("inserts a missed visit between existing dates of expired Period 1; Period 2 and every other row are unchanged", async () => {
      const p = await seedExpiredThenCurrent();
      await q(`INSERT INTO claims_records (patient_id, auth_period, date_of_service, cpt_codes) VALUES ($1, 1, '2026-01-05', '97110')`, [p]);
      const p1Before = await rows(p, 1);
      const p2Before = await rows(p, 2);
      const claimsBefore = await q(`SELECT * FROM claims_records WHERE patient_id = $1`, [p]);
      const before = await metricsOf(p);
      expect(before).toMatchObject({ active: 2, p1: { completed: 3, remaining: 0, expired: true, unusedExpired: 3 } });

      const out = await api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-01-19" });
      const slot = p1Before.find(r => r.session_number === 4)!;
      expect(out).toEqual({ visitId: slot.id, authPeriod: 1, sessionNumber: 4, sessionsAuthorized: 6, completed: 4 });

      // Reload: persisted without restoring Period 1.
      const p1After = await rows(p, 1);
      expect(p1After.map(r => r.id)).toEqual(p1Before.map(r => r.id)); // stable ids, no row added/renumbered
      expect(p1After.every(r => r.expired && r.expired_at === p1Before[0].expired_at)).toBe(true);
      expect(p1After.find(r => r.id === slot.id)).toMatchObject({ dos: "2026-01-19", sessions_remaining: 2, session_number: 4 });
      expect(p1After.filter(r => r.id !== slot.id)).toEqual(p1Before.filter(r => r.id !== slot.id));
      expect(await rows(p, 2)).toEqual(p2Before);
      expect(await q(`SELECT * FROM claims_records WHERE patient_id = $1`, [p])).toEqual(claimsBefore);

      const after = await metricsOf(p);
      expect(after.p1).toEqual({ authorized: 6, completed: 4, remaining: 0, expired: true, unusedExpired: 2 });
      expect(after.p2).toEqual(before.p2);
      expect(after.active).toBe(2); // unused expired sessions never become available

      const log = await audits(p, "SESSION_BACKFILLED");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ entity_id: slot.id, actor_display: "Synthetic Staff", after_data: { auth_period: 1, session_number: 4, date_of_service: "2026-01-19", period_expired: true } });
    });

    it("corrects an existing permitted historical field in expired Period 1 without a restore", async () => {
      const p = await seedExpiredThenCurrent();
      const s2 = (await rows(p, 1)).find(r => r.session_number === 2)!;
      const p2Before = await rows(p, 2);
      await api().update({ id: s2.id, dateOfService: "2026-01-13" });
      await api().updateSessionFields({ id: s2.id, patientId: p, remarks: "Corrected from sign-in sheet" });
      const reloaded = await api().listByPatient({ patientId: p });
      expect(reloaded.find(v => v.id === s2.id)!.remarks).toBe("Corrected from sign-in sheet");
      expect((await rows(p, 1)).find(r => r.id === s2.id)).toMatchObject({ dos: "2026-01-13", expired: true });
      expect(await rows(p, 2)).toEqual(p2Before);
    });

    it("the backfilled date makes CMS-1500 import resolve that line to Period 1 by visit date", async () => {
      const p = await seedExpiredThenCurrent();
      const toImportVisits = (v: Array<{ authPeriod: number | null; dateOfService: unknown }>) =>
        v.map(x => ({ authPeriod: x.authPeriod ?? 1, dateOfService: x.dateOfService ? new Date(x.dateOfService as string).toISOString().slice(0, 10) : null }));
      // Feb 2 is after Period 1's last recorded date: the importer can't tell which period it belongs to.
      expect(resolveAuthPeriod(toImportVisits(await api().listByPatient({ patientId: p })), "2026-02-02").status).toBe("uncertain");
      await api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-02-02" });
      expect(resolveAuthPeriod(toImportVisits(await api().listByPatient({ patientId: p })), "2026-02-02"))
        .toEqual({ status: "resolved", authPeriod: 1, basis: "visit_date" });
      expect(await q(`SELECT 1 FROM claims_records WHERE patient_id = $1`, [p])).toHaveLength(0); // no claim is created or marked
    });

    it("a date already recorded (a visit missing only its claim) is refused, naming the existing session", async () => {
      const p = await seedExpiredThenCurrent();
      const snap = await rows(p);
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-01-12" }))
        .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/already recorded as Period 1, Session 2.*add the claim/) });
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-03-02" }))
        .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/Period 2, Session 1/) });
      expect(await rows(p)).toEqual(snap);
      expect(await audits(p, "SESSION_BACKFILLED")).toHaveLength(0);
    });

    it("parallel submissions of the same visit record it once", async () => {
      const p = await seedExpiredThenCurrent();
      const input = { patientId: p, authPeriod: 1, dateOfService: "2026-01-19" };
      const results = await Promise.allSettled([api().addMissingSession(input), api().addMissingSession(input), api().addMissingSession(input)]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect((await rows(p, 1)).filter(r => r.dos === "2026-01-19")).toHaveLength(1);
      expect(await audits(p, "SESSION_BACKFILLED")).toHaveLength(1);
    });

    it("refuses invalid, future, after-expiry and unknown-period dates, and unauthorized callers; nothing changes", async () => {
      const p = await seedExpiredThenCurrent();
      const snap = await rows(p);
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-02-30" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "01/19/2026" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2099-01-01" }))
        .rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/future/) });
      await expect(api().addMissingSession({ patientId: p, authPeriod: 9, dateOfService: "2026-01-19" })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(api(null).addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-01-19" })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const mustChange = { ...STAFF, clinicUser: { ...(STAFF as any).clinicUser, mustChangePassword: true } } as unknown as AuthenticatedUser;
      await expect(api(mustChange).addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-01-19" })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await rows(p)).toEqual(snap);

      // Period 1 actually expired on Feb 15 (New York): a later date is not a Period 1 visit.
      await q(`BEGIN; SELECT set_config('app.p4p31_period_expiry_write', 'on', true);
               UPDATE visit_records SET period_expired_at = '2026-02-15T17:00:00Z' WHERE patient_id = '${p}' AND auth_period = 1; COMMIT;`);
      const expiredSnap = await rows(p);
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-02-16" }))
        .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/after Authorization Period 1 expired/) });
      expect(await rows(p)).toEqual(expiredSnap);
      expect(await audits(p, "SESSION_BACKFILLED")).toHaveLength(0);
    });

    it("the period's authorized count is the limit: no session is created beyond it", async () => {
      const p = await seedExpiredThenCurrent();
      for (const d of ["2026-01-19", "2026-02-02", "2026-02-09"]) await api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: d });
      const full = await rows(p, 1);
      expect(full).toHaveLength(6);
      expect(full.every(r => r.dos !== null)).toBe(true);
      await expect(api().addMissingSession({ patientId: p, authPeriod: 1, dateOfService: "2026-02-10" }))
        .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/All 6 authorized sessions of Period 1/) });
      expect(await rows(p, 1)).toEqual(full);
      expect(getPeriodMetrics(await api().listByPatient({ patientId: p }), 1)).toMatchObject({ completed: 6, remaining: 0, unusedExpired: 0 });
    });
  });
});
