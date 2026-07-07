# Claims Tracker Implementation Guide

## Overview

The Claims Tracker is a comprehensive system for managing and tracking insurance claims for each authorization period. It displays below each Authorization Period card and allows staff to monitor claim status, payment details, and related information.

## Architecture

### Frontend
- **Location**: `client/src/pages/Dashboard.tsx`
- **Component**: Claims Tracker Card (below each Authorization Period)
- **Features**:
  - 22-column table displaying all claim details
  - Color-coded claim status badges (green/approved, red/denied, yellow/pending, blue/submitted)
  - "Add Claim" button to create new claim records
  - Add Claim dialog with all 22 fields
  - Horizontal scroll for responsive display
  - Empty state when no claims exist

### Backend
- **Database Types**: `server/supabase.types.ts` (ClaimRecordRow, InsertClaimRecord, UpdateClaimRecord)
- **Schema Types**: `drizzle/schema.ts` (ClaimRecord interface)
- **Database Helpers**: `server/db.ts` (createClaimRecord, getClaimsByPatientAndPeriod, updateClaimRecord, deleteClaimRecord)
- **tRPC Procedures**: `server/routers.ts` (claims.create, claims.getByPatientAndPeriod, claims.update, claims.delete)

### Database
- **Table**: `public.claims_records` (PostgreSQL in Supabase)
- **Columns**: 25 fields including all claim tracking information
- **Relationships**: Foreign key to `patients.id`
- **Indexes**: For fast queries by patient/period and claim status

## Setup Instructions

### Step 1: Create the Database Table

Run the SQL script in Supabase SQL Editor:

```bash
# Location: references/create-claims-table.sql
```

Or manually execute in Supabase console:

```sql
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
```

### Step 2: Verify Backend Implementation

All backend code is already implemented:

✅ **Database Types** (`server/supabase.types.ts`):
- ClaimRecordRow interface with all 25 fields
- InsertClaimRecord type for creating claims
- UpdateClaimRecord type for updating claims

✅ **Database Helpers** (`server/db.ts`):
- `createClaimRecord()` - Insert new claim
- `getClaimsByPatientAndPeriod()` - Fetch claims for a patient/period
- `updateClaimRecord()` - Update existing claim
- `deleteClaimRecord()` - Delete claim

✅ **tRPC Procedures** (`server/routers.ts`):
- `claims.create` - Create new claim record
- `claims.getByPatientAndPeriod` - Fetch claims (called at top level in Dashboard)
- `claims.update` - Update claim status/details
- `claims.delete` - Delete claim record

### Step 3: Test End-to-End Flows

Run the integration tests:

```bash
cd /home/ubuntu/clinic-dashboard
pnpm test server/claims.integration.test.ts
```

Tests cover:
- ✅ Create claim record
- ✅ Read claim record
- ✅ Update claim record
- ✅ List claims by patient and period
- ✅ Delete claim record

### Step 4: Use in Dashboard

The Claims Tracker is already integrated into the Dashboard:

1. **View Claims**: Navigate to a patient's detail view → scroll down to see Claims Tracker card below Authorization Period
2. **Add Claim**: Click "Add Claim" button → fill in form → click "Save Claim Record"
3. **Update Claim**: Edit any field in the table (inline editing ready for implementation)
4. **Track Status**: Color-coded badges show claim status at a glance

## Data Fields

### Claim Tracking Fields (22 columns in table)

| Field | Type | Description |
|-------|------|-------------|
| Place of Service | text | Where service was delivered (Home, Clinic, etc.) |
| Date of Service | date | When the service was provided |
| Visit # | text | Visit number for this service |
| CPT Codes | text | Current Procedural Terminology codes |
| Units | integer | Number of units billed |
| Diagnosis | text | ICD diagnosis codes |
| Modifier | text | CPT modifier (LT, RT, etc.) |
| Charge Amount | currency | Total charge for service |
| Insurance Reimbursement | currency | Amount insurance paid |
| Patient Amount Paid | currency | Amount patient paid |
| Patient Amount Due | currency | Amount patient still owes |
| Insurance Billed | text | Insurance company name |
| OA Claim # | text | Original authorization claim number |
| Claim Submitted Date | date | When claim was submitted |
| BCBS # | text | BCBS claim number |
| Claim Status | enum | submitted / approved / pending / denied |
| Payment Received | currency | Payment amount received |
| Check Date | date | Date check was received |
| Check # | text | Check or virtual card number |
| Date Received | date | Date payment was received |
| Appeal Date | date | Date of appeal if applicable |
| Reference # | text | Reference number for tracking |

## Frontend Integration

### Claims Tracker Card Structure

```
Authorization Period Card
├── Period Info (Auth Date, Sessions, Insurance)
├── Visit Records Table
└── [Claims Tracker Card Below]
    ├── Header (Add Claim button)
    ├── Claims Table (22 columns)
    └── Add Claim Dialog
        └── Form with all 22 fields
```

### React Hooks Pattern

The Dashboard uses a pre-fetch pattern to avoid React hook violations:

```typescript
// Top-level queries (not inside loops)
const periods = useMemo(() => {...}, [visits]);
const claimsQuery1 = trpc.claims.getByPatientAndPeriod.useQuery(...);
const claimsQuery2 = trpc.claims.getByPatientAndPeriod.useQuery(...);
// ... up to 5 queries for most patients

// Map data for rendering
const claimsDataMap = useMemo(() => {
  const map: Record<number, any[]> = {};
  periods.forEach((period, idx) => {
    map[period] = queries[idx]?.data ?? [];
  });
  return map;
}, [periods, claimsQuery1, claimsQuery2, ...]);

// Use in render
const claims = claimsDataMap[period] ?? [];
```

## Next Steps

### 1. Create Database Table (Required)
Run the SQL script in Supabase console to create `claims_records` table.

### 2. Test End-to-End (Optional)
Run integration tests to verify all CRUD operations work:
```bash
pnpm test server/claims.integration.test.ts
```

### 3. Add Inline Editing (Enhancement)
Make table cells editable with click-to-edit UI for better UX.

### 4. Add Claim History (Enhancement)
Track who changed what and when for audit trail compliance.

### 5. Add Bulk Operations (Enhancement)
Allow staff to update multiple claims at once (e.g., "Mark all as Approved").

## Testing Checklist

- [ ] Create claims_records table in Supabase
- [ ] Run integration tests
- [ ] Create new claim via "Add Claim" button
- [ ] Verify claim appears in Claims Tracker table
- [ ] Update claim status via dropdown
- [ ] Verify claim status changes persist
- [ ] Delete claim and verify it's removed from table
- [ ] Test with multiple authorization periods
- [ ] Verify color-coded status badges display correctly

## Troubleshooting

### Claims table not showing
- Verify `claims_records` table exists in Supabase
- Check browser console for tRPC errors
- Verify patient has authorization periods

### "Add Claim" button not working
- Check that dialog opens (should see form)
- Verify all required fields are filled
- Check browser console for validation errors

### Claims not persisting
- Verify database table was created successfully
- Check Supabase connection in `.env`
- Review tRPC error messages in browser console

## Files Modified

- ✅ `client/src/pages/Dashboard.tsx` - Claims Tracker UI and hooks
- ✅ `server/supabase.types.ts` - ClaimRecord types
- ✅ `drizzle/schema.ts` - ClaimRecord interface
- ✅ `server/db.ts` - Database helpers
- ✅ `server/routers.ts` - tRPC procedures
- ✅ `server/claims.integration.test.ts` - Integration tests
- ✅ `references/create-claims-table.sql` - Database creation script

## Support

For issues or questions:
1. Check the troubleshooting section above
2. Review browser console for error messages
3. Check Supabase logs for database errors
4. Run integration tests to verify backend connectivity
