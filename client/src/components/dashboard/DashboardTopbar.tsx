import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Menu } from 'lucide-react';

export function DashboardTopbar({
  title,
  subtitle,
  actions,
  onOpenMobileNav,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  onOpenMobileNav: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-border">
      <div className="flex items-center justify-between gap-3 px-4 sm:px-6 xl:px-8 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenMobileNav}
            aria-label="Open navigation menu"
            className="lg:hidden -ml-2 text-brand-blue"
          >
            <Menu className="w-5 h-5" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold text-brand-blue leading-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs sm:text-sm text-muted-foreground truncate">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>
    </header>
  );
}
