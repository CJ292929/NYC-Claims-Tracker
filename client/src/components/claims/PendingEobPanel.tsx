/**
 * client/src/components/claims/PendingEobPanel.tsx — P4-P28
 *
 * Reimbursement lines a reviewer saved while no CMS1500 line existed. Nothing
 * here has been paid: each line is applied only when someone clicks Apply, and
 * the server re-validates it (server/pendingEob.ts). The list re-classifies on
 * every load, so a line becomes applicable once its CMS1500 is saved. Rendered
 * only for users with Claims access (Bulk Upload → Insurance Reimbursement).
 */
import { useRef, useState } from "react";
import { CheckCircle2, Clock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc";
import { createSingleFlightGuard } from "@/lib/concurrencyGuards";
import { formatCalendarDate } from "@/lib/date";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "../../../../server/routers";

type Item = inferRouterOutputs<AppRouter>["claims"]["pendingEobList"]["items"][number];
type Choice = { claimRecordId?: string; confirmReplace?: boolean };

const money = (n: number | null | undefined) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);

/** The apply request for a line, or null when it still needs something. */
function applyItem(item: Item, choice: Choice | undefined) {
  const c = item.classification;
  if (c.status === "matched" || c.status === "already_saved") {
    return c.targetClaimId ? { pendingId: item.id, claimRecordId: c.targetClaimId } : null;
  }
  if (c.status === "needs_selection") {
    return choice?.claimRecordId ? { pendingId: item.id, claimRecordId: choice.claimRecordId } : null;
  }
  if (c.status === "needs_confirmation") {
    return c.targetClaimId && choice?.confirmReplace ? { pendingId: item.id, claimRecordId: c.targetClaimId, confirmReplace: true } : null;
  }
  return null;
}

export function PendingEobPanel({ onApplied }: { onApplied?: () => void }) {
  const { data, isLoading, error } = trpc.claims.pendingEobList.useQuery();
  const utils = trpc.useUtils();
  const apply = trpc.claims.pendingEobApply.useMutation();
  const dismiss = trpc.claims.pendingEobDismiss.useMutation();
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [confirmingDismiss, setConfirmingDismiss] = useState<string | null>(null);
  const guard = useRef(createSingleFlightGuard());
  const items = data?.items ?? [];

  if (isLoading) return null;
  if (error) return <p className="text-xs text-destructive">Could not load waiting reimbursement lines: {error.message}</p>;
  if (items.length === 0) return null;

  const ready = items.map(i => applyItem(i, choices[i.id])).filter((x): x is NonNullable<typeof x> => !!x);

  const applyReady = async () => {
    if (!guard.current.tryEnter()) return;
    try {
      const { results } = await apply.mutateAsync({ items: ready.slice(0, 100) });
      const saved = results.filter(r => r.status === "saved" || r.status === "unchanged").length;
      setMessages(results.reduce<Record<string, string>>((m, r) => (r.message ? { ...m, [r.pendingId]: r.message } : m), {}));
      await utils.claims.pendingEobList.invalidate();
      if (saved > 0) onApplied?.();
      const problems = results.length - saved;
      if (problems > 0) toast.warning(`${saved} applied, ${problems} still need attention. They stay listed below.`);
      else toast.success(`${saved} reimbursement line${saved !== 1 ? "s" : ""} applied.`);
    } catch (err: any) {
      toast.error(`Could not apply: ${err?.message ?? "error"}. Nothing from this request was reported as applied — retry.`);
    } finally {
      guard.current.exit();
    }
  };

  const dismissLine = async (id: string) => {
    if (!guard.current.tryEnter()) return;
    try {
      await dismiss.mutateAsync({ pendingId: id });
      setConfirmingDismiss(null);
      await utils.claims.pendingEobList.invalidate();
      toast.success("Line dismissed. No claim line was changed.");
    } catch (err: any) {
      toast.error(`Could not dismiss: ${err?.message ?? "error"}`);
    } finally {
      guard.current.exit();
    }
  };

  const busy = apply.isPending || dismiss.isPending;

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-3" data-testid="pending-eob-panel">
      <div className="flex flex-wrap items-center gap-2">
        <Clock className="h-4 w-4 text-amber-700" />
        <p className="text-sm font-semibold text-amber-950">{items.length} reimbursement line{items.length !== 1 ? "s" : ""} waiting for a CMS1500</p>
        <Button
          size="sm"
          className="h-auto min-h-8 whitespace-normal bg-brand-blue py-1 text-white hover:bg-brand-blue-dark sm:ml-auto"
          disabled={busy || ready.length === 0}
          onClick={() => void applyReady()}
          data-testid="pending-eob-apply"
        >
          {apply.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-1 h-4 w-4" />}
          Apply {ready.length} ready
        </Button>
      </div>
      <p className="mt-1 text-xs text-amber-900">Nothing here has been paid. Upload the matching CMS1500 first, then apply the lines that are ready.</p>
      {data?.truncated && <p className="mt-1 text-xs font-medium text-amber-950">Showing the oldest {items.length}. More lines are waiting; apply these to see them.</p>}
      <ul className="mt-2 max-h-72 divide-y divide-amber-200 overflow-y-auto">
        {items.map(item => {
          const c = item.classification;
          return (
            <li key={item.id} className="py-2 text-xs" data-testid="pending-eob-line">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="break-words font-medium">{item.patientName}</span>
                <span>{formatCalendarDate(item.dateOfService)}</span>
                <span className="font-medium">{item.cptCodes}</span>
                <span>Billed {money(item.chargeAmount)}</span>
                <span>Paid {money(item.insuranceReimbursement)}</span>
                <span>Pt resp. {money(item.patientAmountDue)}</span>
                {item.fileName && <span className="break-all text-muted-foreground">{item.fileName}</span>}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {c.status === "cms1500_required" && <Badge variant="outline">Upload the matching CMS1500 first</Badge>}
                {c.status === "matched" && <Badge variant="secondary">Ready to apply</Badge>}
                {c.status === "invalid" && <span className="text-destructive">{c.reason}</span>}
                {c.status === "needs_selection" && (
                  <select
                    className="h-8 max-w-full rounded-md border border-input bg-background px-2 text-xs"
                    aria-label="Claim line this payment belongs to"
                    value={choices[item.id]?.claimRecordId ?? ""}
                    onChange={e => setChoices(prev => ({ ...prev, [item.id]: { claimRecordId: e.target.value || undefined } }))}
                  >
                    <option value="">Choose the CMS1500 line…</option>
                    {c.candidates.map(x => <option key={x.id} value={x.id}>Period {x.authPeriod} · {x.cptCodes} {x.modifier ?? ""} · {x.unitsBilled ?? "?"}u</option>)}
                  </select>
                )}
                {c.status === "needs_confirmation" && (
                  <label className="flex items-center gap-1">
                    <Checkbox
                      checked={choices[item.id]?.confirmReplace === true}
                      onCheckedChange={v => setChoices(prev => ({ ...prev, [item.id]: { confirmReplace: v === true } }))}
                    />
                    {c.reason ?? "Replace the existing amounts on this line"}
                  </label>
                )}
                {messages[item.id] && <span className="text-amber-900">{messages[item.id]}</span>}
                {confirmingDismiss === item.id ? (
                  <span className="flex items-center gap-1 sm:ml-auto">
                    Dismiss this line?
                    <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" disabled={busy} onClick={() => void dismissLine(item.id)}>Dismiss</Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setConfirmingDismiss(null)}>Keep</Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] sm:ml-auto" onClick={() => setConfirmingDismiss(item.id)}>Dismiss</Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
