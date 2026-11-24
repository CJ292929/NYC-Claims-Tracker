import { Switch } from '@/components/ui/switch';

/**
 * Active / Discharged switch for the patient snapshot and patient details.
 * Scoped styling (not the global Switch): green track = Active (ON), red
 * track = Discharged (OFF), always beside an explicit text label, with a
 * visible focus ring. Track colours are -600 shades against the white thumb
 * and page (≥ 3:1 non-text contrast); labels use -700/-800 text (≥ 4.5:1).
 * Behaviour is unchanged: onToggle goes to the existing confirmation /
 * permission / audited-save flow (Dashboard handleToggleActive).
 */
export function PatientActiveToggle({
  isActive,
  onToggle,
  disabled,
  id = 'patient-active-toggle',
}: {
  isActive: boolean;
  onToggle: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <label
        htmlFor={id}
        className={`text-xs font-semibold ${isActive ? 'text-green-800' : 'text-red-700'}`}
      >
        {isActive ? 'Active' : 'Discharged'}
      </label>
      <Switch
        id={id}
        checked={isActive}
        onCheckedChange={onToggle}
        disabled={disabled}
        aria-label="Toggle patient active status"
        className="h-5 w-9 border-2 data-[state=checked]:bg-green-600 data-[state=checked]:border-green-700 data-[state=unchecked]:bg-red-600 data-[state=unchecked]:border-red-700 dark:data-[state=unchecked]:bg-red-600 focus-visible:ring-[3px] focus-visible:ring-brand-gold focus-visible:ring-offset-2"
      />
    </span>
  );
}
