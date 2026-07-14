/**
 * server/claimsStatusCounts.test.ts
 * Unit tests for the Claims Status count aggregation logic in server/db.ts.
 */

import { describe, it, expect } from 'vitest';
import { aggregateClaimStatusCounts } from './db';

describe('aggregateClaimStatusCounts', () => {
  it('counts "all" as the total number of claim rows', () => {
    const rows = [
      { claimStatus: 'rejected', patientId: 'p1' },
      { claimStatus: 'rejected', patientId: 'p1' },
      { claimStatus: 'submitted', patientId: 'p2' },
    ];
    const { counts } = aggregateClaimStatusCounts(rows);
    expect(counts.all).toBe(3);
  });

  it('buckets each known claim_status into its own count', () => {
    const rows = [
      { claimStatus: 'rejected', patientId: 'p1' },
      { claimStatus: 'rejected', patientId: 'p1' },
      { claimStatus: 'rejected', patientId: 'p1' },
      { claimStatus: 'submitted', patientId: 'p2' },
      { claimStatus: 'approved', patientId: 'p3' },
      { claimStatus: 'pending', patientId: 'p4' },
      { claimStatus: 'denied', patientId: 'p5' },
      { claimStatus: 'pended', patientId: 'p6' },
      { claimStatus: 'resubmitted', patientId: 'p7' },
    ];
    const { counts } = aggregateClaimStatusCounts(rows);
    expect(counts).toEqual({
      all: 9,
      submitted: 1,
      approved: 1,
      pending: 1,
      denied: 1,
      pended: 1,
      rejected: 3,
      resubmitted: 1,
      none: 0,
    });
  });

  it('buckets null claim_status under "none"', () => {
    const rows = [{ claimStatus: null, patientId: 'p1' }];
    const { counts } = aggregateClaimStatusCounts(rows);
    expect(counts.none).toBe(1);
    expect(counts.all).toBe(1);
  });

  it('buckets empty-string claim_status under "none"', () => {
    const rows = [{ claimStatus: '', patientId: 'p1' }];
    const { counts } = aggregateClaimStatusCounts(rows);
    expect(counts.none).toBe(1);
  });

  it('buckets an unrecognized claim_status value under "none" without dropping it from "all"', () => {
    const rows = [{ claimStatus: 'some-legacy-value', patientId: 'p1' }];
    const { counts } = aggregateClaimStatusCounts(rows);
    expect(counts.none).toBe(1);
    expect(counts.all).toBe(1);
  });

  it('returns zeroed counts for an empty input', () => {
    const { counts } = aggregateClaimStatusCounts([]);
    expect(counts).toEqual({
      all: 0, submitted: 0, approved: 0, pending: 0, denied: 0,
      pended: 0, rejected: 0, resubmitted: 0, none: 0,
    });
  });

  it('collects the distinct patient IDs matching each status (this is what the reference bug needs: 3 rejected claim rows for ALLISON, all under one patientId, should count as 3 in the rejected total but only appear once in patientIdsByStatus.rejected)', () => {
    const rows = [
      { claimStatus: 'rejected', patientId: 'allison-id' },
      { claimStatus: 'rejected', patientId: 'allison-id' },
      { claimStatus: 'rejected', patientId: 'allison-id' },
      { claimStatus: 'submitted', patientId: 'other-id' },
    ];
    const { counts, patientIdsByStatus } = aggregateClaimStatusCounts(rows);
    expect(counts.rejected).toBe(3);
    expect(patientIdsByStatus.rejected).toEqual(['allison-id']);
    expect(patientIdsByStatus.submitted).toEqual(['other-id']);
    expect(patientIdsByStatus.none).toEqual([]);
  });
});
