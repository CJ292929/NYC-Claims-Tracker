import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("[Supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — DB calls will fail.");
}

/**
 * Server-side Supabase client using the service role key.
 * This bypasses RLS and has full access to all tables.
 * Never expose this client or its key to the browser.
 *
 * We intentionally do NOT pass a Database generic here — the db.ts helpers
 * use explicit `as` casts to map snake_case Supabase rows to the app's
 * camelCase types, so the generic is not needed and avoids `never` type issues.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const supabase = createClient<any>(
  supabaseUrl ?? "https://placeholder.supabase.co",
  supabaseKey ?? "placeholder-key",
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);
