import { Gauge } from 'lucide-react';
import { buildHlsQualityChoices } from '@/utils/hlsQuality';
import type { HlsQualityOption, HlsQualityPreference } from '@/utils/hlsQuality';

interface HLSQualitySelectorProps {
  options: HlsQualityOption[];
  preference: HlsQualityPreference;
  effectiveHeight: number | null;
  onSelect: (preference: HlsQualityPreference) => void;
  title: string;
  autoLabel: string;
  playingLabel: string;
}

export function HLSQualitySelector({
  options,
  preference,
  effectiveHeight,
  onSelect,
  title,
  autoLabel,
  playingLabel,
}: HLSQualitySelectorProps) {
  if (options.length === 0) return null;

  const choices = buildHlsQualityChoices(options, autoLabel);
  const selectedValue = options.length === 1 ? options[0].height : preference;

  return (
    <section className="mb-5 rounded-xl border border-white/10 bg-white/[0.04] p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
          <Gauge className="h-4 w-4 shrink-0 text-red-400" aria-hidden="true" />
          <span className="truncate">{title}</span>
        </div>
        {effectiveHeight ? (
          <span className="shrink-0 text-xs text-gray-400">
            {playingLabel.replace('{{quality}}', `${effectiveHeight}p`)}
          </span>
        ) : null}
      </div>
      <div
        className={`grid gap-2 ${choices.length === 1 ? 'grid-cols-1' : 'grid-cols-3'}`}
        role="group"
        aria-label={title}
      >
        {choices.map(choice => {
          const active = selectedValue === choice.value;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(choice.value)}
              className={[
                'min-h-11 rounded-lg border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
                active
                  ? 'border-red-500 bg-red-600 text-white'
                  : 'border-white/10 bg-black/30 text-gray-300 hover:border-white/25 hover:text-white',
              ].join(' ')}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </section>
  );
}
