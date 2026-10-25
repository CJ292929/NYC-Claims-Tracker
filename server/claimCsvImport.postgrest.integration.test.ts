/**
 * server/claimCsvImport.postgrest.integration.test.ts — P4-P26
 *
 * Both downloadable claims CSV templates, end to end through the REAL app:
 *
 *   buildClaimCsvTemplate (the exact bytes the Download button saves)
 *   → client request builders (initialDecision / buildCsvCommitInputs)
 *   → appRouter.createCaller (claims.csvImportPreview / csvImportCommit)
 *   → server/claimCsvImport.ts → server/claimImport.ts → server/db.ts
 *   → @supabase/supabase-js → local PostgREST → commit_cms1500_line_with_audit
 *     / apply_eob_line_with_audit in a disposable postgres:16.
 *
 * Same harness as server/claimImport.postgrest.integration.test.ts (schema
 * + every migration, Supabase default grants emulated). Every record is
 * synthetic. Excluded from CI by the `**\/*.integration.test.ts` glob;
 * self-skips without Docker.
 *
 *   npx vitest run server/claimCsvImport.postgrest.integration.test.ts
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
import { buildClaimCsvTemplate } from "@shared/claimCsvTemplates";
import { buildCsvCommitInputs, initialDecision, type FileReviewState, type LineDecision } from "../client/src/lib/claimImportReview";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const POSTGREST_IMAGE = "public.ecr.aws/supabase/postgrest:v14.5";
const RUN = randomUUID().slice(0, 8);
const NET = `p4p26-net-${RUN}`;
const PG = `p4p26-pg-${RUN}`;
const REST = `p4p26-rest-${RUN}`;
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

// ─── App wiring ────────────────────────────────────────────────────────────

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
const owner = () => caller(OWNER);

const PATIENT_A = "11111111-1111-4111-8111-111111111111"; // TESTPATIENT, ALEX — periods 1 and 2
const PATIENT_B = "22222222-2222-4222-8222-222222222222"; // OTHERPERSON, SAM — period 1
const SEED = `
  INSERT INTO patients (id, name, insurance) VALUES
    ('${PATIENT_A}', 'TESTPATIENT, ALEX', 'Synthetic Health'),
    ('${PATIENT_B}', 'OTHERPERSON, SAM', 'Synthetic Health');
  INSERT INTO visit_records (patient_id, auth_period, date_of_service) VALUES
    ('${PATIENT_A}', 1, '2026-01-05'), ('${PATIENT_A}', 1, '2026-02-20'),
    ('${PATIENT_A}', 2, '2026-03-02'), ('${PATIENT_A}', 2, '2026-03-30'),
    ('${PATIENT_B}', 1, '2026-03-01'), ('${PATIENT_B}', 1, '2026-03-31');
`;

const counts = async () => (await q(`
  SELECT (SELECT count(*) FROM claims_records)::int AS claims,
         (SELECT count(*) FROM audit_logs)::int AS audits,
         (SELECT count(*) FROM claim_import_documents)::int AS docs`))[0] as { claims: number; audits: number; docs: number };

// ─── CSV files and the client's review loop ──────────────────────────────

/** The downloaded template, made usable: EXAMPLE ids → a run-unique prefix, sample patient → a seeded one. */
function fromTemplate(kind: "cms1500" | "eob", prefix: string, patient = "TESTPATIENT, ALEX") {
  return buildClaimCsvTemplate(kind).replace(/EXAMPLE-/g, `${prefix}-`).replace(/SAMPLE, PATIENT/g, patient);
}

type Kind = "cms1500" | "eob";

async function preview(kind: Kind, csvText: string, user: AuthenticatedUser | null = OWNER, patientChoices: Record<string, string> = {}) {
  return caller(user).claims.csvImportPreview({ kind, fileName: `${kind}.csv`, csvText, patientChoices });
}

/** What the dialog does: start from the preview's own decisions, let `decide` override, confirm patients. */
async function reviewAndSave(kind: Kind, csvText: string, opts: {
  decide?: (line: any, i: number) => LineDecision | null | undefined;
  confirmPatients?: boolean;
  state?: FileReviewState;
  user?: AuthenticatedUser;
} = {}) {
  const p = await preview(kind, csvText, opts.user ?? OWNER);
  expect(p.templateError).toBeNull();
  const state: FileReviewState = opts.state ?? { doc: p.document! as any, patientChoice: {}, patientConfirmed: {}, decisions: {}, edits: {}, results: {} };
  let i = 0;
  for (const g of p.preview!.groups) {
    if (g.patient.patientId) state.patientChoice[g.groupKey] = g.patient.patientId;
    if (opts.confirmPatients) state.patientConfirmed[g.groupKey] = true;
    for (const line of g.lines) {
      const auto = initialDecision({ kind, line: line as any, mode: "bulk", contextAuthPeriod: null });
      const override = opts.decide?.(line, i++);
      state.decisions[line.sourceLineKey] = override === undefined ? auto : override;
    }
  }
  const batches = buildCsvCommitInputs({ source: { kind, fileName: `${kind}.csv`, csvText }, state });
  const results = [];
  for (const b of batches) {
    const r = await caller(opts.user ?? OWNER).claims.csvImportCommit(b);
    for (const g of r.groups) for (const l of g.lines) state.results[l.sourceLineKey] = l;
    results.push(r);
  }
  return { preview: p, state, results, lines: results.flatMap(r => r.groups.flatMap(g => g.lines)) };
}

const describeDb = HAS_DOCKER ? describe : describe.skip;

describeDb("Claims CSV templates through the real app + PostgREST + Postgres", () => {
  let workDir = "";

  beforeAll(async () => {
    sh("docker", ["network", "create", NET]);
    sh("docker", ["run", "-d", "--rm", "--name", PG, "--network", NET, "-e", "POSTGRES_PASSWORD=postgres", "-p", "127.0.0.1::5432", "postgres:16"]);
    pgPort = Number(sh("docker", ["port", PG, "5432"]).trim().split("\n")[0].split(":").pop());
    await waitFor(() => { sh("docker", ["exec", PG, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]); return true; }, "postgres");
    psql("CREATE DATABASE fresh", "postgres");
    workDir = mkdtempSync(path.join(os.tmpdir(), "p4p26-"));
    const roles = path.join(workDir, "roles.sql");
    writeFileSync(roles, SUPABASE_DEFAULTS);
    psqlFile(roles);
    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const m of readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()) psqlFile(path.join(MIGRATIONS_DIR, m));
    psql(SEED);

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

  // ── Main flow: the two downloaded templates, CMS1500 first ──────────────

  const CMS = fromTemplate("cms1500", "T1");
  const EOB = fromTemplate("eob", "T1");
  const cmsRows = () => q(`SELECT *, claim_submitted_date::text AS claim_submitted_date FROM claims_records WHERE cms1500_document_id IS NOT NULL AND patient_id = $1 AND date_of_service = '2026-01-05' ORDER BY cms1500_line_key`, [PATIENT_A]);

  it("reimbursement first is refused: preview says upload the CMS1500 first, and commit writes nothing even with a guessed target", async () => {
    const before = await counts();
    const p = await preview("eob", EOB);
    expect(p.preview!.groups[0].patient).toMatchObject({ status: "matched", patientId: PATIENT_A });
    expect(p.preview!.groups[0].lines.map(l => l.status)).toEqual(["cms1500_required", "cms1500_required", "cms1500_required"]);
    expect((p.preview!.groups[0].lines[0] as any).reason).toMatch(/^Upload the matching CMS1500 first\. CMS1500 line T1-CMS-1001 \/ line 1/);

    // A manual claim row exists on the same date + CPT; a client that names it as the target is still refused.
    const { claimId } = await owner().claims.create({ patientId: PATIENT_A, authPeriod: 1, dateOfService: "2026-01-05", cptCodes: "97110" });
    const mid = await counts();
    const g = p.preview!.groups[0];
    const r = await owner().claims.csvImportCommit({
      kind: "eob", fileName: "eob.csv", csvText: EOB,
      groups: [{ groupKey: g.groupKey, lines: g.lines.map(l => ({ sourceLineKey: l.sourceLineKey, decision: { action: "apply" as const, claimRecordId: claimId } })) }],
    });
    expect(r.groups[0].lines.map(l => [l.status, l.reason])).toEqual(Array(3).fill(["review_required", "cms1500_required"]));
    expect(await counts()).toEqual(mid);
    await owner().claims.delete({ id: claimId, patientId: PATIENT_A });
    expect((await counts()).claims).toBe(before.claims);
  });

  it("CMS1500 template → preview → save: one row per line, repeated CPT lines kept, every amount unknown", async () => {
    const before = await counts();
    const { preview: p, lines } = await reviewAndSave("cms1500", CMS);
    expect(p.rowErrors).toEqual([]);
    expect(p.preview!.groups[0].lines.map(l => l.status)).toEqual(["ready_new", "ready_new", "ready_new"]);
    expect(lines.map(l => [l.status, l.outcome, l.authPeriod])).toEqual(Array(3).fill(["saved", "created", 1]));

    const rows = await cmsRows();
    expect(rows).toHaveLength(3);
    expect(rows.map(r => [r.cpt_codes, r.modifier, r.units_billed, r.place_of_service, r.diagnosis_codes, r.visit_number])).toEqual([
      ["97110", "GP", 2, "11", "M54.50, M25.561", null],
      ["97110", "GP", 2, "11", "M54.50, M25.561", null],
      ["97140", "GP, 59", 1, "02", "M54.50", 4],
    ]);
    for (const r of rows) {
      expect([r.charge_amount, r.insurance_reimbursement, r.patient_amount_due, r.patient_amount_paid, r.payment_received]).toEqual([null, null, null, null, null]);
      expect(r.claim_submitted_date).toBe("2026-01-10");
      expect(r.claim_status).toBe("submitted");
    }
    expect(new Set(rows.map(r => r.cms1500_document_id)).size).toBe(1);
    const after = await counts();
    expect([after.claims - before.claims, after.audits - before.audits, after.docs - before.docs]).toEqual([3, 3, 1]);

    // Reload through the app.
    const reloaded = await owner().claims.getByPatientAndPeriod({ patientId: PATIENT_A, authPeriod: 1 });
    expect(reloaded.filter((c: any) => c.dateOfService === "2026-01-05" || c.date_of_service === "2026-01-05")).toHaveLength(3);
  });

  it("re-importing the same CMS1500 file — or an edited, re-sorted copy — never duplicates", async () => {
    const before = await counts();
    const again = await reviewAndSave("cms1500", CMS);
    expect(again.preview.preview!.groups[0].lines.map(l => l.status)).toEqual(["already_saved", "already_saved", "already_saved"]);
    expect(again.lines.map(l => l.status)).toEqual(["unchanged", "unchanged", "unchanged"]);
    expect(await counts()).toEqual(before);

    // Rows re-sorted, one cell corrected: same lines, one audited update, no new rows.
    const lines = CMS.trim().split("\r\n");
    const h = lines.findIndex(l => !l.startsWith("#"));
    const data = lines.slice(h + 1);
    const edited = [...lines.slice(0, h + 1), data[2].replace('"1","', '"2","'), data[1], data[0]].join("\r\n");
    const r = await reviewAndSave("cms1500", edited);
    expect(r.lines.map(l => l.status).sort()).toEqual(["saved", "unchanged", "unchanged"]);
    expect(r.lines.find(l => l.status === "saved")!.outcome).toBe("updated");
    const after = await counts();
    expect([after.claims, after.audits - before.audits, after.docs]).toEqual([before.claims, 1, before.docs]);
    expect((await cmsRows()).find(r => r.cpt_codes === "97140")!.units_billed).toBe(2);
  });

  it("matching reimbursement: each row lands on exactly its referenced CMS1500 line; blank stays unknown, 0 is zero", async () => {
    const p = await preview("eob", EOB);
    const g = p.preview!.groups[0];
    expect(g.lines.map(l => l.status)).toEqual(["matched", "matched", "needs_selection"]);
    // Row 3: the CMS1500 line's units were corrected to 2 above, the EOB says 1 — the reviewer confirms.
    const rows = await cmsRows();
    const byLine = (n: number) => rows.find(r => r.cms1500_line_key.endsWith(`:csv.${n}`))!.id;
    expect(g.lines.slice(0, 2).map(l => (l as any).targetClaimId)).toEqual([byLine(1), byLine(2)]);

    const before = await counts();
    const saved = await reviewAndSave("eob", EOB, { decide: (l, i) => (i === 2 ? { action: "apply", claimRecordId: byLine(3) } : undefined) });
    expect(saved.lines.map(l => l.status)).toEqual(["saved", "saved", "saved"]);
    const after = await counts();
    expect([after.claims - before.claims, after.audits - before.audits, after.docs - before.docs]).toEqual([0, 3, 1]);

    const money = await q(`SELECT cms1500_line_key, charge_amount, insurance_reimbursement, payment_received, patient_amount_due, patient_amount_paid, claim_status, check_date::text AS check_date, oa_claim_number, check_number_virtual_card FROM claims_records WHERE id = ANY($1) ORDER BY cms1500_line_key`, [[byLine(1), byLine(2), byLine(3)]]);
    expect(money.map(r => [r.charge_amount, r.insurance_reimbursement, r.payment_received, r.patient_amount_due, r.patient_amount_paid, r.claim_status])).toEqual([
      ["150.00", "80.00", "80.00", "20.00", null, "approved"], // patient_paid blank → unknown, responsibility not copied
      ["150.00", "80.00", "80.00", "20.00", "0.00", "approved"], // patient_paid 0 → zero
      ["95.00", "0.00", "0.00", null, null, "denied"], // insurance_paid 0, responsibility blank
    ]);
    expect(money.every(r => r.check_date === "2026-02-01" && r.oa_claim_number === "SYN-PAYER-0001" && r.check_number_virtual_card === "000123")).toBe(true);
  });

  it("re-importing the reimbursement file, and concurrent saves of it, never repeat a payment", async () => {
    const before = await counts();
    const runs = await Promise.all(Array.from({ length: 4 }, () => reviewAndSave("eob", EOB, { decide: l => (l.status === "needs_selection" ? { action: "apply", claimRecordId: l.candidates[0].id } : undefined) })));
    for (const r of runs) expect(r.preview.preview!.groups[0].lines.map(l => l.status)).toEqual(["already_saved", "already_saved", "already_saved"]);
    expect(runs.flatMap(r => r.lines.map(l => l.status)).every(s => s === "unchanged")).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it("a second remittance with blank amounts never erases known money; replacing needs explicit confirmation", async () => {
    const text = fromTemplate("eob", "T1B")
      .replace(/T1B-CMS-1001/g, "T1-CMS-1001")
      .replace(/"150\.00","80\.00","20\.00"/g, '"","",""')
      .replace(/"approved"/g, '"resubmitted"');
    const p = await preview("eob", text);
    expect(p.preview!.groups[0].lines.map(l => l.status)).toEqual(["needs_confirmation", "needs_confirmation", "needs_selection"]);
    const unconfirmed = await reviewAndSave("eob", text, { decide: l => ({ action: "apply", claimRecordId: l.targetClaimId ?? l.candidates[0].id }) });
    expect(unconfirmed.lines.map(l => l.reason)).toEqual(["already_reconciled", "already_reconciled", "already_reconciled"]);

    const before = await counts();
    await reviewAndSave("eob", text, { decide: l => ({ action: "apply", claimRecordId: l.targetClaimId ?? l.candidates[0].id, confirmReplace: true }) });
    const rows = await q(`SELECT insurance_reimbursement, patient_amount_due, claim_status FROM claims_records WHERE cms1500_line_key LIKE '%:csv.1' AND patient_id = $1 AND date_of_service = '2026-01-05'`, [PATIENT_A]);
    expect(rows).toEqual([{ insurance_reimbursement: "80.00", patient_amount_due: "20.00", claim_status: "resubmitted" }]);
    expect((await counts()).claims).toBe(before.claims);
  });

  // ── Repeated identical lines without references ───────────────────────

  it("repeated identical CPT lines without a CMS1500 reference need an explicit choice and never share a payment", async () => {
    const cms = fromTemplate("cms1500", "T2", "OTHERPERSON, SAM").replace(/2026-01-05|01\/05\/2026/g, "2026-03-05").replace(/"1","2026-03-05"/g, '"","2026-03-05"');
    await reviewAndSave("cms1500", cms);
    const eob = fromTemplate("eob", "T2", "OTHERPERSON, SAM").replace(/2026-01-05|01\/05\/2026/g, "2026-03-05").replace(/"T2-CMS-1001","\d"/g, '"",""');
    const p = await preview("eob", eob);
    const [l1, l2] = p.preview!.groups[0].lines as any[];
    expect([l1.status, l2.status]).toEqual(["needs_selection", "needs_selection"]);
    expect(l1.candidates).toHaveLength(2);

    // Only the unambiguous line (97140) is auto-applied; the two identical lines wait for a choice.
    const auto = await reviewAndSave("eob", eob);
    expect(auto.lines.map(l => l.status)).toEqual(["saved"]);

    const [a, b] = l1.candidates.map((c: any) => c.id);
    // Both payments pointed at the same line: the second is refused.
    const same = await reviewAndSave("eob", eob, { decide: (_l, i) => (i < 2 ? { action: "apply", claimRecordId: a } : { action: "skip" }) });
    expect(same.lines.map(l => l.status)).toEqual(["saved", "review_required", "skipped"]);
    expect(same.lines[1].reason).toBe("already_reconciled");
    // Retry only the unresolved line, onto the other candidate.
    const retry = await reviewAndSave("eob", eob, { state: same.state, decide: (_l, i) => (i === 1 ? { action: "apply", claimRecordId: b } : undefined) });
    expect(retry.lines.map(l => l.status)).toEqual(["saved"]);
    const paid = await q(`SELECT id, insurance_reimbursement, eob_line_key FROM claims_records WHERE id = ANY($1) ORDER BY eob_line_key`, [[a, b]]);
    expect(paid.map(r => r.insurance_reimbursement)).toEqual(["80.00", "80.00"]);
    expect(new Set(paid.map(r => r.eob_line_key)).size).toBe(2);
  });

  // ── Invalid / ambiguous input ──────────────────────────────────────────

  it("a reference to a CMS1500 line that was never imported is review-required with no write", async () => {
    const eob = fromTemplate("eob", "T3").replace(/"T3-CMS-1001"/g, '"NEVER-IMPORTED"');
    const before = await counts();
    const r = await reviewAndSave("eob", eob, { decide: () => ({ action: "apply", claimRecordId: randomUUID() }) });
    expect(r.preview.preview!.groups[0].lines.every(l => l.status === "cms1500_required")).toBe(true);
    expect(r.lines.every(l => l.status === "review_required")).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it("a client-chosen target the file row does not reference is refused (target IDs are not trusted)", async () => {
    const p = await preview("eob", EOB);
    const wrongTarget = (await cmsRows()).find(r => r.cms1500_line_key.endsWith(":csv.3"))!.id;
    const g = p.preview!.groups[0];
    expect(g.lines.every(l => l.status !== "cms1500_required")).toBe(true);
    const before = await counts();
    const p4 = await preview("eob", fromTemplate("eob", "T4").replace(/T4-CMS-1001/g, "T1-CMS-1001"));
    const g4 = p4.preview!.groups[0];
    const r4 = await owner().claims.csvImportCommit({
      kind: "eob", fileName: "eob.csv", csvText: fromTemplate("eob", "T4").replace(/T4-CMS-1001/g, "T1-CMS-1001"),
      groups: [{ groupKey: g4.groupKey, lines: [{ sourceLineKey: g4.lines[0].sourceLineKey, decision: { action: "apply", claimRecordId: wrongTarget, confirmReplace: true } }] }],
    });
    expect(r4.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "target_not_allowed" });
    // Keys or groups not in the file are refused too.
    const r5 = await owner().claims.csvImportCommit({
      kind: "eob", fileName: "eob.csv", csvText: EOB,
      groups: [{ groupKey: "gdeadbeef0000", lines: [{ sourceLineKey: "gdeadbeef0000:csv.1", decision: { action: "apply", claimRecordId: wrongTarget } }] }],
    });
    expect(r5.groups[0].lines[0]).toMatchObject({ status: "review_required", reason: "not_in_file" });
    expect(await counts()).toEqual(before);
  });

  it("unknown patient, mismatched patient_id, and a contradicting period are never guessed", async () => {
    const before = await counts();
    const unknown = await preview("cms1500", fromTemplate("cms1500", "T5", "NOBODY, UNKNOWN"));
    expect(unknown.preview!.groups[0].patient.status).toBe("unmatched");
    expect(unknown.preview!.groups[0].lines.every(l => l.status === "patient_required")).toBe(true);

    const mismatched = fromTemplate("cms1500", "T6").replace(/"TESTPATIENT, ALEX",""/g, `"TESTPATIENT, ALEX","${PATIENT_B}"`);
    const m = await preview("cms1500", mismatched);
    expect(m.document!.groups).toEqual([]);
    expect(m.rowErrors[0].message).toBe(`patient_id ${PATIENT_B} belongs to OTHERPERSON, SAM, not TESTPATIENT, ALEX.`);

    // File says period 2, visit dates say period 1: a choice is required; nothing auto-saves.
    const conflict = fromTemplate("cms1500", "T7").replace(/2026-01-05|01\/05\/2026/g, "2026-02-20").replace(/"TESTPATIENT, ALEX","","1"/g, '"TESTPATIENT, ALEX","","2"');
    const c = await reviewAndSave("cms1500", conflict, { decide: (l, i) => (i === 2 ? { action: "skip" } : undefined) });
    expect(c.preview.preview!.groups[0].lines.slice(0, 2).map(l => [l.status, (l as any).reason])).toEqual(Array(2).fill([
      "period_required", "The file says period 2, but the visit dates place this date of service in period 1. Choose the period.",
    ]));
    expect(c.lines.map(l => l.status)).toEqual(["skipped"]);
    expect(await counts()).toEqual(before);
  });

  it("the wrong template is refused with a clear message at preview and at commit, with no writes", async () => {
    const before = await counts();
    expect((await preview("eob", CMS)).templateError).toBe("This is the CMS1500 CSV template, not Insurance Reimbursement. Nothing was imported. Upload it under Bulk Upload → CMS1500.");
    expect((await preview("cms1500", EOB)).templateError).toMatch(/^This is the Insurance Reimbursement CSV template, not CMS1500/);
    expect((await preview("cms1500", '"Patient Name","Insurance","Authorized Sessions"\n"A","B","1"\n')).templateError).toMatch(/Patient Data CSV template/);
    const g = (await preview("cms1500", CMS)).preview!.groups[0];
    await expect(owner().claims.csvImportCommit({
      kind: "eob", fileName: "x.csv", csvText: CMS,
      groups: [{ groupKey: g.groupKey, lines: [{ sourceLineKey: g.lines[0].sourceLineKey, decision: { action: "apply", claimRecordId: randomUUID() } }] }],
    })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await counts()).toEqual(before);
  });

  // ── Retries, concurrency, audit ────────────────────────────────────────

  it("partial save then retry of only the unresolved lines; concurrent identical saves create each line once", async () => {
    // Period 2 dates; line 3 has no period and an in-between date → needs a choice.
    const text = fromTemplate("cms1500", "T8")
      .replace(/"2026-01-05"/g, '"2026-03-02"').replace('"01/05/2026"', '"2026-02-25"').replace(/"TESTPATIENT, ALEX","","1"/g, '"TESTPATIENT, ALEX","","2"');
    const before = await counts();
    const first = await reviewAndSave("cms1500", text);
    expect(first.lines.map(l => l.status)).toEqual(["saved", "saved"]);
    const pending = first.preview.preview!.groups[0].lines[2];
    expect(pending.status).toBe("period_required");

    const retry = await reviewAndSave("cms1500", text, { state: first.state, decide: (_l, i) => (i === 2 ? { action: "create", authPeriod: 1, periodSource: "selected" } : undefined) });
    expect(retry.lines.map(l => [l.sourceLineKey, l.status])).toEqual([[pending.sourceLineKey, "saved"]]);
    const mid = await counts();
    expect([mid.claims - before.claims, mid.audits - before.audits]).toEqual([3, 3]);

    const fresh = fromTemplate("cms1500", "T9", "OTHERPERSON, SAM").replace(/2026-01-05|01\/05\/2026/g, "2026-03-09").replace(/"1","2026-03-09"/g, '"","2026-03-09"');
    const runs = await Promise.all(Array.from({ length: 5 }, () => reviewAndSave("cms1500", fresh)));
    const statuses = runs.flatMap(r => r.lines.map(l => l.status));
    expect(statuses.filter(s => s === "saved")).toHaveLength(3);
    expect(statuses.filter(s => s === "unchanged")).toHaveLength(12);
    const after = await counts();
    expect([after.claims - mid.claims, after.audits - mid.audits, after.docs - mid.docs]).toEqual([3, 3, 1]);
  });

  it("an audit failure rolls back its line's write for CSV CMS1500 and CSV reimbursement lines", async () => {
    psql(`
      CREATE OR REPLACE FUNCTION test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.after_data ->> 'cpt_codes' = '97999' OR NEW.after_data ->> 'insurance_reimbursement' = '77.77' THEN
          RAISE EXCEPTION 'synthetic audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_fail_audit();`);
    try {
      const cms = fromTemplate("cms1500", "T10", "OTHERPERSON, SAM").replace(/2026-01-05|01\/05\/2026/g, "2026-03-11").replace(/"1","2026-03-11"/g, '"","2026-03-11"').replace(/"97140"/, '"97999"');
      const before = await counts();
      const r = await reviewAndSave("cms1500", cms);
      expect(r.lines.map(l => l.status)).toEqual(["saved", "saved", "failed"]);
      const mid = await counts();
      expect([mid.claims - before.claims, mid.audits - before.audits]).toEqual([2, 2]);
      expect((await q(`SELECT count(*)::int AS n FROM claims_records WHERE cpt_codes = '97999'`))[0].n).toBe(0);

      const eob = fromTemplate("eob", "T10", "OTHERPERSON, SAM").replace(/2026-01-05|01\/05\/2026/g, "2026-03-11").replace(/"80\.00"/, '"77.77"');
      const e = await reviewAndSave("eob", eob);
      expect(e.lines.map(l => l.status)).toEqual(["failed", "saved"]);
      const [row] = await q(`SELECT insurance_reimbursement, eob_document_id FROM claims_records WHERE id = $1`, [r.lines[0].claimId]);
      expect(row).toEqual({ insurance_reimbursement: null, eob_document_id: null });

      // Retry after the fault clears saves only the failed line, once.
      psql("DROP TRIGGER IF EXISTS test_fail_audit ON audit_logs;");
      const retry = await reviewAndSave("eob", eob.replace('"77.77"', '"80.00"'), { state: e.state });
      expect(retry.lines.map(l => l.status)).toEqual(["saved"]);
    } finally {
      psql("DROP TRIGGER IF EXISTS test_fail_audit ON audit_logs; DROP FUNCTION IF EXISTS test_fail_audit();");
    }
  });

  // ── Permissions ────────────────────────────────────────────────────────

  it("Owner and Clinic Admin may use both CSV imports; Staff and signed-out callers are denied with no writes", async () => {
    const adminRun = await reviewAndSave("cms1500", fromTemplate("cms1500", "T11", "OTHERPERSON, SAM").replace(/2026-01-05|01\/05\/2026/g, "2026-03-13").replace(/"1","2026-03-13"/g, '"","2026-03-13"'), { user: clinic("admin") });
    expect(adminRun.lines.map(l => l.status)).toEqual(["saved", "saved", "saved"]);
    const audit = await q(`SELECT DISTINCT actor_type FROM audit_logs WHERE entity_id = $1`, [adminRun.lines[0].claimId]);
    expect(audit).toEqual([{ actor_type: "clinic_user" }]);

    const before = await counts();
    const text = fromTemplate("cms1500", "T12", "OTHERPERSON, SAM");
    const g = (await preview("cms1500", text)).preview!.groups[0];
    const commit = { kind: "cms1500" as const, fileName: "x.csv", csvText: text, groups: [{ groupKey: g.groupKey, lines: [{ sourceLineKey: g.lines[0].sourceLineKey, decision: { action: "create" as const } }] }] };
    for (const [user, code] of [[clinic("staff"), "FORBIDDEN"], [null, "UNAUTHORIZED"]] as const) {
      await expect(caller(user).claims.csvImportPreview({ kind: "cms1500", fileName: "x.csv", csvText: text })).rejects.toMatchObject({ code });
      await expect(caller(user).claims.csvImportCommit(commit)).rejects.toMatchObject({ code });
      await expect(caller(user).claims.csvImportPreview({ kind: "eob", fileName: "x.csv", csvText: EOB })).rejects.toMatchObject({ code });
    }
    expect(await counts()).toEqual(before);
  });
});
