import type { CSSProperties } from 'react';

export const CHART_COLORS = {
  grid: 'rgba(255,255,255,0.08)',
  axis: 'rgba(255,255,255,0.45)',
  registrations: '#38bdf8',
  sessions: '#f43f5e',
  dau: '#a855f7',
  comments: '#f97316',
  lists: '#14b8a6',
  vip: '#fbbf24',
};

export const PROVIDER_COLORS: Record<string, string> = {
  bip39: '#38bdf8',
  discord: '#5865F2',
  google: '#ef4444',
  unknown: '#64748b',
};

export const tooltipStyle: CSSProperties = {
  background: 'rgba(10,10,10,0.95)',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 12,
  color: '#fff',
  fontSize: 12,
};

/** 'YYYY-MM-DD' -> 'DD/MM' for compact axis/tooltip labels. */
export const formatDayLabel = (d: string): string => {
  const parts = String(d).split('-');
  if (parts.length !== 3) return String(d);
  return `${parts[2]}/${parts[1]}`;
};
