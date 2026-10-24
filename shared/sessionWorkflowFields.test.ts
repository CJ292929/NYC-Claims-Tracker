import { describe, expect, it } from "vitest";
import { sessionWorkflowFieldsInput, SESSION_REMARKS_MAX_LENGTH } from "./sessionWorkflowFields";

describe("sessionWorkflowFieldsInput (P4-P23)", () => {
  it("accepts every allowed value, null (clear), and omission (untouched)", () => {
    for (const v of ["yes", "no", null]) {
      expect(sessionWorkflowFieldsInput.parse({ assignmentOfBenefits: v })).toEqual({ assignmentOfBenefits: v });
    }
    for (const v of ["ready_to_file", "hold", "do_not_file", null]) {
      expect(sessionWorkflowFieldsInput.parse({ submissionStatus: v })).toEqual({ submissionStatus: v });
    }
    expect(sessionWorkflowFieldsInput.parse({})).toEqual({});
  });

  it("never defaults a missing value", () => {
    const parsed = sessionWorkflowFieldsInput.parse({ remarks: "x" });
    expect(parsed).not.toHaveProperty("assignmentOfBenefits");
    expect(parsed).not.toHaveProperty("submissionStatus");
  });

  it("rejects values outside the allowed sets (case-sensitive)", () => {
    for (const bad of [{ assignmentOfBenefits: "YES" }, { assignmentOfBenefits: "" }, { submissionStatus: "Ready to file" }, { submissionStatus: 1 }]) {
      expect(sessionWorkflowFieldsInput.safeParse(bad).success).toBe(false);
    }
  });

  it("keeps multiline remarks verbatim, clears whitespace-only, caps length", () => {
    expect(sessionWorkflowFieldsInput.parse({ remarks: "  a\n\nb  " }).remarks).toBe("  a\n\nb  ");
    expect(sessionWorkflowFieldsInput.parse({ remarks: " \n\t" }).remarks).toBeNull();
    expect(sessionWorkflowFieldsInput.safeParse({ remarks: "x".repeat(SESSION_REMARKS_MAX_LENGTH) }).success).toBe(true);
    expect(sessionWorkflowFieldsInput.safeParse({ remarks: "x".repeat(SESSION_REMARKS_MAX_LENGTH + 1) }).success).toBe(false);
  });
});
