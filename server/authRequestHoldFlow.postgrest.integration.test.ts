/**
 * server/authRequestHoldFlow.postgrest.integration.test.ts
 *
 * Hold Request for Authorization, end to end through the REAL app:
 *
 *   appRouter.createCaller → server/routers.ts → server/db.ts →
 *   @supabase/supabase-js → local PostgREST (max-rows = 1000, Supabase's
 *   default) → hold_authorization_request_with_audit in a disposable postgres:16.
 *
 * Regression for "This patient's authorization changed since you loaded it"
 * on a valid first Confirm: the Authorization Alerts list read every
 * visit_records row in ONE request, which PostgREST silently capped at 1000
 * rows. Ordered by auth_period, the newest periods were the rows dropped, so
 * the list showed an older period than the per-patient re-read the hold
 * mutation does → a false stale-screen conflict.
 *
 * Synthetic data only. Same harness as claimImportPatients.postgrest.integration.test.ts;
 * self-skips without Docker / the PostgREST image.
 *
 *   npx vitest run server/authRequestHoldFlow.postgrest.integration.test.ts
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
import { classifyAuthorizationAlert } from "../shared/authRequestHold";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.5";
const RUN = randomUUID().slice(0, 8);
const NET = `hold-flow-net-${RUN}`;
const PG = `hold-flow-pg-${RUN}`;
const REST = `hold-flow-rest-${RUN}`;
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

function api() {
  const ctx: TrpcContext = { user: STAFF, req: { protocol: "https", headers: {} } as any, res: {} as any };
  return appRouter.createCaller(ctx).visits;
}

/** periods[i] = authorized/used for period i+1; the last row of a period is Pending when `pending`. */
async function seedPatient(name: string, periods: Array<{ auth: number; used: number; pending?: boolean }>, authValidUntil: number | null = null) {
  const [{ id }] = await q<{ id: string }>(`INSERT INTO patients (name, insurance, auth_valid_until) VALUES ($1, 'Synthetic Ins', $2) RETURNING id`, [name, authValidUntil]);
  for (const [i, p] of periods.entries()) {
    for (let s = 1; s <= p.auth; s++) {
      await q(`INSERT INTO visit_records (patient_id, sessions_authorized, session_number, auth_period, date_of_service, auth_status)
               VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, p.auth, s, i + 1, s <= p.used ? `2026-0${i + 1}-${String(s).padStart(2, "0")}` : null, p.pending && s === p.auth ? "pending" : "approved"]);
    }
  }
  return id;
}
/** 60 synthetic patients × 20 period-1 rows = 1200 rows: pushes every later period past PostgREST's 1000-row cap. */
async function seedFiller() {
  await q(`INSERT INTO patients (name, insurance) SELECT 'Filler ' || lpad(g::text, 3, '0'), 'Synthetic Ins' FROM generate_series(1, 60) g`);
  await q(`INSERT INTO visit_records (patient_id, sessions_authorized, session_number, auth_period, auth_status)
           SELECT p.id, 20, s, 1, 'approved' FROM patients p CROSS JOIN generate_series(1, 20) s WHERE p.name LIKE 'Filler %'`);
}
async function alertFor(patientId: string) {
  const row = (await api().authAlerts()).find(a => a.patientId === patientId);
  if (!row) throw new Error("alert row missing");
  return row;
}
const heldAudits = async (patientId: string) =>
  q(`SELECT after_data FROM audit_logs WHERE patient_id = $1 AND action = 'AUTHORIZATION_REQUEST_HELD'`, [patientId]);
const activeHolds = async (patientId: string) =>
  q(`SELECT id, auth_period, reason FROM authorization_request_holds WHERE patient_id = $1 AND released_at IS NULL`, [patientId]);
const visitsSnapshot = async (patientId: string) =>
  q(`SELECT id, auth_period, session_number, sessions_authorized, date_of_service::text, auth_status, period_expired_at::text, updated_at::text
     FROM visit_records WHERE patient_id = $1 ORDER BY auth_period, session_number`, [patientId]);
const patientSnapshot = async (patientId: string) =>
  (await q(`SELECT auth_date::text, auth_valid_until::text, insurance, is_active FROM patients WHERE id = $1`, [patientId]))[0];

const describeDb = HAS_DOCKER ? describe : describe.skip;

describeDb("Hold Request for Authorization through the real app + PostgREST (max-rows 1000) + Postgres", () => {
  let workDir = "";

  beforeAll(async () => {
    sh("docker", ["network", "create", NET]);
    sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    pgPort = Number(sh("docker", ["port", PG, "5432"]).trim().split("\n")[0].split(":").pop());
    await waitFor(() => { sh("docker", ["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }, "postgres");
    psql("CREATE DATABASE fresh", "postgres");
    workDir = mkdtempSync(path.join(os.tmpdir(), "hold-flow-"));
    const roles = path.join(workDir, "roles.sql");
    writeFileSync(roles, SUPABASE_DEFAULTS);
    psqlFile(roles);
    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const m of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) psqlFile(path.join(MIGRATIONS_DIR, m));

    sh("docker", [
      "run", "-d", "--rm", "--name", REST, "--network", NET,
      "-e", `PGRST_DB_URI=postgres://authenticator:authpw@${PG}:5432/${DB}`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
      "-e", "PGRST_DB_MAX_ROWS=1000", // Supabase's default API row cap
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

  it("reproduction: >1000 visit rows — the alert shows the patient's real period, and ONE confirm holds it", async () => {
    await seedFiller();
    // Period 1 used up; period 2 approved with 1 session left → critical, target period 2.
    const p = await seedPatient("Synthetic Renewed", [{ auth: 4, used: 4 }, { auth: 4, used: 3, pending: true }]);
    expect((await q(`SELECT count(*)::int AS n FROM visit_records`))[0].n).toBeGreaterThan(1000);

    const alert = await alertFor(p);
    expect(alert).toMatchObject({ authPeriod: 2, latestAuthPeriod: 2, sessionsRemaining: 1, urgency: "critical" });
    expect(classifyAuthorizationAlert(alert)).toBe("attention");

    const out = await api().holdAuthorizationRequest({ patientId: p, authPeriod: alert.authPeriod, reason: "Waiting on updated referral" });
    expect(out).toMatchObject({ success: true, changed: true });
    expect(await activeHolds(p)).toEqual([{ id: out.holdId, auth_period: 2, reason: "Waiting on updated referral" }]);
  });

  it("filler patients beyond the cap keep correct completed/alert data too", async () => {
    await seedFiller();
    const alerts = await api().authAlerts();
    expect(alerts.filter(a => a.patientName.startsWith("Filler "))).toHaveLength(60);
    expect(alerts.every(a => a.sessionsAuthorized === 20 && a.sessionsRemaining === 20)).toBe(true);
  });

  it("valid reason + one confirm persists, moves the row to On Hold, and a reload keeps the hold and reason", async () => {
    const p = await seedPatient("Synthetic Pending", [{ auth: 4, used: 3, pending: true }]);
    const before = await visitsSnapshot(p);
    const alert = await alertFor(p);
    expect(classifyAuthorizationAlert(alert)).toBe("attention");

    await api().holdAuthorizationRequest({ patientId: p, authPeriod: alert.authPeriod, reason: "  Physician out until Monday  " });

    // "Reload": a fresh list read, as the dashboard / On Hold page / patient details do.
    const reloaded = await alertFor(p);
    expect(classifyAuthorizationAlert(reloaded)).toBe("on_hold");
    expect(reloaded.hold).toMatchObject({ authPeriod: 1, reason: "Physician out until Monday", heldByDisplay: "Synthetic Staff" });
    expect(reloaded.urgency).toBe(alert.urgency); // classification only — the authorization itself is unchanged
    expect(await visitsSnapshot(p)).toEqual(before);
    expect(await heldAudits(p)).toHaveLength(1);
  });

  it("an expired authorization is held without changing its expiry", async () => {
    const p = await seedPatient("Synthetic Expired", [{ auth: 4, used: 1 }], Date.UTC(2026, 9, 1));
    await api().setPeriodExpired({ patientId: p, authPeriod: 1, expired: true });
    const alert = await alertFor(p);
    expect(alert).toMatchObject({ urgency: "expired", periodExpired: true, authPeriod: 1 });
    const visitsBefore = await visitsSnapshot(p);
    const patientBefore = await patientSnapshot(p);

    await api().holdAuthorizationRequest({ patientId: p, authPeriod: 1, reason: "Insurer reviewing" });

    const after = await alertFor(p);
    expect(classifyAuthorizationAlert(after)).toBe("on_hold");
    expect(after).toMatchObject({ urgency: "expired", periodExpired: true });
    expect(await visitsSnapshot(p)).toEqual(visitsBefore); // period_expired_at, status, counts untouched
    expect(await patientSnapshot(p)).toEqual(patientBefore); // auth_valid_until untouched
  });

  it("repeated and parallel confirms create one hold and one audit event", async () => {
    const p = await seedPatient("Synthetic Double", [{ auth: 4, used: 3, pending: true }]);
    const input = { patientId: p, authPeriod: 1, reason: "Waiting on referral" };
    const results = await Promise.all([api().holdAuthorizationRequest(input), api().holdAuthorizationRequest(input), api().holdAuthorizationRequest(input)]);
    const again = await api().holdAuthorizationRequest(input);
    expect(results.filter(r => r.changed)).toHaveLength(1);
    expect(again.changed).toBe(false);
    expect(new Set([...results, again].map(r => r.holdId)).size).toBe(1);
    expect(await activeHolds(p)).toHaveLength(1);
    expect(await heldAudits(p)).toHaveLength(1);
  });

  it("a genuine approval after the screen loaded is refused with the specific conflict; nothing is held", async () => {
    const p = await seedPatient("Synthetic Approved", [{ auth: 4, used: 4, pending: true }]);
    const stale = await alertFor(p);
    expect(stale.authPeriod).toBe(1);
    await api().approveAuthorization({ patientId: p, sessionsAuthorized: 6 }); // creates period 2

    await expect(api().holdAuthorizationRequest({ patientId: p, authPeriod: stale.authPeriod, reason: "r" }))
      .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/newer authorization period \(Period 2\)/) });
    expect(await activeHolds(p)).toHaveLength(0);
    expect(await heldAudits(p)).toHaveLength(0);
    // The newer period is never held silently: it is still actionable data, not on hold.
    expect((await alertFor(p)).hold).toBeNull();
  });

  it("Resume restores the current classification", async () => {
    const p = await seedPatient("Synthetic Resume", [{ auth: 4, used: 3, pending: true }]);
    const { holdId } = await api().holdAuthorizationRequest({ patientId: p, authPeriod: 1, reason: "r" });
    const out = await api().releaseAuthorizationRequestHold({ patientId: p, holdId });
    expect(out).toMatchObject({ changed: true, category: "attention", urgency: "critical" });
    const row = await alertFor(p);
    expect(row.hold).toBeNull();
    expect(classifyAuthorizationAlert(row)).toBe("attention");
  });
});
