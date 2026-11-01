/**
 * server/claimImportPatients.postgrest.integration.test.ts — P4-P28
 *
 * Automatic patient creation, external-id mappings and pending EOB lines, end
 * to end through the REAL app:
 *
 *   client request builders → appRouter.createCaller → server/claimCsvImport.ts
 *   / server/claimImport.ts / server/pendingEob.ts → server/db.ts →
 *   @supabase/supabase-js → local PostgREST → the P4-P28 RPCs in a disposable
 *   postgres:16.
 *
 * Same harness as server/claimCsvImport.postgrest.integration.test.ts (schema +
 * every migration, Supabase default grants emulated). Every record is
 * synthetic, and PDF-path documents are built in the shape upload-extract
 * returns. Excluded from CI by the `**\/*.integration.test.ts` glob; self-skips
 * without Docker.
 *
 *   npx vitest run server/claimImportPatients.postgrest.integration.test.ts
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
import {
  buildCommitInput,
  buildCsvCommitInputs,
  buildPreviewInput,
  initialDecision,
  type FileReviewState,
} from "../client/src/lib/claimImportReview";
import { exportCsv, exportRow } from "./fixtures/cms1500ExportSynthetic";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.5";
const RUN = randomUUID().slice(0, 8);
const NET = `p4p28-net-${RUN}`;
const PG = `p4p28-pg-${RUN}`;
const REST = `p4p28-rest-${RUN}`;
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
const clinic = (role: "admin" | "staff") => ({
  ...OWNER, id: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b1" : "c1"}`, openId: `clinic_${role}`, role: "user",
  clinicUser: { clinicUserId: `00000000-0000-4000-8000-0000000000${role === "admin" ? "b2" : "c2"}`, username: `${role}.synthetic`, name: `Synthetic ${role}`, email: null, department: null, role, mustChangePassword: false },
}) as unknown as AuthenticatedUser;

function caller(user: AuthenticatedUser | null) {
  const ctx: TrpcContext = { user, req: { protocol: "https", headers: {} } as any, res: {} as any };
  return appRouter.createCaller(ctx);
}

type Kind = "cms1500" | "eob";

/** The dialog's loop for a CSV: start from the preview's own decisions, then the test's choices. */
async function csvPreview(kind: Kind, csvText: string, state?: Partial<FileReviewState>, user: AuthenticatedUser = OWNER) {
  const patientChoices: Record<string, string> = {};
  for (const [k, v] of Object.entries(state?.patientChoice ?? {})) if (v) patientChoices[k] = v;
  const patientCreates: Record<string, any> = {};
  for (const [k, v] of Object.entries(state?.patientCreate ?? {})) if (v) patientCreates[k] = v;
  return caller(user).claims.csvImportPreview({ kind, fileName: `${kind}.csv`, csvText, patientChoices, patientCreates, lineEdits: (state?.edits ?? {}) as any });
}

function reviewStateFrom(p: Awaited<ReturnType<typeof csvPreview>>): FileReviewState {
  const state: FileReviewState = { doc: p.document! as any, patientChoice: {}, patientConfirmed: {}, patientCreate: {}, patientOutcomes: {}, decisions: {}, edits: {}, results: {} };
  for (const g of p.preview!.groups) {
    if (g.patient.patientId) state.patientChoice[g.groupKey] = g.patient.patientId;
    if (g.patient.identityStatus === "new" && g.patient.creatingName) state.patientCreate![g.groupKey] = { name: g.patient.creatingName };
    for (const line of g.lines) state.decisions[line.sourceLineKey] = initialDecision({ kind: p.document!.kind, line: line as any, mode: "bulk", contextAuthPeriod: null });
  }
  return state;
}

/** Period chosen on every CMS1500 line that asks for one, as the "Set every line" button does. */
function choosePeriod(p: Awaited<ReturnType<typeof csvPreview>>, state: FileReviewState, period = 1) {
  for (const g of p.preview!.groups) {
    for (const line of g.lines) {
      if (line.status === "period_required") state.decisions[line.sourceLineKey] = { action: "create", authPeriod: period, periodSource: "selected" };
    }
  }
}

async function csvSave(kind: Kind, csvText: string, state: FileReviewState, user: AuthenticatedUser = OWNER) {
  const batches = buildCsvCommitInputs({ source: { kind, fileName: `${kind}.csv`, csvText }, state });
  const groups = [];
  for (const b of batches) {
    const r = await caller(user).claims.csvImportCommit(b);
    for (const g of r.groups) for (const l of g.lines) state.results[l.sourceLineKey] = l;
    groups.push(...r.groups);
  }
  return { groups, lines: groups.flatMap(g => g.lines) };
}

async function importNewPatientCsv(csv: string) {
  const p = await csvPreview("cms1500", csv);
  const state = reviewStateFrom(p);
  choosePeriod(p, state);
  return { p, state, ...(await csvSave("cms1500", csv, state)) };
}

const EOB_HEADER = "reimbursement_id,reimbursement_line_id,patient_name,date_of_service,cpt_code,billed_charge,insurance_paid,patient_responsibility,claim_status,payment_date,check_or_eft_number";
const eobCsv = (patient: string, rows: Array<{ id?: string; line: string; dos?: string; cpt?: string; paid?: string }>) => [
  EOB_HEADER,
  ...rows.map(r => [r.id ?? "ERA-1", r.line, `"${patient}"`, r.dos ?? "2026-02-02", r.cpt ?? "97112", "175.00", r.paid ?? "80.00", "20.00", "approved", "2026-03-01", "000123"].join(",")),
].join("\n") + "\n";

const counts = async () => (await q(`
  SELECT (SELECT count(*) FROM patients)::int AS patients,
         (SELECT count(*) FROM claims_records)::int AS claims,
         (SELECT count(*) FROM patient_external_ids)::int AS mappings,
         (SELECT count(*) FROM pending_eob_lines)::int AS pending,
         (SELECT count(*) FROM audit_logs)::int AS audits`))[0] as { patients: number; claims: number; mappings: number; pending: number; audits: number };

const describeDb = HAS_DOCKER ? describe : describe.skip;

describeDb("Patient creation and pending EOB through the real app + PostgREST + Postgres", () => {
  let workDir = "";

  beforeAll(async () => {
    sh("docker", ["network", "create", NET]);
    sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    pgPort = Number(sh("docker", ["port", PG, "5432"]).trim().split("\n")[0].split(":").pop());
    await waitFor(() => { sh("docker", ["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }, "postgres");
    psql("CREATE DATABASE fresh", "postgres");
    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p28-"));
    const roles = path.join(workDir, "roles.sql");
    writeFileSync(roles, SUPABASE_DEFAULTS);
    psqlFile(roles);
    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const m of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) psqlFile(path.join(MIGRATIONS_DIR, m));

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
    await q("DROP TRIGGER IF EXISTS p28_fail_audit ON audit_logs");
    await q("TRUNCATE pending_eob_lines, patient_external_ids, claims_records, claim_import_documents, audit_logs, visit_records, patients CASCADE");
  });

  // ── Invoice export → new patient ────────────────────────────────────────

  describe("invoice export for a patient not on the dashboard", () => {
    const CSV = exportCsv(exportRow({ invoice: "SYN1-C01", total: "350.0", balance: "350.0" }));

    it("preview marks a new patient, asks for a period, and writes nothing", async () => {
      const before = await counts();
      const p = await csvPreview("cms1500", CSV);
      expect(p.preview!.groups[0].patient).toMatchObject({ identityStatus: "new", creatingName: "Alex Testpatient", patientId: null });
      expect(p.preview!.groups[0].periodOptions).toEqual([1]);
      expect(p.preview!.groups[0].lines.map(l => l.status)).toEqual(["period_required", "period_required", "period_required"]);
      expect(await counts()).toEqual(before);
    });

    it("no period chosen: nothing is ready, and no patient appears", async () => {
      const p = await csvPreview("cms1500", CSV);
      const state = reviewStateFrom(p);
      const { lines } = await csvSave("cms1500", CSV, state);
      expect(lines).toEqual([]);
      expect((await counts()).patients).toBe(0);
    });

    it("save creates the patient with the name only, its lines without money, the mapping and the audit trail", async () => {
      const { lines, groups } = await importNewPatientCsv(CSV);
      expect(lines.map(l => l.status)).toEqual(["saved", "saved", "saved"]);
      expect(groups[0].patientOutcome).toBe("created");

      const [patient] = await q("SELECT * FROM patients");
      expect(patient).toMatchObject({ name: "Alex Testpatient", insurance: "", auth_date: null, auth_valid_until: null, claims_status: null, created_by: OWNER_ID, created_by_type: "owner" });

      const claims = await q("SELECT * FROM claims_records ORDER BY cpt_codes");
      expect(claims.map(c => [c.cpt_codes, c.units_billed, c.auth_period, c.patient_id === patient.id])).toEqual([
        ["97112", 1, 1, true], ["97530", 1, 1, true], ["97530", 1, 1, true],
      ]);
      expect(claims.every(c => c.date_of_service.toISOString?.().startsWith("2026-02") ?? String(c.date_of_service).includes("2026"))).toBe(true);
      for (const money of ["charge_amount", "insurance_reimbursement", "payment_received", "patient_amount_due", "patient_amount_paid"]) {
        expect(claims.every(c => c[money] === null), money).toBe(true);
      }

      const maps = await q("SELECT source_system, external_id, to_char(birth_date, 'YYYY-MM-DD') AS birth_date FROM patient_external_ids ORDER BY source_system");
      expect(maps.map(m => m.source_system)).toEqual(["billing_invoice_export", "claims_import_group"]);
      expect(maps[0]).toMatchObject({ external_id: "S1001-1", birth_date: "1950-03-14" });

      const audit = (await q("SELECT action, import_batch_id FROM audit_logs ORDER BY created_at")).map(a => a.action);
      expect(audit.filter(a => a === "PATIENT_CREATE_FROM_IMPORT")).toHaveLength(1);
      expect(audit.filter(a => a === "PATIENT_EXTERNAL_ID_LINK")).toHaveLength(1);
      expect(audit.filter(a => a === "CLAIM_RECORD_CMS1500_CREATE")).toHaveLength(3);
      expect(new Set((await q("SELECT import_batch_id FROM audit_logs")).map(a => a.import_batch_id)).size).toBe(1);
    });

    it("re-import and reordered files change nothing and duplicate nothing", async () => {
      const two = exportCsv(exportRow({ invoice: "SYN1-C01" }), exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" }));
      await importNewPatientCsv(two);
      const before = await counts();
      expect(before).toMatchObject({ patients: 1, claims: 6 });

      const reordered = exportCsv(exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" }), exportRow({ invoice: "SYN1-C01" }));
      const p = await csvPreview("cms1500", reordered);
      expect(p.preview!.groups.every(g => g.patient.identityStatus === "existing")).toBe(true);
      expect(p.preview!.groups.flatMap(g => g.lines).every(l => l.status === "already_saved")).toBe(true);
      const { lines } = await csvSave("cms1500", reordered, reviewStateFrom(p));
      expect(new Set(lines.map(l => l.status))).toEqual(new Set(["unchanged"]));
      expect(await counts()).toEqual(before);
    });

    it("the same external patient across several invoices and files is one patient", async () => {
      const file1 = exportCsv(exportRow({ invoice: "SYN1-C01" }), exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" }));
      const { groups } = await importNewPatientCsv(file1);
      expect(groups.map(g => g.patientOutcome)).toEqual(["created", "existing"]);
      const file2 = exportCsv(exportRow({ invoice: "SYN3-C01", serviceDate: "2026-02-09", patient: "TESTPATIENT, ALEX" }));
      const p2 = await csvPreview("cms1500", file2);
      expect(p2.preview!.groups[0].patient).toMatchObject({ identityStatus: "existing", requiresConfirmation: false });
      const state = reviewStateFrom(p2);
      choosePeriod(p2, state);
      await csvSave("cms1500", file2, state);
      expect(await counts()).toMatchObject({ patients: 1, claims: 9 });
      // The file's name variant never overwrote the record.
      expect((await q("SELECT name FROM patients"))[0].name).toBe("Alex Testpatient");
    });

    it("concurrent saves of one new patient create one patient and no duplicate lines", async () => {
      const p = await csvPreview("cms1500", CSV);
      const state = reviewStateFrom(p);
      choosePeriod(p, state);
      const [batch] = buildCsvCommitInputs({ source: { kind: "cms1500", fileName: "cms1500.csv", csvText: CSV }, state });
      const results = await Promise.all(Array.from({ length: 6 }, () => caller(OWNER).claims.csvImportCommit(batch)));
      expect(await counts()).toMatchObject({ patients: 1, claims: 3, mappings: 2 });
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'PATIENT_CREATE_FROM_IMPORT'"))[0].n).toBe(1);
      for (const r of results) for (const l of r.groups[0].lines) expect(["saved", "unchanged"]).toContain(l.status);
      expect(results.filter(r => r.groups[0].patientOutcome === "created")).toHaveLength(1);
    });

    it("concurrent saves of different files for one guid converge on one patient", async () => {
      const a = exportCsv(exportRow({ invoice: "SYN1-C01" }));
      const b = exportCsv(exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" }));
      const make = async (csv: string) => {
        const p = await csvPreview("cms1500", csv);
        const s = reviewStateFrom(p);
        choosePeriod(p, s);
        return buildCsvCommitInputs({ source: { kind: "cms1500", fileName: "x.csv", csvText: csv }, state: s })[0];
      };
      const [ba, bb] = await Promise.all([make(a), make(b)]);
      await Promise.all([caller(OWNER).claims.csvImportCommit(ba), caller(OWNER).claims.csvImportCommit(bb)]);
      expect(await counts()).toMatchObject({ patients: 1, claims: 6 });
    });
  });

  // ── Existing patients and ambiguity ─────────────────────────────────────

  describe("existing patients", () => {
    const CSV = exportCsv(exportRow({ invoice: "SYN1-C01" }));

    it("first link needs confirmation; once confirmed, later imports match by id alone", async () => {
      const [{ id }] = await q("INSERT INTO patients (name, insurance) VALUES ('TESTPATIENT, ALEX', 'Synthetic Health') RETURNING id");
      await q("INSERT INTO visit_records (patient_id, auth_period, date_of_service) VALUES ($1, 2, '2026-02-02')", [id]);

      const p = await csvPreview("cms1500", CSV);
      const g = p.preview!.groups[0];
      expect(g.patient).toMatchObject({ identityStatus: "needs_confirmation", patientId: null, canCreate: true });

      // Without the confirmation nothing is written.
      const s0 = reviewStateFrom(p);
      s0.patientChoice[g.groupKey] = id;
      const p1 = await csvPreview("cms1500", CSV, s0);
      const s1 = reviewStateFrom(p1);
      s1.patientChoice[g.groupKey] = id;
      s1.patientConfirmed[g.groupKey] = false;
      const refused = await csvSave("cms1500", CSV, s1);
      expect(new Set(refused.lines.map(l => l.status))).toEqual(new Set(["review_required"]));
      expect(await counts()).toMatchObject({ patients: 1, claims: 0, mappings: 0 });

      s1.patientConfirmed[g.groupKey] = true;
      const saved = await csvSave("cms1500", CSV, s1);
      expect(new Set(saved.lines.map(l => l.status))).toEqual(new Set(["saved"]));
      expect(saved.groups[0].patientOutcome).toBe("existing");
      expect(await counts()).toMatchObject({ patients: 1, claims: 3, mappings: 1 });
      // Demographics untouched, period from the patient's own visit.
      expect((await q("SELECT name, insurance FROM patients"))[0]).toEqual({ name: "TESTPATIENT, ALEX", insurance: "Synthetic Health" });
      expect(new Set((await q("SELECT auth_period FROM claims_records")).map(c => c.auth_period))).toEqual(new Set([2]));

      const later = await csvPreview("cms1500", exportCsv(exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-02" })));
      expect(later.preview!.groups[0].patient).toMatchObject({ identityStatus: "existing", patientId: id, requiresConfirmation: false });
    });

    it("duplicate names are never resolved alone: a choice or an explicit new patient", async () => {
      const [a] = await q("INSERT INTO patients (name) VALUES ('TESTPATIENT, ALEX') RETURNING id");
      const [b] = await q("INSERT INTO patients (name) VALUES ('ALEX TESTPATIENT') RETURNING id");
      const p = await csvPreview("cms1500", CSV);
      const g = p.preview!.groups[0];
      expect(g.patient).toMatchObject({ identityStatus: "needs_confirmation", patientId: null });
      expect(g.patient.allowedIds.sort()).toEqual([a.id, b.id].sort());

      // An explicit "someone else": a third record, with the mapping, once only.
      const s = reviewStateFrom(p);
      s.patientCreate![g.groupKey] = { name: "Alex Testpatient", distinctConfirmed: true };
      const p2 = await csvPreview("cms1500", CSV, s);
      expect(p2.preview!.groups[0].patient.identityStatus).toBe("new");
      s.doc = p2.document as any;
      choosePeriod(p2, s);
      const first = await csvSave("cms1500", CSV, s);
      expect(first.groups[0].patientOutcome).toBe("created");
      expect(await counts()).toMatchObject({ patients: 3, claims: 3 });
      s.results = {};
      const retry = await csvSave("cms1500", CSV, s);
      expect(retry.groups[0].patientOutcome).toBe("existing");
      expect(await counts()).toMatchObject({ patients: 3, claims: 3 });
    });

    it("a stale 'new patient' review is refused when that name now exists", async () => {
      const p = await csvPreview("cms1500", exportCsv(exportRow({ invoice: "SYN1-C01", guid: "", birthDate: "" })));
      const s = reviewStateFrom(p);
      choosePeriod(p, s);
      await q("INSERT INTO patients (name) VALUES ('TESTPATIENT, ALEX')");
      // The roster is re-read at save, so this becomes an existing patient, not a duplicate.
      const csv = exportCsv(exportRow({ invoice: "SYN1-C01", guid: "", birthDate: "" }));
      const { groups } = await csvSave("cms1500", csv, s);
      expect(groups[0].patientOutcome).toBe("existing");
      expect((await counts()).patients).toBe(1);
    });

    it("conflicting ids and birth dates wait for a person", async () => {
      await importNewPatientCsv(CSV);
      const otherId = await csvPreview("cms1500", exportCsv(exportRow({ invoice: "SYN2-C01", guid: "S9999-9" })));
      expect(otherId.preview!.groups[0].patient.identityStatus).toBe("needs_confirmation");
      expect(otherId.preview!.groups[0].patient.identityReasons!.join(" ")).toMatch(/different patient ID/);
      const otherDob = await csvPreview("cms1500", exportCsv(exportRow({ invoice: "SYN3-C01", birthDate: "1961-01-01" })));
      expect(otherDob.preview!.groups[0].patient.identityStatus).toBe("needs_confirmation");
      expect(otherDob.preview!.groups[0].patient.identityReasons!.join(" ")).toMatch(/birth date/);
      const inFile = await csvPreview("cms1500", exportCsv(exportRow({ invoice: "A" }), exportRow({ invoice: "B", guid: "S9999-9" })));
      expect(inFile.preview!.groups.every(g => g.patient.identityStatus === "needs_confirmation")).toBe(true);
    });

    it("an unreadable patient name cannot be saved until someone supplies one", async () => {
      const csv = exportCsv(exportRow({ invoice: "SYN1-C01", patient: "", guid: "" }));
      const p = await csvPreview("cms1500", csv);
      const g = p.preview!.groups[0];
      expect(g.patient).toMatchObject({ status: "unreadable", identityStatus: "needs_confirmation" });
      expect(g.lines.every(l => l.status === "patient_required")).toBe(true);
      expect((await counts()).patients).toBe(0);
      const s = reviewStateFrom(p);
      s.patientCreate![g.groupKey] = { name: "Typed Name", distinctConfirmed: true };
      const p2 = await csvPreview("cms1500", csv, s);
      expect(p2.preview!.groups[0].patient.creatingName).toBe("Typed Name");
    });
  });

  // ── Failure and recovery ────────────────────────────────────────────────

  describe("failures", () => {
    const CSV = exportCsv(exportRow({ invoice: "SYN1-C01" }), exportRow({ invoice: "SYN2-C01", serviceDate: "2026-02-04" }));
    const failAudit = async (action: string, when = "true") => {
      await q(`CREATE OR REPLACE FUNCTION p28_fail_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = '${action}' AND ${when} THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
      await q("CREATE TRIGGER p28_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION p28_fail_audit_fn()");
    };

    it("an audit failure rolls back the patient, its mapping and every line; a retry then succeeds", async () => {
      await failAudit("CLAIM_RECORD_CMS1500_CREATE");
      const p = await csvPreview("cms1500", CSV);
      const s = reviewStateFrom(p);
      choosePeriod(p, s);
      const failed = await csvSave("cms1500", CSV, s);
      expect(new Set(failed.lines.map(l => l.status))).toEqual(new Set(["failed"]));
      expect(failed.groups.every(g => g.patientOutcome == null)).toBe(true);
      expect(await counts()).toMatchObject({ patients: 0, claims: 0, mappings: 0, audits: 0 });

      await q("DROP TRIGGER p28_fail_audit ON audit_logs");
      s.results = {};
      const ok = await csvSave("cms1500", CSV, s);
      expect(new Set(ok.lines.map(l => l.status))).toEqual(new Set(["saved"]));
      expect(await counts()).toMatchObject({ patients: 1, claims: 6 });
    });

    it("the patient audit row failing also rolls everything back", async () => {
      await failAudit("PATIENT_CREATE_FROM_IMPORT");
      const p = await csvPreview("cms1500", CSV);
      const s = reviewStateFrom(p);
      choosePeriod(p, s);
      await csvSave("cms1500", CSV, s);
      expect(await counts()).toMatchObject({ patients: 0, claims: 0, mappings: 0 });
    });

    it("a partial-file failure keeps what saved, and a retry sends only what did not", async () => {
      const p = await csvPreview("cms1500", CSV);
      const s = reviewStateFrom(p);
      choosePeriod(p, s);
      // The first invoice creates the patient; the second invoice's lines fail on their audit row.
      await failAudit("CLAIM_RECORD_CMS1500_CREATE", "(NEW.after_data ->> 'date_of_service') = '2026-02-04'");
      const first = await csvSave("cms1500", CSV, s);
      expect(first.lines.filter(l => l.status === "saved")).toHaveLength(3);
      expect(first.lines.filter(l => l.status === "failed")).toHaveLength(3);
      expect(await counts()).toMatchObject({ patients: 1, claims: 3 });

      await q("DROP TRIGGER p28_fail_audit ON audit_logs");
      const batches = buildCsvCommitInputs({ source: { kind: "cms1500", fileName: "cms1500.csv", csvText: CSV }, state: s });
      expect(batches.flatMap(b => (b as any).groups.flatMap((g: any) => g.lines))).toHaveLength(3);
      const retry = await csvSave("cms1500", CSV, s);
      expect(new Set(retry.lines.map(l => l.status))).toEqual(new Set(["saved"]));
      expect(await counts()).toMatchObject({ patients: 1, claims: 6 });
    });

    it("a group with only skipped lines leaves no orphan patient", async () => {
      const p = await csvPreview("cms1500", CSV);
      const s = reviewStateFrom(p);
      for (const key of Object.keys(s.decisions)) s.decisions[key] = { action: "skip" };
      const { lines } = await csvSave("cms1500", CSV, s);
      expect(new Set(lines.map(l => l.status))).toEqual(new Set(["skipped"]));
      expect((await counts()).patients).toBe(0);
    });
  });

  // ── Pending EOB ─────────────────────────────────────────────────────────

  describe("EOB before its CMS1500", () => {
    const CMS = exportCsv(exportRow({ invoice: "SYN1-C01", guid: "", birthDate: "" }));
    const EOB = eobCsv("TESTPATIENT, ALEX", [{ line: "1" }]);

    async function saveEobForNewPatient() {
      const p = await csvPreview("eob", EOB);
      expect(p.preview!.groups[0].patient).toMatchObject({ identityStatus: "new", creatingName: "TESTPATIENT, ALEX" });
      expect(p.preview!.groups[0].lines[0].status).toBe("cms1500_required");
      const s = reviewStateFrom(p);
      expect(Object.values(s.decisions)).toEqual([{ action: "hold" }]);
      return { p, s, ...(await csvSave("eob", EOB, s)) };
    }

    it("creates the patient and keeps the line pending; no claim row exists and nothing is paid", async () => {
      const { lines, groups } = await saveEobForNewPatient();
      expect(lines[0]).toMatchObject({ status: "held", message: "Upload the matching CMS1500 first." });
      expect(groups[0].patientOutcome).toBe("created");
      expect(await counts()).toMatchObject({ patients: 1, claims: 0, pending: 1 });
      const [row] = await q("SELECT status, cpt_codes, data FROM pending_eob_lines");
      expect(row).toMatchObject({ status: "pending", cpt_codes: "97112" });
      expect(Number(row.data.insurance_reimbursement)).toBe(80);
      expect((await q("SELECT action FROM audit_logs")).map(a => a.action).sort()).toEqual(["EOB_LINE_PENDING_CREATE", "PATIENT_CREATE_FROM_IMPORT"]);
    });

    it("retrying the reviewed EOB adds nothing", async () => {
      await saveEobForNewPatient();
      const before = await counts();
      const p = await csvPreview("eob", EOB);
      expect(p.preview!.groups[0].patient.identityStatus).toBe("existing");
      expect(p.preview!.groups[0].lines[0]).toMatchObject({ status: "cms1500_required", held: true });
      const { lines } = await csvSave("eob", EOB, reviewStateFrom(p));
      expect(lines[0].status).toBe("held");
      expect(await counts()).toEqual(before);
    });

    it("stays visible and unappliable until the CMS1500 exists", async () => {
      await saveEobForNewPatient();
      const { items } = await caller(OWNER).claims.pendingEobList();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ patientName: "TESTPATIENT, ALEX", cptCodes: "97112", insuranceReimbursement: 80 });
      expect(items[0].classification.status).toBe("cms1500_required");
      expect(items[0].classification.reason).toBe("Upload the matching CMS1500 first.");
      // A forged apply on a claim row of another patient is refused.
      const [{ id: other }] = await q("INSERT INTO patients (name) VALUES ('OTHERPERSON, SAM') RETURNING id");
      const [{ id: claim }] = await q("INSERT INTO claims_records (patient_id, auth_period, date_of_service, cpt_codes) VALUES ($1, 1, '2026-02-02', '97112') RETURNING id", [other]);
      const r = await caller(OWNER).claims.pendingEobApply({ items: [{ pendingId: items[0].id, claimRecordId: claim }] });
      expect(r.results[0].status).toBe("review_required");
      expect((await q("SELECT insurance_reimbursement FROM claims_records"))[0].insurance_reimbursement).toBeNull();
    });

    it("CMS1500 → pending EOB reconciles once, with no double payment", async () => {
      await saveEobForNewPatient();
      const pCms = await csvPreview("cms1500", CMS);
      expect(pCms.preview!.groups[0].patient.identityStatus).toBe("existing");
      const sCms = reviewStateFrom(pCms);
      choosePeriod(pCms, sCms);
      await csvSave("cms1500", CMS, sCms);
      expect(await counts()).toMatchObject({ patients: 1, claims: 3 });
      // CMS1500 still carries no money.
      expect((await q("SELECT count(*)::int AS n FROM claims_records WHERE insurance_reimbursement IS NOT NULL"))[0].n).toBe(0);

      const { items } = await caller(OWNER).claims.pendingEobList();
      expect(items[0].classification.status).toBe("matched");
      const target = items[0].classification.targetClaimId!;
      const apply = { items: [{ pendingId: items[0].id, claimRecordId: target }] };

      // Double click: two at once, then a stale third.
      const twice = await Promise.all([caller(OWNER).claims.pendingEobApply(apply), caller(OWNER).claims.pendingEobApply(apply)]);
      const third = await caller(OWNER).claims.pendingEobApply(apply);
      for (const r of [...twice, third]) expect(["saved", "unchanged"]).toContain(r.results[0].status);

      const paid = await q("SELECT id, insurance_reimbursement, payment_received, patient_amount_due, patient_amount_paid, eob_document_id FROM claims_records WHERE insurance_reimbursement IS NOT NULL");
      expect(paid).toHaveLength(1);
      expect(paid[0].id).toBe(target);
      expect(Number(paid[0].insurance_reimbursement)).toBe(80);
      expect(Number(paid[0].patient_amount_due)).toBe(20);
      expect(paid[0].patient_amount_paid).toBeNull();
      expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'CLAIM_RECORD_EOB_APPLY'"))[0].n).toBe(1);
      expect((await q("SELECT status, applied_claim_id FROM pending_eob_lines"))[0]).toEqual({ status: "applied", applied_claim_id: target });
      expect((await caller(OWNER).claims.pendingEobList()).items).toEqual([]);
    });

    it("uploading the EOB again after its CMS1500 applies through the normal path and closes the pending line", async () => {
      await saveEobForNewPatient();
      const pCms = await csvPreview("cms1500", CMS);
      const sCms = reviewStateFrom(pCms);
      choosePeriod(pCms, sCms);
      await csvSave("cms1500", CMS, sCms);

      const p = await csvPreview("eob", EOB);
      expect(p.preview!.groups[0].lines[0].status).toBe("matched");
      const { lines } = await csvSave("eob", EOB, reviewStateFrom(p));
      expect(lines[0].status).toBe("saved");
      expect((await q("SELECT status FROM pending_eob_lines"))[0].status).toBe("applied");
      expect((await caller(OWNER).claims.pendingEobList()).items).toEqual([]);
      const again = await csvPreview("eob", EOB);
      expect(again.preview!.groups[0].lines[0].status).toBe("already_saved");
      expect((await q("SELECT count(*)::int AS n FROM claims_records WHERE insurance_reimbursement IS NOT NULL"))[0].n).toBe(1);
    });

    it("an existing patient's unmatched EOB line is also kept pending, while its matched lines apply", async () => {
      const pCms = await csvPreview("cms1500", CMS);
      const sCms = reviewStateFrom(pCms);
      choosePeriod(pCms, sCms);
      await csvSave("cms1500", CMS, sCms);
      const eob = eobCsv("TESTPATIENT, ALEX", [{ line: "1", cpt: "97112" }, { line: "2", cpt: "97110" }]);
      const p = await csvPreview("eob", eob);
      expect(p.preview!.groups[0].lines.map(l => l.status)).toEqual(["matched", "cms1500_required"]);
      const { lines } = await csvSave("eob", eob, reviewStateFrom(p));
      expect(lines.map(l => l.status).sort()).toEqual(["held", "saved"]);
      expect(await counts()).toMatchObject({ claims: 3, pending: 1 });
    });

    it("a stale hold is refused once the CMS1500 exists, so nothing waits for no reason", async () => {
      const { s } = await (async () => {
        const p = await csvPreview("eob", EOB);
        return { s: reviewStateFrom(p) };
      })();
      await importCmsThenConfirm();
      const { lines } = await csvSave("eob", EOB, s);
      expect(lines[0]).toMatchObject({ status: "review_required", reason: "cms1500_available" });
      expect((await counts()).pending).toBe(0);

      async function importCmsThenConfirm() {
        const pCms = await csvPreview("cms1500", CMS);
        const sCms = reviewStateFrom(pCms);
        choosePeriod(pCms, sCms);
        await csvSave("cms1500", CMS, sCms);
      }
    });

    describe("a dismissed line stays dismissed", () => {
      const dismissOnly = async () => {
        await saveEobForNewPatient();
        const { items } = await caller(OWNER).claims.pendingEobList();
        await caller(OWNER).claims.pendingEobDismiss({ pendingId: items[0].id });
        return items[0].id;
      };
      const saveCms = async () => {
        const pCms = await csvPreview("cms1500", CMS);
        const sCms = reviewStateFrom(pCms);
        choosePeriod(pCms, sCms);
        await csvSave("cms1500", CMS, sCms);
      };
      const paidRows = async () => (await q("SELECT count(*)::int AS n FROM claims_records WHERE insurance_reimbursement IS NOT NULL OR eob_document_id IS NOT NULL"))[0].n;
      const pendingStatus = async () => (await q("SELECT status FROM pending_eob_lines"))[0].status;

      it("closes with an audit row and leaves the pending list", async () => {
        await dismissOnly();
        expect((await caller(OWNER).claims.pendingEobList()).items).toEqual([]);
        expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'EOB_LINE_PENDING_DISMISS'"))[0].n).toBe(1);
      });

      it("reimporting before the CMS1500 exists: starts with no decision, and the default save reopens nothing", async () => {
        await dismissOnly();
        const p = await csvPreview("eob", EOB);
        const line = p.preview!.groups[0].lines[0] as any;
        expect(line.dismissed).toBe(true);
        expect(line.reason).toMatch(/dismissed/i);
        const state = reviewStateFrom(p);
        expect(state.decisions[line.sourceLineKey]).toBeNull();
        expect((await csvSave("eob", EOB, state)).lines).toEqual([]);
        expect(await pendingStatus()).toBe("dismissed");
        expect((await caller(OWNER).claims.pendingEobList()).items).toEqual([]);
      });

      it("reimporting after the CMS1500 exists: matched, but no payment by default", async () => {
        await dismissOnly();
        await saveCms();
        const p = await csvPreview("eob", EOB);
        const line = p.preview!.groups[0].lines[0] as any;
        expect(line.status).toBe("matched");
        expect(line.dismissed).toBe(true);
        const state = reviewStateFrom(p);
        expect(state.decisions[line.sourceLineKey]).toBeNull();
        expect((await csvSave("eob", EOB, state)).lines).toEqual([]);
        expect(await paidRows()).toBe(0);
        expect(await pendingStatus()).toBe("dismissed");
      });

      it("a hand-built apply or hold without the reopen flag is refused by the server", async () => {
        await dismissOnly();
        const held = reviewStateFrom(await csvPreview("eob", EOB));
        const key = Object.keys(held.decisions)[0];
        held.decisions[key] = { action: "hold" };
        expect((await csvSave("eob", EOB, held)).lines[0]).toMatchObject({ status: "review_required", reason: "line_dismissed" });
        await saveCms();
        const p = await csvPreview("eob", EOB);
        const state = reviewStateFrom(p);
        state.decisions[key] = { action: "apply", claimRecordId: (p.preview!.groups[0].lines[0] as any).targetClaimId };
        expect((await csvSave("eob", EOB, state)).lines[0]).toMatchObject({ status: "review_required", reason: "line_dismissed" });
        expect(await paidRows()).toBe(0);
      });

      it("the database refuses too: apply and hold RPCs called directly cannot land a dismissed line", async () => {
        await dismissOnly();
        await saveCms();
        const [row] = await q("SELECT p.patient_id, p.line_key, d.content_sha256 FROM pending_eob_lines p JOIN claim_import_documents d ON d.id = p.document_id");
        const [{ id: claim }] = await q("SELECT id FROM claims_records WHERE cpt_codes = '97112'");
        await expect(q(
          "SELECT public.apply_eob_line_with_audit($1, $2, 'x.csv', NULL, $3, $4, jsonb_build_object('date_of_service','2026-02-02','cpt_codes','97112'), true, '{\"insurance_reimbursement\": 80}'::jsonb, NULL, 'owner', 'x', NULL)",
          [row.patient_id, row.content_sha256, row.line_key, claim],
        )).rejects.toMatchObject({ code: "P0033" });
        await expect(q(
          "SELECT public.hold_eob_line_with_audit($1, $2, 'x.csv', NULL, $3, jsonb_build_object('date_of_service','2026-02-02','cpt_codes','97112'), '{}'::jsonb, NULL, NULL, 'owner', 'x', NULL)",
          [row.patient_id, row.content_sha256, row.line_key],
        )).rejects.toMatchObject({ code: "P0033" });
        expect(await paidRows()).toBe(0);
        expect(await pendingStatus()).toBe("dismissed");
      });

      it("the same line under a new document identity (a re-issued file) is still caught by its content", async () => {
        await dismissOnly();
        await saveCms();
        const reissued = eobCsv("TESTPATIENT, ALEX", [{ id: "ERA-REISSUED", line: "1", cpt: "97112" }]);
        const p = await csvPreview("eob", reissued);
        const line = p.preview!.groups[0].lines[0] as any;
        expect(line.dismissed).toBe(true);
        const state = reviewStateFrom(p);
        expect(state.decisions[line.sourceLineKey]).toBeNull();
        state.decisions[line.sourceLineKey] = { action: "apply", claimRecordId: line.targetClaimId };
        expect((await csvSave("eob", reissued, state)).lines[0]).toMatchObject({ status: "review_required", reason: "line_dismissed" });
        expect(await paidRows()).toBe(0);
        // Different amounts are a different line, so a corrected remittance is not swallowed.
        const corrected = eobCsv("TESTPATIENT, ALEX", [{ id: "ERA-CORRECTED", line: "1", cpt: "97112", paid: "95.00" }]);
        expect(((await csvPreview("eob", corrected)).preview!.groups[0].lines[0] as any).dismissed).toBeUndefined();
      });

      it("only an explicit reopen brings it back, with its own audit row", async () => {
        await dismissOnly();
        await saveCms();
        const p = await csvPreview("eob", EOB);
        const line = p.preview!.groups[0].lines[0] as any;
        const state = reviewStateFrom(p);
        state.decisions[line.sourceLineKey] = { action: "apply", claimRecordId: line.targetClaimId, reopenDismissed: true };
        expect((await csvSave("eob", EOB, state)).lines[0].status).toBe("saved");
        expect(await paidRows()).toBe(1);
        expect(await pendingStatus()).toBe("applied");
        expect((await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'EOB_LINE_PENDING_REOPEN'"))[0].n).toBe(1);
      });

      it("an explicit reopen with no CMS1500 yet waits on the pending list again", async () => {
        await dismissOnly();
        const p = await csvPreview("eob", EOB);
        const state = reviewStateFrom(p);
        state.decisions[p.preview!.groups[0].lines[0].sourceLineKey] = { action: "hold", reopenDismissed: true };
        expect((await csvSave("eob", EOB, state)).lines[0].status).toBe("held");
        expect(await pendingStatus()).toBe("pending");
        expect((await caller(OWNER).claims.pendingEobList()).items).toHaveLength(1);
      });

      it("a stale apply from the pending list is refused after dismissal", async () => {
        const id = await dismissOnly();
        await saveCms();
        const [{ id: claim }] = await q("SELECT id FROM claims_records WHERE cpt_codes = '97112'");
        const r = await caller(OWNER).claims.pendingEobApply({ items: [{ pendingId: id, claimRecordId: claim }] });
        expect(r.results[0].status).toBe("review_required");
        expect(await paidRows()).toBe(0);
      });
    });

    it("deleting the claim row a pending line was applied to lets the EOB wait again", async () => {
      await saveEobForNewPatient();
      const pCms = await csvPreview("cms1500", CMS);
      const sCms = reviewStateFrom(pCms);
      choosePeriod(pCms, sCms);
      await csvSave("cms1500", CMS, sCms);
      const { items } = await caller(OWNER).claims.pendingEobList();
      const target = items[0].classification.targetClaimId!;
      await caller(OWNER).claims.pendingEobApply({ items: [{ pendingId: items[0].id, claimRecordId: target }] });
      await q("DELETE FROM claims_records");
      expect((await q("SELECT status, applied_claim_id FROM pending_eob_lines"))[0]).toEqual({ status: "applied", applied_claim_id: null });
      const p = await csvPreview("eob", EOB);
      const { lines } = await csvSave("eob", EOB, reviewStateFrom(p));
      expect(lines[0].status).toBe("held");
      expect((await q("SELECT status FROM pending_eob_lines"))[0].status).toBe("pending");
    });

    it("Staff cannot read EOB amounts, billing ids or the source file through history or the activity log", async () => {
      const { groups } = await saveEobForNewPatient();
      await q("INSERT INTO patient_external_ids (patient_id, source_system, external_id) VALUES ($1, 'billing_invoice_export', 'S1')", [groups[0].patientId]);
      await q("INSERT INTO audit_logs (entity_type, entity_id, patient_id, actor_id, actor_type, action, after_data) VALUES ('patient', $1, $1, $2, 'owner', 'PATIENT_EXTERNAL_ID_LINK', '{\"external_id\":\"S1\"}')", [groups[0].patientId, OWNER_ID]);
      const staffView = await caller(clinic("staff")).patients.history({ id: groups[0].patientId! });
      expect(staffView.map(r => r.action)).toEqual(["PATIENT_CREATE_FROM_IMPORT"]);
      expect(staffView[0].afterData).toEqual({ name: "TESTPATIENT, ALEX" });
      const ownerView = await caller(OWNER).patients.history({ id: groups[0].patientId! });
      expect(ownerView.map(r => r.action)).toContain("PATIENT_EXTERNAL_ID_LINK");
      expect((await caller(OWNER).activityLog.list({ entityType: "pending_eob_line" })).total).toBe(1);
      const { listActivityLog } = await import("./db");
      const excluded = await listActivityLog({ page: 0, pageSize: 50, excludeClaims: true });
      expect(excluded.rows.map(r => r.action)).toEqual(["PATIENT_CREATE_FROM_IMPORT"]);
    });

    it("a held line whose audit row fails is not kept, and the new patient is not created", async () => {
      await q(`CREATE OR REPLACE FUNCTION p28_fail_audit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'EOB_LINE_PENDING_CREATE' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END; $$`);
      await q("CREATE TRIGGER p28_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION p28_fail_audit_fn()");
      const p = await csvPreview("eob", EOB);
      const { lines } = await csvSave("eob", EOB, reviewStateFrom(p));
      expect(lines[0].status).toBe("failed");
      expect(await counts()).toMatchObject({ patients: 0, pending: 0, audits: 0 });
    });
  });

  // ── PDF-path documents ──────────────────────────────────────────────────

  describe("documents returned by upload-extract", () => {
    const SHA = "a".repeat(64);
    const doc = (patientName: string, account: string | null): any => ({
      kind: "cms1500", sha256: SHA, fileName: "form.pdf", pageCount: 1, extractionMethod: "CMS1500 form fields (1/1 pages)", warnings: [],
      groups: [{
        groupKey: "gabc123def456", patientName, pages: [1], claimIdentifier: account, warnings: [], unresolvedClaimTotals: [],
        patientIdentity: { sourceSystem: "cms1500_box26", externalId: account, strength: "account", birthDate: "1950-03-14" },
        lines: [{ sourceLineKey: "gabc123def456:p1r1", page: 1, slot: 1, dateOfService: "2026-02-02", placeOfService: "12", cptCodes: "97110", modifier: "GP", unitsBilled: 1, diagnosisPointer: "A", diagnosisCodes: "M54.50", claimSubmittedDate: "2026-03-01", insuranceBilled: null, lineChargeForValidation: 175, unreadable: [], notes: null }],
      }],
    });

    async function savePdf(document: any, user: AuthenticatedUser = OWNER) {
      const state: FileReviewState = { doc: document, patientChoice: {}, patientConfirmed: {}, patientCreate: {}, decisions: {}, edits: {}, results: {} };
      const p = await caller(user).claims.importPreview(buildPreviewInput({ state, contextPatientId: null }) as any);
      for (const g of p.groups) {
        if (g.patient.patientId) state.patientChoice[g.groupKey] = g.patient.patientId;
        if (g.patient.identityStatus === "new" && g.patient.creatingName) state.patientCreate![g.groupKey] = { name: g.patient.creatingName };
        for (const line of g.lines) {
          state.decisions[line.sourceLineKey] = line.status === "period_required"
            ? { action: "create", authPeriod: 1, periodSource: "selected" }
            : initialDecision({ kind: "cms1500", line: line as any, mode: "bulk", contextAuthPeriod: null });
        }
      }
      const input = buildCommitInput({ state, contextPatientId: null, contextAuthPeriod: null });
      return { p, r: await caller(user).claims.importCommit(input as any) };
    }

    it("creates a missing patient atomically, and the same bytes again change nothing", async () => {
      const { r } = await savePdf(doc("TESTPATIENT, ALEX", "99"));
      expect(r.groups[0].patientOutcome).toBe("created");
      expect(await counts()).toMatchObject({ patients: 1, claims: 1, mappings: 2 });
      const { p, r: again } = await savePdf(doc("TESTPATIENT, ALEX", "99"));
      expect(p.groups[0].patient.identityStatus).toBe("existing");
      expect(again.groups[0].lines[0].status).toBe("unchanged");
      expect(await counts()).toMatchObject({ patients: 1, claims: 1 });
    });

    it("the same Box 26 number on a different person is not that patient", async () => {
      await savePdf(doc("TESTPATIENT, ALEX", "99"));
      const second = doc("OTHERPERSON, SAM", "99");
      second.sha256 = "b".repeat(64);
      const { p, r } = await savePdf(second);
      expect(p.groups[0].patient).toMatchObject({ identityStatus: "new", creatingName: "OTHERPERSON, SAM" });
      expect(r.groups[0].patientOutcome).toBe("created");
      expect(await counts()).toMatchObject({ patients: 2, claims: 2 });
    });

    it("a client cannot pass off a stable-id identity on this path", async () => {
      const forged = doc("TESTPATIENT, ALEX", "99");
      const input = buildPreviewInput({ state: { doc: forged, patientChoice: {}, edits: {} }, contextPatientId: null }) as any;
      input.groups[0].patientIdentity = { sourceSystem: "billing_invoice_export", externalId: "S1", strength: "patient", birthDate: null };
      await expect(caller(OWNER).claims.importPreview(input)).rejects.toThrow();
    });

    it("single-patient uploads never create anyone", async () => {
      const [{ id }] = await q("INSERT INTO patients (name) VALUES ('TESTPATIENT, ALEX') RETURNING id");
      const state: FileReviewState = { doc: doc("OTHERPERSON, SAM", null), patientChoice: {}, patientConfirmed: {}, patientCreate: {}, decisions: {}, edits: {}, results: {} };
      const p = await caller(OWNER).claims.importPreview(buildPreviewInput({ state, contextPatientId: id }) as any);
      expect(p.groups[0].patient.status).toBe("other_patient");
      const input: any = buildPreviewInput({ state, contextPatientId: id });
      const commit = await caller(OWNER).claims.importCommit({
        ...input, contextAuthPeriod: 1,
        groups: input.groups.map((g: any) => ({ ...g, createPatient: { name: "OTHERPERSON, SAM" }, allLineKeys: g.lines.map((l: any) => l.sourceLineKey), lines: g.lines.map((l: any) => ({ ...l, decision: { action: "create", authPeriod: 1, periodSource: "context" } })) })),
      });
      expect(commit.groups[0].lines[0].status).toBe("review_required");
      expect(await counts()).toMatchObject({ patients: 1, claims: 0 });
    });
  });

  // ── Access ──────────────────────────────────────────────────────────────

  describe("access", () => {
    const CSV = exportCsv(exportRow({ invoice: "SYN1-C01" }));
    const uuid = "11111111-1111-4111-8111-111111111111";

    it("Clinic Admin may import and create; Owner already covered above", async () => {
      const admin = clinic("admin");
      const p = await csvPreview("cms1500", CSV, undefined, admin);
      const s = reviewStateFrom(p);
      choosePeriod(p, s);
      const { groups } = await csvSave("cms1500", CSV, s, admin);
      expect(groups[0].patientOutcome).toBe("created");
      expect((await q("SELECT created_by_type FROM patients"))[0].created_by_type).toBe("clinic_user");
      expect((await caller(admin).claims.pendingEobList()).items).toEqual([]);
    });

    for (const [label, user, code] of [["Staff", clinic("staff"), "FORBIDDEN"], ["anonymous", null, "UNAUTHORIZED"]] as const) {
      it(`${label} is denied every import procedure and nothing is written`, async () => {
        const c = caller(user as AuthenticatedUser | null);
        const calls: Array<() => Promise<unknown>> = [
          () => c.claims.csvImportPreview({ kind: "cms1500", fileName: "x.csv", csvText: CSV, patientChoices: {} }),
          () => c.claims.csvImportCommit({ kind: "cms1500", fileName: "x.csv", csvText: CSV, groups: [{ groupKey: "g1", createPatient: { name: "X" }, lines: [{ sourceLineKey: "g1:a", decision: { action: "create" } }] }] } as any),
          () => c.claims.importPreview({ kind: "cms1500", document: { sha256: "a".repeat(64), fileName: "a", pageCount: 1 }, groups: [{ groupKey: "g1", patientName: "X", lines: [] }] } as any),
          () => c.claims.importCommit({ kind: "cms1500", document: { sha256: "a".repeat(64), fileName: "a", pageCount: 1 }, groups: [{ groupKey: "g1", patientName: "X", createPatient: { name: "X" }, allLineKeys: [], lines: [] }] } as any),
          () => c.claims.pendingEobList(),
          () => c.claims.pendingEobApply({ items: [{ pendingId: uuid, claimRecordId: uuid }] }),
          () => c.claims.pendingEobDismiss({ pendingId: uuid }),
          () => c.claims.periodsForPatient({ patientId: uuid }),
        ];
        for (const call of calls) await expect(call()).rejects.toMatchObject({ code });
        expect(await counts()).toMatchObject({ patients: 0, claims: 0 });
      });
    }

    it("the new tables are closed to anon and authenticated", async () => {
      for (const table of ["patient_external_ids", "pending_eob_lines"]) {
        for (const role of ["anon", "authenticated"]) {
          const [{ ok }] = await q("SELECT has_table_privilege($1, $2, 'SELECT') AS ok", [role, `public.${table}`]);
          expect(ok, `${role} on ${table}`).toBe(false);
        }
      }
      const [{ ok }] = await q("SELECT has_function_privilege('anon', 'public.commit_import_with_new_patient(text, text, text, text, date, text, boolean, text, text, integer, text[], jsonb, uuid, text, text, uuid)', 'EXECUTE') AS ok");
      expect(ok).toBe(false);
      const [{ reopen }] = await q("SELECT has_function_privilege('authenticated', 'public.reopen_dismissed_eob_line_with_audit(uuid, uuid, text, text, uuid)', 'EXECUTE') AS reopen");
      expect(reopen).toBe(false);
    });
  });

  // ── Invoice export: does a re-imported line really correspond to the saved one? ──

  describe("line correspondence on re-import", () => {
    const description = (...blocks: Array<[string, string]>) =>
      ["Synthetic Plan", ...blocks.flatMap(([cpt, dx]) => [`1x ${cpt} - Service ($175.00)`, dx]), "Coinsurance: $350.00"].join("\n");
    const A: [string, string] = ["97530", "M54.50"];
    const B: [string, string] = ["97530", "R29.6"];
    const csv = (o: { blocks: Array<[string, string]>; serviceDate?: string; patient?: string; guid?: string }) =>
      exportCsv(exportRow({ invoice: "SYN-LINES", description: description(...o.blocks), serviceDate: o.serviceDate, patient: o.patient, guid: o.guid }));
    const rows = async () => q("SELECT id, cms1500_line_key, cpt_codes, diagnosis_codes, to_char(date_of_service, 'YYYY-MM-DD') AS dos FROM claims_records ORDER BY id");
    const firstImport = async (file: string) => {
      await importNewPatientCsv(file);
      return rows();
    };
    const reapplies = async () => (await q("SELECT count(*)::int AS n FROM audit_logs WHERE action = 'CLAIM_RECORD_CMS1500_REAPPLY'"))[0].n;

    it("reordered blocks with different diagnoses keep each block on its own row", async () => {
      const before = await firstImport(csv({ blocks: [A, B] }));
      const file = csv({ blocks: [B, A] });
      const p = await csvPreview("cms1500", file);
      expect(p.preview!.groups[0].lines.map(l => l.status)).toEqual(["already_saved", "already_saved"]);
      const { lines } = await csvSave("cms1500", file, reviewStateFrom(p));
      expect(lines.map(l => l.status)).toEqual(["unchanged", "unchanged"]);
      expect(await rows()).toEqual(before);
      expect(await reapplies()).toBe(0);
    });

    it("a subset of different blocks maps to the right row and changes nothing", async () => {
      const before = await firstImport(csv({ blocks: [A, B] }));
      const file = csv({ blocks: [B] });
      const p = await csvPreview("cms1500", file);
      const { lines } = await csvSave("cms1500", file, reviewStateFrom(p));
      expect(lines.map(l => l.status)).toEqual(["unchanged"]);
      expect(await rows()).toEqual(before);
      expect(await reapplies()).toBe(0);
    });

    it("a changed block cannot silently overwrite or sit beside the saved one: a reviewer chooses", async () => {
      const before = await firstImport(csv({ blocks: [A, B] }));
      const file = csv({ blocks: [A, ["97530", "M62.81"]] });
      const p = await csvPreview("cms1500", file);
      const changed = p.preview!.groups[0].lines[1] as any;
      expect(changed.status).toBe("needs_selection");
      const state = reviewStateFrom(p);
      expect(state.decisions[changed.sourceLineKey]).toBeNull();
      await csvSave("cms1500", file, state);
      expect(await rows()).toEqual(before);
    });

    it("a subset of identical repeats says which row it means by nothing, so it is reviewed", async () => {
      const same: [string, string] = ["97530", "M54.50"];
      const before = await firstImport(csv({ blocks: [same, same] }));
      const file = csv({ blocks: [same] });
      const p = await csvPreview("cms1500", file);
      const line = p.preview!.groups[0].lines[0] as any;
      expect(line.status).toBe("identity_review");
      expect(line.reason).toMatch(/2 identical/);
      const state = reviewStateFrom(p);
      expect(state.decisions[line.sourceLineKey]).toBeNull();
      state.decisions[line.sourceLineKey] = { action: "create" };
      expect((await csvSave("cms1500", file, state)).lines[0]).toMatchObject({ status: "review_required", reason: "line_identity_review" });
      expect(await rows()).toEqual(before);
    });

    it("identical repeats on different dates: a subset cannot move one onto the other's date", async () => {
      const same: [string, string] = ["97530", "M54.50"];
      const multi = csv({ blocks: [same, same], serviceDate: '"2026-02-02, 2026-02-04"' });
      const p1 = await csvPreview("cms1500", multi);
      const s1 = reviewStateFrom(p1);
      const keys = p1.preview!.groups[0].lines.map(l => l.sourceLineKey);
      s1.edits[keys[0]] = { dateOfService: "2026-02-02" };
      s1.edits[keys[1]] = { dateOfService: "2026-02-04" };
      for (const k of keys) s1.decisions[k] = { action: "create", authPeriod: 1, periodSource: "selected" };
      expect((await csvSave("cms1500", multi, s1)).lines.map(l => l.status)).toEqual(["saved", "saved"]);
      const before = await rows();

      const later = csv({ blocks: [same], serviceDate: "2026-02-04" });
      const p = await csvPreview("cms1500", later);
      const line = p.preview!.groups[0].lines[0] as any;
      expect(line.status).toBe("identity_review");
      const state = reviewStateFrom(p);
      expect(state.decisions[line.sourceLineKey]).toBeNull();
      state.decisions[line.sourceLineKey] = { action: "create_distinct", authPeriod: 1, periodSource: "selected" };
      expect((await csvSave("cms1500", later, state)).lines[0]).toMatchObject({ status: "review_required", reason: "line_identity_review" });
      expect(await rows()).toEqual(before);
      expect(await reapplies()).toBe(0);
    });

    it("a changed service date on a saved line is reviewed, never moved", async () => {
      const before = await firstImport(csv({ blocks: [A] }));
      const file = csv({ blocks: [A], serviceDate: "2026-02-09" });
      const p = await csvPreview("cms1500", file);
      const line = p.preview!.groups[0].lines[0] as any;
      expect(line.status).toBe("identity_review");
      expect(line.reason).toMatch(/2026-02-02/);
      await csvSave("cms1500", file, reviewStateFrom(p));
      expect(await rows()).toEqual(before);
    });

    it("a saved line whose diagnosis was changed by hand is not overwritten by the file", async () => {
      await firstImport(csv({ blocks: [A] }));
      await q("UPDATE claims_records SET diagnosis_codes = 'Z99.9'");
      const before = await rows();
      const file = csv({ blocks: [A] });
      const p = await csvPreview("cms1500", file);
      expect((p.preview!.groups[0].lines[0] as any).status).toBe("identity_review");
      await csvSave("cms1500", file, reviewStateFrom(p));
      expect(await rows()).toEqual(before);
    });

    it("an invoice re-exported under a different patient is reviewed, and creates nobody", async () => {
      const before = await firstImport(csv({ blocks: [A] }));
      const file = csv({ blocks: [["97530", "M62.81"]], patient: "Sam Otherperson", guid: "S2002-1" });
      const p = await csvPreview("cms1500", file);
      const line = p.preview!.groups[0].lines[0] as any;
      expect(line.status).toBe("identity_review");
      const state = reviewStateFrom(p);
      state.decisions[line.sourceLineKey] = { action: "create", authPeriod: 1, periodSource: "selected" };
      expect((await csvSave("cms1500", file, state)).lines[0].status).toBe("review_required");
      expect(await rows()).toEqual(before);
      expect((await counts()).patients).toBe(1);
    });
  });

  // ── Birth date as identity evidence ─────────────────────────────────────

  describe("birth date evidence", () => {
    const invoice = (id: string, birthDate: string, guid = "") => exportCsv(exportRow({ invoice: id, guid, birthDate, patient: "Alex Testpatient" }));
    const patient = async () => (await q("INSERT INTO patients (name) VALUES ('TESTPATIENT, ALEX') RETURNING id"))[0].id as string;
    /** As the dialog does: choosing a patient re-previews, and the lines get their decisions from that. */
    const save = async (file: string, confirm = false) => {
      let p = await csvPreview("cms1500", file);
      const patientChoice: Record<string, string> = {};
      const patientConfirmed: Record<string, boolean> = {};
      if (confirm) {
        for (const g of p.preview!.groups) {
          patientChoice[g.groupKey] = g.patient.allowedIds[0];
          patientConfirmed[g.groupKey] = true;
        }
        p = await csvPreview("cms1500", file, { patientChoice });
      }
      const state = reviewStateFrom(p);
      Object.assign(state.patientChoice, patientChoice);
      Object.assign(state.patientConfirmed, patientConfirmed);
      choosePeriod(p, state);
      return { p, ...(await csvSave("cms1500", file, state)) };
    };

    it("a name-only match with a first birth date is confirmed once, recorded, then checked for good", async () => {
      const id = await patient();
      const first = await csvPreview("cms1500", invoice("D1", "1950-03-14"));
      expect(first.preview!.groups[0].patient.identityStatus).toBe("needs_confirmation");
      expect(first.preview!.groups[0].patient.identityReasons!.join(" ")).toMatch(/no birth date on record/);

      await save(invoice("D1", "1950-03-14"), true);
      const rows = await q("SELECT source_system, to_char(birth_date, 'YYYY-MM-DD') AS birth_date FROM patient_external_ids WHERE patient_id = $1", [id]);
      expect(rows).toEqual([{ source_system: "import_birth_evidence", birth_date: "1950-03-14" }]);
      // patients itself still has no birth date.
      expect(Object.keys((await q("SELECT * FROM patients"))[0]).some(k => /birth|dob/i.test(k))).toBe(false);

      const same = await csvPreview("cms1500", invoice("D2", "1950-03-14"));
      expect(same.preview!.groups[0].patient).toMatchObject({ identityStatus: "existing", patientId: id });

      const other = await csvPreview("cms1500", invoice("D3", "1961-07-01"));
      expect(other.preview!.groups[0].patient.identityStatus).toBe("needs_confirmation");
      expect(other.preview!.groups[0].patient.identityReasons!.join(" ")).toMatch(/differs/);
    });

    it("a mapping saved without a birth date gets its baseline from the next file that has one", async () => {
      const id = await patient();
      await q("INSERT INTO patient_external_ids (patient_id, source_system, external_id, birth_date) VALUES ($1, 'billing_invoice_export', 'G1', NULL)", [id]);
      const { lines } = await save(invoice("D4", "1950-03-14", "G1"));
      expect(lines.every(l => l.status === "saved")).toBe(true);
      const other = await csvPreview("cms1500", invoice("D5", "1961-07-01", "G1"));
      expect(other.preview!.groups[0].patient.identityStatus).toBe("needs_confirmation");
    });

    it("a confirmed save with a different birth date does not rewrite the baseline", async () => {
      const id = await patient();
      await save(invoice("D6", "1950-03-14"), true);
      await save(invoice("D7", "1961-07-01"), true);
      const dates = await q("SELECT to_char(birth_date, 'YYYY-MM-DD') AS d FROM patient_external_ids WHERE patient_id = $1", [id]);
      expect(dates).toEqual([{ d: "1950-03-14" }]);
      expect((await csvPreview("cms1500", invoice("D8", "1961-07-01"))).preview!.groups[0].patient.identityStatus).toBe("needs_confirmation");
    });

    it("a file with no birth date neither asks nor records anything", async () => {
      await patient();
      const file = exportCsv(exportRow({ invoice: "D9", guid: "", birthDate: "" }));
      const p = await csvPreview("cms1500", file);
      expect(p.preview!.groups[0].patient.identityStatus).toBe("existing");
      await save(file);
      expect((await counts()).mappings).toBe(0);
    });
  });
});
