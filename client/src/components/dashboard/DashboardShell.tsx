import { useState, type ReactNode } from 'react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { SidebarNav, type NavSection } from './DashboardSidebar';
import { DashboardTopbar } from './DashboardTopbar';

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

  const handleNavigate = (section: NavSection) => {
    setMobileNavOpen(false);
    onNavigate(section);
  };

  return (
    <div className="min-h-screen bg-muted/30">
      {/* Desktop sidebar */}
      <aside className="hidden lg:block lg:fixed lg:inset-y-0 lg:left-0 lg:w-64 lg:z-40">
        <SidebarNav
          activeSection={activeSection}
          onNavigate={handleNavigate}
          onSignOut={onSignOut}
          signingOut={signingOut}
          canManageStaff={canManageStaff}
        />
      </aside>

      <div className="lg:pl-64 flex flex-col min-h-screen">
        <DashboardTopbar
          title={topbarTitle}
          subtitle={topbarSubtitle}
          actions={topbarActions}
          onOpenMobileNav={() => setMobileNavOpen(true)}
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
          />
        </SheetContent>
      </Sheet>
    </div>
  );
}
