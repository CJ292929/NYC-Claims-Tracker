// The ONE classification of an authorization alert row (trpc.visits.authAlerts,
// server/db.ts getAuthAlertSummaries) into what the dashboard shows. Every
// list, badge and count — Authorization Alerts, the Authorization Attention
// KPI, Needs Attention, "Authorization Requests on Hold" — goes through
// classifyAuthorizationAlert, so a count and its list can never disagree.
//
// A hold is temporary and manual: it never changes urgency, status, period
// expiry, sessions or claims. It only moves the row out of the actionable
// queue while it matches the period it was placed on. Once a newer period
// exists (or the patient's target period otherwise moves), the hold is
// "superseded": it stops suppressing anything, and the row is classified
// from its current data exactly as if there were no hold.
//
// A discharged patient (stored isActive === false — never inferred from hold
// or note text) is never operational: their row is "inactive" — out of
// Authorization Alerts, every attention count AND the On Hold card/count/list
// (client requirement 2026-11-25, superseding "a held patient stays on the On
// Hold page"). Discharge never creates, resumes or deletes a hold: the hold
// row, its reason and its audit trail stay stored and visible in the
// patient's own detail/history. Reactivating re-derives the category from
// current data: a hold placed on the current period is effective again
// ("on_hold"); a hold from an older period stays superseded and suppresses
// nothing. Claims are not classified here and are unaffected.
import type { AuthUrgency } from "./authUrgency";

export interface AuthorizationRequestHoldInfo {
  holdId: string;
  /** Period the hold was placed on; null = patient had no period yet. */
  authPeriod: number | null;
  reason: string;
  /** ISO timestamp. */
  heldAt: string;
  heldByDisplay: string;
}

export type AuthorizationAlertCategory = "on_hold" | "attention" | "inactive" | "ok";

export interface ClassifiableAlert {
  urgency: AuthUrgency;
  /** The row's current target period (null = no period yet). */
  authPeriod: number | null;
  hold?: AuthorizationRequestHoldInfo | null;
  /** false = discharged. Absent is treated as active (older callers / fixtures). */
  isActive?: boolean;
}

/** True when the row's hold still applies to its current target period. */
export function isHoldEffective(alert: ClassifiableAlert): boolean {
  return !!alert.hold && alert.hold.authPeriod === alert.authPeriod;
}

/** True when the row carries an active hold placed on a different period than its current one. */
export function isHoldSuperseded(alert: ClassifiableAlert): boolean {
  return !!alert.hold && alert.hold.authPeriod !== alert.authPeriod;
}

export function classifyAuthorizationAlert(alert: ClassifiableAlert): AuthorizationAlertCategory {
  if (alert.isActive === false) return "inactive";
  if (isHoldEffective(alert)) return "on_hold";
  return alert.urgency !== "ok" ? "attention" : "ok";
}

/** Rows to list under "Authorization Requests on Hold": every active hold of
 *  an active (not discharged) patient, effective or superseded. Discharged
 *  patients' holds are kept but shown only in their patient history. */
export function heldAuthorizationAlerts<T extends ClassifiableAlert>(alerts: T[]): T[] {
  return alerts.filter(a => !!a.hold && a.isActive !== false);
}

export const HOLD_REASON_MAX = 500;

/** Trimmed reason, or null when blank / too long. */
export function normalizeHoldReason(raw: string | null | undefined): string | null {
  const reason = (raw ?? "").trim();
  return reason.length >= 1 && reason.length <= HOLD_REASON_MAX ? reason : null;
}
