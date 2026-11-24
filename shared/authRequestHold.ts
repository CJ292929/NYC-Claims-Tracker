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
// A discharged patient (isActive === false) is never actionable: their row is
// "inactive" — out of Authorization Alerts and every attention count — while
// all period/session/history data is untouched. An effective hold still wins
// (the row stays "on_hold"), so a held patient remains findable and counted
// on the On Hold page whatever their activity; discharge never creates,
// resumes or deletes a hold. Reactivating simply re-derives the category
// from current data. Claims are not classified here and are unaffected.
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
  if (isHoldEffective(alert)) return "on_hold";
  if (alert.isActive === false) return "inactive";
  return alert.urgency !== "ok" ? "attention" : "ok";
}

/** Rows to list under "Authorization Requests on Hold": every active hold,
 *  effective or superseded, so a held patient is always findable. */
export function heldAuthorizationAlerts<T extends ClassifiableAlert>(alerts: T[]): T[] {
  return alerts.filter(a => !!a.hold);
}

export const HOLD_REASON_MAX = 500;

/** Trimmed reason, or null when blank / too long. */
export function normalizeHoldReason(raw: string | null | undefined): string | null {
  const reason = (raw ?? "").trim();
  return reason.length >= 1 && reason.length <= HOLD_REASON_MAX ? reason : null;
}
