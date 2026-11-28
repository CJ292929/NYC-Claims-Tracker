// @vitest-environment jsdom
/**
 * Shared keyboard-entry rules: Enter / Escape / Ctrl+Enter intents, IME
 * composition and key repeat, Ctrl+Enter submitting a textarea's own form,
 * and a dialog form (portal) never submitting the form it was opened from.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { guardFormEnter, inlineKeyIntent, onFormSubmit, submitFormOnModEnter } from './keyboardEntry';

afterEach(cleanup);

const ev = (over: Record<string, unknown>) => ({
  key: 'Enter', repeat: false, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, keyCode: 13,
  nativeEvent: { isComposing: false },
  ...over,
}) as any;

describe('inlineKeyIntent', () => {
  it('single-line: Enter saves, Escape cancels, other keys (Tab) do nothing', () => {
    expect(inlineKeyIntent(ev({}))).toBe('save');
    expect(inlineKeyIntent(ev({ key: 'Escape', keyCode: 27 }))).toBe('cancel');
    expect(inlineKeyIntent(ev({ key: 'Tab', keyCode: 9 }))).toBeNull();
  });
  it('ignores a held (auto-repeat) Enter and Enter while an IME is composing', () => {
    expect(inlineKeyIntent(ev({ repeat: true }))).toBeNull();
    expect(inlineKeyIntent(ev({ nativeEvent: { isComposing: true } }))).toBeNull();
    expect(inlineKeyIntent(ev({ keyCode: 229 }))).toBeNull();
    expect(inlineKeyIntent(ev({ key: 'Escape', nativeEvent: { isComposing: true } }))).toBeNull();
  });
  it('multiline: plain and Shift+Enter type a newline; Ctrl+Enter and Cmd+Enter save', () => {
    expect(inlineKeyIntent(ev({}), { multiline: true })).toBeNull();
    expect(inlineKeyIntent(ev({ shiftKey: true }), { multiline: true })).toBeNull();
    expect(inlineKeyIntent(ev({ ctrlKey: true }), { multiline: true })).toBe('save');
    expect(inlineKeyIntent(ev({ metaKey: true }), { multiline: true })).toBe('save');
    expect(inlineKeyIntent(ev({ ctrlKey: true, nativeEvent: { isComposing: true } }), { multiline: true })).toBeNull();
  });
});

describe('guardFormEnter', () => {
  it('cancels the implicit submission of a held or composing Enter only', () => {
    for (const [over, prevented] of [[{}, false], [{ repeat: true }, true], [{ nativeEvent: { isComposing: true } }, true]] as const) {
      const preventDefault = vi.fn();
      guardFormEnter(ev({ ...over, preventDefault }));
      expect(preventDefault).toHaveBeenCalledTimes(prevented ? 1 : 0);
    }
  });
});

describe('submitFormOnModEnter', () => {
  function Form({ onSubmit }: { onSubmit: () => void }) {
    return (
      <form onSubmit={onFormSubmit(onSubmit)}>
        <textarea aria-label="Reason" onKeyDown={submitFormOnModEnter} />
        <button type="submit">Save</button>
      </form>
    );
  }
  it('Ctrl+Enter submits the textarea’s form once; plain Enter and composing Ctrl+Enter do not', () => {
    const onSubmit = vi.fn();
    render(<Form onSubmit={onSubmit} />);
    const box = screen.getByLabelText('Reason');
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true, isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });
});

describe('onFormSubmit', () => {
  it('a form rendered in a portal (dialog) does not also submit the form it was opened from', () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <form aria-label="outer" onSubmit={onFormSubmit(outer)}>
        {createPortal(
          <form aria-label="inner" onSubmit={onFormSubmit(inner)}><button type="submit">Inner</button></form>,
          document.body,
        )}
      </form>,
    );
    fireEvent.submit(screen.getByRole('form', { name: 'inner' }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });
});
