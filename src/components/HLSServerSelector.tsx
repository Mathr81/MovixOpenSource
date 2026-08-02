import type { ReactNode } from 'react';
import { Server as ServerIcon } from 'lucide-react';

export interface HLSServerSource {
  url: string;
}

interface HLSServerSelectorProps<T extends HLSServerSource> {
  sources: T[];
  currentUrl: string;
  onSelect: (source: T, index: number) => void;
  title: string;
  serverTitle: string;
  getServerLabel: (number: number) => string;
  headerAction?: ReactNode;
  renderSourceMeta?: (source: T, active: boolean) => ReactNode;
  renderCopyAction?: (source: T) => ReactNode;
}

export function HLSServerSelector<T extends HLSServerSource>({
  sources,
  currentUrl,
  onSelect,
  title,
  serverTitle,
  getServerLabel,
  headerAction,
  renderSourceMeta,
  renderCopyAction,
}: HLSServerSelectorProps<T>) {
  if (sources.length === 0) return null;

  return (
    <section className="mb-3 rounded-xl border border-white/10 bg-white/[0.04] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
          <ServerIcon className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
          <span className="truncate">{serverTitle}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-gray-400">{title}</span>
          {headerAction}
        </div>
      </div>

      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="group"
        aria-label={`${title} — ${serverTitle}`}
      >
        {sources.map((source, index) => {
          const active = source.url === currentUrl;
          return (
            <div key={source.url} className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelect(source, index)}
                className={[
                  'min-h-11 min-w-0 flex-1 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
                  active
                    ? 'border-red-500 bg-red-600 text-white'
                    : 'border-white/10 bg-black/30 text-gray-300 hover:border-white/25 hover:text-white',
                ].join(' ')}
              >
                <span className="block truncate">{getServerLabel(index + 1)}</span>
                {renderSourceMeta?.(source, active)}
              </button>
              {renderCopyAction?.(source)}
            </div>
          );
        })}
      </div>
    </section>
  );
}
