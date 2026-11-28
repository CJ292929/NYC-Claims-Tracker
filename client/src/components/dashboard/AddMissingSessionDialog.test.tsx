// @vitest-environment jsdom
/**
 * Add Missing Session: sends the EXPLICIT period (never the newest), submits
 * once (Enter / repeated Enter / click share one guarded submit), keeps the
 * typed date and shows the server's message on failure, refuses obviously
 * bad dates before sending, refreshes sessions/counts/claims on success, and
 * explains a full period instead of offering a save.
 *
 * jsdom does not perform implicit submission on Enter, so Enter is exercised
 * as the form's submit event (see LogSessionDialog.test.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

type Call = { input: any; opts: { onSuccess?: (o: any) => void; onError?: (e: { message: string }) => void; onSettled?: () => void } };

const h = vi.hoisted(() => {
  const invalidations: Array<[string, unknown]> = [];
  const inv = (name: string) => (arg?: unknown) => { invalidations.push([name, arg]); };
  return {
    invalidations,
    utils: {
      visits: {
        listByPatient: { invalidate: inv('listByPatient') },
        completedPatientIds: { invalidate: inv('completedPatientIds') },
        authAlerts: { invalidate: inv('authAlerts') },
        historyForPatient: { invalidate: inv('historyForPatient') },
      },
      claims: { getByPatientAndPeriod: { invalidate: inv('claims') } },
    },
    calls: [] as Call[],
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => h.utils,
    visits: {
      addMissingSession: {
        useMutation: () => ({ mutate: (input: any, opts: any) => h.calls.push({ input, opts }), isPending: false }),
      },
    },
  },
}));

import { AddMissingSessionDialog, INVALID_MISSING_SESSION_DATE, newYorkDateOf } from './AddMissingSessionDialog';

const PATIENT = '44444444-4444-4444-8444-444444444444';
const base = { patientId: PATIENT, patientName: 'Synthetic Patient', period: 1, authorized: 6, completed: 3, unusedRows: 3, expired: true, periodExpiredAt: '2026-11-20T15:00:00Z' };

beforeEach(() => { h.calls.length = 0; h.invalidations.length = 0; h.toast.success.mockReset(); });
afterEach(cleanup);

function open(props = base) {
  render(<AddMissingSessionDialog {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /add missing session to authorization period 1/i }));
  return screen.queryByLabelText('Date of Service') as HTMLInputElement;
}
const form = () => screen.getByLabelText('Date of Service').closest('form')!;

describe('AddMissingSessionDialog', () => {
  it('Enter submits the explicitly selected period once, even when repeated', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '2026-01-19' } });
    fireEvent.submit(form());
    fireEvent.submit(form());
    fireEvent.click(screen.getByRole('button', { name: /add session to period 1/i }));
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].input).toEqual({ patientId: PATIENT, authPeriod: 1, dateOfService: '2026-01-19' });
  });

  it('success refreshes sessions, counts, alerts, history and this period’s claims, then closes', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '2026-01-19' } });
    fireEvent.submit(form());
    act(() => { h.calls[0].opts.onSuccess?.({ sessionNumber: 4 }); h.calls[0].opts.onSettled?.(); });
    expect(h.invalidations).toEqual(expect.arrayContaining([
      ['listByPatient', { patientId: PATIENT }], ['completedPatientIds', undefined], ['authAlerts', undefined],
      ['historyForPatient', { patientId: PATIENT }], ['claims', { patientId: PATIENT, authPeriod: 1 }],
    ]));
    expect(h.toast.success).toHaveBeenCalledWith(expect.stringMatching(/Period 1 as Session 4\. Period 1 was not restored/));
    expect(screen.queryByLabelText('Date of Service')).toBeNull();
  });

  it('a server refusal stays inline with the typed date kept, and a retry is allowed', () => {
    const input = open();
    fireEvent.change(input, { target: { value: '2026-01-12' } });
    fireEvent.submit(form());
    act(() => { h.calls[0].opts.onError?.({ message: 'That date of service is already recorded as Period 1, Session 2.' }); h.calls[0].opts.onSettled?.(); });
    expect(screen.getByRole('alert').textContent).toMatch(/already recorded as Period 1, Session 2/);
    expect((screen.getByLabelText('Date of Service') as HTMLInputElement).value).toBe('2026-01-12');
    fireEvent.submit(form());
    expect(h.calls).toHaveLength(2);
  });

  it('incomplete, future and after-expiry dates are refused before sending', () => {
    const input = open();
    fireEvent.submit(form());
    expect(screen.getByRole('alert').textContent).toBe(INVALID_MISSING_SESSION_DATE);
    fireEvent.change(input, { target: { value: '2099-01-01' } });
    fireEvent.submit(form());
    expect(screen.getByRole('alert').textContent).toMatch(/expiry date|future/);
    expect(h.calls).toHaveLength(0);
    expect(input.max).toBe(newYorkDateOf(base.periodExpiredAt));
  });

  it('a period with no unused session explains the limit and offers no save', () => {
    open({ ...base, completed: 6, unusedRows: 0 });
    expect(screen.getByRole('alert').textContent).toMatch(/without exceeding the authorization.*add the claim/);
    expect(screen.queryByRole('button', { name: /add session to period/i })).toBeNull();
  });
});
