import { describe, it, expect } from 'vitest';
import {
  getClaimsFollowUpViewState,
  formatChargeAmount,
  formatReimbursement,
  formatDateOrDash,
  getFollowUpRowStyle,
} from './claimsFollowUpViewState';

describe('getClaimsFollowUpViewState', () => {
  it('does not treat a failed query as the all-clear empty state', () => {
    const state = getClaimsFollowUpViewState({ isLoading: false, isError: true, data: [] });
    expect(state).toBe('error');
    expect(state).not.toBe('empty');
  });

  it('treats a successful query with zero rows as the true empty state', () => {
    expect(getClaimsFollowUpViewState({ isLoading: false, isError: false, data: [] })).toBe('empty');
  });

  it('prioritizes loading over error and data', () => {
    expect(getClaimsFollowUpViewState({ isLoading: true, isError: true, data: [{}] })).toBe('loading');
  });

  it('returns data when the query succeeds with rows', () => {
    expect(getClaimsFollowUpViewState({ isLoading: false, isError: false, data: [{ id: '1' }] })).toBe('data');
  });
});

describe('money and date formatting (shared by table and card views)', () => {
  it('formats a charge amount or falls back to an em dash', () => {
    expect(formatChargeAmount(120.5)).toBe('$120.50');
    expect(formatChargeAmount(null)).toBe('—');
    expect(formatChargeAmount(undefined)).toBe('—');
  });

  it('formats reimbursement, defaulting missing values to $0.00', () => {
    expect(formatReimbursement(75)).toBe('$75.00');
    expect(formatReimbursement(null)).toBe('$0.00');
  });

  it('formats a date or falls back to an em dash', () => {
    expect(formatDateOrDash(null)).toBe('—');
    expect(formatDateOrDash('2026-01-05')).toBe(new Date('2026-01-05').toLocaleDateString());
  });
});

describe('getFollowUpRowStyle', () => {
  it('maps known statuses to their product-spec color', () => {
    expect(getFollowUpRowStyle('denied').badge).toContain('bg-red-100');
    expect(getFollowUpRowStyle('approved').badge).toContain('bg-green-100');
  });

  it('falls back to the rejected style for unknown statuses', () => {
    expect(getFollowUpRowStyle('unknown-status')).toEqual(getFollowUpRowStyle('rejected'));
  });
});
