import type { ReactNode } from 'react';
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
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: 'navy' | 'gold' | 'destructive';
}) {
  return (
    <Card className="border-brand-cream-dark shadow-sm hover:shadow-md transition-shadow">
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
}
