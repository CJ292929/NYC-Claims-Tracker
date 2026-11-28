/**
 * client/src/lib/keyboardEntry.ts
 *
 * Shared keyboard-entry rules ("Enter saves, no mouse needed"), applied per
 * field or per form — never as a global key handler, so Enter can only ever
 * submit the form or editor the user is typing in.
 *
 *   single-line inline editor   Enter saves, Escape cancels
 *   standard form               Enter in an input submits through the form's
 *                               own validated submit handler (native implicit
 *                               submission; nothing extra is needed)
 *   multiline field             Enter inserts a newline; Ctrl+Enter (Cmd+Enter
 *                               on macOS) saves
 *   dropdowns / date pickers    left to the component: a Radix Select item or
 *                               the browser's date popup consumes its own Enter,
 *                               and its trigger is a type="button", so
 *                               confirming a choice never submits a form
 *
 * Every rule ignores IME composition (Enter that confirms a composed word) and
 * key auto-repeat (a held Enter), so one key press saves at most once. The
 * callers' single-flight guards cover the rest (Enter + blur, Enter + click,
 * Enter while a save is pending).
 */
import type { KeyboardEvent } from 'react';

/** True while an IME is composing (keyCode 229 covers older Safari). */
export function isComposing(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export type InlineKeyIntent = 'save' | 'cancel' | null;

/**
 * What a key press means inside an inline editor. Single-line: Enter saves.
 * Multiline: only Ctrl/Cmd+Enter saves (plain Enter types a newline).
 * Escape cancels in both. Repeats and IME composition mean nothing.
 */
export function inlineKeyIntent(e: KeyboardEvent, opts: { multiline?: boolean } = {}): InlineKeyIntent {
  if (isComposing(e)) return null;
  if (e.key === 'Escape') return 'cancel';
  if (e.key !== 'Enter' || e.repeat || e.shiftKey || e.altKey) return null;
  if (opts.multiline) return e.ctrlKey || e.metaKey ? 'save' : null;
  return 'save';
}

/**
 * onKeyDown for a <form>: drops the implicit submission a held Enter or an
 * IME-confirming Enter would otherwise trigger. Plain Enter still submits.
 */
export function guardFormEnter(e: KeyboardEvent<HTMLElement>): void {
  if (e.key === 'Enter' && (e.repeat || isComposing(e))) e.preventDefault();
}

/**
 * onKeyDown for a <textarea> inside a <form>: Ctrl/Cmd+Enter submits that
 * form through its own submit handler (requestSubmit runs validation and the
 * onSubmit guard). Plain Enter is left alone and inserts a newline.
 */
export function submitFormOnModEnter(e: KeyboardEvent<HTMLTextAreaElement>): void {
  if (inlineKeyIntent(e, { multiline: true }) !== 'save') return;
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}

/**
 * onSubmit for a form: prevents the page navigation and stops the React
 * submit event from bubbling. React propagates synthetic events through
 * portals, so without this a form inside a dialog opened from another form
 * (Correct Count inside Edit Patient) would also submit the outer form.
 */
export function onFormSubmit(fn: () => void) {
  return (e: { preventDefault(): void; stopPropagation(): void }) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };
}

/** The visible hint shown under multiline fields. */
export const MOD_ENTER_HINT =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '')
    ? '⌘+Enter to save'
    : 'Ctrl+Enter to save';
