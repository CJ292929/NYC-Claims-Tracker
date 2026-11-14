// Pure authorization-urgency primitive. No React, no Supabase, no
// server/client dependencies — safe to import from either side of the
// client/server boundary. Mirrors the urgency derivation currently inlined
// in server/db.ts getAuthAlertSummaries.
//
// C5: "denied" is a first-class urgency, distinct from "exhausted". A denied
// authorization is factually different from one that ran out of sessions,
// even though both are top-priority alerts. Denied still overrides every
// other tier exactly as the old "denied" -> "exhausted" mapping did — only
// the label changed, not the precedence. See
// server/getAuthAlertSummaries.urgencyParity.test.ts for the frozen pre-C5
// reference behavior this intentionally diverges from.

// P4-P31: "expired" — staff manually marked the target authorization period
// Expired. Distinct from both "exhausted" (sessions all used) and "denied".
export type AuthUrgency = "exhausted" | "critical" | "warning" | "pending" | "ok" | "denied" | "expired";

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
  /** P4-P31: the target period was manually marked Expired (see shared/authPeriodMetrics.ts). */
  periodExpired?: boolean;
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

// Mirrors server/db.ts getAuthAlertSummaries, with the C5 denied-urgency
// change applied:
//
//   let urgency = "ok";
//   if (sessionsRemaining === 0) urgency = "exhausted";
//   else if (sessionsRemaining <= 2) urgency = "critical";
//   else if (sessionsRemaining <= 3) urgency = "warning";
//   if (authStatus === "pending" && urgency === "ok") urgency = "pending";
//   if (authStatus === "denied") urgency = "denied";
//
//   const expiresWithin7Days = authValidUntil !== null && authValidUntil > now && authValidUntil - now <= sevenDaysMs;
//   const alreadyExpired = authValidUntil !== null && authValidUntil < now;
//   const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === "ok";
//   if (authExpiryWarning) urgency = "warning";
export function deriveAuthorizationUrgency(
  input: AuthorizationUrgencyInput,
): AuthorizationUrgencyResult {
  const { remaining, authStatus = null, authValidUntil = null, now = new Date(), periodExpired = false } = input;

  let urgency: AuthUrgency = "ok";
  if (remaining === 0) urgency = "exhausted";
  else if (remaining <= 2) urgency = "critical";
  else if (remaining <= 3) urgency = "warning";

  if (authStatus === "pending" && urgency === "ok") urgency = "pending";
  // P4-P31: an expired period has no available sessions, but it is not
  // "exhausted" — it shows as expired. Once a new authorization has been
  // requested from it (its status row is pending) it shows as pending, so
  // Approved / Re-request stay reachable.
  if (periodExpired || authStatus === "expired") {
    urgency = authStatus === "pending" ? "pending" : "expired";
  }
  // Denied is top priority: it overrides every remaining-session tier above,
  // exactly as the old denied -> exhausted mapping did.
  if (authStatus === "denied") urgency = "denied";

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
