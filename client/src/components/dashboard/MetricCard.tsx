import type { ReactNode } from 'react';
import { Link } from 'wouter';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<'navy' | 'gold' | 'destructive', string> = {
  navy: 'text-brand-blue',
  gold: 'text-brand-gold-dark',
  destructive: 'text-destructive',
};

export function MetricCard({
  icon,
  label,
  value,
  sub,
  tone = 'navy',
  href,
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: 'navy' | 'gold' | 'destructive';
  /** When set, the whole card is a real link to its destination list
   *  (navigation only — clicking never changes any record). */
  href?: string;
}) {
  const card = (
    <Card className={cn('border-brand-cream-dark shadow-sm hover:shadow-md transition-shadow h-full', href && 'group-hover:border-brand-blue/40 group-hover:shadow-md')}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {icon}
          <span>{label}</span>
        </div>
        <div className={cn('text-2xl sm:text-3xl font-bold mt-1.5', TONE_CLASS[tone])}>{value}</div>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
  if (!href) return card;
  return (
    <Link
      href={href}
      aria-label={`${label}: ${typeof value === 'number' || typeof value === 'string' ? value : ''}${sub ? ` — ${sub}` : ''}. Open list`}
      className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue focus-visible:ring-offset-2"
    >
      {card}
    </Link>
  );
}
