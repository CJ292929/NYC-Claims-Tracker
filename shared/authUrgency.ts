// Pure authorization-urgency primitive. No React, no Supabase, no
// server/client dependencies — safe to import from either side of the
// client/server boundary. Mirrors the urgency derivation currently inlined
// in server/db.ts getAuthAlertSummaries.
//
// This is a parity port: it reproduces current server behavior exactly,
// including the "denied" -> "exhausted" mapping regardless of remaining
// session count. That mapping looks like it may be accidental (a patient
// with sessions remaining and a denied claim reads identically to one who
// is fully exhausted), but changing it is out of scope here — this helper
// exists to establish a shared source of truth before any call sites move
// over to it. See PHASE 6 of the C4A task for context.

export type AuthUrgency = "exhausted" | "critical" | "warning" | "pending" | "ok";

export interface AuthorizationUrgencyInput {
  remaining: number;
  authStatus?: string | null;
  // Unix ms timestamp, matching how patients.auth_valid_until is stored and
  // read on the server (server/db.ts Patient.authValidUntil: number | null).
  // Date/string are also accepted so client code storing a Date or ISO
  // string can call this without a separate conversion step; they are
  // normalized to a ms timestamp before comparison. Production today only
  // ever supplies a number or null, so the Date/string paths are untested
  // against real data and exist for forward compatibility only.
  authValidUntil?: number | string | Date | null;
  now?: Date;
}

export interface AuthorizationUrgencyResult {
  urgency: AuthUrgency;
  authExpiryWarning: boolean;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function toMillis(value: number | string | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

// Mirrors server/db.ts getAuthAlertSummaries exactly:
//
//   let urgency = "ok";
//   if (sessionsRemaining === 0) urgency = "exhausted";
//   else if (sessionsRemaining <= 2) urgency = "critical";
//   else if (sessionsRemaining <= 3) urgency = "warning";
//   if (authStatus === "pending" && urgency === "ok") urgency = "pending";
//   if (authStatus === "denied") urgency = "exhausted";
//
//   const expiresWithin7Days = authValidUntil !== null && authValidUntil > now && authValidUntil - now <= sevenDaysMs;
//   const alreadyExpired = authValidUntil !== null && authValidUntil < now;
//   const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
//   if (authExpiryWarning) urgency = "warning";
export function deriveAuthorizationUrgency(
  input: AuthorizationUrgencyInput,
): AuthorizationUrgencyResult {
  const { remaining, authStatus = null, authValidUntil = null, now = new Date() } = input;

  let urgency: AuthUrgency = "ok";
  if (remaining === 0) urgency = "exhausted";
  else if (remaining <= 2) urgency = "critical";
  else if (remaining <= 3) urgency = "warning";

  if (authStatus === "pending" && urgency === "ok") urgency = "pending";
  if (authStatus === "denied") urgency = "exhausted";

  const nowMs = now.getTime();
  const authValidUntilMs = authValidUntil !== null ? toMillis(authValidUntil) : null;
  const expiresWithin7Days =
    authValidUntilMs !== null && authValidUntilMs > nowMs && authValidUntilMs - nowMs <= SEVEN_DAYS_MS;
  const alreadyExpired = authValidUntilMs !== null && authValidUntilMs < nowMs;

  // authExpiryWarning = true means the warning is ONLY because of expiry date, not session count
  const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
  if (authExpiryWarning) urgency = "warning";

  return { urgency, authExpiryWarning };
}
