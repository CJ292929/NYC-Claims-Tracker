import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  LayoutDashboard,
  Users,
  ShieldAlert,
  CalendarCheck,
  FileStack,
  UploadCloud,
  UserCog,
  LogOut,
  Loader2,
  ChevronDown,
  History,
} from 'lucide-react';
import logoIcon from '@/assets/logos/logo-icon.png';

export type NavSection =
  | 'dashboard'
  | 'patients-overview'
  | 'patients-records'
  | 'patients-discharged'
  | 'authorizations-overview'
  | 'authorizations-attention'
  | 'authorizations-records'
  | 'visits'
  | 'claims'
  | 'bulk-upload'
  | 'staff'
  | 'activity-log';

type IconType = React.ComponentType<{ className?: string }>;

interface NavLeaf {
  type: 'leaf';
  key: NavSection;
  label: string;
  icon?: IconType;
}

interface NavParent {
  type: 'parent';
  key: string;
  label: string;
  icon: IconType;
  children: NavLeaf[];
}

type NavEntry = NavLeaf | NavParent;

const leaf = (key: NavSection, label: string, icon?: IconType): NavLeaf => ({ type: 'leaf', key, label, icon });

const NAV_GROUPS: Array<{ label: string; items: NavEntry[] }> = [
  {
    label: 'Main',
    items: [leaf('dashboard', 'Dashboard', LayoutDashboard)],
  },
  {
    label: 'Patient Management',
    items: [
      {
        type: 'parent',
        key: 'patients',
        label: 'Patients',
        icon: Users,
        children: [
          leaf('patients-overview', 'Overview'),
          leaf('patients-records', 'Patient Records'),
          leaf('patients-discharged', 'Discharged Patients'),
        ],
      },
      {
        type: 'parent',
        key: 'authorizations',
        label: 'Authorizations',
        icon: ShieldAlert,
        children: [
          leaf('authorizations-overview', 'Overview'),
          leaf('authorizations-attention', 'Needs Attention'),
          leaf('authorizations-records', 'Records'),
        ],
      },
    ],
  },
  {
    label: 'Clinical / Billing',
    items: [
      leaf('visits', 'Visits', CalendarCheck),
      leaf('claims', 'Claims', FileStack),
    ],
  },
  {
    label: 'Actions',
    items: [leaf('bulk-upload', 'Bulk Upload', UploadCloud)],
  },
  {
    label: 'Management',
    items: [
      leaf('staff', 'Staff Management', UserCog),
      leaf('activity-log', 'Activity Log', History),
    ],
  },
];

/** Group label gated to owner/admin sessions only — see canManageStaff prop
 * on SidebarNav, threaded down from DashboardShell. */
const ADMIN_ONLY_GROUP_LABELS = new Set(['Management']);

/** Items gated to Claims-access roles (P4-P25: Owner/Super Admin, Clinic Admin) — see canAccessClaims. */
const CLAIMS_ACCESS_SECTIONS = new Set<NavSection>(['claims']);

/** Group keys whose children include the given section. */
function parentKeysContaining(activeSection: NavSection): string[] {
  const keys: string[] = [];
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.type === 'parent' && item.children.some((c) => c.key === activeSection)) {
        keys.push(item.key);
      }
    }
  }
  return keys;
}

export function SidebarNav({
  activeSection = 'dashboard',
  onNavigate,
  onSignOut,
  signingOut = false,
  canManageStaff = false,
  canAccessClaims = false,
}: {
  activeSection?: NavSection;
  onNavigate: (section: NavSection) => void;
  onSignOut: () => void;
  signingOut?: boolean;
  /** Owner OAuth admins and clinic admins only — hides the Management group
   * (Staff Management) from normal staff. Mirrors the server's
   * adminOrOwnerProcedure gate; see client/src/lib/authGate.ts. */
  canManageStaff?: boolean;
  /** P4-P25: Owner/Super Admin and Clinic Admin only — hides the Claims item from Staff.
   * Defaults to false so a caller that forgets the prop fails closed.
   * Mirrors claimsAccessProcedure; see canAccessClaims in authGate.ts. */
  canAccessClaims?: boolean;
}) {
  const visibleNavGroups = NAV_GROUPS.filter(
    (group) => canManageStaff || !ADMIN_ONLY_GROUP_LABELS.has(group.label)
  ).map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccessClaims || !CLAIMS_ACCESS_SECTIONS.has(item.key as NavSection)),
  }));

  // Which parent groups (e.g. "Patients") are expanded. Initialized open for
  // whichever group contains the current section, then kept in sync as the
  // user navigates — but a manual collapse click is respected until the next
  // navigation into that group, rather than being fought every render.
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(parentKeysContaining(activeSection)));

  useEffect(() => {
    const keys = parentKeysContaining(activeSection);
    if (keys.length === 0) return;
    setOpenGroups((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const key of keys) {
        if (!next.has(key)) {
          next.add(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeSection]);

  const toggleGroup = (key: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col bg-brand-blue text-white">
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-white/10">
        <img src={logoIcon} alt="" className="w-8 h-8 object-contain shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight truncate">NYC Home Rehab Claims</p>
          <p className="text-[11px] text-white/60 leading-tight truncate">Authorization &amp; Claims Tracker</p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
        {visibleNavGroups.map((group) => (
          <div key={group.label}>
            <p className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/40">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                if (item.type === 'leaf') {
                  const isActive = activeSection === item.key;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      onClick={() => onNavigate(item.key)}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(
                        'w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                        isActive
                          ? 'bg-brand-gold text-brand-blue font-semibold'
                          : 'text-white/80 hover:bg-white/10 hover:text-white'
                      )}
                    >
                      {Icon && <Icon className="w-4 h-4 shrink-0" />}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                }

                const isOpen = openGroups.has(item.key);
                const isParentActive = item.children.some((c) => c.key === activeSection);
                return (
                  <div key={item.key}>
                    <button
                      onClick={() => toggleGroup(item.key)}
                      aria-expanded={isOpen}
                      className={cn(
                        'w-full flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                        isParentActive
                          ? 'bg-white/10 text-white font-semibold'
                          : 'text-white/80 hover:bg-white/10 hover:text-white'
                      )}
                    >
                      <item.icon className="w-4 h-4 shrink-0" />
                      <span className="flex-1 text-left truncate">{item.label}</span>
                      <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 transition-transform', isOpen && 'rotate-180')} />
                    </button>
                    {isOpen && (
                      <div className="mt-0.5 ml-4 pl-3 border-l border-white/10 space-y-0.5">
                        {item.children.map((child) => {
                          const isActive = activeSection === child.key;
                          return (
                            <button
                              key={child.key}
                              onClick={() => onNavigate(child.key)}
                              aria-current={isActive ? 'page' : undefined}
                              className={cn(
                                'w-full flex items-center rounded-md px-2.5 py-1.5 text-sm transition-colors',
                                isActive
                                  ? 'bg-brand-gold text-brand-blue font-semibold'
                                  : 'text-white/70 hover:bg-white/10 hover:text-white'
                              )}
                            >
                              <span className="truncate">{child.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
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
