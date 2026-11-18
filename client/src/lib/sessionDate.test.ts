import { describe, expect, it } from 'vitest';
import { isCompleteSessionDate } from './sessionDate';

describe('isCompleteSessionDate', () => {
  it('accepts complete, real dates', () => {
    expect(isCompleteSessionDate('2026-11-18')).toBe(true);
    expect(isCompleteSessionDate('2024-02-29')).toBe(true); // leap year
    expect(isCompleteSessionDate('2026-12-31')).toBe(true);
  });

  it('rejects blank or partial input (native date input reports "")', () => {
    expect(isCompleteSessionDate('')).toBe(false);
    expect(isCompleteSessionDate('2026-11')).toBe(false);
    expect(isCompleteSessionDate('2026-1-5')).toBe(false);
    expect(isCompleteSessionDate(' 2026-11-18')).toBe(false);
  });

  it('rejects impossible calendar dates', () => {
    expect(isCompleteSessionDate('2025-02-29')).toBe(false);
    expect(isCompleteSessionDate('2026-04-31')).toBe(false);
    expect(isCompleteSessionDate('2026-13-01')).toBe(false);
    expect(isCompleteSessionDate('2026-00-10')).toBe(false);
    expect(isCompleteSessionDate('2026-01-00')).toBe(false);
    expect(isCompleteSessionDate('0000-01-01')).toBe(false);
  });
});
