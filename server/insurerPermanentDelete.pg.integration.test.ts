/**
 * server/insurerPermanentDelete.pg.integration.test.ts
 *
 * Real-Postgres tests for the permanent insurer delete — P4-P21
 * (supabase/migrations/20261023000000_p4_p21_insurer_permanent_delete.sql)
 * as changed by P4-P22
 * (supabase/migrations/20261024000000_p4_p22_insurer_catalog_only_delete.sql):
 * catalog-only deletion that succeeds even when records store the name
 * (by name, alias, or a casing/spacing variant) and leaves every patient,
 * visit, claim, and earlier audit row unchanged; atomic delete + audit; the
 * foreign-key refusal; tombstones that stop re-run seeds/backfills from
 * recreating a deleted entry; and the assignment/deletion race. The race
 * only exists under genuinely concurrent Postgres transactions, which the
 * mocked-Supabase unit tests can't produce.
 *
 * Same harness as lastAdminGuard.pg.integration.test.ts: a disposable
 * `postgres:16` Docker container loaded with references/local-setup-schema.sql
 * plus every supabase/migrations file in order. Excluded from CI by the
 * `**\/*.integration.test.ts` glob; self-skips when Docker isn't available.
 *
 *   npx vitest run server/insurerPermanentDelete.pg.integration.test.ts
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readdirSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `p4p21-insurer-delete-pg-${randomUUID().slice(0, 8)}`;
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase", "migrations");

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const HAS_DOCKER = dockerAvailable();

function sh(cmd: string, args: string[]) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

function psqlFile(filePath: string) {
  const remote = "/tmp/apply.sql";
  sh("docker", ["cp", filePath, `${CONTAINER_NAME}:${remote}`]);
  sh("docker", [
    "exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME,
    "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", remote,
  ]);
}

function psqlInline(sql: string) {
  sh("docker", [
    "exec", "-e", "PGPASSWORD=postgres", CONTAINER_NAME,
    "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql,
  ]);
}

let port = 0;

async function waitForReady() {
  for (let i = 0; i < 30; i++) {
    try {
      // Over TCP: the image's temporary init-time server listens on the unix
      // socket only, so a socket check can pass just before it restarts.
      sh("docker", ["exec", CONTAINER_NAME, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Postgres container did not become ready in time");
}

async function connect(): Promise<Client> {
  const client = new Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" });
  await client.connect();
  return client;
}

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = await connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

type Outcome = { ok: true } | { ok: false; code?: string; message?: string };

async function settle(p: Promise<unknown>): Promise<Outcome> {
  try {
    await p;
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code, message: err.message };
  }
}

/** Resolves true if `p` is still pending after `ms` — i.e. it's blocked on a lock. */
async function isBlocked(p: Promise<unknown>, ms = 400): Promise<boolean> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await new Promise((r) => setTimeout(r, ms));
  return !done;
}

const ACTOR = [null, "owner", "Test Owner"] as const;

async function createInsurer(name: string, aliases: string[] = []): Promise<string> {
  const [{ id }] = await q<{ id: string }>(
    `SELECT write_insurer_catalog_with_audit(NULL, $1::jsonb, $2, $3, $4, 'INSURER_CREATE') AS id`,
    [JSON.stringify({ name }), ...ACTOR]
  );
  if (aliases.length) await q(`UPDATE insurer_catalog SET aliases = $2 WHERE id = $1`, [id, aliases]);
  return id;
}

function deleteSql(client: Client, id: string, actorType: string = ACTOR[1]) {
  return client.query(`SELECT delete_insurer_catalog_with_audit($1, $2, $3, $4)`, [id, ACTOR[0], actorType, ACTOR[2]]);
}

async function deleteInsurer(id: string, actorType?: string): Promise<Outcome> {
  const client = await connect();
  try {
    return await settle(deleteSql(client, id, actorType));
  } finally {
    await client.end();
  }
}

async function catalogRowExists(id: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM insurer_catalog WHERE id = $1`, [id])).length === 1;
}

async function insertPatient(insurance: string, isActive = true): Promise<string> {
  const [{ id }] = await q<{ id: string }>(
    `INSERT INTO patients (name, insurance, is_active) VALUES ($1, $2, $3) RETURNING id`,
    [`pg_test_patient_${randomUUID()}`, insurance, isActive]
  );
  return id;
}

/** Every row that could reference an insurer, plus all audit rows other than
 *  the delete's own — compared before/after a delete to prove nothing but
 *  the catalog row (and its new audit/tombstone rows) changed. */
async function recordsSnapshot(): Promise<string> {
  const [{ snap }] = await q<{ snap: unknown }>(`
    SELECT jsonb_build_object(
      'patients', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id), '[]') FROM patients p),
      'visits', (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.id), '[]') FROM visit_records v),
      'claims', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]') FROM claims_records c),
      'audits', (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]') FROM audit_logs a
                 WHERE a.action <> 'INSURER_PERMANENT_DELETE')
    ) AS snap`);
  return JSON.stringify(snap);
}

function uniqueName(label: string) {
  return `P4P21 ${label} ${randomUUID().slice(0, 8)}`;
}

describe.skipIf(!HAS_DOCKER)("insurer permanent delete (real Postgres)", () => {
  beforeAll(async () => {
    sh("docker", [
      "run", "-d", "--name", CONTAINER_NAME, "-e", "POSTGRES_PASSWORD=postgres",
      "-p", "127.0.0.1::5432", "postgres:16",
    ]);
    const portOutput = sh("docker", ["port", CONTAINER_NAME, "5432"]);
    const match = portOutput.trim().match(/:(\d+)$/);
    if (!match) throw new Error(`Could not parse published port from: ${portOutput}`);
    port = Number(match[1]);
    await waitForReady();

    psqlInline(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN NOINHERIT; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN NOINHERIT; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS; END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);
    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      psqlFile(path.join(MIGRATIONS_DIR, file));
    }
  }, 180_000);

  afterAll(() => {
    try {
      sh("docker", ["rm", "-f", CONTAINER_NAME]);
    } catch {
      // best-effort cleanup
    }
  });

  it("deletes an unused entry by id and writes an audit row preserving its id and name", async () => {
    const name = uniqueName("Unused");
    const id = await createInsurer(name, ["Old Spelling " + name]);

    expect(await deleteInsurer(id)).toEqual({ ok: true });
    expect(await catalogRowExists(id)).toBe(false);

    const audits = await q<{ before_data: { id: string; name: string; aliases: string[] }; after_data: unknown; actor_type: string }>(
      `SELECT before_data, after_data, actor_type FROM audit_logs
       WHERE entity_type = 'insurer_catalog' AND entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`,
      [id]
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].before_data).toMatchObject({ id, name, aliases: ["Old Spelling " + name] });
    expect(audits[0].after_data).toBeNull();
    expect(audits[0].actor_type).toBe("owner");
  }, 30_000);

  it("unknown / already-deleted id fails with P0032 and writes no audit row", async () => {
    const id = randomUUID();
    expect(await deleteInsurer(id)).toMatchObject({ ok: false, code: "P0032" });
    expect(await q(`SELECT 1 FROM audit_logs WHERE entity_id = $1`, [id])).toHaveLength(0);
  }, 30_000);

  it("deletes a referenced insurer from the catalog; every record and earlier audit row is unchanged", async () => {
    const name = uniqueName("Referenced");
    const alias = uniqueName("Pre Rename");
    const id = await createInsurer(name, [alias]);
    const unrelated = await createInsurer(uniqueName("Unrelated"));

    const active = await insertPatient(name);
    const discharged = await insertPatient(name, false);
    // A casing/spacing variant — invisible to the UI's exact-match filter
    // count, which is why such entries used to look unused yet be blocked.
    const variant = await insertPatient(`  ${name.toUpperCase().replace(/ /g, "  ")} `);
    await q(`INSERT INTO visit_records (patient_id, auth_period, insurance_company) VALUES ($1, 1, $2), ($3, 1, $4)`,
      [active, name, discharged, alias]);
    await q(`INSERT INTO claims_records (patient_id, auth_period, insurance_billed) VALUES ($1, 1, $2)`, [variant, alias]);
    await q(
      `INSERT INTO audit_logs (entity_type, entity_id, patient_id, actor_type, actor_display, action, before_data, after_data)
       VALUES ('patient', $1, $1, 'owner', 'Test Owner', 'PATIENT_UPDATE', '{"insurance": "x"}', $2::jsonb)`,
      [active, JSON.stringify({ insurance: name })]
    );

    const before = await recordsSnapshot();
    expect(await deleteInsurer(id)).toEqual({ ok: true });

    expect(await catalogRowExists(id)).toBe(false);
    expect(await catalogRowExists(unrelated)).toBe(true);
    expect(await recordsSnapshot()).toBe(before);

    const [audit] = await q<{ before_data: { id: string; name: string; retained_references: Record<string, number> } }>(
      `SELECT before_data FROM audit_logs WHERE entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`, [id]
    );
    expect(audit.before_data).toMatchObject({ id, name, retained_references: { patients: 3, visits: 2, claims: 1 } });
  }, 30_000);

  it("an unreferenced delete records zero retained references", async () => {
    const id = await createInsurer(uniqueName("Unreferenced"));
    expect(await deleteInsurer(id)).toEqual({ ok: true });
    const [audit] = await q<{ before_data: { retained_references: Record<string, number> } }>(
      `SELECT before_data FROM audit_logs WHERE entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`, [id]
    );
    expect(audit.before_data.retained_references).toEqual({ patients: 0, visits: 0, claims: 0 });
  }, 30_000);

  it("after a referenced delete, records carrying the name keep working; only a new patient selection is refused", async () => {
    const name = uniqueName("Still Recorded");
    const id = await createInsurer(name);
    const patientId = await insertPatient(name);
    await q(`INSERT INTO visit_records (patient_id, auth_period, insurance_company, sessions_authorized) VALUES ($1, 1, $2, 1)`, [patientId, name]);
    expect(await deleteInsurer(id)).toEqual({ ok: true });

    // Editing other fields — and re-saving the same insurer — is allowed.
    expect(await settle(q(`UPDATE patients SET name = name || ' (edited)', insurance = insurance WHERE id = $1`, [patientId])))
      .toEqual({ ok: true });

    // A new authorization batch copies the patient's recorded insurer into
    // new visit rows; that is history, not a new selection.
    expect(await settle(q(
      `SELECT approve_authorization_with_audit($1, 1, 2, NULL, NULL, false, NULL, NULL, 'owner', 'Test Owner')`, [patientId]
    ))).toEqual({ ok: true });
    const visits = await q<{ insurance_company: string }>(
      `SELECT insurance_company FROM visit_records WHERE patient_id = $1 AND auth_period = 2`, [patientId]
    );
    expect(visits).toHaveLength(2);
    expect(visits.every((v) => v.insurance_company === name)).toBe(true);

    // A historical EOB billed to the deleted insurer still imports.
    expect(await settle(q(`INSERT INTO claims_records (patient_id, auth_period, insurance_billed) VALUES ($1, 1, $2)`, [patientId, name])))
      .toEqual({ ok: true });

    // Choosing the deleted insurer for another patient IS a new selection.
    const other = await insertPatient(uniqueName("Other Insurer"));
    expect(await settle(q(`UPDATE patients SET insurance = $2 WHERE id = $1`, [other, name])))
      .toMatchObject({ ok: false, code: "P0041" });
    const [otherRow] = await q<{ insurance: string }>(`SELECT insurance FROM patients WHERE id = $1`, [other]);
    expect(otherRow.insurance).not.toBe(name);
  }, 30_000);

  it("refuses (P0042) rather than delete through a foreign key into the catalog", async () => {
    const id = await createInsurer(uniqueName("FK Guard"));
    const client = await connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE TABLE p4p22_fk_probe (insurer_id uuid REFERENCES insurer_catalog(id) ON DELETE CASCADE)`);
      expect(await settle(deleteSql(client, id))).toMatchObject({ ok: false, code: "P0042" });
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
    expect(await catalogRowExists(id)).toBe(true);
    // The real schema has no FK into the catalog, so the guard never fires there.
    expect(await q(`SELECT 1 FROM pg_constraint WHERE contype = 'f' AND confrelid = 'insurer_catalog'::regclass`)).toHaveLength(0);
  }, 30_000);

  it("only service_role can execute the delete function (no anon/authenticated path)", async () => {
    const [row] = await q<{ anon: boolean; authed: boolean; service: boolean }>(`
      SELECT has_function_privilege('anon', 'delete_insurer_catalog_with_audit(uuid, uuid, text, text)', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'delete_insurer_catalog_with_audit(uuid, uuid, text, text)', 'EXECUTE') AS authed,
             has_function_privilege('service_role', 'delete_insurer_catalog_with_audit(uuid, uuid, text, text)', 'EXECUTE') AS service`);
    expect(row).toEqual({ anon: false, authed: false, service: true });
  }, 30_000);

  it("rolls the delete back when the audit insert fails (delete + audit are atomic)", async () => {
    const name = uniqueName("Audit Rollback");
    const id = await createInsurer(name);
    await insertPatient(name);
    const before = await recordsSnapshot();

    // audit_logs_actor_type_check rejects this — the audit INSERT is the last
    // statement in the function, after the DELETE and tombstone insert.
    const result = await deleteInsurer(id, "not_a_real_actor_type");
    expect(result).toMatchObject({ ok: false, code: "23514" });

    expect(await catalogRowExists(id)).toBe(true);
    expect(await q(`SELECT 1 FROM insurer_catalog_deleted_names WHERE deleted_insurer_id = $1`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`, [id])).toHaveLength(0);
    expect(await recordsSnapshot()).toBe(before);
  }, 30_000);

  it("re-running the seed migrations does not recreate a deleted seeded entry", async () => {
    // A name the P4-P7 seed inserts; the test DB has no patients using it.
    const [{ id }] = await q<{ id: string }>(`SELECT id FROM insurer_catalog WHERE normalized_name = 'hanover'`);
    expect(await deleteInsurer(id)).toEqual({ ok: true });

    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      psqlFile(path.join(MIGRATIONS_DIR, file));
    }
    expect(await q(`SELECT 1 FROM insurer_catalog WHERE normalized_name = 'hanover'`)).toHaveLength(0);
  }, 120_000);

  it("re-running the patients/visits backfill migration does not recreate a deleted REFERENCED entry", async () => {
    // 20261004000000 backfills insurer_catalog from DISTINCT patients.insurance
    // and visit_records.insurance_company — exactly the values a referenced
    // delete leaves behind.
    const name = uniqueName("Backfill");
    const id = await createInsurer(name);
    const patientId = await insertPatient(name);
    await q(`INSERT INTO visit_records (patient_id, auth_period, insurance_company) VALUES ($1, 1, $2)`, [patientId, name]);
    expect(await deleteInsurer(id)).toEqual({ ok: true });

    psqlFile(path.join(MIGRATIONS_DIR, "20261004000000_insurer_catalog.sql"));
    expect(await q(`SELECT 1 FROM insurer_catalog WHERE normalized_name = lower($1)`, [name])).toHaveLength(0);
    const [patient] = await q<{ insurance: string }>(`SELECT insurance FROM patients WHERE id = $1`, [patientId]);
    expect(patient.insurance).toBe(name);
  }, 60_000);

  it("a deliberate admin re-add clears the tombstone and recreates the entry", async () => {
    const name = uniqueName("Re Add");
    const firstId = await createInsurer(name);
    expect(await deleteInsurer(firstId)).toEqual({ ok: true });

    // A plain seed-style insert stays a no-op...
    await q(`INSERT INTO insurer_catalog (name) VALUES ($1) ON CONFLICT (normalized_name) DO NOTHING`, [name]);
    expect(await q(`SELECT 1 FROM insurer_catalog WHERE name = $1`, [name])).toHaveLength(0);

    // ...but the explicit Add Insurance Company path brings it back.
    const secondId = await createInsurer(name);
    expect(await catalogRowExists(secondId)).toBe(true);
    expect(await q(`SELECT 1 FROM insurer_catalog_deleted_names WHERE normalized_name = lower($1)`, [name])).toHaveLength(0);
  }, 30_000);

  it("assigning a permanently deleted name afterwards is rejected; unrelated free text still saves", async () => {
    const name = uniqueName("Stale Form");
    const id = await createInsurer(name);
    expect(await deleteInsurer(id)).toEqual({ ok: true });

    expect(await settle(insertPatient(name))).toMatchObject({ ok: false, code: "P0041" });
    expect(await settle(insertPatient(uniqueName("Never Catalogued")))).toEqual({ ok: true });
  }, 30_000);

  it("concurrent: assignment commits first → the delete waits for it, then succeeds; the record keeps its insurer", async () => {
    const name = uniqueName("Race Assign First");
    const id = await createInsurer(name);

    const assigner = await connect();
    const deleter = await connect();
    try {
      await assigner.query("BEGIN");
      await assigner.query(`INSERT INTO patients (name, insurance) VALUES ('race patient', $1)`, [name]);

      const pendingDelete = settle(deleteSql(deleter, id));
      expect(await isBlocked(pendingDelete)).toBe(true);

      await assigner.query("COMMIT");
      expect(await pendingDelete).toEqual({ ok: true });
      expect(await catalogRowExists(id)).toBe(false);
      const [patient] = await q<{ insurance: string }>(`SELECT insurance FROM patients WHERE name = 'race patient'`);
      expect(patient.insurance).toBe(name);
      const [audit] = await q<{ before_data: { retained_references: { patients: number } } }>(
        `SELECT before_data FROM audit_logs WHERE entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`, [id]
      );
      expect(audit.before_data.retained_references.patients).toBe(1);
    } finally {
      await assigner.end();
      await deleter.end();
    }
  }, 30_000);

  it("concurrent: delete commits first → the assignment waits for it, then is rejected", async () => {
    const name = uniqueName("Race Delete First");
    const alias = uniqueName("Race Alias");
    const id = await createInsurer(name, [alias]);

    const deleter = await connect();
    const assigner = await connect();
    try {
      await deleter.query("BEGIN");
      await deleteSql(deleter, id);

      // Assign via the alias to prove alias matches take the lock too.
      const pendingAssign = settle(
        assigner.query(`INSERT INTO patients (name, insurance) VALUES ('race patient 2', $1)`, [alias])
      );
      expect(await isBlocked(pendingAssign)).toBe(true);

      await deleter.query("COMMIT");
      expect(await pendingAssign).toMatchObject({ ok: false, code: "P0041" });
      expect(await catalogRowExists(id)).toBe(false);
      expect(await q(`SELECT 1 FROM patients WHERE name = 'race patient 2'`)).toHaveLength(0);
    } finally {
      await deleter.end();
      await assigner.end();
    }
  }, 30_000);

  it("concurrent: delete rolls back → the waiting assignment proceeds", async () => {
    const name = uniqueName("Race Rollback");
    const id = await createInsurer(name);

    const deleter = await connect();
    const assigner = await connect();
    try {
      await deleter.query("BEGIN");
      await deleteSql(deleter, id);
      const pendingAssign = settle(
        assigner.query(`INSERT INTO patients (name, insurance) VALUES ('race patient 3', $1)`, [name])
      );
      expect(await isBlocked(pendingAssign)).toBe(true);

      await deleter.query("ROLLBACK");
      expect(await pendingAssign).toEqual({ ok: true });
      expect(await catalogRowExists(id)).toBe(true);
    } finally {
      await deleter.end();
      await assigner.end();
    }
  }, 30_000);

  it("concurrent: two simultaneous deletes of the same id — exactly one succeeds, one audit row", async () => {
    const name = uniqueName("Double Delete");
    const id = await createInsurer(name);

    const [a, b] = await Promise.all([deleteInsurer(id), deleteInsurer(id)]);
    const outcomes = [a, b];
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    expect(outcomes.find((o) => !o.ok)).toMatchObject({ code: "P0032" });
    expect(await q(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`, [id])).toHaveLength(1);
  }, 30_000);

  it("soft deactivation does not block concurrent assignments", async () => {
    const name = uniqueName("Deactivate");
    const id = await createInsurer(name);

    const deactivator = await connect();
    try {
      await deactivator.query("BEGIN");
      await deactivator.query(
        `SELECT write_insurer_catalog_with_audit($1, '{"is_active": false}'::jsonb, NULL, 'owner', 'Test Owner', 'INSURER_DEACTIVATE')`,
        [id]
      );
      const assign = settle(insertPatient(name));
      expect(await isBlocked(assign)).toBe(false);
      expect(await assign).toEqual({ ok: true });
      await deactivator.query("COMMIT");
    } finally {
      await deactivator.end();
    }
  }, 30_000);
});
