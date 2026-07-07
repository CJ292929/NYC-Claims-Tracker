/**
 * server/claims.integration.test.ts
 * Integration tests for claims CRUD operations
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./supabase.types";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

describe("Claims CRUD Integration Tests", () => {
  let supabase: ReturnType<typeof createClient<Database>>;
  let testPatientId: string;
  let testClaimId: string;

  beforeAll(async () => {
    supabase = createClient<Database>(supabaseUrl, supabaseKey);

    // Create a test patient
    const { data: patientData, error: patientError } = await supabase
      .from("patients")
      .insert({
        name: "Test Patient for Claims",
        insurance: "Test Insurance",
        is_active: true,
        claims_status: "submitted",
      })
      .select("id")
      .single();

    if (patientError) {
      console.error("Failed to create test patient:", patientError);
      throw patientError;
    }

    testPatientId = patientData.id;
    console.log("Created test patient:", testPatientId);
  });

  afterAll(async () => {
    // Clean up: delete test claim and patient
    if (testClaimId) {
      await supabase.from("claims_records").delete().eq("id", testClaimId);
    }
    if (testPatientId) {
      await supabase.from("patients").delete().eq("id", testPatientId);
    }
  });

  it("should create a claim record", async () => {
    const claimData = {
      patient_id: testPatientId,
      auth_period: 1,
      place_of_service: "Home",
      date_of_service: new Date().toISOString(),
      visit_number: "1",
      cpt_codes: "97110",
      units_billed: 1,
      diagnosis_codes: "M79.3",
      modifier: "LT",
      charge_amount: 150.0,
      insurance_reimbursement: 120.0,
      patient_amount_paid: 0.0,
      patient_amount_due: 30.0,
      insurance_billed: "Test Insurance",
      oa_claim_number: "OA-001",
      claim_submitted_date: new Date().toISOString(),
      claim_status: "submitted",
      reference_no: "REF-001",
    };

    const { data, error } = await supabase
      .from("claims_records")
      .insert(claimData)
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data?.id).toBeDefined();

    testClaimId = data!.id;
    console.log("Created claim record:", testClaimId);
  });

  it("should read a claim record", async () => {
    if (!testClaimId) {
      throw new Error("Test claim not created");
    }

    const { data, error } = await supabase
      .from("claims_records")
      .select("*")
      .eq("id", testClaimId)
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data?.patient_id).toBe(testPatientId);
    expect(data?.claim_status).toBe("submitted");
    expect(data?.place_of_service).toBe("Home");
  });

  it("should update a claim record", async () => {
    if (!testClaimId) {
      throw new Error("Test claim not created");
    }

    const { data, error } = await supabase
      .from("claims_records")
      .update({
        claim_status: "approved",
        payment_received: 120.0,
        check_date: new Date().toISOString(),
        check_number_virtual_card: "CHK-12345",
      })
      .eq("id", testClaimId)
      .select("*")
      .single();

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(data?.claim_status).toBe("approved");
    expect(data?.payment_received).toBe(120.0);
    expect(data?.check_number_virtual_card).toBe("CHK-12345");
  });

  it("should list claims by patient and period", async () => {
    if (!testPatientId) {
      throw new Error("Test patient not created");
    }

    const { data, error } = await supabase
      .from("claims_records")
      .select("*")
      .eq("patient_id", testPatientId)
      .eq("auth_period", 1);

    expect(error).toBeNull();
    expect(data).toBeDefined();
    expect(Array.isArray(data)).toBe(true);
    expect(data!.length).toBeGreaterThan(0);
    expect(data![0].patient_id).toBe(testPatientId);
  });

  it("should delete a claim record", async () => {
    if (!testClaimId) {
      throw new Error("Test claim not created");
    }

    const { error: deleteError } = await supabase
      .from("claims_records")
      .delete()
      .eq("id", testClaimId);

    expect(deleteError).toBeNull();

    // Verify deletion
    const { data, error: selectError } = await supabase
      .from("claims_records")
      .select("id")
      .eq("id", testClaimId)
      .single();

    expect(selectError).toBeDefined(); // Should get an error (no rows)
    expect(data).toBeNull();
  });
});
