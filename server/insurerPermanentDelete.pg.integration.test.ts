/**
 * server/insurerPermanentDelete.pg.integration.test.ts
 *
 * Real-Postgres tests for P4-P21's permanent insurer delete
 * (supabase/migrations/20261023000000_p4_p21_insurer_permanent_delete.sql):
 * reference blocking by name and alias, atomic delete + audit, tombstones
 * that stop re-run seeds from recreating a deleted entry, and the
 * assignment/deletion race. The race only exists under genuinely concurrent
 * Postgres transactions, which the mocked-Supabase unit tests can't produce.
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

  it("blocks when a discharged (inactive) patient still stores the name, changing nothing", async () => {
    const name = uniqueName("Discharged Ref");
    const id = await createInsurer(name);
    const patientId = await insertPatient(name, false);

    expect(await deleteInsurer(id)).toMatchObject({ ok: false, code: "P0040" });
    expect(await catalogRowExists(id)).toBe(true);
    const [patient] = await q<{ insurance: string }>(`SELECT insurance FROM patients WHERE id = $1`, [patientId]);
    expect(patient.insurance).toBe(name);
    expect(await q(`SELECT 1 FROM audit_logs WHERE entity_id = $1 AND action = 'INSURER_PERMANENT_DELETE'`, [id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM insurer_catalog_deleted_names WHERE deleted_insurer_id = $1`, [id])).toHaveLength(0);
  }, 30_000);

  it("blocks on a historical visit record that stores an ALIAS (case/spacing-insensitive)", async () => {
    const name = uniqueName("Renamed");
    const alias = uniqueName("Pre Rename");
    const id = await createInsurer(name, [alias]);
    const patientId = await insertPatient("Some Other Insurer");
    await q(
      `INSERT INTO visit_records (patient_id, auth_period, insurance_company) VALUES ($1, 1, $2)`,
      [patientId, `  ${alias.toUpperCase().replace(/ /g, "   ")} `]
    );

    expect(await deleteInsurer(id)).toMatchObject({ ok: false, code: "P0040" });
    expect(await catalogRowExists(id)).toBe(true);
  }, 30_000);

  it("blocks on a claim record that stores the name", async () => {
    const name = uniqueName("Claim Ref");
    const id = await createInsurer(name);
    const patientId = await insertPatient("Some Other Insurer");
    await q(`INSERT INTO claims_records (patient_id, auth_period, insurance_billed) VALUES ($1, 1, $2)`, [patientId, name]);

    expect(await deleteInsurer(id)).toMatchObject({ ok: false, code: "P0040" });
    expect(await catalogRowExists(id)).toBe(true);
  }, 30_000);

  it("rolls the delete back when the audit insert fails (delete + audit are atomic)", async () => {
    const name = uniqueName("Audit Rollback");
    const id = await createInsurer(name);

    // audit_logs_actor_type_check rejects this — the audit INSERT is the last
    // statement in the function, after the DELETE and tombstone insert.
    const result = await deleteInsurer(id, "not_a_real_actor_type");
    expect(result).toMatchObject({ ok: false, code: "23514" });

    expect(await catalogRowExists(id)).toBe(true);
    expect(await q(`SELECT 1 FROM insurer_catalog_deleted_names WHERE deleted_insurer_id = $1`, [id])).toHaveLength(0);
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

  it("concurrent: assignment commits first → the delete waits for it, then is blocked", async () => {
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
      expect(await pendingDelete).toMatchObject({ ok: false, code: "P0040" });
      expect(await catalogRowExists(id)).toBe(true);
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
