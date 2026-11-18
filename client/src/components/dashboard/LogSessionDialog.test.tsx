// @vitest-environment jsdom
/**
 * Log New Session dialog: submit wiring (Enter / Confirm share one form
 * submit), duplicate-save protection, pending and error behavior, and both
 * save paths. Server procedures are mocked; each mutate() call is recorded
 * with its per-call callbacks so a test decides when and how it settles.
 *
 * jsdom does not perform implicit submission on Enter, so "Enter" is
 * exercised as the form's submit event (what the browser fires for Enter in
 * a text-like input of a form with a submit button). The real-browser
 * keyboard checks are recorded in PR #85.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

type Call = { input: any; opts: { onSuccess?: () => void; onError?: (e: { message: string }) => void } };

const h = vi.hoisted(() => {
  const invalidations: string[] = [];
  const inv = (name: string) => () => { invalidations.push(name); };
  return {
    invalidations,
    utils: {
      visits: {
        listByPatient: { invalidate: inv('listByPatient') },
        completedPatientIds: { invalidate: inv('completedPatientIds') },
        authAlerts: { invalidate: inv('authAlerts') },
      },
    },
    update: { hook: null as any, calls: [] as Call[] },
    create: { hook: null as any, calls: [] as Call[] },
    toast: { success: vi.fn(), error: vi.fn() },
  };
});

vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => h.utils,
    visits: {
      update: {
        useMutation: (hook: any) => {
          h.update.hook = hook;
          return { mutate: (input: any, opts: any) => h.update.calls.push({ input, opts }), isPending: false };
        },
      },
      create: {
        useMutation: (hook: any) => {
          h.create.hook = hook;
          return { mutate: (input: any, opts: any) => h.create.calls.push({ input, opts }), isPending: false };
        },
      },
    },
  },
}));

import { INVALID_SESSION_DATE_MESSAGE, LogSessionDialog } from './LogSessionDialog';

const PATIENT = '44444444-4444-4444-8444-444444444444';
const ROW_P1_DONE = '10000000-0000-4000-8000-000000000001';
const ROW_P2_DONE = '20000000-0000-4000-8000-000000000001';
const ROW_P2_EMPTY_A = '20000000-0000-4000-8000-000000000002';
const ROW_P2_EMPTY_B = '20000000-0000-4000-8000-000000000003';

const visit = (id: string, authPeriod: number, dateOfService: string | null) =>
  ({ id, authPeriod, dateOfService, authStatus: 'approved' }) as any;

// Period 1 fully used; period 2 is active with two undated pre-created rows.
const PRECREATED = [
  visit(ROW_P1_DONE, 1, '2026-10-01'),
  visit(ROW_P2_DONE, 2, '2026-11-02'),
  visit(ROW_P2_EMPTY_A, 2, null),
  visit(ROW_P2_EMPTY_B, 2, null),
];

function renderOpen(visits = PRECREATED, remaining = 2) {
  render(<LogSessionDialog patientId={PATIENT} patientName="SYNTH, GAMMA" remaining={remaining} activePeriod={2} visits={visits} />);
  fireEvent.click(screen.getByRole('button', { name: /log session/i }));
  const dateInput = screen.getByLabelText('Date of Service') as HTMLInputElement;
  const form = dateInput.closest('form') as HTMLFormElement;
  const confirm = screen.getByRole('button', { name: /confirm session/i }) as HTMLButtonElement;
  const cancel = screen.getByRole('button', { name: /cancel/i }) as HTMLButtonElement;
  return { dateInput, form, confirm, cancel };
}
const setDate = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
const pressEnter = (form: HTMLFormElement) => fireEvent.submit(form);
const dialogOpen = () => screen.queryByRole('dialog') !== null;

beforeEach(() => {
  h.invalidations.length = 0;
  h.update.calls.length = 0;
  h.create.calls.length = 0;
  h.toast.success.mockClear();
  h.toast.error.mockClear();
});
afterEach(cleanup);

describe('LogSessionDialog submit wiring', () => {
  it('puts the date input and Confirm Session in one form; Confirm submits, Cancel does not', () => {
    const { dateInput, form, confirm, cancel } = renderOpen();
    expect(form).toBeTruthy();
    expect(form.contains(confirm)).toBe(true);
    expect(confirm.type).toBe('submit');
    expect(cancel.type).toBe('button');
    expect(dateInput.type).toBe('date');
  });

  it('Enter (form submit) fills the first undated row of the active period, once', () => {
    const { dateInput, form } = renderOpen();
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    expect(h.update.calls).toHaveLength(1);
    expect(h.update.calls[0].input).toEqual({
      id: ROW_P2_EMPTY_A,
      dateOfService: '2026-11-17',
      sessionsRemaining: 1,
      authStatus: 'approved',
    });
    expect(h.create.calls).toHaveLength(0);
  });

  it('clicking Confirm Session goes through the same submit', () => {
    const { dateInput, confirm } = renderOpen();
    setDate(dateInput, '2026-11-17');
    fireEvent.click(confirm);
    expect(h.update.calls).toHaveLength(1);
    expect(h.update.calls[0].input.id).toBe(ROW_P2_EMPTY_A);
  });

  it('repeated Enter and Enter + click before the save settles produce exactly one save', () => {
    const { dateInput, form, confirm } = renderOpen();
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    pressEnter(form);
    pressEnter(form);
    fireEvent.click(confirm);
    expect(h.update.calls).toHaveLength(1);
    expect(confirm.disabled).toBe(true);
  });

  it('suppresses implicit submission for an auto-repeated (held) Enter', () => {
    const { dateInput } = renderOpen();
    const held = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    dateInput.dispatchEvent(held);
    expect(held.defaultPrevented).toBe(true);
    const first = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    dateInput.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
  });

  it('a blank or incomplete date shows an inline error and saves nothing', () => {
    const { dateInput, form } = renderOpen();
    setDate(dateInput, '');
    pressEnter(form);
    expect(screen.getByRole('alert').textContent).toBe(INVALID_SESSION_DATE_MESSAGE);
    expect(dateInput.getAttribute('aria-invalid')).toBe('true');
    expect(h.update.calls).toHaveLength(0);
    expect(h.create.calls).toHaveLength(0);
    // Fixing the date clears the error and allows the save.
    setDate(dateInput, '2026-11-17');
    expect(screen.queryByRole('alert')).toBeNull();
    pressEnter(form);
    expect(h.update.calls).toHaveLength(1);
  });

  it('does not save when no sessions remain', () => {
    const { dateInput, form } = renderOpen(PRECREATED, 0);
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    expect(h.update.calls).toHaveLength(0);
    expect(h.toast.error).toHaveBeenCalledWith('No sessions remaining for this patient');
  });
});

describe('LogSessionDialog pending, failure and success', () => {
  it('on failure keeps the dialog open with the entered date and an inline error; retry saves again', () => {
    const { dateInput, form, confirm } = renderOpen();
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    act(() => h.update.calls[0].opts.onError?.({ message: 'network down' }));
    expect(dialogOpen()).toBe(true);
    expect(dateInput.value).toBe('2026-11-17');
    expect(screen.getByRole('alert').textContent).toBe('Failed to log session: network down');
    expect(h.toast.error).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(false);
    pressEnter(form);
    expect(h.update.calls).toHaveLength(2);
    expect(h.update.calls[1].input.dateOfService).toBe('2026-11-17');
  });

  it('on success toasts, closes and resets; a held Enter cannot resubmit until reopened', () => {
    const { dateInput, form } = renderOpen();
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    act(() => {
      h.update.hook.onSuccess();
      h.update.calls[0].opts.onSuccess?.();
      // A held/late Enter landing after the save settles but before the close
      // re-renders (the form is still mounted here) must not save again.
      pressEnter(form);
    });
    expect(h.update.calls).toHaveLength(1);
    expect(h.toast.success).toHaveBeenCalledWith('Session logged successfully!');
    expect(h.invalidations).toEqual(['listByPatient', 'completedPatientIds', 'authAlerts']);
    expect(dialogOpen()).toBe(false);
    // Reopening releases it for the next session.
    const again = renderOpenAgain();
    pressEnter(again.form);
    expect(h.update.calls).toHaveLength(2);
  });

  it('creates a row in the active period when it has no undated rows (alternate path)', () => {
    const visits = [visit(ROW_P1_DONE, 1, '2026-10-01'), visit(ROW_P2_DONE, 2, '2026-11-02')];
    const { dateInput, form, confirm } = renderOpen(visits, 3);
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    pressEnter(form);
    expect(h.update.calls).toHaveLength(0);
    expect(h.create.calls).toHaveLength(1);
    expect(h.create.calls[0].input).toEqual({
      patientId: PATIENT,
      sessionsRemaining: 2,
      sessionNumber: 2,
      authPeriod: 2,
      dateOfService: '2026-11-17',
      newAuth: 'NO',
      authStatus: 'none',
    });
    expect(confirm.disabled).toBe(true);
    act(() => {
      h.create.hook.onSuccess();
      h.create.calls[0].opts.onSuccess?.();
    });
    expect(h.toast.success).toHaveBeenCalledWith('Session logged successfully!');
    expect(h.invalidations).toEqual(['listByPatient', 'completedPatientIds']);
    expect(dialogOpen()).toBe(false);
  });

  it('alternate path failure keeps the dialog open for retry', () => {
    const visits = [visit(ROW_P2_DONE, 2, '2026-11-02')];
    const { dateInput, form } = renderOpen(visits, 3);
    setDate(dateInput, '2026-11-17');
    pressEnter(form);
    act(() => h.create.calls[0].opts.onError?.({ message: 'period expired' }));
    expect(dialogOpen()).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('Failed to log session: period expired');
    pressEnter(form);
    expect(h.create.calls).toHaveLength(2);
  });

  it('Cancel closes without saving', () => {
    const { dateInput, cancel } = renderOpen();
    setDate(dateInput, '2026-11-17');
    fireEvent.click(cancel);
    expect(dialogOpen()).toBe(false);
    expect(h.update.calls).toHaveLength(0);
  });
});

function renderOpenAgain() {
  fireEvent.click(screen.getByRole('button', { name: /log session/i }));
  const dateInput = screen.getByLabelText('Date of Service') as HTMLInputElement;
  return { form: dateInput.closest('form') as HTMLFormElement };
}
