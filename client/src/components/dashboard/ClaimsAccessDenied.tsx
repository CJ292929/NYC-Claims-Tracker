import { ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** P4-P25: shown when Staff (no Claims access) open a Claims URL directly. Says
 *  nothing about the patient or any claim — only that access is restricted
 *  — and offers a way back to the areas this role can use. */
export function ClaimsAccessDenied({ onGoToPatientRecords }: { onGoToPatientRecords: () => void }) {
  return (
    <div className="max-w-xl mx-auto px-4 sm:px-6 py-20 text-center" role="alert">
      <ShieldAlert className="w-10 h-10 text-brand-gold mx-auto mb-4" aria-hidden="true" />
      <h2 className="text-lg font-semibold text-brand-blue mb-2">Access restricted</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Claims are available to administrators only. Patient Records and Authorizations are still available to you.
      </p>
      <Button onClick={onGoToPatientRecords} className="bg-brand-blue hover:bg-brand-blue-dark text-white font-semibold">
        Go to Patient Records
      </Button>
    </div>
  );
}
