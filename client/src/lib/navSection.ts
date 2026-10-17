import type { NavSection } from '@/components/dashboard/DashboardSidebar';

/** Pure URL -> sidebar-section mapping. Anything not explicitly listed
 *  (including "/") falls back to 'dashboard'. */
export function routeToNavSection(location: string): NavSection {
  switch (location) {
    case '/patients': return 'patients-overview';
    case '/patients/records': return 'patients-records';
    case '/patients/discharged': return 'patients-discharged';
    case '/authorizations': return 'authorizations-overview';
    case '/authorizations/attention': return 'authorizations-attention';
    case '/authorizations/records': return 'authorizations-records';
    case '/visits': return 'visits';
    case '/claims': return 'claims';
    case '/staff': return 'staff';
    case '/activity-log': return 'activity-log';
    default: return 'dashboard';
  }
}

/** Reverse of routeToNavSection, for sections that map to a real route.
 *  'bulk-upload' has no route of its own (it opens a dialog in place), so
 *  it returns null rather than a fabricated path. */
export function navSectionToRoute(section: NavSection): string | null {
  switch (section) {
    case 'dashboard': return '/dashboard';
    case 'patients-overview': return '/patients';
    case 'patients-records': return '/patients/records';
    case 'patients-discharged': return '/patients/discharged';
    case 'authorizations-overview': return '/authorizations';
    case 'authorizations-attention': return '/authorizations/attention';
    case 'authorizations-records': return '/authorizations/records';
    case 'visits': return '/visits';
    case 'claims': return '/claims';
    case 'bulk-upload': return null;
    case 'staff': return '/staff';
    case 'activity-log': return '/activity-log';
  }
}
