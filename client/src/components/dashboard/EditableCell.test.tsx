// @vitest-environment jsdom
/**
 * Session-table inline editor (Session #, Date of Service, # Authorized,
 * # Remaining, Date Authorization Submitted): Enter saves exactly once
 * (including when blur follows, or Enter repeats while saving), a failed save
 * keeps the typed value, Escape cancels, Tab and IME composition don't save,
 * and focus returns to the cell after saving.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EditableCell } from './EditableCell';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

function setup(onSave: (v: string) => any, value = '3') {
  render(<EditableCell type="number" label="Session #" value={value} display={value || null} isSaving={false} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: value || 'Click to set' }));
  return screen.getByLabelText('Session #') as HTMLInputElement;
}

describe('EditableCell keyboard entry', () => {
  it('Enter saves once even when blur follows; focus returns to the cell', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const input = setup(onSave);
    fireEvent.change(input, { target: { value: '4' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.blur(input);
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith('4');
    expect(screen.queryByLabelText('Session #')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '3' }));
  });

  it('repeated Enter and a Save click while the save is pending write once', async () => {
    const d = deferred<boolean>();
    const onSave = vi.fn(() => d.promise);
    const input = setup(onSave);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter', repeat: true });
    fireEvent.click(screen.getByRole('button', { name: '…' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => { d.resolve(true); await d.promise; });
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('a validation or server failure keeps the editor open with the typed value, and Enter retries', async () => {
    const onSave = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const input = setup(onSave);
    fireEvent.change(input, { target: { value: '7' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    const still = screen.getByLabelText('Session #') as HTMLInputElement;
    expect(still.value).toBe('7');
    await act(async () => { fireEvent.keyDown(still, { key: 'Enter' }); });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it('Escape cancels without saving; Tab and IME-composing Enter never save', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const input = setup(onSave);
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Session #')).toBeTruthy();
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Session #')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '3' }));
  });

  it('date fields save the picked date with Enter (keyboard-only date entry)', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    render(<EditableCell type="date" label="Date of Service" value="" display={null} isSaving={false} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Click to set' }));
    const input = screen.getByLabelText('Date of Service');
    fireEvent.change(input, { target: { value: '2026-01-19' } });
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(onSave).toHaveBeenCalledWith('2026-01-19');
  });
});
