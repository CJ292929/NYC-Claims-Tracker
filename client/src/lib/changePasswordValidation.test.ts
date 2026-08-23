/**
 * client/src/lib/changePasswordValidation.test.ts
 * S2: client-side pre-checks for the /change-password form. This is where
 * spec test P (confirmation mismatch) lives — there's no component-rendering
 * harness in this project (see App.routeIdentity.test.ts), so the form's
 * validation logic is extracted into a pure function to stay testable.
 */
import { describe, expect, it } from "vitest";
import { validateChangePasswordForm } from "./changePasswordValidation";

const VALID = { currentPassword: "old-password", newPassword: "new-password-1", confirmPassword: "new-password-1" };

describe("validateChangePasswordForm", () => {
  it("accepts a fully valid submission", () => {
    expect(validateChangePasswordForm(VALID)).toBeNull();
  });

  it("rejects a missing current password", () => {
    expect(validateChangePasswordForm({ ...VALID, currentPassword: "" })).toMatch(/current password/i);
  });

  it("rejects a new password shorter than the minimum length", () => {
    expect(validateChangePasswordForm({ ...VALID, newPassword: "short1", confirmPassword: "short1" })).toMatch(/at least/i);
  });

  it("P: rejects a new/confirm mismatch", () => {
    expect(
      validateChangePasswordForm({ ...VALID, newPassword: "new-password-1", confirmPassword: "new-password-2" })
    ).toMatch(/do not match/i);
  });

  it("Q: rejects a new password identical to the current password", () => {
    expect(
      validateChangePasswordForm({ currentPassword: "same-password", newPassword: "same-password", confirmPassword: "same-password" })
    ).toMatch(/different from your current password/i);
  });
});
