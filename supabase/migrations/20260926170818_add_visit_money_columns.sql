-- Add per-visit money columns for the Authorization Period table:
-- Total Insurance Reimbursement, Total Patient Due, Total Patient Paid (editable).
-- Total Amount is computed client-side (sum of the three) and is not stored.
ALTER TABLE public.visit_records ADD COLUMN IF NOT EXISTS total_insurance_reimbursement numeric(10,2);
ALTER TABLE public.visit_records ADD COLUMN IF NOT EXISTS total_patient_due numeric(10,2);
ALTER TABLE public.visit_records ADD COLUMN IF NOT EXISTS total_patient_paid numeric(10,2);
