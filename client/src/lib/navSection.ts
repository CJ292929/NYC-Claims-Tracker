import type { NavSection } from '@/components/dashboard/DashboardSidebar';

/** Pure URL -> sidebar-section mapping. Anything not explicitly listed
 *  (including "/") falls back to 'dashboard'. */
export function routeToNavSection(location: string): NavSection {
  switch (location) {
    case '/patients': return 'patients';
    case '/authorizations': return 'authorizations';
    case '/visits': return 'visits';
    case '/claims': return 'claims';
    default: return 'dashboard';
  }
}
