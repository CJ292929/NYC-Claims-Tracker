/**
 * server/patientCsvImport.postgrest.integration.test.ts — P4-P29
 *
 * "Bulk Upload Patients" end to end through the REAL app:
 *   appRouter.createCaller → server/patientCsvImport.ts → server/db.ts →
 *   @supabase/supabase-js → local PostgREST → import_patient_csv_group_with_audit
 *   in a disposable postgres:16 (schema + every migration).
 *
 * Same harness as server/claimImportPatients.postgrest.integration.test.ts.
 * Every record is synthetic. Excluded from CI by the `**\/*.integration.test.ts`
 * glob; self-skips without Docker.
 *
 *   npx vitest run server/patientCsvImport.postgrest.integration.test.ts
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
import { buildClaimCsvTemplate } from "@shared/claimCsvTemplates";
import { buildPatientCsvTemplate } from "@shared/patientCsvImport";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.5";
const RUN = randomUUID().slice(0, 8);
const NET = `p4p29-net-${RUN}`;
const PG = `p4p29-pg-${RUN}`;
const REST = `p4p29-rest-${RUN}`;
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

const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const OWNER = {
  id: OWNER_ID, openId: "synthetic-owner", name: "Synthetic Owner", email: null, loginMethod: "google",
  role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
} as unknown as AuthenticatedUser;
const clinic = (role: "admin" | "staff", mustChangePassword = false) => ({
  ...OWNER, id: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b1" : "c1"}`, openId: `clinic_${role}`, role: "user",
  clinicUser: { clinicUserId: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b2" : "c2"}`, username: `${role}.synthetic`, name: `Synthetic ${role}`, email: null, department: null, role, mustChangePassword },
}) as unknown as AuthenticatedUser;
const STAFF = clinic("staff");
const ADMIN = clinic("admin");

function caller(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = { user, req: { protocol: "https", headers: {} } as any, res: {} as any };
  return appRouter.createCaller(ctx);
}

const HEADER = "Patient Name,Insurance,Authorized Sessions,Authorization Date,Date of Service,Session Number,Sessions Remaining,New Authorization?,Date Authorization Submitted";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";
const FILE = csv(
  "\"SYNTH, ALPHA\",Synthetic Health Plan,12,2026-04-01,2026-04-02,1,11,NO,",
  "Alpha Synth,,12,,2026-04-04,2,10,NO,",
  "\"SYNTH, BRAVO\",,10,,,,,,",
  "\"SYNTH, CHARLIE\",,x,,,,,,",
);
const CLAIMS_PREVIEW = (csvText: string) => ({ kind: "cms1500", fileName: "c.csv", csvText, patientChoices: {}, patientCreates: {}, lineEdits: {} }) as any;

const preview = (text: string, user: AuthenticatedUser | null = STAFF) =>
  caller(user).patients.csvImportPreview({ fileName: "patients.csv", csvText: text });
const save = (text: string, user: AuthenticatedUser | null = STAFF, choices: { skipKeys?: string[]; confirmKeys?: string[] } = {}) =>
  caller(user).patients.csvImportCommit({ fileName: "patients.csv", csvText: text, skipKeys: choices.skipKeys ?? [], confirmKeys: choices.confirmKeys ?? [] });

const counts = async () => (await q(`
  SELECT (SELECT count(*) FROM patients)::int AS patients,
         (SELECT count(*) FROM visit_records)::int AS visits,
         (SELECT count(*) FROM claims_records)::int AS claims,
         (SELECT count(*) FROM audit_logs)::int AS audits`))[0] as { patients: number; visits: number; claims: number; audits: number };

const describeDb = HAS_DOCKER ? describe : describe.skip;

describeDb("Bulk Upload Patients through the real app + PostgREST + Postgres", () => {
  let workDir = "";

  beforeAll(async () => {
    sh("docker", ["network", "create", NET]);
    sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    pgPort = Number(sh("docker", ["port", PG, "5432"]).trim().split("\n")[0].split(":").pop());
    await waitFor(() => { sh("docker", ["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }, "postgres");
    psql("CREATE DATABASE fresh", "postgres");
    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p29-"));
    const roles = path.join(workDir, "roles.sql");
    writeFileSync(roles, SUPABASE_DEFAULTS);
    psqlFile(roles);
    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const m of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) psqlFile(path.join(MIGRATIONS_DIR, m));
    await q("INSERT INTO insurer_catalog (name) VALUES ('Synthetic Health Plan')");
    await q("INSERT INTO insurer_catalog (name, is_active) VALUES ('Synthetic Retired Plan', false)");

    sh("docker", [
      "run", "-d", "--rm", "--name", REST, "--network", NET,
      "-e", `PGRST_DB_URI=postgres://authenticator:authpw@${PG}:5432/${DB}`,
      "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
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
    await q("DROP TRIGGER IF EXISTS p29_fail_audit ON audit_logs");
    await q("TRUNCATE pending_eob_lines, patient_external_ids, claims_records, claim_import_documents, audit_logs, visit_records, patients CASCADE");
  });

  // ── Access ──────────────────────────────────────────────────────────────

  describe("access", () => {
    it("anonymous callers are refused on preview and save", async () => {
      await expect(preview(FILE, null)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(save(FILE, null)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect((await counts()).patients).toBe(0);
    });

    it("a clinic session that must change its password is refused", async () => {
      await expect(save(FILE, clinic("staff", true))).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await counts()).patients).toBe(0);
    });

    it.each([["Staff", STAFF], ["Clinic Admin", ADMIN], ["Owner", OWNER]] as const)("%s can preview and save patient imports", async (_label, user) => {
      expect((await preview(FILE, user)).counts.new).toBe(2);
      expect((await save(FILE, user)).summary.created).toBe(2);
    });

    it("Staff still cannot use any Claims procedure or claims import", async () => {
      const c = caller(STAFF);
      await expect(c.claims.csvImportPreview(CLAIMS_PREVIEW(buildClaimCsvTemplate("cms1500")))).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.claims.csvImportCommit({} as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.claims.importPreview({} as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.claims.importCommit({} as any)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.claims.pendingEobList()).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.claims.getFollowUpClaims()).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("Clinic Admin and Owner can still use the claims CSV import", async () => {
      for (const user of [ADMIN, OWNER]) {
        await expect(caller(user).claims.csvImportPreview(CLAIMS_PREVIEW(buildClaimCsvTemplate("cms1500")))).resolves.toBeTruthy();
      }
    });
  });

  // ── Preview / save ──────────────────────────────────────────────────────

  it("the downloadable template previews cleanly", async () => {
    const p = await preview(buildPatientCsvTemplate());
    expect(p.fileError).toBeNull();
    expect(p.counts).toMatchObject({ new: 2, invalid: 0, sessions: 3 });
  });

  it("preview validates, groups and writes nothing", async () => {
    const before = await counts();
    const p = await preview(FILE);
    expect(p.groups.map(g => [g.name, g.status, g.visits.length])).toEqual([
      ["SYNTH, ALPHA", "new", 2],
      ["SYNTH, BRAVO", "new", 1],
      ["SYNTH, CHARLIE", "invalid", 0],
    ]);
    expect(p.groups[2].errors[0]).toMatch(/Line 5: Authorized Sessions "x"/);
    expect(await counts()).toEqual(before);
  });

  it("save creates only valid patients with their sessions and audit rows, and reports it accurately", async () => {
    const r = await save(FILE);
    expect(r.summary).toEqual({ created: 2, sessionsCreated: 3, alreadyExists: 0, skipped: 0, invalid: 1, failed: 0 });
    const patients = await q("SELECT name, insurance, to_char(auth_date,'YYYY-MM-DD') AS auth_date, claims_status, created_by_type FROM patients ORDER BY name");
    expect(patients).toEqual([
      { name: "SYNTH, ALPHA", insurance: "Synthetic Health Plan", auth_date: "2026-04-01", claims_status: null, created_by_type: "clinic_user" },
      { name: "SYNTH, BRAVO", insurance: "", auth_date: null, claims_status: null, created_by_type: "clinic_user" },
    ]);
    const visits = await q(`SELECT p.name, v.sessions_authorized, v.sessions_remaining, v.session_number, to_char(v.date_of_service,'YYYY-MM-DD') AS dos,
        v.new_auth, v.auth_period, v.auth_status, v.total_insurance_reimbursement, v.total_patient_due, v.total_patient_paid
      FROM visit_records v JOIN patients p ON p.id = v.patient_id ORDER BY p.name, v.session_number NULLS LAST`);
    const money = { total_insurance_reimbursement: null, total_patient_due: null, total_patient_paid: null };
    expect(visits).toEqual([
      { name: "SYNTH, ALPHA", sessions_authorized: 12, sessions_remaining: 11, session_number: 1, dos: "2026-04-02", new_auth: "NO", auth_period: 1, auth_status: "none", ...money },
      { name: "SYNTH, ALPHA", sessions_authorized: 12, sessions_remaining: 10, session_number: 2, dos: "2026-04-04", new_auth: "NO", auth_period: 1, auth_status: "none", ...money },
      { name: "SYNTH, BRAVO", sessions_authorized: 10, sessions_remaining: 10, session_number: null, dos: null, new_auth: "NO", auth_period: 1, auth_status: "none", ...money },
    ]);
    const audit = await q("SELECT action, import_batch_id, after_data FROM audit_logs ORDER BY created_at");
    const created = audit.filter(a => a.action === "PATIENT_CREATE_FROM_IMPORT");
    expect(created).toHaveLength(2);
    expect(audit.filter(a => a.action === "VISIT_RECORD_CREATE")).toHaveLength(3);
    expect(created.every(a => a.import_batch_id === r.importBatchId && a.after_data.import_source === "patient_csv")).toBe(true);
    expect((await counts()).claims).toBe(0);

    // Staff can read the creation in the patient's history.
    const [{ id }] = await q("SELECT id FROM patients WHERE name = 'SYNTH, ALPHA'");
    const history = await caller(STAFF).patients.history({ id });
    expect(history.some(h => h.action === "PATIENT_CREATE_FROM_IMPORT")).toBe(true);
  });

  it("retrying a save (or saving the same file again) never duplicates patients or sessions", async () => {
    await save(FILE);
    const before = await counts();
    const again = await save(FILE);
    expect(again.summary).toMatchObject({ created: 0, alreadyExists: 2, invalid: 1 });
    expect(await counts()).toEqual(before);
    const p = await preview(FILE);
    expect(p.groups.filter(g => g.status === "existing").map(g => g.matchedName)).toEqual(["SYNTH, ALPHA", "SYNTH, BRAVO"]);
  });

  it("two concurrent saves of one file create each patient once", async () => {
    const [a, b] = await Promise.all([save(FILE), save(FILE, ADMIN)]);
    expect(a.summary.created + b.summary.created).toBe(2);
    expect(a.summary.alreadyExists + b.summary.alreadyExists).toBe(2);
    expect(await counts()).toMatchObject({ patients: 2, visits: 3 });
  });

  it("an existing patient is never modified", async () => {
    await caller(STAFF).patients.create({ name: "Alpha Synth", insurance: "" });
    const before = await q("SELECT * FROM patients");
    const r = await save(FILE);
    expect(r.results.find(x => x.name === "SYNTH, ALPHA")).toMatchObject({ outcome: "already_exists" });
    expect(await q("SELECT * FROM patients WHERE name = 'Alpha Synth'")).toEqual(before);
    expect((await q("SELECT count(*)::int AS n FROM visit_records v JOIN patients p ON p.id = v.patient_id WHERE p.name = 'Alpha Synth'"))[0].n).toBe(0);
  });

  it("a possible duplicate is saved only when the reviewer confirms it; unticked patients are skipped", async () => {
    await caller(STAFF).patients.create({ name: "SYNTH, ALPHA J", insurance: "" });
    const p = await preview(FILE);
    const alpha = p.groups.find(g => g.name === "SYNTH, ALPHA")!;
    expect(alpha).toMatchObject({ status: "possible_duplicate", matchedName: "SYNTH, ALPHA J" });

    const first = await save(FILE, STAFF, { skipKeys: [p.groups.find(g => g.name === "SYNTH, BRAVO")!.key] });
    expect(first.summary).toMatchObject({ created: 0, skipped: 2 });
    expect((await counts()).patients).toBe(1);

    const second = await save(FILE, STAFF, { confirmKeys: [alpha.key] });
    expect(second.summary).toMatchObject({ created: 2, skipped: 0 });
    expect((await counts()).patients).toBe(3);
  });

  it("an unknown or deactivated insurance company is a row error, not a silent value", async () => {
    const p = await preview(csv("\"SYNTH, DELTA\",Not A Real Plan,5", "\"SYNTH, ECHO\",Synthetic Retired Plan,5"));
    expect(p.groups.map(g => g.status)).toEqual(["invalid", "invalid"]);
    expect(p.groups[0].errors[0]).toMatch(/not in the insurance list/);
    expect(p.groups[1].errors[0]).toMatch(/deactivated/);
  });

  it.each([
    ["CMS1500 template", buildClaimCsvTemplate("cms1500"), "claims_template"],
    ["Insurance Reimbursement template", buildClaimCsvTemplate("eob"), "claims_template"],
    ["file with financial columns", "Patient Name,Insurance Paid\nSYNTH ZULU,10\n", "financial_columns"],
  ])("refuses a %s and writes nothing", async (_label, text, code) => {
    expect((await preview(text)).fileError?.code).toBe(code);
    const r = await save(text);
    expect(r.fileError?.code).toBe(code);
    expect(await counts()).toEqual({ patients: 0, visits: 0, claims: 0, audits: 0 });
  });

  it("an audit failure rolls the whole patient back, and a retry then saves it once", async () => {
    await q(`CREATE OR REPLACE FUNCTION p29_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'VISIT_RECORD_CREATE' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER p29_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION p29_fail()");
    const failed = await save(FILE);
    expect(failed.summary).toMatchObject({ created: 0, failed: 2 });
    expect(await counts()).toEqual({ patients: 0, visits: 0, claims: 0, audits: 0 });

    await q("DROP TRIGGER p29_fail_audit ON audit_logs");
    const retry = await save(FILE);
    expect(retry.summary).toMatchObject({ created: 2, sessionsCreated: 3, failed: 0 });
    expect(await counts()).toMatchObject({ patients: 2, visits: 3 });
  });

  it("a CMS1500 import afterwards finds the CSV-imported patient instead of creating another", async () => {
    await save(FILE);
    const cms = [
      "cms1500_claim_id,cms1500_line_id,patient_name,auth_period,date_of_service,cpt_code",
      "SYN-CMS-1,1,\"SYNTH, BRAVO\",1,2026-04-10,97110",
    ].join("\n") + "\n";
    const p = await caller(ADMIN).claims.csvImportPreview(CLAIMS_PREVIEW(cms));
    expect(p.preview!.groups[0].patient.identityStatus).not.toBe("new");
    expect((await counts()).patients).toBe(2);
  });
});
