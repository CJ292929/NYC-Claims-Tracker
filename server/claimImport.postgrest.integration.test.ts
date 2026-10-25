/**
 * server/claimImport.postgrest.integration.test.ts — P4-P24
 *
 * Exercises the REAL application persistence path end to end:
 *
 *   appRouter.createCaller (claims.importPreview / importCommit, Super Admin
 *   gate) → server/claimImport.ts → server/db.ts → @supabase/supabase-js →
 *   local PostgREST (public.ecr.aws/supabase/postgrest:v14.5, the image the
 *   Supabase CLI runs) → commit_cms1500_line_with_audit /
 *   apply_eob_line_with_audit in a disposable postgres:16.
 *
 * Two databases, each behind its own PostgREST:
 *   "fresh"   — references/local-setup-schema.sql + every migration.
 *   "upgrade" — the PRE-P4-P24 schema (origin/main's local-setup-schema.sql)
 *               + every earlier migration, seeded with historical
 *               reimbursement-first claim rows, THEN the P4-P24 migration
 *               (applied twice: re-runnable). Proves historical rows stay
 *               readable/editable and can be associated with a CMS1500
 *               without their money being rewritten.
 *
 * Supabase's default table privileges (ALL on public tables to anon,
 * authenticated, service_role) are emulated before the schema is applied,
 * so the migration's own REVOKEs are what keep anon/authenticated out.
 *
 * Every record is synthetic. Excluded from CI by the
 * `**\/*.integration.test.ts` glob; self-skips without Docker.
 *
 *   npx vitest run server/claimImport.postgrest.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthenticatedUser } from "./_core/sdk";
import type { TrpcContext } from "./_core/context";
import { assembleCms1500Pages } from "./cms1500Vision";
import { assignEobLineKeys, groupKeyFor } from "./claimImportKeys";
import { syntheticScannedPages } from "./fixtures/cms1500ScannedSynthetic";
import type { Cms1500ImportLine, EobImportLine } from "@shared/claimImport";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const P24_MIGRATION = "20261026000000_p4_p24_cms1500_first_claim_lines.sql";
const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.5";
const RUN = randomUUID().slice(0, 8);
const NET = `p4p24-net-${RUN}`;
const PG = `p4p24-pg-${RUN}`;
const REST_FRESH = `p4p24-rest-fresh-${RUN}`;
const REST_UPGRADE = `p4p24-rest-upgrade-${RUN}`;
const JWT_SECRET = randomBytes(32).toString("hex");

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
function preChangeSchema(): string | null {
  try {
    return execFileSync("git", ["show", "origin/main:references/local-setup-schema.sql"], { cwd: REPO_ROOT, encoding: "utf8" });
  } catch {
    return null;
  }
}
const HAS_DOCKER = dockerReady();
const PRE_SCHEMA = preChangeSchema();

let pgPort = 0;
function psqlFile(db: string, file: string) {
  sh("docker", ["cp", file, `${PG}:/tmp/apply.sql`]);
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-f", "/tmp/apply.sql"]);
}
function psql(db: string, sql: string) {
  sh("docker", ["exec", "-e", "PGPASSWORD=postgres", PG, "psql", "-U", "postgres", "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql]);
}
async function q<T = any>(db: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ host: "127.0.0.1", port: pgPort, user: "postgres", password: "postgres", database: db });
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

function startPostgrest(name: string, db: string): number {
  sh("docker", [
    "run", "-d", "--rm", "--name", name, "--network", NET,
    "-e", `PGRST_DB_URI=postgres://authenticator:authpw@${PG}:5432/${db}`,
    "-e", "PGRST_DB_SCHEMAS=public", "-e", "PGRST_DB_ANON_ROLE=anon",
    "-e", `PGRST_JWT_SECRET=${JWT_SECRET}`,
    "-p", "127.0.0.1::3000", POSTGREST_IMAGE,
  ]);
  const mapping = sh("docker", ["port", name, "3000"]).trim().split("\n")[0];
  return Number(mapping.split(":").pop());
}

// supabase-js calls <url>/rest/v1/...; PostgREST serves at /. A tiny proxy
// strips the prefix, and its target can be switched between the two DBs.
let restTarget = 0;
let proxy: http.Server;
let proxyPort = 0;
function startProxy(): Promise<void> {
  proxy = http.createServer((req, res) => {
    const upstream = http.request({
      host: "127.0.0.1", port: restTarget, method: req.method,
      path: (req.url ?? "/").replace(/^\/rest\/v1/, "") || "/",
      headers: { ...req.headers, host: `127.0.0.1:${restTarget}` },
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

// ─── App wiring ────────────────────────────────────────────────────────────

type Router = typeof import("./routers").appRouter;
let appRouter: Router;

const OWNER_ID = "00000000-0000-4000-8000-0000000000a1";
const SUPER_ADMIN = {
  id: OWNER_ID, openId: "synthetic-owner", name: "Synthetic Owner", email: null, loginMethod: "google",
  role: "admin", createdAt: new Date(), updatedAt: new Date(), lastSignedIn: new Date(),
} as unknown as AuthenticatedUser;
const clinic = (role: "admin" | "staff") => ({
  ...SUPER_ADMIN, id: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b1" : "c1"}`, openId: `clinic_${role}`, role: "user",
  clinicUser: { clinicUserId: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b2" : "c2"}`, username: `${role}.synthetic`, name: `Synthetic ${role}`, email: null, department: null, role, mustChangePassword: false },
}) as unknown as AuthenticatedUser;

function caller(user: AuthenticatedUser) {
  const ctx: TrpcContext = { user, req: { protocol: "https", headers: {} } as any, res: {} as any };
  return appRouter.createCaller(ctx);
}
const sa = () => caller(SUPER_ADMIN);

const sha = () => randomBytes(32).toString("hex");

type CmsDecision = { action: "create" | "create_distinct" | "associate" | "skip"; claimRecordId?: string; authPeriod?: number; periodSource?: "resolved" | "selected" | "context"; acknowledgeFlags?: boolean };
type EobDecision = { action: "apply" | "skip"; claimRecordId?: string; confirmReplace?: boolean };

function cmsLineInput(l: Cms1500ImportLine) {
  return {
    sourceLineKey: l.sourceLineKey, dateOfService: l.dateOfService, cptCodes: l.cptCodes, modifier: l.modifier,
    unitsBilled: l.unitsBilled, placeOfService: l.placeOfService, diagnosisCodes: l.diagnosisCodes,
    claimSubmittedDate: l.claimSubmittedDate, insuranceBilled: l.insuranceBilled, unreadable: l.unreadable,
  };
}
function eobLineInput(l: EobImportLine) {
  return {
    sourceLineKey: l.sourceLineKey, dateOfService: l.dateOfService, cptCodes: l.cptCodes, modifier: l.modifier,
    unitsBilled: l.unitsBilled, chargeAmount: l.chargeAmount, insuranceReimbursement: l.insuranceReimbursement,
    patientAmountDue: l.patientAmountDue, patientAmountPaid: l.patientAmountPaid,
    claimStatus: (l.claimStatus as any) ?? null, oaClaimNumber: l.oaClaimNumber, checkDate: l.checkDate,
    checkNumberVirtualCard: l.checkNumberVirtualCard,
  };
}

/** A synthetic CMS1500 document (lines keyed exactly as the extractor keys them). */
function cmsDoc(patientName: string, lines: Array<Partial<Cms1500ImportLine> & { dateOfService: string; cptCodes: string }>) {
  const groupKey = groupKeyFor(`test:${patientName}:${randomUUID()}`);
  const built = lines.map((l, i) => ({
    page: 1, slot: i + 1, placeOfService: "12", modifier: "GP", unitsBilled: 1, diagnosisPointer: "A", diagnosisCodes: "M54.50",
    claimSubmittedDate: null, insuranceBilled: null, lineChargeForValidation: 175, unreadable: [], notes: null,
    ...l, sourceLineKey: `${groupKey}:p1r${i + 1}`,
  })) as Cms1500ImportLine[];
  return { sha256: sha(), groupKey, patientName, lines: built };
}

function eobDoc(patientName: string, lines: Array<Partial<EobImportLine> & { dateOfService: string; cptCodes: string }>) {
  const groupKey = groupKeyFor(`test-eob:${patientName}:${randomUUID()}`);
  const built = assignEobLineKeys(groupKey, lines.map(l => ({
    page: null, modifier: "GP", unitsBilled: 1, chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: 20,
    patientAmountPaid: null, claimStatus: "approved", oaClaimNumber: "SYN-CLM-1", checkDate: "2026-04-01",
    checkNumberVirtualCard: "SYN-EFT-1", notes: null, ...l,
  })));
  return { sha256: sha(), groupKey, patientName, lines: built as EobImportLine[] };
}

function commitCms(doc: ReturnType<typeof cmsDoc>, opts: { patientId?: string; patientName?: string; decide?: (l: Cms1500ImportLine, i: number) => CmsDecision; only?: number[]; contextPatientId?: string; contextAuthPeriod?: number; patientConfirmed?: boolean } = {}) {
  const lines = doc.lines.filter((_, i) => !opts.only || opts.only.includes(i));
  return sa().claims.importCommit({
    kind: "cms1500",
    document: { sha256: doc.sha256, fileName: "synthetic-cms1500.pdf", pageCount: 1 },
    contextPatientId: opts.contextPatientId ?? null,
    contextAuthPeriod: opts.contextAuthPeriod ?? null,
    groups: [{
      groupKey: doc.groupKey, patientName: opts.patientName ?? doc.patientName, patientId: opts.patientId ?? null,
      patientConfirmed: opts.patientConfirmed, allLineKeys: doc.lines.map(l => l.sourceLineKey),
      lines: lines.map((l, i) => ({ ...cmsLineInput(l), decision: opts.decide ? opts.decide(l, i) : { action: "create" as const } })),
    }],
  });
}

function commitEob(doc: ReturnType<typeof eobDoc>, decide: (l: EobImportLine, i: number) => EobDecision, opts: { patientId?: string; patientName?: string; only?: number[] } = {}) {
  const lines = doc.lines.filter((_, i) => !opts.only || opts.only.includes(i));
  return sa().claims.importCommit({
    kind: "eob",
    document: { sha256: doc.sha256, fileName: "synthetic-eob.pdf", pageCount: 1 },
    groups: [{
      groupKey: doc.groupKey, patientName: opts.patientName ?? doc.patientName, patientId: opts.patientId ?? null,
      allLineKeys: doc.lines.map(l => l.sourceLineKey),
      lines: lines.map((l, i) => ({ ...eobLineInput(l), decision: decide(l, i) })),
    }],
  });
}

function previewEob(doc: ReturnType<typeof eobDoc>, patientId?: string) {
  return sa().claims.importPreview({
    kind: "eob", document: { sha256: doc.sha256, fileName: "synthetic-eob.pdf", pageCount: 1 },
    groups: [{ groupKey: doc.groupKey, patientName: doc.patientName, patientId: patientId ?? null, lines: doc.lines.map(eobLineInput) }],
  });
}
function previewCms(doc: ReturnType<typeof cmsDoc>, patientId?: string) {
  return sa().claims.importPreview({
    kind: "cms1500", document: { sha256: doc.sha256, fileName: "synthetic-cms1500.pdf", pageCount: 1 },
    groups: [{ groupKey: doc.groupKey, patientName: doc.patientName, patientId: patientId ?? null, lines: doc.lines.map(cmsLineInput) }],
  });
}

const counts = async (db: string) => (await q(db, `
  SELECT (SELECT count(*) FROM claims_records)::int AS claims,
         (SELECT count(*) FROM audit_logs)::int AS audits,
         (SELECT count(*) FROM claim_import_documents)::int AS docs`))[0] as { claims: number; audits: number; docs: number };

// ─── Setup ──────────────────────────────────────────────────────────────────

const PATIENT_A = "11111111-1111-4111-8111-111111111111"; // TESTPATIENT, ALEX — periods 1 and 2
const PATIENT_B = "22222222-2222-4222-8222-222222222222"; // OTHERPERSON, SAM — period 1
const PATIENT_C = "33333333-3333-4333-8333-333333333333"; // NOVISITS, PAT — no visits

let freshPort = 0;
let upgradePort = 0;
let workDir = "";

const SEED_PATIENTS = `
  INSERT INTO patients (id, name, insurance) VALUES
    ('${PATIENT_A}', 'TESTPATIENT, ALEX', 'Synthetic Health'),
    ('${PATIENT_B}', 'OTHERPERSON, SAM', 'Synthetic Health'),
    ('${PATIENT_C}', 'NOVISITS, PAT', 'Synthetic Health');
  INSERT INTO visit_records (patient_id, auth_period, date_of_service) VALUES
    ('${PATIENT_A}', 1, '2026-01-05'), ('${PATIENT_A}', 1, '2026-02-20'),
    ('${PATIENT_A}', 2, '2026-03-02'), ('${PATIENT_A}', 2, '2026-03-30'),
    ('${PATIENT_B}', 1, '2026-03-01'), ('${PATIENT_B}', 1, '2026-03-31');
`;

const describeDb = HAS_DOCKER && PRE_SCHEMA ? describe : describe.skip;

describeDb("CMS1500-first import through the real app + PostgREST + Postgres", () => {
  beforeAll(async () => {
    sh("docker", ["network", "create", NET]);
    sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    pgPort = Number(sh("docker", ["port", PG, "5432"]).trim().split("\n")[0].split(":").pop());
    await waitFor(() => { sh("docker", ["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }, "postgres");
    await waitFor(async () => { await q("postgres", "SELECT 1"); return true; }, "postgres tcp");

    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p24-"));
    const roles = path.join(workDir, "roles.sql");
    writeFileSync(roles, SUPABASE_DEFAULTS);
    const migrations = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort();

    // fresh
    psql("postgres", "CREATE DATABASE fresh");
    psqlFile("fresh", roles);
    psqlFile("fresh", path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const m of migrations) psqlFile("fresh", path.join(MIGRATIONS_DIR, m));
    psql("fresh", SEED_PATIENTS);

    // upgrade: pre-P4-P24 schema, historical rows, then the migration (twice)
    psql("postgres", "CREATE DATABASE upgrade");
    psqlFile("upgrade", roles);
    const pre = path.join(workDir, "pre.sql");
    writeFileSync(pre, PRE_SCHEMA!);
    psqlFile("upgrade", pre);
    for (const m of migrations.filter(m => m !== P24_MIGRATION)) psqlFile("upgrade", path.join(MIGRATIONS_DIR, m));
    psql("upgrade", SEED_PATIENTS);
    psql("upgrade", `
      INSERT INTO claims_records (id, patient_id, auth_period, date_of_service, cpt_codes, modifier, units_billed,
        charge_amount, insurance_reimbursement, patient_amount_due, claim_status, oa_claim_number, check_date, source_line_index)
      VALUES
        ('44444444-4444-4444-8444-444444444441', '${PATIENT_A}', 1, '2026-02-20', '97110', 'GP', 1, 175.00, 80.00, 20.00, 'approved', 'HIST-1', '2026-03-10', NULL),
        ('44444444-4444-4444-8444-444444444442', '${PATIENT_A}', 1, '2026-02-20', '97112', 'GP', 1, 175.00, 0.00, NULL, 'denied', 'HIST-1', '2026-03-10', 0);
    `);
    psqlFile("upgrade", path.join(MIGRATIONS_DIR, P24_MIGRATION));
    psqlFile("upgrade", path.join(MIGRATIONS_DIR, P24_MIGRATION));

    freshPort = startPostgrest(REST_FRESH, "fresh");
    upgradePort = startPostgrest(REST_UPGRADE, "upgrade");
    for (const port of [freshPort, upgradePort]) {
      await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/`)).status < 500, `postgrest :${port}`);
    }
    restTarget = freshPort;
    await startProxy();

    const jwt = await new SignJWT({ role: "service_role" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().sign(new TextEncoder().encode(JWT_SECRET));
    process.env.SUPABASE_URL = `http://127.0.0.1:${proxyPort}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = jwt;
    ({ appRouter } = await import("./routers"));
  }, 240_000);

  afterAll(() => {
    proxy?.close();
    for (const c of [REST_FRESH, REST_UPGRADE, PG]) {
      try { sh("docker", ["rm", "-f", c]); } catch { /* already gone */ }
    }
    try { sh("docker", ["network", "rm", NET]); } catch { /* ignore */ }
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  });

  describe("fresh database", () => {
    beforeAll(() => { restTarget = freshPort; });
    const DB = "fresh";
    const scanned = () => assembleCms1500Pages(syntheticScannedPages(), 3).groups[0];
    const scanSha = sha();
    const scanCommit = (decide?: (l: Cms1500ImportLine) => CmsDecision, only?: number[]) => {
      const g = scanned();
      const lines = g.lines.filter((_, i) => !only || only.includes(i));
      return sa().claims.importCommit({
        kind: "cms1500", document: { sha256: scanSha, fileName: "synthetic-scan.pdf", pageCount: 3 },
        groups: [{
          groupKey: g.groupKey, patientName: g.patientName, patientId: null, allLineKeys: g.lines.map(l => l.sourceLineKey),
          lines: lines.map(l => ({ ...cmsLineInput(l), decision: decide ? decide(l) : { action: "create" as const } })),
        }],
      });
    };

    it("EOB-first is blocked: preview says upload the CMS1500 first, commit writes nothing", async () => {
      const before = await counts(DB);
      const eob = eobDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-05", cptCodes: "97110" }]);
      const preview = await previewEob(eob);
      expect(preview.groups[0].patient).toMatchObject({ status: "matched", patientId: PATIENT_B });
      expect(preview.groups[0].lines[0]).toMatchObject({ status: "cms1500_required", reason: "Upload the matching CMS1500 first." });

      const result = await commitEob(eob, () => ({ action: "apply" }));
      expect(result.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "cms1500_required" });
      expect(await counts(DB)).toEqual(before);
    });

    it("EOB onto a manual row with no CMS1500 is refused by the database, leaving its money and audit untouched", async () => {
      const { claimId } = await sa().claims.create({ patientId: PATIENT_B, authPeriod: 1, dateOfService: "2026-03-06", cptCodes: "97112", insuranceReimbursement: 50 });
      const before = await counts(DB);
      const eob = eobDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-06", cptCodes: "97112", insuranceReimbursement: 99 }]);
      const result = await commitEob(eob, () => ({ action: "apply", claimRecordId: claimId, confirmReplace: true }));
      expect(result.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "cms1500_required" });
      expect(await counts(DB)).toEqual(before);
      const [r] = await q(DB, "SELECT insurance_reimbursement, eob_document_id FROM claims_records WHERE id = $1", [claimId]);
      expect(r).toEqual({ insurance_reimbursement: "50.00", eob_document_id: null });
    });

    it("CMS1500 first: the scanned 3-page claim creates 16 lines with every amount unknown (NULL), in the right period", async () => {
      const before = await counts(DB);
      const preview = await sa().claims.importPreview({
        kind: "cms1500", document: { sha256: scanSha, fileName: "synthetic-scan.pdf", pageCount: 3 },
        groups: [{ groupKey: scanned().groupKey, patientName: scanned().patientName, lines: scanned().lines.map(cmsLineInput) }],
      });
      expect(preview.groups[0].patient.patientId).toBe(PATIENT_A);
      expect(preview.groups[0].lines.every(l => l.status === "ready_new")).toBe(true);

      const result = await scanCommit();
      const lines = result.groups[0].lines;
      expect(lines).toHaveLength(16);
      expect(lines.every(l => l.status === "saved" && l.outcome === "created" && l.authPeriod === 2)).toBe(true);

      const rows = await q(DB, `SELECT * FROM claims_records WHERE patient_id = $1 AND cms1500_document_id IS NOT NULL ORDER BY date_of_service, cms1500_line_key`, [PATIENT_A]);
      expect(rows).toHaveLength(16);
      for (const r of rows) {
        expect([r.charge_amount, r.insurance_reimbursement, r.patient_amount_paid, r.patient_amount_due, r.payment_received]).toEqual([null, null, null, null, null]);
        expect(r.visit_number).toBeNull();
        expect(r.auth_period).toBe(2);
        expect(r.claim_status).toBe("submitted");
      }
      const r97140 = rows.find(r => r.cpt_codes === "97140")!;
      expect(r97140.modifier).toBe("59, GP");
      expect(r97140.diagnosis_codes).toBe("M54.50, M25.551, M62.81, R26.89");
      expect(rows.find(r => r.cpt_codes === "97530")!.diagnosis_codes).toBe("M62.81, M54.16, R26.89, Z74.09");

      const after = await counts(DB);
      expect(after.claims - before.claims).toBe(16);
      expect(after.audits - before.audits).toBe(16);
      expect(after.docs - before.docs).toBe(1);
      const audits = await q(DB, `SELECT DISTINCT import_batch_id, action, actor_id, actor_type FROM audit_logs WHERE action = 'CLAIM_RECORD_CMS1500_CREATE' AND patient_id = $1`, [PATIENT_A]);
      expect(audits).toEqual([{ import_batch_id: result.importBatchId, action: "CLAIM_RECORD_CMS1500_CREATE", actor_id: OWNER_ID, actor_type: "owner" }]);
    });

    it("re-importing the same CMS1500 is a no-op: no new rows, no audit events", async () => {
      const before = await counts(DB);
      const result = await scanCommit();
      expect(result.groups[0].lines.every(l => l.status === "unchanged")).toBe(true);
      expect(await counts(DB)).toEqual(before);
    });

    it("a matching EOB updates exactly the matching lines; reimport and concurrent resubmits never duplicate money", async () => {
      // EOB for the first date only (4 lines), with real per-line amounts.
      const eob = eobDoc("TESTPATIENT, ALEX", [
        { dateOfService: "2026-03-02", cptCodes: "97110", modifier: "GP", insuranceReimbursement: 81, patientAmountDue: 21 },
        { dateOfService: "2026-03-02", cptCodes: "97112", modifier: "GP", insuranceReimbursement: 82, patientAmountDue: 22 },
        { dateOfService: "2026-03-02", cptCodes: "97530", modifier: "GP", insuranceReimbursement: 0, patientAmountDue: 0, claimStatus: "denied" },
        { dateOfService: "2026-03-02", cptCodes: "97140", modifier: "59, GP", insuranceReimbursement: 84, patientAmountDue: null },
      ]);
      const preview = await previewEob(eob);
      expect(preview.groups[0].lines.map(l => l.status)).toEqual(["matched", "matched", "matched", "matched"]);
      const targets = preview.groups[0].lines.map(l => (l as { targetClaimId?: string }).targetClaimId!);

      const before = await counts(DB);
      const runs = await Promise.all(Array.from({ length: 4 }, () => commitEob(eob, (_, i) => ({ action: "apply", claimRecordId: targets[i] }))));
      const statuses = runs.flatMap(r => r.groups[0].lines.map(l => l.status));
      expect(statuses.filter(s => s === "saved")).toHaveLength(4);
      expect(statuses.filter(s => s === "unchanged")).toHaveLength(12);
      const after = await counts(DB);
      expect(after.claims).toBe(before.claims);
      expect(after.audits - before.audits).toBe(4);

      const rows = await q(DB, `SELECT cpt_codes, insurance_reimbursement, patient_amount_due, patient_amount_paid, claim_status, eob_line_key FROM claims_records WHERE id = ANY($1) ORDER BY cpt_codes`, [targets]);
      expect(rows.map(r => [r.cpt_codes, r.insurance_reimbursement, r.patient_amount_due, r.claim_status])).toEqual([
        ["97110", "81.00", "21.00", "approved"],
        ["97112", "82.00", "22.00", "approved"],
        ["97140", "84.00", null, "approved"],
        ["97530", "0.00", "0.00", "denied"],
      ]);
      // Patient responsibility is never copied into patient paid.
      expect(rows.every(r => r.patient_amount_paid === null)).toBe(true);
      // The other 12 CMS1500 lines still have unknown money.
      const untouched = await q(DB, `SELECT count(*)::int AS n FROM claims_records WHERE patient_id = $1 AND cms1500_document_id IS NOT NULL AND insurance_reimbursement IS NULL`, [PATIENT_A]);
      expect(untouched[0].n).toBe(12);

      // Reimport of the same EOB: unchanged, no audit.
      const again = await commitEob(eob, (_, i) => ({ action: "apply", claimRecordId: targets[i] }));
      expect(again.groups[0].lines.every(l => l.status === "unchanged")).toBe(true);
      expect(await counts(DB)).toEqual(after);
    });

    it("re-importing the CMS1500 (with a corrected value) keeps every EOB amount", async () => {
      const result = await scanCommit(l => ({ action: "create" }), [0]);
      expect(result.groups[0].lines[0].status).toBe("unchanged");
      const g = scanned();
      const corrected = { ...cmsLineInput(g.lines[1]), placeOfService: "11" };
      const fix = await sa().claims.importCommit({
        kind: "cms1500", document: { sha256: scanSha, fileName: "synthetic-scan.pdf", pageCount: 3 },
        groups: [{ groupKey: g.groupKey, patientName: g.patientName, allLineKeys: g.lines.map(l => l.sourceLineKey), lines: [{ ...corrected, decision: { action: "create" } }] }],
      });
      expect(fix.groups[0].lines[0]).toMatchObject({ status: "saved", outcome: "updated" });
      const [r] = await q(DB, `SELECT place_of_service, insurance_reimbursement, patient_amount_due FROM claims_records WHERE cms1500_line_key = $1`, [g.lines[1].sourceLineKey]);
      expect(r).toEqual({ place_of_service: "11", insurance_reimbursement: "82.00", patient_amount_due: "22.00" });
      const [audit] = await q(DB, `SELECT before_data, after_data FROM audit_logs WHERE action = 'CLAIM_RECORD_CMS1500_REAPPLY' ORDER BY created_at DESC LIMIT 1`);
      expect(audit.before_data).toEqual({ place_of_service: "12" });
      expect(audit.after_data).toEqual({ place_of_service: "11" });
    });

    it("identical repeated CPT lines stay distinct, need explicit EOB selection, and never share or sum a payment", async () => {
      const cms = cmsDoc("OTHERPERSON, SAM", [
        { dateOfService: "2026-03-10", cptCodes: "97110" },
        { dateOfService: "2026-03-10", cptCodes: "97110" },
        { dateOfService: "2026-03-10", cptCodes: "97112" },
      ]);
      const saved = await commitCms(cms);
      expect(saved.groups[0].lines.map(l => l.status)).toEqual(["saved", "saved", "saved"]);
      const [idX, idY] = saved.groups[0].lines.map(l => l.claimId!);
      expect(idX).not.toBe(idY);

      const eob = eobDoc("OTHERPERSON, SAM", [
        { dateOfService: "2026-03-10", cptCodes: "97110", insuranceReimbursement: 70 },
        { dateOfService: "2026-03-10", cptCodes: "97110", insuranceReimbursement: 70 },
      ]);
      const preview = await previewEob(eob);
      expect(preview.groups[0].lines.map(l => l.status)).toEqual(["needs_selection", "needs_selection"]);

      // Without a selection nothing is applied.
      const none = await commitEob(eob, () => ({ action: "apply" }));
      expect(none.groups[0].lines.every(l => l.status === "review_required")).toBe(true);

      // Both EOB lines pointed at the same CMS1500 line: only the first lands.
      const same = await commitEob(eob, () => ({ action: "apply", claimRecordId: idX }));
      expect(same.groups[0].lines.map(l => l.status)).toEqual(["saved", "review_required"]);
      expect(same.groups[0].lines[1].reason).toBe("already_reconciled");

      // Retry only the unresolved line, now pointed at the other row.
      const retry = await commitEob(eob, () => ({ action: "apply", claimRecordId: idY }), { only: [1] });
      expect(retry.groups[0].lines[0].status).toBe("saved");
      const rows = await q(DB, `SELECT id, insurance_reimbursement FROM claims_records WHERE id = ANY($1) ORDER BY id`, [[idX, idY]]);
      expect(rows.map(r => r.insurance_reimbursement)).toEqual(["70.00", "70.00"]);

      // One EOB line can never be applied to a second row.
      const twice = await commitEob(eob, () => ({ action: "apply", claimRecordId: idY }), { only: [0] });
      expect(twice.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "source_line_already_saved" });
    });

    it("an ambiguous CMS1500 line (existing row at the same date + CPT) needs an explicit decision", async () => {
      const { claimId: manualId } = await sa().claims.create({ patientId: PATIENT_C, authPeriod: 1, dateOfService: "2026-05-01", cptCodes: "97110", insuranceReimbursement: 60, patientAmountDue: 15 });
      const cms = cmsDoc("NOVISITS, PAT", [{ dateOfService: "2026-05-01", cptCodes: "97110" }, { dateOfService: "2026-05-02", cptCodes: "97112" }]);
      const preview = await previewCms(cms);
      expect(preview.groups[0].lines[0]).toMatchObject({ status: "needs_selection", associableIds: [manualId] });
      expect(preview.groups[0].lines[1]).toMatchObject({ status: "period_required" });

      const before = await counts(DB);
      const blind = await commitCms(cms, { decide: () => ({ action: "create", authPeriod: 1, periodSource: "selected" }) });
      expect(blind.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "needs_selection" });
      expect(blind.groups[0].lines[1]).toMatchObject({ status: "saved", outcome: "created", authPeriod: 1 });
      expect((await counts(DB)).claims - before.claims).toBe(1);

      // No period chosen for an uncertain date → review, nothing written.
      const noPeriod = await commitCms(cmsDoc("NOVISITS, PAT", [{ dateOfService: "2026-05-09", cptCodes: "97530" }]));
      expect(noPeriod.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "period_required" });

      const assoc = await commitCms(cms, { decide: (_, i) => (i === 0 ? { action: "associate", claimRecordId: manualId } : { action: "create", authPeriod: 1, periodSource: "selected" }) });
      expect(assoc.groups[0].lines[0]).toMatchObject({ status: "saved", outcome: "associated", claimId: manualId });
      expect(assoc.groups[0].lines[1].status).toBe("unchanged");
      const [r] = await q(DB, `SELECT insurance_reimbursement, patient_amount_due, auth_period, diagnosis_codes, cms1500_line_key FROM claims_records WHERE id = $1`, [manualId]);
      expect(r).toEqual({ insurance_reimbursement: "60.00", patient_amount_due: "15.00", auth_period: 1, diagnosis_codes: "M54.50", cms1500_line_key: cms.lines[0].sourceLineKey });
    });

    it("wrong patient, wrong date and wrong period are never silently matched", async () => {
      const [aRow] = await q(DB, `SELECT id, insurance_reimbursement FROM claims_records WHERE patient_id = $1 AND cpt_codes = '97110' AND date_of_service = '2026-03-04'`, [PATIENT_A]);
      const before = await counts(DB);

      const wrongPatient = eobDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-04", cptCodes: "97110", insuranceReimbursement: 999 }]);
      const r1 = await commitEob(wrongPatient, () => ({ action: "apply", claimRecordId: aRow.id, confirmReplace: true }));
      expect(r1.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "patient_mismatch" });

      const wrongDate = eobDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-03-05", cptCodes: "97110", insuranceReimbursement: 999 }]);
      const r2 = await commitEob(wrongDate, () => ({ action: "apply", claimRecordId: aRow.id, confirmReplace: true }));
      expect(r2.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "incompatible" });

      const wrongPeriod = cmsDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-01-05", cptCodes: "97750" }]);
      const r3 = await commitCms(wrongPeriod, { decide: () => ({ action: "create", authPeriod: 2, periodSource: "resolved" }) });
      expect(r3.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "period_mismatch" });

      expect(await counts(DB)).toEqual(before);
      const [after] = await q(DB, `SELECT insurance_reimbursement FROM claims_records WHERE id = $1`, [aRow.id]);
      expect(after.insurance_reimbursement).toBe(aRow.insurance_reimbursement);
    });

    it("group ownership: a reviewer cannot route a named group to a different patient, and a saved source line cannot move patients", async () => {
      const before = await counts(DB);
      const cms = cmsDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-03-20", cptCodes: "97110" }]);
      const r1 = await commitCms(cms, { patientId: PATIENT_B, patientConfirmed: true });
      expect(r1.groups[0]).toMatchObject({ patientId: PATIENT_A });
      expect(r1.groups[0].lines[0].status).toBe("saved");
      // The requested PATIENT_B was ignored: a safe name match is the only allowed patient.
      const [row] = await q(DB, `SELECT patient_id FROM claims_records WHERE id = $1`, [r1.groups[0].lines[0].claimId]);
      expect(row.patient_id).toBe(PATIENT_A);

      // Same document + source line, now presented as another patient's group.
      const r2 = await commitCms({ ...cms, patientName: "OTHERPERSON, SAM" }, {});
      expect(r2.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "patient_mismatch" });

      // Unreadable name in bulk mode: nothing saves until a patient is confirmed.
      const unnamed = cmsDoc("", [{ dateOfService: "2026-03-21", cptCodes: "97110" }]);
      const r3 = await sa().claims.importCommit({
        kind: "cms1500", document: { sha256: unnamed.sha256, fileName: "x.pdf", pageCount: 1 },
        groups: [{ groupKey: unnamed.groupKey, patientName: null, patientId: PATIENT_A, allLineKeys: unnamed.lines.map(l => l.sourceLineKey), lines: unnamed.lines.map(l => ({ ...cmsLineInput(l), decision: { action: "create" as const } })) }],
      });
      expect(r3.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "patient_unconfirmed" });
      expect((await counts(DB)).claims - before.claims).toBe(1);

      // Single-patient mode refuses a group that names someone else.
      const r4 = await commitCms(cmsDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-22", cptCodes: "97110" }]), { contextPatientId: PATIENT_A, contextAuthPeriod: 2 });
      expect(r4.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "patient_unconfirmed" });
      expect((await counts(DB)).claims - before.claims).toBe(1);
    });

    it("partial failures keep successful lines, and a partial retry keeps each line's original identity", async () => {
      const cms = cmsDoc("NOVISITS, PAT", [
        { dateOfService: "2026-06-01", cptCodes: "97110" },
        { dateOfService: "2026-06-01", cptCodes: "97110" },
        { dateOfService: "2026-06-01", cptCodes: "97112", unreadable: ["unitsBilled"], unitsBilled: null },
      ]);
      const first = await commitCms(cms, { decide: (_, i) => ({ action: "create", authPeriod: i === 1 ? undefined : 1, periodSource: i === 1 ? undefined : "selected" }) });
      expect(first.groups[0].lines.map(l => l.status)).toEqual(["saved", "review_required", "review_required"]);
      expect(first.groups[0].lines[2].reason).toBe("flags_unacknowledged");

      // Retry only the unresolved lines — line 1 is an identical sibling of the saved line 0.
      const retry = await commitCms(cms, { only: [1, 2], decide: () => ({ action: "create", authPeriod: 1, periodSource: "selected", acknowledgeFlags: true }) });
      expect(retry.groups[0].lines.map(l => l.status)).toEqual(["saved", "saved"]);
      const rows = await q(DB, `SELECT cms1500_line_key, units_billed FROM claims_records WHERE cms1500_line_key = ANY($1) ORDER BY cms1500_line_key`, [cms.lines.map(l => l.sourceLineKey)]);
      expect(rows.map(r => r.cms1500_line_key)).toEqual(cms.lines.map(l => l.sourceLineKey).sort());
      expect(rows.find(r => r.cms1500_line_key === cms.lines[2].sourceLineKey)!.units_billed).toBeNull();

      // One bad group never blocks another group in the same file.
      const good = cmsDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-25", cptCodes: "97110" }]);
      const bad = cmsDoc("NOBODY, UNKNOWN", [{ dateOfService: "2026-03-25", cptCodes: "97110" }]);
      const mixed = await sa().claims.importCommit({
        kind: "cms1500", document: { sha256: good.sha256, fileName: "two-patients.pdf", pageCount: 2 },
        groups: [good, bad].map(d => ({ groupKey: d.groupKey, patientName: d.patientName, allLineKeys: d.lines.map(l => l.sourceLineKey), lines: d.lines.map(l => ({ ...cmsLineInput(l), decision: { action: "create" as const } })) })),
      });
      expect(mixed.groups.map(g => g.lines[0].status)).toEqual(["saved", "review_required"]);
    });

    it("concurrent identical CMS1500 submissions create each line exactly once", async () => {
      const cms = cmsDoc("OTHERPERSON, SAM", [
        { dateOfService: "2026-03-12", cptCodes: "97110" }, { dateOfService: "2026-03-12", cptCodes: "97110" },
        { dateOfService: "2026-03-12", cptCodes: "97112" }, { dateOfService: "2026-03-12", cptCodes: "97530" },
      ]);
      const before = await counts(DB);
      const runs = await Promise.all(Array.from({ length: 6 }, () => commitCms(cms)));
      const statuses = runs.flatMap(r => r.groups[0].lines.map(l => l.status));
      expect(statuses.filter(s => s === "saved")).toHaveLength(4);
      expect(statuses.filter(s => s === "unchanged")).toHaveLength(20);
      const after = await counts(DB);
      expect(after.claims - before.claims).toBe(4);
      expect(after.audits - before.audits).toBe(4);
      expect(after.docs - before.docs).toBe(1);
    });

    it("an audit failure rolls back its line's write (CMS1500 create and EOB apply)", async () => {
      psql(DB, `
        CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.after_data ->> 'cpt_codes' = '97999' OR NEW.after_data ->> 'insurance_reimbursement' = '77.77' THEN
            RAISE EXCEPTION 'synthetic audit failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_audit();`);
      try {
        const cms = cmsDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-13", cptCodes: "97999" }, { dateOfService: "2026-03-13", cptCodes: "97110" }]);
        const before = await counts(DB);
        const r = await commitCms(cms);
        expect(r.groups[0].lines.map(l => l.status)).toEqual(["failed", "saved"]);
        const after = await counts(DB);
        expect(after.claims - before.claims).toBe(1);
        expect(after.audits - before.audits).toBe(1);
        expect((await q(DB, `SELECT count(*)::int AS n FROM claims_records WHERE cpt_codes = '97999'`))[0].n).toBe(0);

        const target = r.groups[0].lines[1].claimId!;
        const eob = eobDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-13", cptCodes: "97110", insuranceReimbursement: 77.77 }]);
        const e = await commitEob(eob, () => ({ action: "apply", claimRecordId: target }));
        expect(e.groups[0].lines[0].status).toBe("failed");
        const [row] = await q(DB, `SELECT insurance_reimbursement, eob_document_id FROM claims_records WHERE id = $1`, [target]);
        expect(row).toEqual({ insurance_reimbursement: null, eob_document_id: null });
      } finally {
        psql(DB, "DROP TRIGGER IF EXISTS test_fail_audit ON audit_logs; DROP FUNCTION IF EXISTS test_fail_audit();");
      }
    });

    it("Admin and Staff are denied on every import procedure, with no writes", async () => {
      const before = await counts(DB);
      const cms = cmsDoc("OTHERPERSON, SAM", [{ dateOfService: "2026-03-14", cptCodes: "97110" }]);
      const input = {
        kind: "cms1500" as const, document: { sha256: cms.sha256, fileName: "x.pdf", pageCount: 1 },
        groups: [{ groupKey: cms.groupKey, patientName: cms.patientName, allLineKeys: [cms.lines[0].sourceLineKey], lines: [{ ...cmsLineInput(cms.lines[0]), decision: { action: "create" as const } }] }],
      };
      for (const user of [clinic("admin"), clinic("staff")]) {
        await expect(caller(user).claims.importCommit(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(caller(user).claims.importPreview({ ...input, groups: [{ ...input.groups[0], lines: [cmsLineInput(cms.lines[0])] }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(caller(user).claims.upsert({})).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(caller(user).claims.bulkImportFromEOB({})).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(await counts(DB)).toEqual(before);
    });

    it("the retired EOB-first save paths refuse even the Super Admin", async () => {
      const before = await counts(DB);
      await expect(sa().claims.upsert({ patientId: PATIENT_B, authPeriod: 1, dateOfService: "2026-03-15", cptCodes: "97110", insuranceReimbursement: 50 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(sa().claims.bulkImportFromEOB({ uploadType: "reimbursement", patientGroups: [] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      await expect(sa().claims.cms1500EnrichmentCommit({ patientId: PATIENT_B, lines: [] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(await counts(DB)).toEqual(before);
    });

    it("PostgREST's anon role cannot reach the import RPCs or the document table directly", async () => {
      const rpc = await fetch(`http://127.0.0.1:${freshPort}/rpc/commit_cms1500_line_with_audit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p_patient_id: PATIENT_B, p_auth_period: 1, p_content_sha256: sha(), p_file_name: null, p_page_count: 1, p_line_key: "gx:p1r1", p_sibling_line_keys: [], p_target_claim_id: null, p_allow_new_distinct: true, p_data: { date_of_service: "2026-03-16", cpt_codes: "97110" }, p_actor_id: null, p_actor_type: null, p_actor_display: null, p_import_batch_id: null }),
      });
      expect([401, 403, 404]).toContain(rpc.status);
      const docs = await fetch(`http://127.0.0.1:${freshPort}/claim_import_documents`);
      expect([401, 403]).toContain(docs.status);
      expect((await q(DB, `SELECT count(*)::int AS n FROM claims_records WHERE date_of_service = '2026-03-16'`))[0].n).toBe(0);
    });
  });

  describe("upgraded database with historical reimbursement-first rows", () => {
    beforeAll(() => { restTarget = upgradePort; });
    const DB = "upgrade";
    const HIST_97110 = "44444444-4444-4444-8444-444444444441";
    const HIST_97112 = "44444444-4444-4444-8444-444444444442";

    it("historical rows stay readable and editable, with no provenance and money unchanged", async () => {
      const rows = await sa().claims.getByPatientAndPeriod({ patientId: PATIENT_A, authPeriod: 1 });
      const hist = rows.find((r: any) => r.id === HIST_97110);
      expect(hist).toMatchObject({ insurance_reimbursement: 80, patient_amount_due: 20, cms1500_document_id: null, eob_document_id: null });
      await sa().claims.update({ id: HIST_97112, referenceNo: "SYN-APPEAL-1" });
      const [r] = await q(DB, `SELECT reference_no, insurance_reimbursement FROM claims_records WHERE id = $1`, [HIST_97112]);
      expect(r).toEqual({ reference_no: "SYN-APPEAL-1", insurance_reimbursement: "0.00" });
      // Old manual-create path still works against the migrated schema.
      const created = await sa().claims.create({ patientId: PATIENT_B, authPeriod: 1, dateOfService: "2026-03-03", cptCodes: "97530" });
      expect(created.success).toBe(true);
    });

    it("an EOB for a historical row is blocked until its CMS1500 is associated", async () => {
      const eob = eobDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-02-20", cptCodes: "97110", insuranceReimbursement: 80, patientAmountDue: 20 }]);
      const preview = await previewEob(eob);
      expect(preview.groups[0].lines[0].status).toBe("cms1500_required");
      expect(preview.groups[0].lines[0].reason).toMatch(/associate it/);
    });

    it("a reviewed CMS1500 association stamps provenance without touching money or period; then EOB reconciliation is guarded", async () => {
      const cms = cmsDoc("TESTPATIENT, ALEX", [
        { dateOfService: "2026-02-20", cptCodes: "97110", diagnosisCodes: "M54.50, M25.551" },
        { dateOfService: "2026-02-20", cptCodes: "97112", diagnosisCodes: "M62.81" },
      ]);
      const preview = await previewCms(cms);
      expect(preview.groups[0].lines.map(l => [l.status, (l as { associableIds?: string[] }).associableIds])).toEqual([
        ["needs_selection", [HIST_97110]],
        ["needs_selection", [HIST_97112]],
      ]);
      const before = await q(DB, `SELECT id, auth_period, charge_amount, insurance_reimbursement, patient_amount_due, claim_status, oa_claim_number, check_date FROM claims_records WHERE id = ANY($1) ORDER BY id`, [[HIST_97110, HIST_97112]]);

      const assoc = await commitCms(cms, { decide: (_, i) => ({ action: "associate", claimRecordId: i === 0 ? HIST_97110 : HIST_97112 }) });
      expect(assoc.groups[0].lines.map(l => l.outcome)).toEqual(["associated", "associated"]);
      const after = await q(DB, `SELECT id, auth_period, charge_amount, insurance_reimbursement, patient_amount_due, claim_status, oa_claim_number, check_date FROM claims_records WHERE id = ANY($1) ORDER BY id`, [[HIST_97110, HIST_97112]]);
      expect(after).toEqual(before);
      const [d] = await q(DB, `SELECT diagnosis_codes, cms1500_document_id IS NOT NULL AS has_cms FROM claims_records WHERE id = $1`, [HIST_97110]);
      expect(d).toEqual({ diagnosis_codes: "M54.50, M25.551", has_cms: true });

      // Association can't be repeated onto a row that already has a CMS1500.
      const second = cmsDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-02-20", cptCodes: "97110" }]);
      const r = await commitCms(second, { decide: () => ({ action: "associate", claimRecordId: HIST_97110 }) });
      expect(r.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "already_has_cms1500" });

      // EOB with the same amounts reconciles; with different amounts it needs confirmation.
      const same = eobDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-02-20", cptCodes: "97110", chargeAmount: 175, insuranceReimbursement: 80, patientAmountDue: 20, oaClaimNumber: "HIST-1", checkDate: "2026-03-10" }]);
      expect((await previewEob(same)).groups[0].lines[0]).toMatchObject({ status: "matched", targetClaimId: HIST_97110 });
      expect((await commitEob(same, () => ({ action: "apply", claimRecordId: HIST_97110 }))).groups[0].lines[0].status).toBe("saved");

      const different = eobDoc("TESTPATIENT, ALEX", [{ dateOfService: "2026-02-20", cptCodes: "97112", insuranceReimbursement: 55 }]);
      expect((await previewEob(different)).groups[0].lines[0].status).toBe("needs_confirmation");
      const blocked = await commitEob(different, () => ({ action: "apply", claimRecordId: HIST_97112 }));
      expect(blocked.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "existing_financials" });
      expect((await q(DB, `SELECT insurance_reimbursement FROM claims_records WHERE id = $1`, [HIST_97112]))[0].insurance_reimbursement).toBe("0.00");
      const confirmed = await commitEob(different, () => ({ action: "apply", claimRecordId: HIST_97112, confirmReplace: true }));
      expect(confirmed.groups[0].lines[0].status).toBe("saved");
      expect((await q(DB, `SELECT insurance_reimbursement FROM claims_records WHERE id = $1`, [HIST_97112]))[0].insurance_reimbursement).toBe("55.00");
    });

    it("the migration did not rewrite any historical row", async () => {
      const rows = await q(DB, `SELECT count(*)::int AS n FROM claims_records WHERE id = ANY($1) AND source_line_index IS NOT DISTINCT FROM (CASE id WHEN $2 THEN NULL ELSE 0 END)`, [[HIST_97110, HIST_97112], HIST_97110]);
      expect(rows[0].n).toBe(2);
    });
  });
});
