import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';

// Card color per claim_status, per product spec:
// Rejected=Black, Denied=Red, Pending=Yellow, Pended=Orange, Approved=Green,
// Resubmitted=Violet, Submitted=Blue.
const FOLLOW_UP_ROW_STYLES: Record<string, { badge: string; row: string }> = {
  rejected:    { badge: 'bg-gray-900 text-white',     row: 'hover:bg-gray-50' },
  denied:      { badge: 'bg-red-100 text-red-800',    row: 'hover:bg-red-50/60' },
  pended:      { badge: 'bg-orange-100 text-orange-800', row: 'hover:bg-orange-50/60' },
  pending:     { badge: 'bg-yellow-100 text-yellow-800', row: 'hover:bg-yellow-50/60' },
  submitted:   { badge: 'bg-blue-100 text-blue-800',  row: 'hover:bg-blue-50/60' },
  approved:    { badge: 'bg-green-100 text-green-800', row: 'hover:bg-green-50/60' },
  resubmitted: { badge: 'bg-violet-100 text-violet-800', row: 'hover:bg-violet-50/60' },
};

export function ClaimsFollowUpPanel({ insurance, onSelectPatient }: { insurance?: string; onSelectPatient: (id: string) => void }) {
  const utils = trpc.useUtils();
  // Scoped by the same insurance filter as the Claims Status counts and the
  // Patients list, so this panel can never disagree with them on screen.
  const queryInput = { insurance: insurance || undefined };
  const { data: followUpClaims = [], isLoading } = trpc.claims.getFollowUpClaims.useQuery(queryInput);
  const markResolved = trpc.claims.markResolved.useMutation({
    onMutate: async ({ id }) => {
      // Optimistically remove the card immediately
      await utils.claims.getFollowUpClaims.cancel(queryInput);
      const prev = utils.claims.getFollowUpClaims.getData(queryInput);
      utils.claims.getFollowUpClaims.setData(queryInput, (old) =>
        (old ?? []).filter((c) => c.id !== id)
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      // Rollback on error
      if (ctx?.prev) utils.claims.getFollowUpClaims.setData(queryInput, ctx.prev);
    },
    onSettled: () => {
      utils.claims.getFollowUpClaims.invalidate();
      utils.claims.getStatusCounts.invalidate();
      // Also invalidate the claims tracker queries so the table rows
      // immediately reflect the updated 'pending' status
      utils.claims.getByPatientAndPeriod.invalidate();
    },
  });

  return (
    <Card className="border-border shadow-sm rounded-xl h-full flex flex-col py-0 gap-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-3 shrink-0 [.border-b]:pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-brand-blue">
          <AlertCircle className="w-4 h-4 text-amber-500" />
          Claims Follow-Up Needed
        </CardTitle>
        {followUpClaims.length > 0 && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            {followUpClaims.length}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0 overflow-y-auto max-h-[350px]">
        {isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading claims…</div>
        ) : followUpClaims.length === 0 ? (
          <div className="flex items-start gap-2.5 p-4 text-sm">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
            <p className="text-green-700">All billed claims have received insurance reimbursement. No follow-up needed.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-brand-cream/70 backdrop-blur z-10">
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-brand-blue">
                  <th className="px-3 py-2">Patient</th>
                  <th className="px-3 py-2">DOS</th>
                  <th className="px-3 py-2">CPT</th>
                  <th className="px-3 py-2">Insurance</th>
                  <th className="px-3 py-2">Submitted</th>
                  <th className="px-3 py-2 text-right">Charged</th>
                  <th className="px-3 py-2 text-right">Reimbursed</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {followUpClaims.map((claim) => {
                  const status = claim.claimStatus ?? 'submitted';
                  const s = FOLLOW_UP_ROW_STYLES[status] ?? FOLLOW_UP_ROW_STYLES.rejected;
                  return (
                    <tr
                      key={claim.id}
                      onClick={() => onSelectPatient(claim.patientId)}
                      className={`cursor-pointer transition-colors ${s.row}`}
                    >
                      <td className="px-3 py-2 font-medium text-brand-blue whitespace-nowrap max-w-[160px] truncate">
                        {claim.patientName}
                        {claim.followUpReason && (
                          <span className="block text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                            {claim.followUpReason}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                        {claim.dateOfService ? new Date(claim.dateOfService).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">{claim.cptCodes || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600 max-w-[140px] truncate">{claim.insurance}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                        {claim.claimSubmittedDate ? new Date(claim.claimSubmittedDate).toLocaleDateString() : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right font-medium text-gray-700">
                        {claim.chargeAmount != null ? `$${parseFloat(String(claim.chargeAmount)).toFixed(2)}` : '—'}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right font-medium text-gray-700">
                        ${(claim.insuranceReimbursement != null ? parseFloat(String(claim.insuranceReimbursement)) : 0).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold capitalize ${s.badge}`}>{status}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => { e.stopPropagation(); markResolved.mutate({ id: claim.id }); }}
                          disabled={markResolved.isPending}
                          aria-label={`Mark claim for ${claim.patientName} as resolved`}
                          title="Mark as resolved and remove from follow-up list"
                          className="h-7 px-2 text-xs"
                        >
                          ✓ Resolved
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
