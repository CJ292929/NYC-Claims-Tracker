// @vitest-environment jsdom
/**
 * Remarks (multiline): Enter inserts a newline and never saves, Ctrl+Enter /
 * Cmd+Enter saves once (repeat and pending presses ignored), a visible hint
 * says so, Escape cancels, and a failed save keeps the typed remarks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  utils: {
    visits: {
      listByPatient: { setData: vi.fn(), invalidate: vi.fn() },
      historyForPatient: { invalidate: vi.fn() },
    },
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/trpc', () => ({
  trpc: {
    useUtils: () => h.utils,
    visits: { updateSessionFields: { useMutation: () => ({ mutateAsync: h.mutateAsync }) } },
  },
}));

import { RemarksCell } from './SessionWorkflowCells';

const PATIENT = '44444444-4444-4444-8444-444444444444';
const VISIT = { id: '10000000-0000-4000-8000-000000000001', remarks: null };

beforeEach(() => { h.mutateAsync.mockReset(); });
afterEach(cleanup);

function edit() {
  render(<RemarksCell patientId={PATIENT} visit={VISIT} />);
  fireEvent.click(screen.getByRole('button', { name: /add remarks/i }));
  return screen.getByLabelText('Remarks') as HTMLTextAreaElement;
}

describe('RemarksCell keyboard entry', () => {
  it('Enter never saves; Ctrl+Enter saves once with a visible hint', async () => {
    let resolve!: (v: unknown) => void;
    h.mutateAsync.mockReturnValue(new Promise(r => { resolve = r; }));
    const box = edit();
    expect(screen.getByText(/Ctrl\+Enter to save|⌘\+Enter to save/)).toBeTruthy();
    fireEvent.change(box, { target: { value: 'Line one\nLine two' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(h.mutateAsync).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, repeat: true });
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    expect(h.mutateAsync.mock.calls[0][0]).toMatchObject({ remarks: 'Line one\nLine two' });
    await act(async () => { resolve({ id: VISIT.id, remarks: 'Line one\nLine two', assignmentOfBenefits: null, submissionStatus: null }); });
    expect(screen.queryByLabelText('Remarks')).toBeNull();
  });

  it('Escape cancels; a failed save keeps the typed remarks open', async () => {
    h.mutateAsync.mockRejectedValue(new Error('network'));
    let box = edit();
    fireEvent.change(box, { target: { value: 'Draft' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true }); });
    box = screen.getByLabelText('Remarks') as HTMLTextAreaElement;
    expect(box.value).toBe('Draft');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByLabelText('Remarks')).toBeNull();
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
  });
});
