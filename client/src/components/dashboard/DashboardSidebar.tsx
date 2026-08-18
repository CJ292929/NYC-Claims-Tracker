import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  ShieldAlert,
  CalendarCheck,
  FileStack,
  AlertCircle,
  UploadCloud,
  LogOut,
  Loader2,
} from 'lucide-react';
import logoIcon from '@/assets/logos/logo-icon.png';

export type NavSection =
  | 'dashboard'
  | 'patients'
  | 'authorizations'
  | 'visits'
  | 'claims'
  | 'claims-followup'
  | 'bulk-upload';

const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ key: NavSection; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    label: 'Main',
    items: [{ key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Patient Management',
    items: [
      { key: 'patients', label: 'Patients', icon: Users },
      { key: 'authorizations', label: 'Authorizations', icon: ShieldAlert },
      { key: 'visits', label: 'Visits', icon: CalendarCheck },
    ],
  },
  {
    label: 'Claims',
    items: [
      { key: 'claims', label: 'Claims', icon: FileStack },
      { key: 'claims-followup', label: 'Claims Follow-Up', icon: AlertCircle },
      { key: 'bulk-upload', label: 'Bulk Upload', icon: UploadCloud },
    ],
  },
];

export function SidebarNav({
  activeSection = 'dashboard',
  onNavigate,
  onSignOut,
  signingOut = false,
}: {
  activeSection?: NavSection;
  onNavigate: (section: NavSection) => void;
  onSignOut: () => void;
  signingOut?: boolean;
}) {
  return (
    <div className="flex h-full flex-col bg-brand-blue text-white">
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-white/10">
        <img src={logoIcon} alt="" className="w-8 h-8 object-contain shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">NYC Home Rehab</p>
          <p className="text-[11px] text-white/60 leading-tight truncate">Authorization &amp; Claims Tracker</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map(({ key, label, icon: Icon }) => {
                const isActive = activeSection === key;
                return (
                  <button
                    key={key}
                    onClick={() => onNavigate(key)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-brand-gold text-brand-blue font-semibold'
                        : 'text-white/80 hover:bg-white/10 hover:text-white'
                    )}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-3">
        <Button
          variant="ghost"
          onClick={onSignOut}
          disabled={signingOut}
          className="w-full justify-start gap-2.5 px-2.5 text-white/70 hover:bg-white/10 hover:text-white font-medium"
        >
          {signingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut className="w-4 h-4" />}
          Sign Out
        </Button>
      </div>
    </div>
  );
}
