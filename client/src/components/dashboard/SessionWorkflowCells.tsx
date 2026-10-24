import { useRef, useState } from 'react';
import { Check, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { trpc } from '@/lib/trpc';
import { createRequestGuard } from '@/lib/concurrencyGuards';
import {
  mergeSavedSessionField,
  normalizeRemarksDraft,
  type SessionWorkflowField,
  type SessionWorkflowValues,
} from '@/lib/sessionFieldSave';
import {
  ASSIGNMENT_OF_BENEFITS_LABELS,
  ASSIGNMENT_OF_BENEFITS_VALUES,
  SESSION_REMARKS_MAX_LENGTH,
  SUBMISSION_STATUS_LABELS,
  SUBMISSION_STATUS_VALUES,
} from '@shared/sessionWorkflowFields';

/**
 * P4-P23 per-session workflow cells for the authorization/session table —
 * Assignment of Benefits, Submission Status, Remarks. They replace the three
 * financial total columns, for every role.
 *
 * Each cell saves through visits.updateSessionFields with only its own
 * field (partial update; the server preserves every other column). Stale
 * responses are discarded: each cell holds a request guard, and only the
 * response to the most recently started save may touch the display or the
 * cached visit list — an older save that resolves late can never overwrite
 * a newer edit. While a save is in flight the cell shows the value being
 * saved; on failure it reverts to the stored value and says so.
 */

type SessionRow = { id: string } & Partial<SessionWorkflowValues>;
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const UNSET = '__unset__';

function useSessionFieldSave<F extends SessionWorkflowField>(patientId: string, visit: SessionRow, field: F) {
  const utils = trpc.useUtils();
  const mutation = trpc.visits.updateSessionFields.useMutation();
  const guardRef = useRef(createRequestGuard());
  const [pending, setPending] = useState<{ value: SessionWorkflowValues[F] } | null>(null);
  const [state, setState] = useState<SaveState>('idle');

  const stored = (visit[field] ?? null) as SessionWorkflowValues[F];
  const value = pending ? pending.value : stored;

  const save = async (next: SessionWorkflowValues[F]): Promise<boolean> => {
    if (next === value && !pending) return true; // no-op: nothing to send
    const requestId = guardRef.current.start();
    setPending({ value: next });
    setState('saving');
    try {
      const saved = await mutation.mutateAsync({ id: visit.id, patientId, [field]: next });
      if (!guardRef.current.isCurrent(requestId)) return true; // superseded by a newer save
      utils.visits.listByPatient.setData({ patientId }, old => mergeSavedSessionField(old, saved, field));
      setPending(null);
      setState('saved');
      void utils.visits.listByPatient.invalidate({ patientId });
      void utils.visits.historyForPatient.invalidate({ patientId });
      return true;
    } catch (err: unknown) {
      if (!guardRef.current.isCurrent(requestId)) return false;
      setPending(null);
      setState('error');
      toast.error(`Failed to save: ${(err as { message?: string })?.message ?? 'Unknown error'}`);
      return false;
    }
  };

  return { value, state, save };
}

function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') return <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-gold shrink-0" aria-label="Saving" />;
  if (state === 'saved') return <Check className="w-3.5 h-3.5 text-green-600 shrink-0" aria-label="Saved" />;
  if (state === 'error') return <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" aria-label="Save failed" />;
  return null;
}

export function AssignmentOfBenefitsSelect({ patientId, visit }: { patientId: string; visit: SessionRow }) {
  const { value, state, save } = useSessionFieldSave(patientId, visit, 'assignmentOfBenefits');
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={value ?? UNSET}
        onValueChange={v => void save(v === UNSET ? null : (v as SessionWorkflowValues['assignmentOfBenefits']))}
      >
        <SelectTrigger size="sm" aria-label="Assignment of Benefits" className="h-8 min-w-[96px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>— Not set —</SelectItem>
          {ASSIGNMENT_OF_BENEFITS_VALUES.map(v => (
            <SelectItem key={v} value={v}>{ASSIGNMENT_OF_BENEFITS_LABELS[v]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SaveIndicator state={state} />
    </div>
  );
}

export function SubmissionStatusSelect({ patientId, visit }: { patientId: string; visit: SessionRow }) {
  const { value, state, save } = useSessionFieldSave(patientId, visit, 'submissionStatus');
  return (
    <div className="flex items-center gap-1.5">
      <Select
        value={value ?? UNSET}
        onValueChange={v => void save(v === UNSET ? null : (v as SessionWorkflowValues['submissionStatus']))}
      >
        <SelectTrigger size="sm" aria-label="Submission Status" className="h-8 min-w-[128px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNSET}>— Not set —</SelectItem>
          {SUBMISSION_STATUS_VALUES.map(v => (
            <SelectItem key={v} value={v}>{SUBMISSION_STATUS_LABELS[v]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SaveIndicator state={state} />
    </div>
  );
}

export function RemarksCell({ patientId, visit }: { patientId: string; visit: SessionRow }) {
  const { value, state, save } = useSessionFieldSave(patientId, visit, 'remarks');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (editing) {
    const tooLong = draft.length > SESSION_REMARKS_MAX_LENGTH;
    return (
      <div className="space-y-1.5 min-w-[220px]">
        <Textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
          rows={3}
          aria-label="Remarks"
          aria-invalid={tooLong}
          className="text-sm min-h-[72px]"
        />
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={state === 'saving' || tooLong}
            onClick={async () => {
              if (await save(normalizeRemarksDraft(draft))) setEditing(false);
            }}
            className="h-auto min-h-[32px] text-green-600 hover:text-green-800 font-bold text-xs px-2 py-1 bg-green-50 hover:bg-green-100"
          >
            {state === 'saving' ? '…' : 'Save'}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing(false)}
            className="h-auto min-h-[32px] text-gray-500 hover:text-gray-700 font-bold text-xs px-2 py-1 bg-gray-100 hover:bg-gray-200"
          >
            Cancel
          </Button>
          <span className={`text-[11px] ${tooLong ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
            {draft.length}/{SESSION_REMARKS_MAX_LENGTH}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-1.5">
      <button
        onClick={() => { setDraft(value ?? ''); setEditing(true); }}
        className="hover:underline cursor-pointer text-left text-sm text-gray-700 whitespace-pre-wrap break-words max-w-[260px] line-clamp-3"
        title={value ?? undefined}
      >
        {value ?? <span className="text-gray-300 italic font-normal">Add remarks</span>}
      </button>
      <SaveIndicator state={state} />
    </div>
  );
}
