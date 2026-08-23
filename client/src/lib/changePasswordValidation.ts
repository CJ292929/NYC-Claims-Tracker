import { MIN_CLINIC_PASSWORD_LENGTH } from "@shared/const";

export type ChangePasswordFormInput = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

/** Client-side pre-check run before calling clinic.changePassword. Mirrors
 * (but does not replace) the server's own validation in routers.ts — the
 * server is still the authority for every one of these rules. */
export function validateChangePasswordForm(input: ChangePasswordFormInput): string | null {
  if (!input.currentPassword) {
    return "Please enter your current password.";
  }
  if (input.newPassword.length < MIN_CLINIC_PASSWORD_LENGTH) {
    return `New password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters.`;
  }
  if (input.newPassword !== input.confirmPassword) {
    return "New password and confirmation do not match.";
  }
  if (input.newPassword === input.currentPassword) {
    return "New password must be different from your current password.";
  }
  return null;
}
