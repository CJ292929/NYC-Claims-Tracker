/**
 * scripts/create-claims-table.mjs
 * Creates the claims_records table in Supabase by calling the Supabase
 * Management API (pg_dump / SQL execution endpoint).
 */
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

console.log("Supabase URL:", supabaseUrl.substring(0, 40) + "...");

// Extract project ref from URL (e.g. https://abcdefgh.supabase.co → abcdefgh)
const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
console.log("Project ref:", projectRef);

const SQL = `
CREATE TABLE IF NOT EXISTS public.claims_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
  auth_period integer NOT NULL,
  place_of_service text,
  date_of_service timestamp with time zone,
  visit_number text,
  cpt_codes text,
  units_billed integer,
  diagnosis_codes text,
  modifier text,
  charge_amount numeric(10, 2),
  insurance_reimbursement numeric(10, 2),
  patient_amount_paid numeric(10, 2),
  patient_amount_due numeric(10, 2),
  insurance_billed text,
  oa_claim_number text,
  claim_submitted_date timestamp with time zone,
  expire_bcbs_claim_number text,
  claim_status text DEFAULT 'submitted' CHECK (claim_status IN ('submitted', 'approved', 'pending', 'denied')),
  payment_received numeric(10, 2),
  check_date timestamp with time zone,
  check_number_virtual_card text,
  date_received timestamp with time zone,
  date_of_appeal timestamp with time zone,
  reference_no text,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claims_patient_period ON public.claims_records(patient_id, auth_period);
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.claims_records(claim_status);
`;

// Try using Supabase's pg endpoint via the REST API
const pgUrl = `${supabaseUrl}/rest/v1/rpc/exec_sql`;
console.log("Trying RPC endpoint:", pgUrl);

try {
  const resp = await fetch(pgUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
    body: JSON.stringify({ sql: SQL }),
  });
  const text = await resp.text();
  console.log("RPC response:", resp.status, text.substring(0, 200));
} catch (e) {
  console.log("RPC failed:", e.message);
}

// Also try the Supabase Management API
const mgmtUrl = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
console.log("\nTrying Management API:", mgmtUrl);

// We need a personal access token for this, which we don't have
// Instead, let's verify the table by trying to select from it
const supabase = createClient(supabaseUrl, supabaseKey);
const { data, error } = await supabase.from("claims_records").select("id").limit(1);

if (error) {
  console.log("\nTable check result:", error.code, error.message);
  if (error.code === "PGRST205") {
    console.log("\n⚠️  Table does not exist yet.");
    console.log("Please run the following SQL in Supabase SQL Editor:");
    console.log("https://supabase.com/dashboard/project/" + projectRef + "/sql/new");
    console.log("\n--- SQL to run ---");
    console.log(SQL);
    console.log("--- End SQL ---");
  }
} else {
  console.log("\n✅ Table exists! Rows:", data?.length ?? 0);
}
