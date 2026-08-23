import { MIN_CLINIC_PASSWORD_LENGTH } from "@shared/const";

export type CreateStaffFormInput = {
  name: string;
  username: string;
  password: string;
  confirmPassword: string;
};

/** Client-side pre-check run before calling staff.create. Mirrors (but does
 * not replace) the server's own validation in routers.ts. */
export function validateCreateStaffForm(input: CreateStaffFormInput): string | null {
  if (!input.name.trim()) {
    return "Full name is required.";
  }
  if (!input.username.trim()) {
    return "Username is required.";
  }
  if (input.password.length < MIN_CLINIC_PASSWORD_LENGTH) {
    return `Temporary password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters.`;
  }
  if (input.password !== input.confirmPassword) {
    return "Temporary password and confirmation do not match.";
  }
  return null;
}

export type ResetStaffPasswordFormInput = {
  password: string;
  confirmPassword: string;
};

/** Client-side pre-check run before calling staff.resetPassword. */
export function validateResetStaffPasswordForm(input: ResetStaffPasswordFormInput): string | null {
  if (input.password.length < MIN_CLINIC_PASSWORD_LENGTH) {
    return `Temporary password must be at least ${MIN_CLINIC_PASSWORD_LENGTH} characters.`;
  }
  if (input.password !== input.confirmPassword) {
    return "Temporary password and confirmation do not match.";
  }
  return null;
}
