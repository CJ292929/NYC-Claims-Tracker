/**
 * server/getAuthAlertSummaries.urgencyParity.test.ts
 * Regression coverage for the C4B migration: getAuthAlertSummaries' urgency /
 * authExpiryWarning decision must produce the same observable output now that
 * it is sourced from @shared/authUrgency's deriveAuthorizationUrgency instead
 * of an inline duplicate formula.
 *
 * Does not touch Supabase — getAuthAlertSummaries itself is not called here;
 * this proves the extracted decision block, not the DB round-trip.
 */

import { describe, it, expect } from 'vitest';
import { deriveAuthorizationUrgency } from '../shared/authUrgency';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-01-15T00:00:00.000Z');

function ms(offsetDays: number): number {
  return NOW.getTime() + offsetDays * DAY_MS;
}

// Frozen copy of the pre-C4B inline urgency block that lived in
// getAuthAlertSummaries (server/db.ts), kept deliberately duplicated (not
// imported) so this test fails if the shared helper ever drifts from the
// server's original inline logic.
function oldServerUrgency(
  sessionsRemaining: number,
  authStatus: string | null,
  authValidUntil: number | null,
  now: number,
): { urgency: string; authExpiryWarning: boolean } {
  let urgency = 'ok';
  if (sessionsRemaining === 0) urgency = 'exhausted';
  else if (sessionsRemaining <= 2) urgency = 'critical';
  else if (sessionsRemaining <= 3) urgency = 'warning';
  if (authStatus === 'pending' && urgency === 'ok') urgency = 'pending';
  if (authStatus === 'denied') urgency = 'exhausted';

  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const expiresWithin7Days = authValidUntil !== null && authValidUntil > now && authValidUntil - now <= sevenDaysMs;
  const alreadyExpired = authValidUntil !== null && authValidUntil < now;
  const authExpiryWarning = (expiresWithin7Days || alreadyExpired) && urgency === 'ok';
  if (authExpiryWarning) urgency = 'warning';

  return { urgency, authExpiryWarning };
}

const fixtures: Array<{
  name: string;
  remaining: number;
  authStatus: string | null;
  authValidUntil: number | null;
  expected: { urgency: string; authExpiryWarning: boolean };
}> = [
  { name: 'remaining 0 + approved', remaining: 0, authStatus: 'approved', authValidUntil: null,
    expected: { urgency: 'exhausted', authExpiryWarning: false } },
  { name: 'remaining 1 + approved', remaining: 1, authStatus: 'approved', authValidUntil: null,
    expected: { urgency: 'critical', authExpiryWarning: false } },
  { name: 'remaining 2 + pending', remaining: 2, authStatus: 'pending', authValidUntil: null,
    expected: { urgency: 'critical', authExpiryWarning: false } },
  { name: 'remaining 3 + approved', remaining: 3, authStatus: 'approved', authValidUntil: null,
    expected: { urgency: 'warning', authExpiryWarning: false } },
  { name: 'remaining >3 + pending', remaining: 8, authStatus: 'pending', authValidUntil: null,
    expected: { urgency: 'pending', authExpiryWarning: false } },
  { name: 'remaining >3 + approved + expiry within 7 days', remaining: 8, authStatus: 'approved', authValidUntil: ms(3),
    expected: { urgency: 'warning', authExpiryWarning: true } },
  { name: 'remaining >3 + approved + expired', remaining: 8, authStatus: 'approved', authValidUntil: ms(-3),
    expected: { urgency: 'warning', authExpiryWarning: true } },
  { name: 'remaining >3 + denied', remaining: 8, authStatus: 'denied', authValidUntil: null,
    expected: { urgency: 'exhausted', authExpiryWarning: false } },
  { name: 'remaining 1 + denied', remaining: 1, authStatus: 'denied', authValidUntil: null,
    expected: { urgency: 'exhausted', authExpiryWarning: false } },
  { name: 'pending + expiring soon', remaining: 8, authStatus: 'pending', authValidUntil: ms(3),
    expected: { urgency: 'pending', authExpiryWarning: false } },
];

describe('getAuthAlertSummaries urgency (post-C4B): shared helper matches pre-migration server output', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      const old = oldServerUrgency(fixture.remaining, fixture.authStatus, fixture.authValidUntil, NOW.getTime());
      const shared = deriveAuthorizationUrgency({
        remaining: fixture.remaining,
        authStatus: fixture.authStatus,
        authValidUntil: fixture.authValidUntil,
        now: NOW,
      });

      expect(old).toEqual(fixture.expected);
      expect(shared).toEqual(fixture.expected);
      expect(shared).toEqual(old);
    });
  }
});
