/**
 * server/claimsFollowUp.test.ts
 * Unit tests for the Claims Follow-Up classification logic in server/db.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyClaimFollowUp,
  sortByFollowUpUrgency,
  FOLLOW_UP_STALE_DAYS,
} from './db';

const NOW = new Date('2026-07-14T00:00:00Z');

function daysAgo(n: number): string {
  const d = new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
  return d.toISOString().split('T')[0];
}

describe('classifyClaimFollowUp', () => {
  it('flags rejected claims regardless of reimbursement or date', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'rejected', insuranceReimbursement: 150, claimSubmittedDate: daysAgo(1) },
      NOW
    );
    expect(result).toEqual({ urgency: 'rejected', followUpReason: 'Claim rejected — needs review' });
  });

  it('flags denied claims', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'denied', insuranceReimbursement: null, claimSubmittedDate: null },
      NOW
    );
    expect(result).toEqual({ urgency: 'denied', followUpReason: 'Claim denied — needs appeal or resubmission' });
  });

  it('flags pended claims', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'pended', insuranceReimbursement: null, claimSubmittedDate: daysAgo(2) },
      NOW
    );
    expect(result).toEqual({ urgency: 'pended', followUpReason: 'Claim pended — waiting on additional info' });
  });

  it('flags approved claims with null reimbursement as a data-entry gap', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'approved', insuranceReimbursement: null, claimSubmittedDate: daysAgo(1) },
      NOW
    );
    expect(result).toEqual({ urgency: 'approved_unpaid', followUpReason: 'Approved but no reimbursement recorded' });
  });

  it('flags approved claims with zero reimbursement', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'approved', insuranceReimbursement: 0, claimSubmittedDate: daysAgo(1) },
      NOW
    );
    expect(result?.urgency).toBe('approved_unpaid');
  });

  it('does not flag approved claims that were actually paid', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'approved', insuranceReimbursement: 120, claimSubmittedDate: daysAgo(60) },
      NOW
    );
    expect(result).toBeNull();
  });

  it('flags pending claims older than 30 days', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'pending', insuranceReimbursement: null, claimSubmittedDate: daysAgo(31) },
      NOW
    );
    expect(result).toEqual({ urgency: 'pending_stale', followUpReason: 'Pending >30 days — follow up with payer' });
  });

  it('does not flag pending claims within 30 days', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'pending', insuranceReimbursement: null, claimSubmittedDate: daysAgo(10) },
      NOW
    );
    expect(result).toBeNull();
  });

  it('does not flag pending claims with no submitted date (cannot determine staleness)', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'pending', insuranceReimbursement: null, claimSubmittedDate: null },
      NOW
    );
    expect(result).toBeNull();
  });

  it('flags submitted claims unpaid after 30 days', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'submitted', insuranceReimbursement: 0, claimSubmittedDate: daysAgo(45) },
      NOW
    );
    expect(result).toEqual({ urgency: 'submitted_stale', followUpReason: 'Submitted >30 days ago — no payment received' });
  });

  it('does not flag submitted claims unpaid but still within 30 days', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'submitted', insuranceReimbursement: null, claimSubmittedDate: daysAgo(5) },
      NOW
    );
    expect(result).toBeNull();
  });

  it('does not flag submitted claims that were paid, even if old', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'submitted', insuranceReimbursement: 200, claimSubmittedDate: daysAgo(90) },
      NOW
    );
    expect(result).toBeNull();
  });

  it('flags resubmitted claims only once the resubmission itself is stale', () => {
    const stale = classifyClaimFollowUp(
      { claimStatus: 'resubmitted', insuranceReimbursement: null, claimSubmittedDate: daysAgo(31) },
      NOW
    );
    expect(stale).toEqual({ urgency: 'resubmitted_stale', followUpReason: 'Resubmitted >30 days ago — no response' });

    const fresh = classifyClaimFollowUp(
      { claimStatus: 'resubmitted', insuranceReimbursement: null, claimSubmittedDate: daysAgo(2) },
      NOW
    );
    expect(fresh).toBeNull();
  });

  it('does not flag a resubmitted claim with no date', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'resubmitted', insuranceReimbursement: null, claimSubmittedDate: null },
      NOW
    );
    expect(result).toBeNull();
  });

  it('treats exactly 30 days as not yet stale (threshold is "older than" 30 days)', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'pending', insuranceReimbursement: null, claimSubmittedDate: daysAgo(FOLLOW_UP_STALE_DAYS) },
      NOW
    );
    expect(result).toBeNull();
  });

  it('does not flag claims in other statuses (e.g. "none")', () => {
    const result = classifyClaimFollowUp(
      { claimStatus: 'none', insuranceReimbursement: null, claimSubmittedDate: daysAgo(90) },
      NOW
    );
    expect(result).toBeNull();
  });
});

describe('sortByFollowUpUrgency', () => {
  it('orders claims by urgency rank: rejected, denied, pended, approved_unpaid, pending_stale, submitted_stale, resubmitted_stale', () => {
    const items = [
      { urgency: 'resubmitted_stale' as const, id: 'r' },
      { urgency: 'pending_stale' as const, id: 'p' },
      { urgency: 'denied' as const, id: 'd' },
      { urgency: 'submitted_stale' as const, id: 's' },
      { urgency: 'approved_unpaid' as const, id: 'a' },
      { urgency: 'rejected' as const, id: 'rj' },
      { urgency: 'pended' as const, id: 'pd' },
    ];
    const sorted = sortByFollowUpUrgency(items).map((i) => i.id);
    expect(sorted).toEqual(['rj', 'd', 'pd', 'a', 'p', 's', 'r']);
  });
});
