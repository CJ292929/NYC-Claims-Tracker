import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import {
  getClaimsFollowUpViewState,
  getFollowUpRowStyle,
  formatChargeAmount,
  formatReimbursement,
  formatDateOrDash,
} from './claimsFollowUpViewState';

export function ClaimsFollowUpPanel({ insurance, onSelectPatient }: { insurance?: string; onSelectPatient: (id: string) => void }) {
  const utils = trpc.useUtils();
  // Scoped by the same insurance filter as the Claims Status counts and the
  // Patients list, so this panel can never disagree with them on screen.
  const queryInput = { insurance: insurance || undefined };
  const { data: followUpClaims = [], isLoading, isError } = trpc.claims.getFollowUpClaims.useQuery(queryInput);
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

  const viewState = getClaimsFollowUpViewState({ isLoading, isError, data: followUpClaims });

  const handleResolve = (e: React.MouseEvent, claimId: string) => {
    e.stopPropagation();
    markResolved.mutate({ id: claimId });
  };

  return (
    <Card className="border-border shadow-sm rounded-xl h-full flex flex-col py-0 gap-0 overflow-hidden">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border px-4 py-3 shrink-0 [.border-b]:pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold text-brand-blue">
          <AlertCircle className="w-4 h-4 text-amber-500" />
          Claims Follow-Up Needed
        </CardTitle>
        {viewState === 'data' && (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800">
            {followUpClaims.length}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0 flex-1 min-h-0 overflow-y-auto max-h-[350px]">
        {viewState === 'loading' ? (
          <div className="p-4 text-sm text-muted-foreground">Loading claims…</div>
        ) : viewState === 'error' ? (
          <div className="flex items-start gap-2.5 p-4 text-sm">
            <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <p className="text-red-700">Unable to load claims follow-up. Please refresh.</p>
          </div>
        ) : viewState === 'empty' ? (
          <div className="flex items-start gap-2.5 p-4 text-sm">
            <CheckCircle2 className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />
            <p className="text-green-700">All billed claims have received insurance reimbursement. No follow-up needed.</p>
          </div>
        ) : (
          <>
            {/* Narrow/tablet: stacked cards. The panel only gets ~650-780px at lg
                (8/12 of the content grid), too tight for a 9-column table. */}
            <div className="xl:hidden divide-y divide-border">
              {followUpClaims.map((claim) => {
                const status = claim.claimStatus ?? 'submitted';
                const s = getFollowUpRowStyle(status);
                return (
                  <div
                    key={claim.id}
                    onClick={() => onSelectPatient(claim.patientId)}
                    className={`cursor-pointer p-3 space-y-2 transition-colors ${s.row}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-medium text-brand-blue truncate">{claim.patientName}</p>
                        {claim.followUpReason && (
                          <span className="block text-[10px] font-semibold uppercase tracking-wide text-amber-600">
                            {claim.followUpReason}
                          </span>
                        )}
                      </div>
                      <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold capitalize ${s.badge}`}>
                        {status}
                      </span>
                    </div>
                    <Separator />
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-gray-600">
                      <div>
                        <span className="text-muted-foreground">DOS: </span>
                        {formatDateOrDash(claim.dateOfService)}
                      </div>
                      <div className="truncate">
                        <span className="text-muted-foreground">Insurance: </span>
                        {claim.insurance}
                      </div>
                      <div>
                        <span className="text-muted-foreground">CPT: </span>
                        {claim.cptCodes || '—'}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Submitted: </span>
                        {formatDateOrDash(claim.claimSubmittedDate)}
                      </div>
                      <div className="font-medium text-gray-700">
                        <span className="font-normal text-muted-foreground">Charged: </span>
                        {formatChargeAmount(claim.chargeAmount)}
                      </div>
                      <div className="font-medium text-gray-700">
                        <span className="font-normal text-muted-foreground">Reimbursed: </span>
                        {formatReimbursement(claim.insuranceReimbursement)}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={(e) => handleResolve(e, claim.id)}
                      disabled={markResolved.isPending}
                      aria-label={`Mark claim for ${claim.patientName} as resolved`}
                      title="Mark as resolved and remove from follow-up list"
                      className="w-full h-7 text-xs"
                    >
                      ✓ Resolved
                    </Button>
                  </div>
                );
              })}
            </div>

            {/* Wide desktop: compact table */}
            <div className="hidden xl:block overflow-x-auto">
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
                    const s = getFollowUpRowStyle(status);
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
                          {formatDateOrDash(claim.dateOfService)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">{claim.cptCodes || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600 max-w-[140px] truncate">{claim.insurance}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-600">
                          {formatDateOrDash(claim.claimSubmittedDate)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right font-medium text-gray-700">
                          {formatChargeAmount(claim.chargeAmount)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right font-medium text-gray-700">
                          {formatReimbursement(claim.insuranceReimbursement)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold capitalize ${s.badge}`}>{status}</span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={(e) => handleResolve(e, claim.id)}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
