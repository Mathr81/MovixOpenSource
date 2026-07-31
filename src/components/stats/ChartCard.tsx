import type { ReactNode } from 'react';
import AnimatedBorderCard from '../ui/animated-border-card';

interface ChartCardProps {
  title: string;
  highlight?: string;
  action?: ReactNode;
  children: ReactNode;
}

const ChartCard = ({ title, highlight = '56 189 248', action, children }: ChartCardProps) => (
  <AnimatedBorderCard highlightColor={highlight} backgroundColor="10 10 10" className="p-5">
    <div className="mb-4 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-white/70">{title}</h3>
      {action}
    </div>
    <div className="h-64 w-full">{children}</div>
  </AnimatedBorderCard>
);

export default ChartCard;
