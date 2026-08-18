import { defineConfig } from "drizzle-kit";

// LEGACY — targets the old MySQL/TiDB database, not the Supabase PostgreSQL
// database this app actually runs on. Do NOT run `pnpm db:push` against
// production. See drizzle/LEGACY.md.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
