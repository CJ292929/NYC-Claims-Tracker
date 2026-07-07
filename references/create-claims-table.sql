-- Create claims_records table in Supabase PostgreSQL
-- Run this SQL in Supabase SQL Editor to create the table

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

-- Create index for faster queries by patient and period
CREATE INDEX IF NOT EXISTS idx_claims_patient_period ON public.claims_records(patient_id, auth_period);

-- Create index for claim status queries
CREATE INDEX IF NOT EXISTS idx_claims_status ON public.claims_records(claim_status);

-- Enable Row Level Security (optional, for multi-tenant security)
ALTER TABLE public.claims_records ENABLE ROW LEVEL SECURITY;

-- Create policy to allow authenticated users to view their own claims (if needed)
-- CREATE POLICY "Users can view their own claims" ON public.claims_records
--   FOR SELECT USING (auth.uid() = patient_id);
