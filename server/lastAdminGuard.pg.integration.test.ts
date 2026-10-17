/**
 * server/lastAdminGuard.pg.integration.test.ts
 *
 * Real-Postgres regression test for the "last active account manager" race
 * fixed in supabase/migrations/20261018010000_p4_p17r_atomic_audit_and_concurrency_guard.sql
 * (P4-P17R). The bug it guards against: update_clinic_user_role_with_audit
 * and archive_clinic_user_with_audit each counted OTHER active admins with a
 * plain SELECT COUNT(*) (no row lock). With exactly two active admins A and
 * B, a transaction demoting A and a concurrent transaction demoting B each
 * saw "1 other active admin" under READ COMMITTED (neither had committed
 * yet) and BOTH passed the guard — leaving zero active admins. The fix locks
 * the whole active-admin row set with SELECT ... FOR UPDATE before counting.
 *
 * Every other test in this repo mocks the Supabase client (see
 * staffManagement.db.test.ts), which cannot reproduce this bug at all — the
 * race only exists under genuine concurrent Postgres transactions. This file
 * spins up a disposable `postgres:16` Docker container, loads the real
 * schema (references/local-setup-schema.sql + every file in
 * supabase/migrations, in order) into it, and fires concurrent SQL calls at
 * the actual plpgsql functions.
 *
 * Like claims.integration.test.ts, this file is matched by the CI workflows'
 * vitest --exclude glob for integration tests, so CI never attempts it. Run
 * it explicitly and locally (requires Docker):
 *
 *   npx vitest run server/lastAdminGuard.pg.integration.test.ts
 *
 * If Docker isn't available/running, every test in this file self-skips
 * (logging why) instead of failing, so a plain `npx vitest run` / `pnpm test`
 * with no filter still passes on a machine without Docker — it just won't
 * have exercised this file.
 */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { readdirSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CONTAINER_NAME = `p4p17r2-lastadmin-pg-${randomUUID().slice(0, 8)}`;

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
    "exec",
    "-e",
    "PGPASSWORD=postgres",
    CONTAINER_NAME,
    "psql",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    remote,
  ]);
}

function psqlInline(sql: string) {
  sh("docker", [
    "exec",
    "-e",
    "PGPASSWORD=postgres",
    CONTAINER_NAME,
    "psql",
    "-U",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}

let port = 0;

async function waitForReady() {
  for (let i = 0; i < 30; i++) {
    try {
      sh("docker", ["exec", CONTAINER_NAME, "pg_isready", "-U", "postgres"]);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Postgres container did not become ready in time");
}

function newClient(): Client {
  return new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
}

describe.skipIf(!HAS_DOCKER)("last-admin guard concurrency (real Postgres)", () => {
  beforeAll(async () => {
    if (!HAS_DOCKER) {
      console.warn("[lastAdminGuard.pg.integration.test] Docker not available — skipping.");
      return;
    }

    sh("docker", [
      "run",
      "-d",
      "--name",
      CONTAINER_NAME,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-p",
      "127.0.0.1::5432",
      "postgres:16",
    ]);

    const portOutput = sh("docker", ["port", CONTAINER_NAME, "5432"]);
    const match = portOutput.trim().match(/:(\d+)$/);
    if (!match) throw new Error(`Could not parse published port from: ${portOutput}`);
    port = Number(match[1]);

    await waitForReady();

    // Supabase's anon/authenticated/service_role roles aren't in a plain
    // postgres image — local-setup-schema.sql and the migrations GRANT to
    // them, so they must exist first.
    psqlInline(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    `);

    psqlFile(path.join(REPO_ROOT, "references", "local-setup-schema.sql"));

    const migrationsDir = path.join(REPO_ROOT, "supabase", "migrations");
    const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of migrationFiles) {
      psqlFile(path.join(migrationsDir, file));
    }
  }, 120_000);

  afterAll(() => {
    if (!HAS_DOCKER) return;
    try {
      sh("docker", ["rm", "-f", CONTAINER_NAME]);
    } catch {
      // best-effort cleanup
    }
  });

  async function seedAdmins(count: number): Promise<string[]> {
    const client = newClient();
    await client.connect();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const res = await client.query(
        `INSERT INTO clinic_users (username, password_hash, role, status, token_version)
         VALUES ($1, 'x', 'admin', 'active', 0) RETURNING id`,
        [`pg_test_admin_${randomUUID()}`]
      );
      ids.push(res.rows[0].id);
    }
    await client.end();
    return ids;
  }

  async function cleanupUsers(ids: string[]) {
    const client = newClient();
    await client.connect();
    await client.query(`DELETE FROM clinic_users WHERE id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])`, [ids]);
    await client.end();
  }

  async function countActiveAdmins(ids: string[]): Promise<number> {
    const client = newClient();
    await client.connect();
    const res = await client.query(
      `SELECT count(*) FROM clinic_users WHERE id = ANY($1::uuid[]) AND role = 'admin' AND status = 'active'`,
      [ids]
    );
    await client.end();
    return Number(res.rows[0].count);
  }

  async function archive(id: string) {
    const client = newClient();
    await client.connect();
    try {
      await client.query(
        `SELECT archive_clinic_user_with_audit($1, 0, NULL, 'clinic_user', 'Test Actor')`,
        [id]
      );
      return { ok: true as const };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false as const, code: err.code, message: err.message };
    } finally {
      await client.end();
    }
  }

  async function demoteToStaff(id: string) {
    const client = newClient();
    await client.connect();
    try {
      await client.query(
        `SELECT update_clinic_user_role_with_audit($1, 'staff', 0, NULL, 'clinic_user', 'Test Actor')`,
        [id]
      );
      return { ok: true as const };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      return { ok: false as const, code: err.code, message: err.message };
    } finally {
      await client.end();
    }
  }

  it("sequential: archiving the only active admin is rejected (sanity check, no concurrency)", async () => {
    const [onlyAdmin] = await seedAdmins(1);
    try {
      const result = await archive(onlyAdmin);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("P0023");
      expect(await countActiveAdmins([onlyAdmin])).toBe(1);
    } finally {
      await cleanupUsers([onlyAdmin]);
    }
  }, 30_000);

  it("concurrent: archiving both of exactly two active admins at once never leaves zero active admins", async () => {
    // Repeat several times: the race is timing-dependent (the fix can
    // surface as a clean P0023 rejection OR a Postgres deadlock abort,
    // depending on lock-acquisition order — see this file's header comment
    // and the PR description. Either way, the invariant that matters —
    // never zero active admins — must hold every single time.)
    for (let attempt = 0; attempt < 5; attempt++) {
      const [adminA, adminB] = await seedAdmins(2);
      try {
        const [resultA, resultB] = await Promise.all([archive(adminA), archive(adminB)]);

        const successes = [resultA, resultB].filter((r) => r.ok);
        const failures = [resultA, resultB].filter((r) => !r.ok);

        // The core regression: before the fix, both could succeed.
        expect(successes.length).toBe(1);
        expect(failures.length).toBe(1);

        // The loser must fail either with the clean business-rule error or
        // a Postgres deadlock abort — never anything else.
        expect(["P0023", "40P01"]).toContain(failures[0].code);

        const activeAfter = await countActiveAdmins([adminA, adminB]);
        expect(activeAfter).toBe(1);
      } finally {
        await cleanupUsers([adminA, adminB]);
      }
    }
  }, 60_000);

  it("concurrent: demoting both of exactly two active admins (role change path) never leaves zero active admins", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [adminA, adminB] = await seedAdmins(2);
      try {
        const [resultA, resultB] = await Promise.all([demoteToStaff(adminA), demoteToStaff(adminB)]);

        const successes = [resultA, resultB].filter((r) => r.ok);
        const failures = [resultA, resultB].filter((r) => !r.ok);

        expect(successes.length).toBe(1);
        expect(failures.length).toBe(1);
        expect(["P0023", "40P01"]).toContain(failures[0].code);

        const activeAfter = await countActiveAdmins([adminA, adminB]);
        expect(activeAfter).toBe(1);
      } finally {
        await cleanupUsers([adminA, adminB]);
      }
    }
  }, 60_000);

  it("concurrent: mixing archive + role-change across the two guard functions never leaves zero active admins", async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const [adminA, adminB] = await seedAdmins(2);
      try {
        const [resultA, resultB] = await Promise.all([archive(adminA), demoteToStaff(adminB)]);

        const successes = [resultA, resultB].filter((r) => r.ok);
        const failures = [resultA, resultB].filter((r) => !r.ok);

        expect(successes.length).toBe(1);
        expect(failures.length).toBe(1);
        expect(["P0023", "40P01"]).toContain(failures[0].code);

        const activeAfter = await countActiveAdmins([adminA, adminB]);
        expect(activeAfter).toBe(1);
      } finally {
        await cleanupUsers([adminA, adminB]);
      }
    }
  }, 60_000);

  it("concurrent: with three active admins, demoting two different ones never leaves zero active admins", async () => {
    const [adminA, adminB, adminC] = await seedAdmins(3);
    try {
      const [resultA, resultB] = await Promise.all([archive(adminA), archive(adminB)]);

      const successes = [resultA, resultB].filter((r) => r.ok);
      // Both may succeed here (3 - 2 = 1 remaining is still a valid end
      // state) OR one may lose the lock-ordering race and need a retry —
      // either is correct as long as at least one admin stays active.
      expect(successes.length).toBeGreaterThanOrEqual(1);

      const activeAfter = await countActiveAdmins([adminA, adminB, adminC]);
      expect(activeAfter).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanupUsers([adminA, adminB, adminC]);
    }
  }, 30_000);
});
