/**
 * client/src/components/dashboard/EditableCell.tsx
 *
 * Generic click-to-edit cell for a single date/number field on a visit row
 * (session #, date of service, # authorized, # remaining, date auth
 * submitted). Moved out of pages/Dashboard.tsx so its keyboard behavior can
 * be tested directly.
 *
 * `onSave` returns `false` to keep the field open with the typed value (failed
 * validation or a rejected mutation); anything else closes it.
 *
 * Keyboard (client/src/lib/keyboardEntry.ts): Enter saves, Escape cancels,
 * Tab moves on normally. Blur never saves (Save / Cancel stay explicit), so
 * Enter followed by blur writes once. A synchronous single-flight guard drops
 * a second Enter or a Save click while a save is still pending. After a save
 * or cancel, focus returns to the cell's button so keyboard entry can go on.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { createSingleFlightGuard } from '@/lib/concurrencyGuards';
import { inlineKeyIntent } from '@/lib/keyboardEntry';

export interface EditableCellProps {
  type: 'date' | 'number';
  value: string;
  display: ReactNode;
  onSave: (value: string) => Promise<boolean | void> | boolean | void;
  isSaving: boolean;
  min?: number;
  step?: number;
  emptyLabel?: string;
  /** Accessible name of the field being edited (e.g. "Date of Service"). */
  label?: string;
  /** Extra buttons shown beside Save / Cancel while editing. */
  extraActions?: ReactNode;
}

export function EditableCell({
  type, value, display, onSave, isSaving, min, step, emptyLabel = 'Click to set', label, extraActions,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const guard = useRef(createSingleFlightGuard());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);

  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [editing]);

  const close = () => { refocus.current = true; setEditing(false); };

  const save = async () => {
    if (!guard.current.tryEnter()) return;
    setSaving(true);
    try {
      const result = await onSave(draft);
      if (result !== false) close();
    } finally {
      guard.current.exit();
      setSaving(false);
    }
  };

  if (editing) {
    const busy = isSaving || saving;
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <input
          type={type}
          min={min}
          step={step}
          value={draft}
          aria-label={label}
          aria-busy={busy}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            const intent = inlineKeyIntent(e);
            if (intent === 'save') { e.preventDefault(); void save(); }
            else if (intent === 'cancel') { e.preventDefault(); if (!guard.current.isBusy) close(); }
          }}
          autoFocus
          className="border border-brand-gold rounded-md px-2 py-1.5 text-sm text-brand-blue focus:outline-none focus:ring-2 focus:ring-brand-gold/30 min-h-[36px] w-full sm:w-auto"
        />
        <Button
          size="sm"
          disabled={busy}
          onClick={() => void save()}
          className="h-auto min-h-[32px] text-green-600 hover:text-green-800 font-bold text-xs px-2 py-1 bg-green-50 hover:bg-green-100"
        >
          {busy ? '…' : 'Save'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={close}
          disabled={busy}
          className="h-auto min-h-[32px] text-gray-500 hover:text-gray-700 font-bold text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200"
        >
          Cancel
        </Button>
        {extraActions}
        <span className="sr-only" role="status">{busy ? 'Saving…' : ''}</span>
      </div>
    );
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => { setDraft(value); setEditing(true); }}
      className="hover:underline cursor-pointer text-left"
    >
      {display ?? <span className="text-gray-300 italic font-normal">{emptyLabel}</span>}
    </button>
  );
}
