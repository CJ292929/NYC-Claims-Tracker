import { useEffect, useState, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { SidebarNav, type NavSection } from './DashboardSidebar';
import { DashboardTopbar } from './DashboardTopbar';

const DESKTOP_SIDEBAR_PREF_KEY = 'dashboard-desktop-sidebar-open';

function readDesktopSidebarPref(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const stored = window.localStorage.getItem(DESKTOP_SIDEBAR_PREF_KEY);
    return stored === null ? true : stored === 'true';
  } catch {
    return true;
  }
}

export function DashboardShell({
  activeSection,
  onNavigate,
  onSignOut,
  signingOut,
  canManageStaff = false,
  topbarTitle,
  topbarSubtitle,
  topbarActions,
  children,
}: {
  activeSection?: NavSection;
  onNavigate: (section: NavSection) => void;
  onSignOut: () => void;
  signingOut?: boolean;
  canManageStaff?: boolean;
  topbarTitle: string;
  topbarSubtitle?: string;
  topbarActions?: ReactNode;
  children: ReactNode;
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(readDesktopSidebarPref);

  useEffect(() => {
    try {
      window.localStorage.setItem(DESKTOP_SIDEBAR_PREF_KEY, String(desktopSidebarOpen));
    } catch {
      // Ignore storage failures (e.g. private browsing); preference just won't persist.
    }
  }, [desktopSidebarOpen]);

  const handleNavigate = (section: NavSection) => {
    setMobileNavOpen(false);
    onNavigate(section);
  };

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Desktop sidebar */}
      <aside
        aria-hidden={!desktopSidebarOpen}
        className={cn(
          'hidden lg:block lg:fixed lg:inset-y-0 lg:left-0 lg:z-40 overflow-hidden',
          'transition-[width] duration-200 motion-reduce:transition-none',
          desktopSidebarOpen ? 'lg:w-64' : 'lg:w-0 invisible'
        )}
      >
        <div className="w-64 h-full">
          <SidebarNav
            activeSection={activeSection}
            onNavigate={handleNavigate}
            onSignOut={onSignOut}
            signingOut={signingOut}
            canManageStaff={canManageStaff}
          />
        </div>
      </aside>

      <div
        className={cn(
          'flex flex-col min-h-screen',
          'transition-[padding] duration-200 motion-reduce:transition-none',
          desktopSidebarOpen ? 'lg:pl-64' : 'lg:pl-0'
        )}
      >
        <DashboardTopbar
          title={topbarTitle}
          subtitle={topbarSubtitle}
          actions={topbarActions}
          onOpenMobileNav={() => setMobileNavOpen(true)}
          desktopSidebarOpen={desktopSidebarOpen}
          onToggleDesktopSidebar={() => setDesktopSidebarOpen((prev) => !prev)}
        />
        <main className="flex-1">{children}</main>
      </div>

      {/* Mobile sidebar drawer */}
      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="w-72 p-0 border-0 [&>button]:text-white">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarNav
            activeSection={activeSection}
            onNavigate={handleNavigate}
            onSignOut={onSignOut}
            signingOut={signingOut}
            canManageStaff={canManageStaff}
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
